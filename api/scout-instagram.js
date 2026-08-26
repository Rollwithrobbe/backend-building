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
  for (let page = 0; page < 5 && nextUrl; page++) {
    const mediaRes = await fetch(nextUrl);
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
  const results = await mapConcurrent(reels, 8, (media) => processOneMedia(media, brand, token, SUPABASE_URL, sbHeaders));

  // Anything Supabase still has as 'tracking' for this brand+platform that didn't show up in
  // this fetch has vanished from Instagram (deleted, or archived — archived posts drop out of
  // the standard media list) before ever hitting its requirement — flag it distinctly instead
  // of freezing it silently forever pretending it might still resolve. Self-heals: if it
  // reappears in a later fetch (e.g. unarchived), the normal update path above finds the
  // existing row and overwrites this status.
  const seenIds = new Set(reels.map((m) => m.id));
  const missingCount = await flagMissingVideos(brand, 'instagram', seenIds, SUPABASE_URL, sbHeaders);

  return { checked: results.length, results, flaggedMissing: missingCount };
}

// Everything one reel needs, start to finish — reads its view count, then either inserts it
// (first time seen) or patches its existing row. Pulled out of scoutBrandAccount's loop so it
// can be run concurrently across reels instead of one at a time (see mapConcurrent above it).
async function processOneMedia(media, brand, token, SUPABASE_URL, sbHeaders) {
  const debug = [];
  const views = await fetchViews(media.id, token, debug);
  if (views === null) {
    return { id: media.id, action: 'skipped', reason: 'could not read view count', debug: debug[0] };
  }
  const { total: viewCount, facebookComponent } = views;

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
      body: JSON.stringify({ view_count: viewCount, last_checked_at: new Date().toISOString(), status, earned, thumbnail_url: media.thumbnail_url || media.media_url || null, facebook_views_component: facebookComponent }),
    });
    return { id: media.id, action: 'updated', views: viewCount, status };
  }

  // status is 'hit' or 'expired' — the payout outcome is already locked in either way, so
  // there's nothing left to decide here, but the view count itself is still real, meaningful
  // information (matches what the brand's own dashboard shows, and what you'd actually want to
  // see if you go check on a video later). Only status/earned/pay_amount stay locked.
  await fetch(`${SUPABASE_URL}/rest/v1/tracked_videos?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ view_count: viewCount, last_checked_at: new Date().toISOString(), thumbnail_url: media.thumbnail_url || media.media_url || null, facebook_views_component: facebookComponent }),
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
async function fetchMetric(mediaId, metric, token) {
  const res = await fetch(
    `https://graph.instagram.com/${mediaId}/insights?metric=${metric}&access_token=${encodeURIComponent(token)}`
  );
  return res.json();
}
// Returns { total, facebookComponent } — total is native + facebook_views combined (what
// actually gets compared against the brand's requirement and stored as view_count, matching
// what Instagram's own app shows on the post). facebookComponent is that Facebook portion kept
// separately too (null when the reel isn't crossposted), purely so the UI can show "incl. X via
// Facebook" as a small aside on the Instagram row — it was never a separate video, so it never
// gets a separate platform tag or its own merge target, just this annotation.
async function fetchViews(mediaId, token, debug) {
  // 'views' is the metric that actually succeeds in practice (plays/video_views are legacy
  // fallbacks for older API versions) and facebook_views is independent of it either way, so
  // fire both together instead of waiting on 'views' first and only then asking about Facebook —
  // that turns 2 sequential round trips into 1 in the common case.
  const [viewsData, fbData] = await Promise.all([
    fetchMetric(mediaId, 'views', token),
    fetchMetric(mediaId, 'facebook_views', token),
  ]);
  const errors = [];
  let native = viewsData?.data?.[0]?.values?.[0]?.value;
  if (typeof native !== 'number') {
    if (viewsData.error) errors.push(`views: ${viewsData.error.message}`);
    // fall back sequentially only in the rare case 'views' itself didn't work
    for (const metric of ['plays', 'video_views']) {
      const data = await fetchMetric(mediaId, metric, token);
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
