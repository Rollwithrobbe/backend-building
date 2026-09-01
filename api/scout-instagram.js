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

// Writes one row to scout_runs at the end of every run — success, per-brand error, or full
// crash — so the dashboard's alerts bell can tell "ran fine" apart from "silently never ran"
// apart from "ran but got rejected", instead of only inferring health indirectly from whether
// tracked_videos.last_checked_at moved (which a fully-blocked run wouldn't move at all). Never
// lets a logging failure fail the actual scouting run — this is purely observability.
async function logScoutRun(SUPABASE_URL, sbHeaders, { startedAt, ok, topError, brandsScanned, brandErrors }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/scout_runs`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        platform: 'instagram', started_at: startedAt, finished_at: new Date().toISOString(),
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

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'missing required environment variables (SUPABASE_URL / SUPABASE_KEY)' });
  }

  const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    // or=(status.neq.paused,status.is.null) rather than a plain status=eq.active — in SQL, a NULL
    // never satisfies <>, so a plain neq.paused would silently exclude any brand with no status
    // set at all (a legacy row, or one written by something other than the dashboard's own edit
    // flow) instead of defaulting it to tracked. This treats "no status" as active, same as the
    // dashboard itself does everywhere else (`status || 'active'`); only an *explicit* "paused"
    // (set via the Brands tab's inactive toggle, e.g. contract ended) actually stops tracking.
    const brandsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/brands?select=*&instagram_business_account_id=not.is.null&or=(status.neq.paused,status.is.null)`,
      { headers: sbHeaders }
    );
    const brands = await brandsRes.json();

    if (!Array.isArray(brands) || brands.length === 0) {
      await logScoutRun(SUPABASE_URL, sbHeaders, { startedAt, ok: true, brandsScanned: 0 });
      return res.status(200).json({ message: 'no brands with an Instagram account connected yet' });
    }

    // One guard shared across every brand in this run — X-App-Usage reflects the whole app's
    // usage, not any one brand's account, so a threshold crossed scouting brand 1 applies just
    // as much to brand 2. See makeUsageGuard()/igFetch() for how this actually works.
    const guard = makeUsageGuard();
    const perBrand = [];
    for (const brand of brands) {
      if (guard.stop) {
        perBrand.push({ brand: brand.name, instagram: brand.instagram_username, skipped: guard.reason });
        continue;
      }
      const outcome = await scoutBrandAccount(brand, guard, SUPABASE_URL, sbHeaders);
      perBrand.push({ brand: brand.name, instagram: brand.instagram_username, ...outcome });
    }

    const brandErrors = perBrand.filter(p => p.error).map(p => ({ brand: p.brand, error: p.error }));
    await logScoutRun(SUPABASE_URL, sbHeaders, { startedAt, ok: true, brandsScanned: brands.length, brandErrors });
    return res.status(200).json({ brandsScanned: brands.length, perBrand, usage: { peakPct: guard.pct, stoppedEarly: guard.stop } });
  } catch (err) {
    await logScoutRun(SUPABASE_URL, sbHeaders, { startedAt, ok: false, topError: String(err) });
    return res.status(500).json({ error: String(err) });
  }
}

// Self-imposed rate-limit failsafe (added 2026-08-26, after a burst of manual testing tripped a
// real Meta "API access blocked" penalty). Meta returns real-time usage in the X-App-Usage
// response header on every Graph API call — {call_count, total_time, total_cputime}, each a
// percentage of the rolling-hour budget. Reading that directly, instead of hardcoding a guessed
// number, is deliberate: Meta's actual limit is a formula based on account impressions (not a
// flat "200/hour"), so a static constant would either be wrong or need constant upkeep. This
// stops ALL further Instagram calls in this run — cron-triggered or manually curled — the moment
// any dimension crosses SAFE_USAGE_PCT, leaving real headroom instead of riding the limit to the
// edge. Whatever didn't get checked this run picks up on the next scheduled run.
const SAFE_USAGE_PCT = 75;
function makeUsageGuard() {
  return { stop: false, pct: 0, reason: null };
}
async function igFetch(url, guard) {
  const res = await fetch(url);
  const usageHeader = res.headers.get('x-app-usage');
  if (usageHeader) {
    try {
      const usage = JSON.parse(usageHeader);
      const pct = Math.max(Number(usage.call_count) || 0, Number(usage.total_time) || 0, Number(usage.total_cputime) || 0);
      if (pct > guard.pct) guard.pct = pct;
      if (pct >= SAFE_USAGE_PCT && !guard.stop) {
        guard.stop = true;
        guard.reason = `Instagram usage hit ${pct}% of its hourly budget — stopped early to stay well under the limit; whatever's left picks up on the next scheduled run.`;
      }
    } catch (e) { /* header present but unparsable — ignore, not worth failing the run over */ }
  }
  return res;
}

