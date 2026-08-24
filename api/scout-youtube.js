// Scouting job: checks the YouTube channel for new uploads, tracks their view counts,
// and automatically marks a tracked video "hit" (earned) once it crosses its brand's
// view requirement, or "expired" once its eligibility window passes unmet.
//
// Runs on a schedule (see vercel.json) — Vercel Hobby plan allows once/day for cron;
// more frequent checks need either Vercel Pro or an external trigger (e.g. a free
// GitHub Actions scheduled workflow hitting this same URL). Fine to start with daily.
//
// Required env vars (set in Vercel project settings, never committed to git):
//   YOUTUBE_API_KEY   - from Google Cloud Console
//   SUPABASE_URL      - Project URL from Supabase settings
//   SUPABASE_KEY      - the publishable/anon key (safe to expose, but env var anyway for easy rotation)
// Optional:
//   CRON_SECRET       - if set, only requests carrying it (Vercel's own cron invocations do this
//                       automatically) are allowed to run this — stops randoms from spamming it.

const CHANNEL_HANDLE = 'Robbedoesfintech'; // not sensitive, hardcoded rather than another env var to set up

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

  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };

  try {
    // 1. Resolve the channel handle to its "uploads" playlist
    const chRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(CHANNEL_HANDLE)}&key=${YT_KEY}`
    );
    const chData = await chRes.json();
    const uploadsPlaylistId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      return res.status(500).json({ error: 'could not resolve channel uploads playlist', chData });
    }

    // 2. Pull the most recent uploads (15 is plenty for a channel posting daily)
    const plRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=15&key=${YT_KEY}`
    );
    const plData = await plRes.json();
    const videoIds = (plData.items || []).map((i) => i.snippet?.resourceId?.videoId).filter(Boolean);
    if (videoIds.length === 0) {
      return res.status(200).json({ message: 'no videos found on channel' });
    }

    // 3. Get current view counts for those videos in one batched call
    const statsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoIds.join(',')}&key=${YT_KEY}`
    );
    const statsData = await statsRes.json();

    // 4. Temporary: auto-assign newly discovered videos to the first brand in the table.
    // Replace this with real brand-picker UI once the core loop is proven.
    const brandRes = await fetch(`${SUPABASE_URL}/rest/v1/brands?select=*&limit=1`, { headers: sbHeaders });
    const brands = await brandRes.json();
    const defaultBrand = brands[0];

    const results = [];
    for (const v of statsData.items || []) {
      const viewCount = parseInt(v.statistics?.viewCount || '0', 10);

      const existingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/tracked_videos?platform=eq.youtube&external_video_id=eq.${v.id}&select=*`,
        { headers: sbHeaders }
      );
      const existing = await existingRes.json();

      if (existing.length === 0) {
        const eligibleUntil = defaultBrand
          ? new Date(Date.now() + defaultBrand.eligibility_window_days * 86400000).toISOString()
          : null;
        // check the threshold immediately on discovery too — a video can already have enough
        // views the very first time it's seen (e.g. discovered a few days after posting), and
        // that shouldn't have to wait for a second run to be caught.
        const alreadyHit = !!(defaultBrand && viewCount >= defaultBrand.view_requirement);
        await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos`, {
          method: 'POST',
          headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({
            brand_id: defaultBrand?.id || null,
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
          }),
        });
        results.push({ id: v.id, action: 'discovered', views: viewCount, status: alreadyHit ? 'hit' : 'tracking' });
      } else {
        const row = existing[0];
        if (row.status === 'tracking') {
          let status = 'tracking';
          let earned = false;
          if (defaultBrand && viewCount >= defaultBrand.view_requirement) {
            status = 'hit';
            earned = true;
          } else if (row.eligible_until && new Date() > new Date(row.eligible_until)) {
            status = 'expired';
          }
          await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos?id=eq.${row.id}`, {
            method: 'PATCH',
            headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
              view_count: viewCount,
              last_checked_at: new Date().toISOString(),
              status,
              earned,
            }),
          });
          results.push({ id: v.id, action: 'updated', views: viewCount, status });
        } else {
          results.push({ id: v.id, action: 'skipped', status: row.status });
        }
      }
    }

    return res.status(200).json({ checked: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
