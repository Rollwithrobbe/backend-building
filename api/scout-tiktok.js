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

    // Self-imposed rate-limit failsafe (added 2026-08-26, matching the one built for
    // scout-instagram.js after that platform tripped a real Meta throttle). TikTok's documented
    // limit is generous relative to how little this job actually calls it (600 requests/minute
    // per endpoint — a full run across every brand is normally a few dozen calls, total), so a
    // header-driven guard like Instagram's isn't needed for real headroom. This is a simple,
    // conservative call-count ceiling instead — cheap insurance against a future bug (a runaway
    // pagination loop, an accidental multi-trigger) rather than a response to any actual TikTok
    // throttling seen so far. Shared across every brand in this run, same reasoning as Instagram's.
    const callGuard = { count: 0, stop: false, reason: null };
    const perBrand = [];
    for (const brand of brands) {
      if (callGuard.stop) {
        perBrand.push({ brand: brand.name, tiktok: brand.tiktok_username, skipped: callGuard.reason });
        continue;
      }
      const outcome = await scoutBrandAccount(brand, callGuard, CLIENT_KEY, CLIENT_SECRET, SUPABASE_URL, sbHeaders);
      perBrand.push({ brand: brand.name, tiktok: brand.tiktok_username, ...outcome });
    }

    return res.status(200).json({ brandsScanned: brands.length, perBrand, apiCallsThisRun: callGuard.count });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

const SAFE_CALL_CEILING = 200; // well under TikTok's documented 600/min — see the comment above
function tickCallGuard(guard) {
  guard.count++;
  if (guard.count >= SAFE_CALL_CEILING && !guard.stop) {
    guard.stop = true;
    guard.reason = `Hit the self-imposed ${SAFE_CALL_CEILING}-call ceiling for this run — stopped early as a precaution; whatever's left picks up on the next scheduled run.`;
  }
}

async function scoutBrandAccount(brand, callGuard, CLIENT_KEY, CLIENT_SECRET, SUPABASE_URL, sbHeaders) {
  let token = brand.tiktok_access_token;
  if (!token) {
    return { error: 'no tiktok_access_token stored for this brand — reconnect TikTok' };
  }

  // Refresh the access token if it's expired or about to be (within 1 hour) —
  // TikTok access tokens only last ~24h, refresh tokens last much longer.
  const expiresAt = brand.tiktok_token_expires_at ? new Date(brand.tiktok_token_expires_at).getTime() : 0;
  if (Date.now() > expiresAt - 60 * 60 * 1000) {
    tickCallGuard(callGuard);
    const refreshed = await refreshToken(brand, CLIENT_KEY, CLIENT_SECRET, SUPABASE_URL, sbHeaders);
    if (refreshed.error) return refreshed;
    token = refreshed.access_token;
  }

  // Pull recent videos, paginating until either the brand's own eligibility window is fully
  // covered or a safety cap is hit — not just a fixed page count. A fixed cap is fine at low
  // posting volume, but a creator posting near/above roughly (window days × 1.6/day) can push an
  // older still-tracking video off the fetched pages before its window naturally closes.
  // flagMissingVideos() can't tell "aged out of the fetch" apart from "actually deleted" — it
  // would falsely mark a real, still-live video 'missing' (excluding it from Pending) well before
  // it had its fair shot at hitting. Confirmed this is already close to biting on a real account
  // (2026-08-25): 47 videos in the last 30 days against a 3-page/60-video cap.
  const cutoff = Date.now() - Math.max(Number(brand.eligibility_window_days) || 30, 30) * 86400000;
  const videos = [];
  let cursor = null;
  // Raised from 5 to 10 pages (2026-08-26) — see scout-instagram.js's identical comment for the
  // full reasoning.
  for (let page = 0; page < 10 && !callGuard.stop; page++) {
    const body = { max_count: 20 };
    if (cursor) body.cursor = cursor;
    tickCallGuard(callGuard);
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
      if (page === 0) return { error: `TikTok API error: ${listData.error.message || listData.error.code}` };
      break; // already have earlier pages' data — don't discard it over a later-page error
    }
    const pageVideos = listData?.data?.videos || [];
    videos.push(...pageVideos);
    const oldestOnPage = pageVideos[pageVideos.length - 1]?.create_time;
    if (!listData?.data?.has_more) break; // no more videos at all
    if (oldestOnPage && oldestOnPage * 1000 < cutoff) break; // window fully covered
    cursor = listData.data.cursor;
  }

  if (videos.length === 0) {
    return { checked: 0, results: [] };
  }

  // Each video needs 1-2 Supabase round trips, all independent of every other video — no
  // reason to do them one at a time. See scout-instagram.js's mapConcurrent comment for the
  // full rationale (measured there: 49 items sequentially took 47s; a brand with a full page
  // per platform × several brands in one cron run risks the function's own execution timeout).
  const results = await mapConcurrent(videos, 8, (video) => processOneVideo(video, brand, SUPABASE_URL, sbHeaders));

  // Anything Supabase still has as 'tracking' for this brand+platform that didn't show up in
  // this fetch has vanished from TikTok (deleted, or set private) before ever hitting its
  // requirement — flag it distinctly instead of freezing it silently forever pretending it
  // might still resolve. Self-heals: if it reappears in a later fetch, the normal update path
  // above finds the existing row and overwrites this status.
  //
  // Skipped if the call guard tripped mid-fetch — seenIds would only be a partial picture, and
  // comparing "still tracking" against a partial fetch would falsely flag real, still-live
  // videos this run simply never got to as 'missing'.
  let missingCount = null;
  if (!callGuard.stop) {
    const seenIds = new Set(videos.map((v) => v.id));
    missingCount = await flagMissingVideos(brand, 'tiktok', seenIds, SUPABASE_URL, sbHeaders);
  }

  return { checked: results.length, results, flaggedMissing: missingCount };
}

