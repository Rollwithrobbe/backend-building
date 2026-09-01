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

// See the identical function in scout-instagram.js for the full rationale — duplicated rather
// than shared since each scout job is a standalone serverless function.
async function logScoutRun(SUPABASE_URL, sbHeaders, { startedAt, ok, topError, brandsScanned, brandErrors }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/scout_runs`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        platform: 'youtube', started_at: startedAt, finished_at: new Date().toISOString(),
        ok, top_error: topError || null, brands_scanned: brandsScanned || 0, brand_errors: brandErrors || [],
      }),
    });
  } catch (e) { /* logging the run shouldn't ever fail the run itself */ }
}

export default async function handler(req, res) {
  const startedAt = new Date().toISOString();
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
    // or=(status.neq.paused,status.is.null) — see the identical comment in scout-instagram.js for
    // why not a plain status=eq.active (NULL never satisfies <> in SQL, which would silently drop
    // any brand with no status set instead of defaulting it to tracked).
    const brandsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/brands?select=*&youtube_channel_handle=not.is.null&or=(status.neq.paused,status.is.null)`,
      { headers: sbHeaders }
    );
    const brands = await brandsRes.json();

    if (!Array.isArray(brands) || brands.length === 0) {
      await logScoutRun(SUPABASE_URL, sbHeaders, { startedAt, ok: true, brandsScanned: 0 });
      return res.status(200).json({ message: 'no brands with a youtube_channel_handle set yet' });
    }

    // Self-imposed rate-limit failsafe (added 2026-08-26, matching the one built for
    // scout-instagram.js after that platform tripped a real Meta throttle). YouTube's default
    // quota is 10,000 units/day and nearly every call this job makes costs 1 unit, so a full run
    // across every brand is normally well under 1% of the daily budget — a header-driven guard
    // like Instagram's isn't needed for real headroom. This is a simple, conservative call-count
    // ceiling instead — cheap insurance against a future bug (a runaway pagination loop, an
    // accidental multi-trigger) rather than a response to any actual YouTube throttling seen.
    const callGuard = { count: 0, stop: false, reason: null };
    const perBrand = [];
    for (const brand of brands) {
      if (callGuard.stop) {
        perBrand.push({ brand: brand.name, channel: brand.youtube_channel_handle, skipped: callGuard.reason });
        continue;
      }
      const outcome = await scoutBrandChannel(brand, callGuard, YT_KEY, SUPABASE_URL, sbHeaders);
      perBrand.push({ brand: brand.name, channel: brand.youtube_channel_handle, ...outcome });
    }

    const brandErrors = perBrand.filter(p => p.error).map(p => ({ brand: p.brand, error: p.error }));
    await logScoutRun(SUPABASE_URL, sbHeaders, { startedAt, ok: true, brandsScanned: brands.length, brandErrors });
    return res.status(200).json({ brandsScanned: brands.length, perBrand, apiCallsThisRun: callGuard.count });
  } catch (err) {
    await logScoutRun(SUPABASE_URL, sbHeaders, { startedAt, ok: false, topError: String(err) });
    return res.status(500).json({ error: String(err) });
  }
}

const SAFE_CALL_CEILING = 500; // ~5% of the 10,000/day default quota, in one run — see comment above
function tickCallGuard(guard) {
  guard.count++;
  if (guard.count >= SAFE_CALL_CEILING && !guard.stop) {
    guard.stop = true;
    guard.reason = `Hit the self-imposed ${SAFE_CALL_CEILING}-call ceiling for this run — stopped early as a precaution; whatever's left picks up on the next scheduled run.`;
  }
}

