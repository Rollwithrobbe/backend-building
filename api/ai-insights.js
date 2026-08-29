// Weekly AI content-analytics job (Mondays, 23:45 UTC — after that day's three scout jobs have
// run, so it's reasoning over fresh data): pulls the same underlying data the Analytics page
// computes from (tracked_videos + brands + view_snapshots), builds a compact structured summary,
// and asks Claude (claude-sonnet-5) what's working, what's not, what hooks/patterns are paying
// off, and what to do next. Writes the result to ai_insights so the dashboard can show the latest
// run. Weekly (not daily) is a deliberate cost/value call — see vercel.json's cron entry.
//
// Deliberately raw `fetch` throughout, matching scout-tiktok.js / scout-instagram.js /
// scout-youtube.js — this project has no package.json / npm dependencies, so no @anthropic-ai/sdk.
//
// Required env vars (set in Vercel):
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_KEY
// Optional:
//   CRON_SECRET

const SONNET_5_INPUT_PER_MTOK = 2.0;
const SONNET_5_OUTPUT_PER_MTOK = 10.0;

function extractTags(title) {
  if (!title) return [];
  const matches = title.match(/#[a-z0-9_]+/gi) || [];
  return [...new Set(matches.map(t => t.slice(1).toLowerCase()))];
}

function rowRequirement(row) {
  return row.view_requirement_override != null
    ? Number(row.view_requirement_override)
    : Number(row.brands?.view_requirement || 0);
}

// One snapshot per (video, day) — collapses duplicate same-day rows from manual re-triggers /
// cron retries by keeping whichever has the latest checked_at. Same fix as the dashboard's
// caLatestSnapshotPerDay — without it, velocity reads near-zero whenever the last two raw rows
// happen to be minutes apart instead of a real day apart.
function latestSnapshotPerDay(snapshots, trackedVideoId) {
  const byDay = {};
  snapshots.forEach(s => {
    if (s.tracked_video_id !== trackedVideoId) return;
    const d = s.checked_at.slice(0, 10);
    if (!byDay[d] || s.checked_at > byDay[d].checked_at) byDay[d] = s;
  });
  return byDay;
}

function videoVelocity(snapshots, trackedVideoId) {
  const byDay = latestSnapshotPerDay(snapshots, trackedVideoId);
  const days = Object.keys(byDay).sort();
  if (days.length < 2) return null;
  const last = Number(byDay[days[days.length - 1]].view_count) || 0;
  const prev = Number(byDay[days[days.length - 2]].view_count) || 0;
  return Math.max(0, last - prev);
}

function buildDeliverables(trackedVideos) {
  const byGroup = {};
  const standalone = [];
  trackedVideos.forEach(r => {
    if (r.group_id) { (byGroup[r.group_id] = byGroup[r.group_id] || []).push(r); }
    else standalone.push(r);
  });

  const deliverables = standalone.map(r => ({ key: r.id, rows: [r] }));
  Object.entries(byGroup).forEach(([gid, rows]) => deliverables.push({ key: gid, rows }));

  return deliverables.map(dv => {
    const active = dv.rows.filter(r => !r.excluded);
    const consider = active.length ? active : dv.rows;
    const hitRow = consider.find(r => r.status === 'hit');
    const anyTracking = consider.some(r => r.status === 'tracking');
    const anyMissing = consider.some(r => r.status === 'missing');
    const status = hitRow ? 'hit' : anyTracking ? 'tracking' : anyMissing ? 'missing' : 'expired';
    const rep = hitRow || consider[0];
    const postedAt = dv.rows.map(r => r.posted_at).filter(Boolean).sort()[0] || null;

    const likes = dv.rows.reduce((s, r) => s + (Number(r.likes) || 0), 0);
    const comments = dv.rows.reduce((s, r) => s + (Number(r.comments) || 0), 0);
    const shares = dv.rows.reduce((s, r) => s + (Number(r.shares) || 0), 0);
    const views = dv.rows.reduce((s, r) => s + (Number(r.view_count) || 0), 0);
    const hasEngagement = dv.rows.some(r => r.likes != null || r.comments != null || r.shares != null);

    const platforms = {};
    dv.rows.forEach(r => { platforms[r.platform] = (platforms[r.platform] || 0) + (Number(r.view_count) || 0); });

    const tracking = consider.filter(r => !r.excluded && r.status === 'tracking');
    const bestRatio = tracking.length
      ? Math.max(...tracking.map(r => { const req = rowRequirement(r); return req > 0 ? (Number(r.view_count) || 0) / req : 0; }))
      : null;
    const isNearMiss = status === 'tracking' && bestRatio != null && bestRatio >= 0.8 && bestRatio < 1;

    return {
      key: dv.key, rows: dv.rows, status, postedAt,
      brandId: rep.brand_id, brandName: rep.brands?.name || 'Unassigned',
      title: rep.title, tags: extractTags(rep.title),
      platforms, views,
      likes: hasEngagement ? likes : null,
      comments: hasEngagement ? comments : null,
      shares: hasEngagement ? shares : null,
      engRate: hasEngagement && views > 0 ? Number(((likes + comments + shares) / views * 100).toFixed(2)) : null,
      isNearMiss,
    };
  });
}

function buildInsightsPayload(deliverables, snapshots) {
  // Velocity + trending, same rule as the dashboard's caIsTrending: this deliverable's best
  // per-video day-over-day gain vs. that brand's average gain across all its videos with
  // enough snapshot history — >=2x counts as trending.
  const velocityByDeliverable = new Map();
  deliverables.forEach(dv => {
    const vals = dv.rows.map(r => videoVelocity(snapshots, r.id)).filter(v => v != null);
    velocityByDeliverable.set(dv.key, vals.length ? Math.max(...vals) : null);
  });

  const velocityByBrand = new Map();
  deliverables.forEach(dv => {
    const v = velocityByDeliverable.get(dv.key);
    if (v == null) return;
    if (!velocityByBrand.has(dv.brandId)) velocityByBrand.set(dv.brandId, []);
    velocityByBrand.get(dv.brandId).push(v);
  });
  const brandAvgVelocity = new Map();
  velocityByBrand.forEach((vals, brandId) => brandAvgVelocity.set(brandId, vals.reduce((a, b) => a + b, 0) / vals.length));

  // Most recently posted first, capped so the prompt stays a bounded, predictable size —
  // recent content is what a weekly recommendation run should actually be about.
  const sorted = [...deliverables].sort((a, b) => (b.postedAt || '').localeCompare(a.postedAt || ''));
  const capped = sorted.slice(0, 200);

  const items = capped.map(dv => {
    const velocity = velocityByDeliverable.get(dv.key);
    const avg = brandAvgVelocity.get(dv.brandId);
    const breakoutRatio = velocity != null && avg ? Number((velocity / avg).toFixed(2)) : null;
    return {
      brand: dv.brandName, title: dv.title, tags: dv.tags, postedAt: dv.postedAt,
      status: dv.status, platforms: dv.platforms, totalViews: dv.views,
      likes: dv.likes, comments: dv.comments, shares: dv.shares, engagementRatePct: dv.engRate,
      isNearMiss: dv.isNearMiss,
      isTrending: breakoutRatio != null && breakoutRatio >= 2,
      breakoutRatioVsBrandAvg: breakoutRatio,
    };
  });

  const tagStats = new Map();
  capped.forEach(dv => dv.tags.forEach(tag => {
    if (!tagStats.has(tag)) tagStats.set(tag, { tag, videos: 0, totalViews: 0 });
    const t = tagStats.get(tag);
    t.videos += 1; t.totalViews += dv.views;
  }));
  const topHashtags = [...tagStats.values()].sort((a, b) => b.totalViews - a.totalViews).slice(0, 15);

  return { generatedAt: new Date().toISOString(), deliverablesAnalyzed: items.length, topHashtags, content: items };
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-4 sentence plain-English overview of how content performed recently.' },
    whats_working: {
      type: 'array',
      items: { type: 'object', properties: { insight: { type: 'string' }, evidence: { type: 'string' } }, required: ['insight', 'evidence'], additionalProperties: false },
    },
    whats_not_working: {
      type: 'array',
      items: { type: 'object', properties: { insight: { type: 'string' }, evidence: { type: 'string' } }, required: ['insight', 'evidence'], additionalProperties: false },
    },
    hook_patterns: {
      type: 'array',
      description: 'Patterns in titles/hooks/tags that correlate with strong or weak performance.',
      items: { type: 'object', properties: { pattern: { type: 'string' }, examples: { type: 'array', items: { type: 'string' } } }, required: ['pattern', 'examples'], additionalProperties: false },
    },
    videos_to_watch: {
      type: 'array',
      description: 'Specific videos worth a human look right now — near-misses close to the bar, decelerating trends, standout breakouts.',
      items: { type: 'object', properties: { title: { type: 'string' }, brand: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'brand', 'reason'], additionalProperties: false },
    },
    recommendations: { type: 'array', description: 'Concrete next actions.', items: { type: 'string' } },
  },
  required: ['summary', 'whats_working', 'whats_not_working', 'hook_patterns', 'videos_to_watch', 'recommendations'],
  additionalProperties: false,
};

