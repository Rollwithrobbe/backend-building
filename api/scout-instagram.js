// Scouting job: for every brand with a connected Instagram Business account, checks
// that account's recent Reels, reads their view counts (which Instagram already
// combines across Instagram + crossposted Facebook plays — see the Instagram
// Insights UI, "Weergaven" breakdown), and automatically marks a tracked video
// "hit" once it crosses that brand's own view requirement — same pattern as
// scout-youtube.js.
//
// Required env vars (set in Vercel):
//   SUPABASE_URL
//   SUPABASE_KEY
// Optional:
//   CRON_SECRET

export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'missing required environment variables (SUPABASE_URL / SUPABASE_KEY)' });
  }

  const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    const brandsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/brands?select=*&instagram_business_account_id=not.is.null`,
      { headers: sbHeaders }
    );
    const brands = await brandsRes.json();

    if (!Array.isArray(brands) || brands.length === 0) {
      return res.status(200).json({ message: 'no brands with an Instagram account connected yet' });
    }

    const perBrand = [];
    for (const brand of brands) {
      const outcome = await scoutBrandAccount(brand, SUPABASE_URL, sbHeaders);
      perBrand.push({ brand: brand.name, instagram: brand.instagram_username, ...outcome });
    }

    return res.status(200).json({ brandsScanned: brands.length, perBrand });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

async function scoutBrandAccount(brand, SUPABASE_URL, sbHeaders) {
  const igId = brand.instagram_business_account_id;
  const token = brand.instagram_access_token;
  if (!token) {
    return { error: 'no instagram_access_token stored for this brand — reconnect Instagram' };
  }

  // 1. Pull recent media, only keeping Reels (that's what carries a view-count/base-pay target)
  // "me" is used instead of the numeric account id — with an Instagram Login user token,
  // the token is already scoped to exactly one account, and "me" is the endpoint form
  // that actually resolves for it (the raw numeric id form returns a "does not exist" error).
  const mediaRes = await fetch(
    `https://graph.instagram.com/me/media` +
    `?fields=id,caption,timestamp,permalink,media_type,media_product_type` +
    `&limit=50&access_token=${encodeURIComponent(token)}`
  );
  const mediaData = await mediaRes.json();
  if (mediaData.error) {
    return { error: `Instagram API error: ${mediaData.error.message}` };
  }
  const reels = (mediaData.data || []).filter(
    (m) => m.media_product_type === 'REELS' || m.media_type === 'VIDEO'
  );
  if (reels.length === 0) {
    return { checked: 0, results: [] };
  }

  const results = [];
  for (const media of reels) {
    const debug = [];
    const viewCount = await fetchViews(media.id, token, debug);
    if (viewCount === null) {
      results.push({ id: media.id, action: 'skipped', reason: 'could not read view count', debug: debug[0] });
      continue;
    }

    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tracked_videos?platform=eq.instagram&external_video_id=eq.${media.id}&select=*`,
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
          platform: 'instagram',
          external_video_id: media.id,
          url: media.permalink || '',
          title: media.caption ? media.caption.slice(0, 200) : '',
          posted_at: media.timestamp || null,
          view_count: viewCount,
          last_checked_at: new Date().toISOString(),
          eligible_until: eligibleUntil,
          status: alreadyHit ? 'hit' : 'tracking',
          earned: alreadyHit,
        }),
      });
      results.push({ id: media.id, action: 'discovered', views: viewCount, status: alreadyHit ? 'hit' : 'tracking' });
    } else {
      const row = existing[0];
      if (row.status === 'tracking') {
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
        results.push({ id: media.id, action: 'updated', views: viewCount, status });
      } else {
        results.push({ id: media.id, action: 'skipped', status: row.status });
      }
    }
  }
  return { checked: results.length, results };
}

// Instagram has renamed/consolidated its view-count metric a few times across API
// versions ("views" is the current unified one; older versions used "plays" or
// "video_views"). Try each in order and use whichever the account/API version accepts.
async function fetchViews(mediaId, token, debug) {
  const metricsToTry = ['views', 'plays', 'video_views'];
  const errors = [];
  for (const metric of metricsToTry) {
    const res = await fetch(
      `https://graph.instagram.com/${mediaId}/insights?metric=${metric}&access_token=${encodeURIComponent(token)}`
    );
    const data = await res.json();
    const value = data?.data?.[0]?.values?.[0]?.value;
    if (typeof value === 'number') return value;
    if (data.error) errors.push(`${metric}: ${data.error.message}`);
  }
  if (debug) debug.push(errors.join(' | '));
  return null;
}