async function scoutBrandAccount(brand, guard, SUPABASE_URL, sbHeaders) {
  const igId = brand.instagram_business_account_id;
  const token = brand.instagram_access_token;
  if (!token) {
    return { error: 'no instagram_access_token stored for this brand — reconnect Instagram' };
  }

  // 1. Pull recent media, paginating until either the brand's own eligibility window is fully
  // covered or a safety cap is hit — not just a single fixed 50-item page. A single page is fine
  // at low posting volume, but a creator posting near/above roughly (window days × 1.6/day) can
  // push an older still-tracking reel off a fixed page before its window naturally closes.
  // flagMissingVideos() can't tell "aged out of the fetch" apart from "actually deleted" — it
  // would falsely mark a real, still-live reel 'missing' (excluding it from Pending) well before
  // it had its fair shot at hitting. Confirmed this is already close to biting on a real account
  // (2026-08-25): 47 reels in the last 30 days against a single 50-item page.
  // "me" is used instead of the numeric account id — with an Instagram Login user token,
  // the token is already scoped to exactly one account, and "me" is the endpoint form
  // that actually resolves for it (the raw numeric id form returns a "does not exist" error).
  const cutoff = Date.now() - Math.max(Number(brand.eligibility_window_days) || 30, 30) * 86400000;
  let mediaItems = [];
  let nextUrl =
    `https://graph.instagram.com/me/media` +
    `?fields=id,caption,timestamp,permalink,media_type,media_product_type,thumbnail_url,media_url` +
    `&limit=50&access_token=${encodeURIComponent(token)}`;
  // Raised from 5 to 10 pages (2026-08-26, alongside tracking windows extending up to 180 days)
  // — the tiered check frequency reduces how often an OLD video gets re-checked, but this loop
  // is just building the candidate list, so it still needs to see far enough back to know that
  // old video exists at all. 10 pages × 50 covers 500 media at any posting pace; a single brand
  // sustaining far beyond ~2-3/day for the full 180 days would still eventually outrun this and
  // need a bigger change (e.g. paginating across multiple runs) — not a real concern at today's
  // actual pace, worth revisiting if that changes.
  for (let page = 0; page < 10 && nextUrl && !guard.stop; page++) {
    const mediaRes = await igFetch(nextUrl, guard);
    const mediaData = await mediaRes.json();
    if (mediaData.error) {
      if (page === 0) return { error: `Instagram API error: ${mediaData.error.message}` };
      break; // already have earlier pages' data — don't discard it over a later-page error
    }
    const items = mediaData.data || [];
    mediaItems.push(...items);
    const oldestOnPage = items[items.length - 1]?.timestamp;
    nextUrl = mediaData.paging?.next || null;
    if (oldestOnPage && new Date(oldestOnPage).getTime() < cutoff) break; // window fully covered
  }
  const reels = mediaItems.filter(
    (m) => m.media_product_type === 'REELS' || m.media_type === 'VIDEO'
  );
  if (reels.length === 0) {
    return { checked: 0, results: [] };
  }

  // Each media item needs 2-3 Instagram Graph calls (views + facebook_views probe) plus 1-2
  // Supabase round trips — all independent of every other media item, so there's no reason to
  // do them one at a time. Sequentially, 49 reels measured at 47s end-to-end (2026-08-25) — at
  // 6 brands that's ~4.7 minutes in one function invocation, well past any sane serverless
  // timeout. mapConcurrent runs a bounded pool instead (8 in flight at once here), which cut the
  // same 49-reel run to a few seconds. 8 is conservative against Meta's per-token rate limiting,
  // not tuned for max throughput.
  const results = await mapConcurrent(reels, 8, (media) => processOneMedia(media, brand, guard, token, SUPABASE_URL, sbHeaders));

  // Anything Supabase still has as 'tracking' for this brand+platform that didn't show up in
  // this fetch has vanished from Instagram (deleted, or archived — archived posts drop out of
  // the standard media list) before ever hitting its requirement — flag it distinctly instead
  // of freezing it silently forever pretending it might still resolve. Self-heals: if it
  // reappears in a later fetch (e.g. unarchived), the normal update path above finds the
  // existing row and overwrites this status.
  //
  // Skipped entirely if the usage guard tripped mid-sweep: seenIds would only be a partial
  // picture at that point, and comparing "still tracking" against a partial fetch would falsely
  // flag real, still-live videos this run simply never got to as 'missing'.
  let missingCount = null;
  if (!guard.stop) {
    const seenIds = new Set(reels.map((m) => m.id));
    missingCount = await flagMissingVideos(brand, 'instagram', seenIds, SUPABASE_URL, sbHeaders);
  }

  return { checked: results.length, results, flaggedMissing: missingCount, usagePeakPct: guard.pct, stoppedEarly: guard.stop };
}