async function callClaude(ANTHROPIC_API_KEY, payload) {
  const system = `You are a UGC content strategist reviewing performance data for "Roll with Robbe", a creator-ops agency tracking short-form video content across TikTok, Instagram, and YouTube for multiple brands.

You'll be given structured JSON: recent tracked content ("deliverables") with per-platform view counts, engagement (likes/comments/shares — null means not measured on that platform, not zero), hashtags extracted from titles, near-miss/trending flags, and a top-hashtags rollup.

Ground every claim in the actual data given — cite real titles/brands/numbers in "evidence" and "examples", never invent them. If the data is too thin for a category (e.g. too few videos to spot a hook pattern), say so briefly rather than padding it out.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
      system,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
  });

  const body = await res.json();
  if (!res.ok) throw new Error(`Anthropic API returned ${res.status}: ${JSON.stringify(body)}`);

  const textBlock = (body.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error(`No text block in Anthropic response: ${JSON.stringify(body)}`);

  return { parsed: JSON.parse(textBlock.text), usage: body.usage || {} };
}

export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'missing required environment variables (ANTHROPIC_API_KEY / SUPABASE_URL / SUPABASE_KEY)' });
  }

  const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    const [videosRes, snapshotsRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/tracked_videos?select=*,brands(name,base_pay,view_requirement,eligibility_window_days)&order=discovered_at.desc`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/view_snapshots?select=tracked_video_id,brand_id,platform,view_count,checked_at&checked_at=gte.${new Date(Date.now() - 14 * 86400000).toISOString()}&order=checked_at.asc`, { headers: sbHeaders }),
    ]);
    if (!videosRes.ok) throw new Error(`Supabase tracked_videos returned ${videosRes.status}`);
    if (!snapshotsRes.ok) throw new Error(`Supabase view_snapshots returned ${snapshotsRes.status}`);

    const trackedVideos = await videosRes.json();
    const snapshots = await snapshotsRes.json();

    const deliverables = buildDeliverables(trackedVideos);
    const payload = buildInsightsPayload(deliverables, snapshots);

    const { parsed, usage } = await callClaude(ANTHROPIC_API_KEY, payload);

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const estimatedCost = (inputTokens / 1e6) * SONNET_5_INPUT_PER_MTOK + (outputTokens / 1e6) * SONNET_5_OUTPUT_PER_MTOK;

    const row = {
      model: 'claude-sonnet-5',
      summary: parsed.summary,
      whats_working: parsed.whats_working,
      whats_not_working: parsed.whats_not_working,
      hook_patterns: parsed.hook_patterns,
      videos_to_watch: parsed.videos_to_watch,
      recommendations: parsed.recommendations,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: Number(estimatedCost.toFixed(4)),
      deliverables_analyzed: payload.deliverablesAnalyzed,
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/ai_insights`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!insertRes.ok) throw new Error(`Supabase ai_insights insert returned ${insertRes.status}: ${await insertRes.text()}`);
    const inserted = (await insertRes.json())[0];

    return res.status(200).json({ ok: true, insight: inserted });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
