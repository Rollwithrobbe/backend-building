// Scouting job: for every brand with a connected TikTok account, checks that
// account's recent videos, reads their view counts, and automatically marks a
// tracked video "hit" once it crosses that brand's own view requirement —
// same pattern as scout-youtube.js / scout-instagram.js.
//
// TikTok access tokens are short-lived (~24h) but come with a refresh token
// (~365 days), so this job refreshes first whenever the stored token is
// close to expiring — no user action needed once connected.
//
// Required env vars (set in Vercel):
//   TIKTOK_CLIENT_KEY
//   TIKTOK_CLIENT_SECRET
//   SUPABASE_URL
//   SUPABASE_KEY
// Optional:
//   CRON_SECRET

export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
  const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!CLIENT_KEY || !CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'missing required environment variables (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / SUPABASE_URL / SUPABASE_KEY)' });
  }

  const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    const brandsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/brands?select=*&tiktok_open_id=not.is.null`,
      { headers: sbHeaders }
    );
    const brands = await brandsRes.json();

    if (!Array.isArray(brands) || brands.length === 0) {
      return res.status(200).json({ message: 'no brands with a TikTok account connected yet' });
    }

    const perBrand = [];
    for (const brand of brands) {
      const outcome = await scoutBrandAccount(brand, CLIENT_KEY, CLIENT_SECRET, SUPABASE_URL, sbHeaders);
      perBrand.push({ brand: brand.name, tiktok: brand.tiktok_username, ...outcome });
    }

    return res.status(200).json({ brandsScanned: brands.length, perBrand });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

async function scoutBrandAccount(brand, CLIENT_KEY, CLIENT_SECRET, SUPABASE_URL, sbHeaders) {
  let token = brand.tiktok_access_token;
  if (!token) {
    return { error: 'no tiktok_access_token stored for this brand — reconnect TikTok' };
  }

  // Refresh the access token if it's expired or about to be (within 1 hour) —
  // TikTok access tokens only last ~24h, refresh tokens last much longer.
  const expiresAt = brand.tiktok_token_expires_at ? new Date(brand.tiktok_token_expires_at).getTime() : 0;
  if (Date.now() > expiresAt - 60 * 60 * 1000) {
    const refreshed = await refreshToken(brand, CLIENT_KEY, CLIENT_SECRET, SUPABASE_URL, sbHeaders);
    if (refreshed.error) return refreshed;
    token = refreshed.access_token;
  }

  // Pull recent videos (paginated, cap at 3 pages / ~60 videos per run)
  const videos = [];
  let cursor = null;
  for (let page = 0; page < 3; page++) {
    const body = { max_count: 20 };
    if (cursor) body.cursor = cursor;
    const listRes = await fetch(
      'https://open.tiktokapis.com/v2/video/list/?fields=id,title,view_count,create_time,share_url,cover_image_url',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const listData = await listRes.json();
    if (listData.error && listData.error.code !== 'ok') {
      return { error: `TikTok API error: ${listData.error.message || listData.error.code}` };
    }
    const pageVideos = listData?.data?.videos || [];
    videos.push(...pageVideos);
    if (!listData?.data?.has_more) break;
    cursor = listData.data.cursor;
  }

  if (videos.length === 0) {
    return { checked: 0, results: [] };
  }

  const results = [];
  for (const video of videos) {
    const viewCount = video.view_count;
    if (typeof viewCount !== 'number') {
      results.push({ id: video.id, action: 'skipped', reason: 'no view count returned' });
      continue;
    }

    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tracked_videos?platform=eq.tiktok&external_video_id=eq.${video.id}&select=*`,
      { headers: sbHeaders }
    );
    const existing = await existingRes.json();

    if (existing.length === 0) {
      const eligibleUntil = new Date(Date.now() + brand.eligibility_window_days * 86400000).toISOString();
      const alreadyHit = viewCount >= brand.view_requirement;
      await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          brand_id: brand.id,
          platform: 'tiktok',
          external_video_id: video.id,
          url: video.share_url || '',
          title: video.title ? video.title.slice(0, 200) : '',
          posted_at: video.create_time ? new Date(video.create_time * 1000).toISOString() : null,
          view_count: viewCount,
          last_checked_at: new Date().toISOString(),
          eligible_until: eligibleUntil,
          status: alreadyHit ? 'hit' : 'tracking',
          earned: alreadyHit,
          pay_amount: brand.base_pay,
          thumbnail_url: video.cover_image_url || null,
        }),
      });
      results.push({ id: video.id, action: 'discovered', views: viewCount, status: alreadyHit ? 'hit' : 'tracking' });
    } else {
      const row = existing[0];
      if (row.excluded) {
        results.push({ id: video.id, action: 'skipped', status: 'excluded' });
      } else if (row.status === 'tracking') {
        let status = 'tracking';
        let earned = false;
        if (viewCount >= brand.view_requirement) {
          status = 'hit';
          earned = true;
        } else if (row.eligible_until && new Date() > new Date(row.eligible_until)) {
          status = 'expired';
        }
        await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ view_count: viewCount, last_checked_at: new Date().toISOString(), status, earned }),
        });
        results.push({ id: video.id, action: 'updated', views: viewCount, status });
      } else {
        results.push({ id: video.id, action: 'skipped', status: row.status });
      }
    }
  }

  // Anything Supabase still has as 'tracking' for this brand+platform that didn't show up in
  // this fetch has vanished from TikTok (deleted, or set private) before ever hitting its
  // requirement — flag it distinctly instead of freezing it silently forever pretending it
  // might still resolve. Self-heals: if it reappears in a later fetch, the normal update path
  // above finds the existing row and overwrites this status.
  const seenIds = new Set(videos.map((v) => v.id));
  const missingCount = await flagMissingVideos(brand, 'tiktok', seenIds, SUPABASE_URL, sbHeaders);

  return { checked: results.length, results, flaggedMissing: missingCount };
}

async function flagMissingVideos(brand, platform, seenIds, SUPABASE_URL, sbHeaders) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tracked_videos?platform=eq.${platform}&brand_id=eq.${brand.id}&status=eq.tracking&select=id,external_video_id`,
    { headers: sbHeaders }
  );
  const stillTracking = await res.json();
  const nowMissing = (Array.isArray(stillTracking) ? stillTracking : []).filter((row) => !seenIds.has(row.external_video_id));
  for (const row of nowMissing) {
    await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'missing', last_checked_at: new Date().toISOString() }),
    });
  }
  return nowMissing.length;
}

async function refreshToken(brand, CLIENT_KEY, CLIENT_SECRET, SUPABASE_URL, sbHeaders) {
  if (!brand.tiktok_refresh_token) {
    return { error: 'access token expired and no refresh token stored — reconnect TikTok' };
  }
  const form = new URLSearchParams({
    client_key: CLIENT_KEY,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: brand.tiktok_refresh_token,
  });
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: form.toString(),
  });
  const data = await res.json();
  if (!data.access_token) {
    return { error: `could not refresh TikTok token: ${JSON.stringify(data)}` };
  }
  const expiresAt = new Date(Date.now() + (data.expires_in || 86400) * 1000).toISOString();
  const refreshExpiresAt = new Date(Date.now() + (data.refresh_expires_in || 365 * 86400) * 1000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/brands?id=eq.${brand.id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      tiktok_access_token: data.access_token,
      tiktok_refresh_token: data.refresh_token,
      tiktok_token_expires_at: expiresAt,
      tiktok_refresh_expires_at: refreshExpiresAt,
    }),
  });
  return { access_token: data.access_token };
}