// Tiered check frequency (added 2026-08-26, for tracking windows that now go up to 180 days) —
// daily for the first 30 days, weekly from day 31-90, monthly from day 91 onward. Anchored to
// each tier's own start (day 30, day 90) rather than day 0, so a video's very first day in a new
// tier is always itself a check — nothing waits a full cycle before its first reduced-frequency
// check. Purely a function of how old the video is vs now, no stored state needed — videos
// posted on different days naturally land their weekly/monthly checks on different calendar
// days without any random/hash bookkeeping to make that happen. A window shorter than a tier
// boundary (e.g. eligibility_window_days=30) never actually reaches the reduced tiers in
// practice, since the video ages out of the fetch entirely at 30 days regardless.
function isDueForCheck(daysSincePosted){
  if (daysSincePosted <= 30) return true;
  if (daysSincePosted <= 90) return Math.floor(daysSincePosted - 30) % 7 === 0;
  return Math.floor(daysSincePosted - 90) % 30 === 0;
}

// Everything one reel needs, start to finish — reads its view count, then either inserts it
// (first time seen) or patches its existing row. Pulled out of scoutBrandAccount's loop so it
// can be run concurrently across reels instead of one at a time (see mapConcurrent above it).
async function processOneMedia(media, brand, guard, token, SUPABASE_URL, sbHeaders) {
  if (guard.stop) {
    return { id: media.id, action: 'skipped', reason: 'rate guard tripped — see run-level usagePeakPct/stoppedEarly' };
  }
  if (media.timestamp) {
    const daysSincePosted = (Date.now() - new Date(media.timestamp).getTime()) / 86400000;
    if (!isDueForCheck(daysSincePosted)) {
      // not due yet under the tiered schedule — skip before even touching Supabase or Meta's
      // API for this one. Still counted in the caller's seenIds (built from the raw fetched
      // list, not from these results), so flagMissingVideos() never mistakes "not due" for
      // "vanished" — this is a real skip, not a sign anything's wrong.
      return { id: media.id, action: 'skipped (not due yet)', daysSincePosted: Math.floor(daysSincePosted) };
    }
  }
  const debug = [];
  // Fired together, not sequentially — same reasoning as views/facebook_views inside fetchViews()
  // itself: two independent Graph API calls, no reason to wait on one before starting the other.
  const [views, engagement] = await Promise.all([
    fetchViews(media.id, token, guard, debug),
    fetchEngagement(media.id, token, guard),
  ]);
  if (views === null) {
    return { id: media.id, action: 'skipped', reason: 'could not read view count', debug: debug[0] };
  }
  const { total: viewCount, facebookComponent } = views;
  const { likes, comments, shares } = engagement;

  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tracked_videos?platform=eq.instagram&external_video_id=eq.${media.id}&select=*`,
    { headers: sbHeaders }
  );
  const existing = await existingRes.json();

  if (existing.length === 0) {
    // Anchor the window to when the video was actually POSTED, not to whenever this scout run
    // happens to discover it — a backlogged video (brand just connected, pagination catching up)
    // would otherwise get a silent bonus window measured from discovery day instead of the date
    // the brief actually promises, and rank as artificially "safe" in Expiring Soon. Fall back to
    // discovery time only if the platform genuinely gave us no timestamp.
    const anchor = media.timestamp ? new Date(media.timestamp).getTime() : Date.now();
    const eligibleUntil = new Date(anchor + brand.eligibility_window_days * 86400000).toISOString();
    const alreadyHit = viewCount >= brand.view_requirement;
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        brand_id: brand.id,
        platform: 'instagram',
        external_video_id: media.id,
        url: media.permalink || '',
        title: media.caption ? media.caption.slice(0, 200) : '',
        posted_at: media.timestamp || null,
        view_count: viewCount,
        likes, comments, shares,
        last_checked_at: new Date().toISOString(),
        eligible_until: eligibleUntil,
        status: alreadyHit ? 'hit' : 'tracking',
        earned: alreadyHit,
        // See scout-tiktok.js for the full rationale (identical here).
        hit_at: alreadyHit ? new Date().toISOString() : null,
        // snapshot the brand's current rate at discovery time — if the brand's deal changes
        // later (e.g. a warm-up brief ending), only newly-discovered videos pick up the new
        // rate; this one keeps what applied when it was found. Editable per-video afterward.
        pay_amount: brand.base_pay,
        // reels don't always return thumbnail_url reliably — media_url is the fallback,
        // itself a working still image for that case
        thumbnail_url: media.thumbnail_url || media.media_url || null,
        // null unless this reel is crossposted to Facebook — see fetchViews. Not a separate
        // platform/row, just a small "incl. X via FB" aside on this same Instagram row.
        facebook_views_component: facebookComponent,
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
    return { id: media.id, action: 'discovered', views: viewCount, status: alreadyHit ? 'hit' : 'tracking' };
  }

  const row = existing[0];
  if (row.excluded) {
    return { id: media.id, action: 'skipped', status: 'excluded' };
  }
  // EXPERIMENTAL (added 2026-08-25, 2-week trial) — daily view-count history, purely for the
  // trend sparkline in the brand breakdown modal. Fire-and-forget: never blocks or fails the
  // actual tracking/payout logic below if this errors. Self-contained — to remove, delete this
  // call, logViewSnapshot() below, the matching block in scout-tiktok.js/scout-youtube.js, drop
  // the view_snapshots table, and remove loadViewSnapshots()/VIEW_SNAPSHOTS_DATA/
  // brandPlatformTrend()/the sparkline markup in index.html. Nothing else depends on any of it.
  logViewSnapshot(row.id, brand.id, 'instagram', viewCount, SUPABASE_URL, sbHeaders);
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
      // thumbnail_url included here too (not just at discovery) — Instagram's media list
      // already returns it on every single fetch regardless of status, so there's no reason
      // this row's banner should stay permanently blank just because it existed before
      // thumbnail capture was added. Every video's thumbnail backfills itself the next time
      // it's touched by a scouting run — no separate migration needed.
      body: JSON.stringify({
        view_count: viewCount, likes, comments, shares,
        last_checked_at: new Date().toISOString(), status, earned,
        thumbnail_url: media.thumbnail_url || media.media_url || null, facebook_views_component: facebookComponent,
        // Set only on the exact PATCH where status actually flips to 'hit' — see scout-tiktok.js
        // for the full rationale (identical here).
        ...(status === 'hit' ? { hit_at: new Date().toISOString() } : {}),
      }),
    });
    return { id: media.id, action: 'updated', views: viewCount, status };
  }

  // status is 'hit' or 'expired' — the payout outcome is already locked in either way, so
  // there's nothing left to decide here, but the view count (and now likes/comments/shares) is
  // still real, meaningful information (matches what the brand's own dashboard shows, and what
  // you'd actually want to see if you go check on a video later). Only status/earned/pay_amount
  // stay locked.
  await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      view_count: viewCount, likes, comments, shares,
      last_checked_at: new Date().toISOString(),
      thumbnail_url: media.thumbnail_url || media.media_url || null, facebook_views_component: facebookComponent,
    }),
  });
  return { id: media.id, action: 'updated (views only)', views: viewCount, status: row.status };
}

// Runs fn(item) across items with at most `limit` in flight at once, preserving result order.
// A plain Promise.all(items.map(fn)) would fire every request at the same instant — fine at
// today's volume, but fires increasingly large simultaneous bursts as the video library grows,
// which is exactly the kind of pattern that trips a token's rate limit. A fixed-size worker
// pool keeps concurrency flat regardless of how many items there are.
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
// the brand breakdown modal's trend sparkline. See the removal note where this is called for
// what deleting this feature entirely involves. Deliberately not awaited by its caller and
// swallows its own errors — this is a nice-to-have for a chart, never something that should be
// able to fail (or even slow down) the actual tracking/payout logic it sits next to.
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

// Instagram has renamed/consolidated its view-count metric a few times across API
// versions ("views" is the current unified one; older versions used "plays" or
// "video_views"). Try each in order and use whichever the account/API version accepts.
//
// That "views" figure is Instagram-native only. When a reel is also crossposted to a linked
// Facebook Page (Instagram's own "share to Facebook" toggle at the moment of posting — not a
// separate native upload to Facebook), the plays picked up over on Facebook land under a
// distinct `facebook_views` metric and are NOT folded into `views` by this API. Instagram's own
// app *does* show one combined number on the post's own Insights screen (it sums the two for
// display) — confirmed directly against the API (2026-08-25): `views` + `facebook_views` is
// exactly that combined figure. So this adds facebook_views on top whenever it's present, to
// match what's shown there and to avoid under-counting a crossposted video against the brand's
// view requirement. A reel that was never crossposted to Facebook throws when facebook_views is
// requested (IGApiException, "not crossposted to facebook") — that's expected and just means
// there's nothing to add, not a real failure.
async function fetchMetric(mediaId, metric, token, guard) {
  const res = await igFetch(
    `https://graph.instagram.com/${mediaId}/insights?metric=${metric}&access_token=${encodeURIComponent(token)}`,
    guard
  );
  return res.json();
}
// Likes/comments/shares — one extra Graph API call per reel (Instagram's insights endpoint
// doesn't reliably let "views" and "likes" ride in the same request across API versions), fired
// alongside fetchViews() in processOneMedia rather than after it, so it's still just one extra
// round trip, not one extra round trip per field. Meta's insights endpoint does accept a
// comma-separated metric list in a single call. Any of the three can legitimately come back
// missing (e.g. a creator hid like counts) — null in that case, never a false zero.
async function fetchEngagement(mediaId, token, guard) {
  if (guard.stop) return { likes: null, comments: null, shares: null };
  const data = await fetchMetric(mediaId, 'likes,comments,shares', token, guard);
  const valueFor = (name) => {
    const entry = data?.data?.find((d) => d.name === name);
    const v = entry?.values?.[0]?.value;
    return typeof v === 'number' ? v : null;
  };
  return { likes: valueFor('likes'), comments: valueFor('comments'), shares: valueFor('shares') };
}
// Returns { total, facebookComponent } — total is native + facebook_views combined (what
// actually gets compared against the brand's requirement and stored as view_count, matching
// what Instagram's own app shows on the post). facebookComponent is that Facebook portion kept
// separately too (null when the reel isn't crossposted), purely so the UI can show "incl. X via
// Facebook" as a small aside on the Instagram row — it was never a separate video, so it never
// gets a separate platform tag or its own merge target, just this annotation.
async function fetchViews(mediaId, token, guard, debug) {
  if (guard.stop) return null;
  // 'views' is the metric that actually succeeds in practice (plays/video_views are legacy
  // fallbacks for older API versions) and facebook_views is independent of it either way, so
  // fire both together instead of waiting on 'views' first and only then asking about Facebook —
  // that turns 2 sequential round trips into 1 in the common case.
  const [viewsData, fbData] = await Promise.all([
    fetchMetric(mediaId, 'views', token, guard),
    fetchMetric(mediaId, 'facebook_views', token, guard),
  ]);
  const errors = [];
  let native = viewsData?.data?.[0]?.values?.[0]?.value;
  if (typeof native !== 'number') {
    if (viewsData.error) errors.push(`views: ${viewsData.error.message}`);
    // fall back sequentially only in the rare case 'views' itself didn't work
    for (const metric of ['plays', 'video_views']) {
      if (guard.stop) break;
      const data = await fetchMetric(mediaId, metric, token, guard);
      const value = data?.data?.[0]?.values?.[0]?.value;
      if (typeof value === 'number') { native = value; break; }
      if (data.error) errors.push(`${metric}: ${data.error.message}`);
    }
  }
  if (typeof native !== 'number') {
    if (debug) debug.push(errors.join(' | '));
    return null;
  }
  const fbValue = fbData?.data?.[0]?.values?.[0]?.value;
  const facebookComponent = typeof fbValue === 'number' ? fbValue : null;
  return { total: native + (facebookComponent || 0), facebookComponent };
}