// Everything one video needs, start to finish — either inserts it (first time seen) or patches
// its existing row. Pulled out of scoutBrandAccount's loop so it can run concurrently across
// videos instead of one at a time (see mapConcurrent below it).
// Tiered check frequency (added 2026-08-26, for tracking windows that now go up to 180 days) —
// see the identical function in scout-instagram.js for the full rationale. Duplicated here
// rather than shared since each scout job is a standalone serverless function, same pattern as
// mapConcurrent/flagMissingVideos already being duplicated across all three.
function isDueForCheck(daysSincePosted){
  if (daysSincePosted <= 30) return true;
  if (daysSincePosted <= 90) return Math.floor(daysSincePosted - 30) % 7 === 0;
  return Math.floor(daysSincePosted - 90) % 30 === 0;
}

async function processOneVideo(video, brand, SUPABASE_URL, sbHeaders) {
  const viewCount = video.view_count;
  if (typeof viewCount !== 'number') {
    return { id: video.id, action: 'skipped', reason: 'no view count returned' };
  }
  if (video.create_time) {
    const daysSincePosted = (Date.now() - video.create_time * 1000) / 86400000;
    if (!isDueForCheck(daysSincePosted)) {
      return { id: video.id, action: 'skipped (not due yet)', daysSincePosted: Math.floor(daysSincePosted) };
    }
  }

  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tracked_videos?platform=eq.tiktok&external_video_id=eq.${video.id}&select=*`,
    { headers: sbHeaders }
  );
  const existing = await existingRes.json();

  if (existing.length === 0) {
    // Anchor the window to when the video was actually POSTED, not to whenever this scout run
    // happens to discover it — see scout-instagram.js's identical comment for the full rationale.
    const anchor = video.create_time ? video.create_time * 1000 : Date.now();
    const eligibleUntil = new Date(anchor + brand.eligibility_window_days * 86400000).toISOString();
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
    return { id: video.id, action: 'discovered', views: viewCount, status: alreadyHit ? 'hit' : 'tracking' };
  }

  const row = existing[0];
  if (row.excluded) {
    return { id: video.id, action: 'skipped', status: 'excluded' };
  }
  // EXPERIMENTAL (added 2026-08-25, 2-week trial) — see scout-instagram.js's logViewSnapshot
  // for the full rationale and the exact removal steps (identical here).
  logViewSnapshot(row.id, brand.id, 'tiktok', viewCount, SUPABASE_URL, sbHeaders);
  if (row.status === 'tracking') {
    let status = 'tracking';
    let earned = false;
    // per-video override (set from the "Edit tracked video" modal) wins over the brand's
    // live requirement — see scout-youtube.js for the full rationale, identical here.
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
      // thumbnail_url included here too (not just at discovery) — TikTok's video list already
      // returns cover_image_url on every single fetch regardless of status, so every video's
      // thumbnail backfills itself the next time it's touched by a scouting run instead of
      // staying permanently blank just because it existed before thumbnail capture was added.
      body: JSON.stringify({ view_count: viewCount, last_checked_at: new Date().toISOString(), status, earned, thumbnail_url: video.cover_image_url || null }),
    });
    return { id: video.id, action: 'updated', views: viewCount, status };
  }

  // status is 'hit' or 'expired' — the payout outcome is already locked in, but the view
  // count is still real information worth keeping current. Only status/earned/pay_amount
  // stay locked.
  await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ view_count: viewCount, last_checked_at: new Date().toISOString(), thumbnail_url: video.cover_image_url || null }),
  });
  return { id: video.id, action: 'updated (views only)', views: viewCount, status: row.status };
}

// Runs fn(item) across items with at most `limit` in flight at once, preserving result order.
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// EXPERIMENTAL (added 2026-08-25, 2-week trial) — one row per video per day it's checked, for
// the brand breakdown modal's trend sparkline. Not awaited by its caller and swallows its own
// errors — a nice-to-have for a chart, never something that should slow down or fail the actual
// tracking/payout logic it sits next to. To remove this feature entirely: delete this function,
// its call site above, the matching pieces in scout-instagram.js/scout-youtube.js, drop the
// view_snapshots table, and remove loadViewSnapshots()/VIEW_SNAPSHOTS_DATA/brandPlatformTrend()/
// the sparkline markup in index.html. Nothing else depends on any of it.
function logViewSnapshot(trackedVideoId, brandId, platform, viewCount, SUPABASE_URL, sbHeaders) {
  fetch(`${SUPABASE_URL}/rest/v1/view_snapshots`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ tracked_video_id: trackedVideoId, brand_id: brandId, platform, view_count: viewCount }),
  }).catch(() => {});
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
