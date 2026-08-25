// Scouting job: for every brand that has a YouTube channel connected, checks that channel
// for new uploads, tracks their view counts, and automatically marks a tracked video "hit"
// (earned) once it crosses THAT brand's own view requirement, or "expired" once its own
// eligibility window passes unmet. Each video is tied to the brand whose channel it was
// actually discovered on — correct by construction, no guessing/default-brand fallback.
//
// Runs on a schedule (see vercel.json) — Vercel Hobby plan allows once/day for cron;
// more frequent checks need either Vercel Pro or an external trigger (e.g. a free
// GitHub Actions scheduled workflow hitting this same URL). Fine to start with daily.
//
// Required env vars (set in Vercel project settings, never committed to git):
//   YOUTUBE_API_KEY   - from Google Cloud Console
//   SUPABASE_URL      - Project URL from Supabase settings
//   SUPABASE_KEY      - the publishable/anon key
// Optional:
//   CRON_SECRET       - if set, only requests carrying it (Vercel's own cron invocations do this
//                       automatically) are allowed to run this — stops randoms from spamming it.

export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const YT_KEY = process.env.YOUTUBE_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!YT_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'missing required environment variables (YOUTUBE_API_KEY / SUPABASE_URL / SUPABASE_KEY)' });
  }

  const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    // Every brand that has a YouTube channel connected gets scouted independently.
    const brandsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/brands?select=*&youtube_channel_handle=not.is.null`,
      { headers: sbHeaders }
    );
    const brands = await brandsRes.json();

    if (!Array.isArray(brands) || brands.length === 0) {
      return res.status(200).json({ message: 'no brands with a youtube_channel_handle set yet' });
    }

    const perBrand = [];
    for (const brand of brands) {
      const outcome = await scoutBrandChannel(brand, YT_KEY, SUPABASE_URL, sbHeaders);
      perBrand.push({ brand: brand.name, channel: brand.youtube_channel_handle, ...outcome });
    }

    return res.status(200).json({ brandsScanned: brands.length, perBrand });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

async function scoutBrandChannel(brand, YT_KEY, SUPABASE_URL, sbHeaders) {
  const handle = brand.youtube_channel_handle;

  // 1. Resolve the channel handle to its "uploads" playlist
  const chRes = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(handle)}&key=${YT_KEY}`
  );
  const chData = await chRes.json();
  const uploadsPlaylistId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    return { error: 'could not resolve channel uploads playlist', chData };
  }

  // 2. Pull recent uploads (50 is YouTube's per-request max without pagination)
  const plRes = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=50&key=${YT_KEY}`
  );
  const plData = await plRes.json();
  const videoIds = (plData.items || []).map((i) => i.snippet?.resourceId?.videoId).filter(Boolean);
  if (videoIds.length === 0) {
    return { checked: 0, results: [] };
  }

  // 3. Get current view counts for those videos in one batched call
  const statsRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoIds.join(',')}&key=${YT_KEY}`
  );
  const statsData = await statsRes.json();

  const results = [];
  for (const v of statsData.items || []) {
    const viewCount = parseInt(v.statistics?.viewCount || '0', 10);

    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tracked_videos?platform=eq.youtube&external_video_id=eq.${v.id}&select=*`,
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
          platform: 'youtube',
          external_video_id: v.id,
          url: `https://youtube.com/watch?v=${v.id}`,
          title: v.snippet?.title || '',
          posted_at: v.snippet?.publishedAt || null,
          view_count: viewCount,
          last_checked_at: new Date().toISOString(),
          eligible_until: eligibleUntil,
          status: alreadyHit ? 'hit' : 'tracking',
          earned: alreadyHit,
          // snapshot the brand's current rate at discovery time — if the brand's deal changes
          // later (e.g. a warm-up brief ending), only newly-discovered videos pick up the new
          // rate; this one keeps what applied when it was found. Editable per-video afterward.
          pay_amount: brand.base_pay,
          thumbnail_url: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || null,
        }),
      });
      results.push({ id: v.id, action: 'discovered', views: viewCount, status: alreadyHit ? 'hit' : 'tracking' });
    } else {
      const row = existing[0];
      if (row.excluded) {
        results.push({ id: v.id, action: 'skipped', status: 'excluded' });
      } else if (row.status === 'tracking') {
        let status = 'tracking';
        let earned = false;
        // per-video override (set from the "Edit tracked video" modal) wins over the brand's
        // live requirement — lets one video be pinned to its own threshold (a different deal,
        // or the brand's requirement changed after this was posted) without that video getting
        // dragged along every time the brand-level setting changes, which is the default/normal
        // behavior for every other row.
        const requirement = row.view_requirement_override != null ? row.view_requirement_override : brand.view_requirement;
        if (viewCount >= requirement) {
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
        results.push({ id: v.id, action: 'updated', views: viewCount, status });
      } else {
        // status is 'hit' or 'expired' — the payout outcome is already locked in, but the view
        // count is still real information worth keeping current (see scout-instagram.js for the
        // full rationale — previously this froze view_count forever at whatever it happened to
        // be the instant it crossed the requirement). Only status/earned/pay_amount stay locked.
        await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ view_count: viewCount, last_checked_at: new Date().toISOString() }),
        });
        results.push({ id: v.id, action: 'updated (views only)', views: viewCount, status: row.status });
      }
    }
  }

  // Anything Supabase still has as 'tracking' for this brand+platform that didn't show up in
  // this fetch has vanished from YouTube (deleted, or set private/unlisted so it stops
  // qualifying) before ever hitting its requirement — flag it distinctly instead of freezing it
  // silently forever pretending it might still resolve. Self-heals: if it reappears in a later
  // fetch, the normal update path above finds the existing row and overwrites this status.
  const seenIds = new Set((statsData.items || []).map((v) => v.id));
  const missingCount = await flagMissingVideos(brand, 'youtube', seenIds, SUPABASE_URL, sbHeaders);

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