async function scoutBrandChannel(brand, callGuard, YT_KEY, SUPABASE_URL, sbHeaders) {
  const handle = brand.youtube_channel_handle;

  // 1. Resolve the channel handle to its "uploads" playlist
  tickCallGuard(callGuard);
  const chRes = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(handle)}&key=${YT_KEY}`
  );
  const chData = await chRes.json();
  const uploadsPlaylistId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    return { error: 'could not resolve channel uploads playlist', chData };
  }

  // 2. Pull recent uploads, paginating until either the brand's own eligibility window is fully
  // covered or a safety cap is hit — not just a single fixed 50-item page. A single page is fine
  // at low posting volume, but a creator posting near/above roughly (window days × 1.6/day) can
  // push an older still-tracking video off a fixed page before its window naturally closes.
  // flagMissingVideos() can't tell "aged out of the fetch" apart from "actually deleted" — it
  // would falsely mark a real, still-live video 'missing' (excluding it from Pending) well
  // before it had its fair shot at hitting. Confirmed this is already close to biting on a real
  // account (2026-08-25): 47 uploads in the last 30 days against a single 50-item page.
  const cutoff = Date.now() - Math.max(Number(brand.eligibility_window_days) || 30, 30) * 86400000;
  let videoIds = [];
  let pageToken = '';
  // Raised from 5 to 10 pages (2026-08-26) — see scout-instagram.js's identical comment for the
  // full reasoning.
  for (let page = 0; page < 10 && !callGuard.stop; page++) {
    tickCallGuard(callGuard);
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=50&key=${YT_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const plRes = await fetch(url);
    const plData = await plRes.json();
    const items = plData.items || [];
    videoIds.push(...items.map((i) => i.snippet?.resourceId?.videoId).filter(Boolean));
    const oldestOnPage = items[items.length - 1]?.snippet?.publishedAt;
    pageToken = plData.nextPageToken;
    if (!pageToken) break; // no more uploads at all
    if (oldestOnPage && new Date(oldestOnPage).getTime() < cutoff) break; // window fully covered
  }
  if (videoIds.length === 0) {
    return { checked: 0, results: [] };
  }

  // 3. Get current view counts in batched calls (the videos endpoint's id param caps at 50 ids)
  const statsItems = [];
  for (let i = 0; i < videoIds.length && !callGuard.stop; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    tickCallGuard(callGuard);
    const statsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${chunk.join(',')}&key=${YT_KEY}`
    );
    const chunkData = await statsRes.json();
    statsItems.push(...(chunkData.items || []));
  }
  const statsData = { items: statsItems };

  // Each video needs 1-2 Supabase round trips, all independent of every other video — no
  // reason to do them one at a time. See scout-instagram.js's mapConcurrent comment for the
  // full rationale (measured there: 49 items sequentially took 47s; a brand with a full page
  // per platform × several brands in one cron run risks the function's own execution timeout).
  const results = await mapConcurrent(statsData.items || [], 8, (v) => processOneVideo(v, brand, SUPABASE_URL, sbHeaders));

  // Skipped if the call guard tripped mid-fetch (rare given the generous ceiling, but the video
  // pagination loop above may not have run to completion) — seenIds would only be a partial
  // picture, and comparing "still tracking" against a partial fetch would falsely flag real,
  // still-live videos this run simply never got to as 'missing'.
  if (callGuard.stop) {
    return { checked: results.length, results, flaggedMissing: null, skippedMissingCheck: true };
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

// Everything one video needs, start to finish — either inserts it (first time seen) or patches
// its existing row. Pulled out of the loop above so it can run concurrently across videos
// instead of one at a time (see mapConcurrent below it).
// Tiered check frequency (added 2026-08-26, for tracking windows that now go up to 180 days) —
// see the identical function in scout-instagram.js for the full rationale. Duplicated here
// rather than shared since each scout job is a standalone serverless function, same pattern as
// mapConcurrent/flagMissingVideos already being duplicated across all three.
function isDueForCheck(daysSincePosted){
  if (daysSincePosted <= 30) return true;
  if (daysSincePosted <= 90) return Math.floor(daysSincePosted - 30) % 7 === 0;
  return Math.floor(daysSincePosted - 90) % 30 === 0;
}

async function processOneVideo(v, brand, SUPABASE_URL, sbHeaders) {
  const viewCount = parseInt(v.statistics?.viewCount || '0', 10);
  // Already in the same statistics response the view count comes from — no extra API call, no
  // extra quota. likeCount/commentCount come back as strings same as viewCount; either can be
  // absent (creator hid likes, or comments are disabled), so null rather than a false zero in
  // that case. YouTube's Data API has no share-count field at all — shares stays null here always,
  // that's a real platform gap, not a bug.
  const likeCount = v.statistics?.likeCount != null ? parseInt(v.statistics.likeCount, 10) : null;
  const commentCount = v.statistics?.commentCount != null ? parseInt(v.statistics.commentCount, 10) : null;
  if (v.snippet?.publishedAt) {
    const daysSincePosted = (Date.now() - new Date(v.snippet.publishedAt).getTime()) / 86400000;
    if (!isDueForCheck(daysSincePosted)) {
      return { id: v.id, action: 'skipped (not due yet)', daysSincePosted: Math.floor(daysSincePosted) };
    }
  }

  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tracked_videos?platform=eq.youtube&external_video_id=eq.${v.id}&select=*`,
    { headers: sbHeaders }
  );
  const existing = await existingRes.json();

  if (existing.length === 0) {
    // Anchor the window to when the video was actually POSTED, not to whenever this scout run
    // happens to discover it — see scout-instagram.js's identical comment for the full rationale.
    const anchor = v.snippet?.publishedAt ? new Date(v.snippet.publishedAt).getTime() : Date.now();
    const eligibleUntil = new Date(anchor + brand.eligibility_window_days * 86400000).toISOString();
    const alreadyHit = viewCount >= brand.view_requirement;
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        brand_id: brand.id,
        platform: 'youtube',
        external_video_id: v.id,
        url: `https://youtube.com/watch?v=${v.id}`,
        title: v.snippet?.title || '',
        posted_at: v.snippet?.publishedAt || null,
        view_count: viewCount,
        likes: likeCount,
        comments: commentCount,
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
    // Same idea as pay_amount above, but for the richer CPM/milestone shapes — see
    // scout-tiktok.js's identical comment for the full rationale. Separate, best-effort PATCH:
    // locked_payout_model is a newer column, and the video actually getting tracked matters far
    // more than this one field, so a missing column just no-ops here instead of failing the insert.
    if (brand.payout_model) {
      try {
        const [insertedRow] = await insertRes.json();
        if (insertedRow?.id) {
          await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos?id=eq.${insertedRow.id}`, {
            method: 'PATCH',
            headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ locked_payout_model: brand.payout_model }),
          });
        }
      } catch (e) { /* best-effort — see comment above */ }
    }
    return { id: v.id, action: 'discovered', views: viewCount, status: alreadyHit ? 'hit' : 'tracking' };
  }

  const row = existing[0];
  if (row.excluded) {
    return { id: v.id, action: 'skipped', status: 'excluded' };
  }
  // EXPERIMENTAL (added 2026-08-25, 2-week trial) — see scout-instagram.js's logViewSnapshot
  // for the full rationale and the exact removal steps (identical here).
  logViewSnapshot(row.id, brand.id, 'youtube', viewCount, SUPABASE_URL, sbHeaders);
  if (row.status === 'tracking') {
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
      // thumbnail_url included here too (not just at discovery) — the stats call already
      // returns snippet.thumbnails on every single fetch regardless of status, so every video's
      // thumbnail backfills itself the next time it's touched by a scouting run instead of
      // staying permanently blank just because it existed before thumbnail capture was added.
      body: JSON.stringify({
        view_count: viewCount, likes: likeCount, comments: commentCount,
        last_checked_at: new Date().toISOString(), status, earned, thumbnail_url: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || null,
        // Set only on the exact PATCH where status actually flips to 'hit' — see scout-tiktok.js
        // for the full rationale (identical here).
        ...(status === 'hit' ? { hit_at: new Date().toISOString() } : {}),
      }),
    });
    return { id: v.id, action: 'updated', views: viewCount, status };
  }

  // status is 'hit' or 'expired' — the payout outcome is already locked in, but the view
  // count (and now likes/comments) are still real information worth keeping current. Only
  // status/earned/pay_amount stay locked.
  await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      view_count: viewCount, likes: likeCount, comments: commentCount,
      last_checked_at: new Date().toISOString(), thumbnail_url: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || null,
    }),
  });
  return { id: v.id, action: 'updated (views only)', views: viewCount, status: row.status };
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
// its call site above, the matching pieces in scout-instagram.js/scout-tiktok.js, drop the
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
