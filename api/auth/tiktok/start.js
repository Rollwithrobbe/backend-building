// Step 1 of the TikTok OAuth flow: redirects the browser to TikTok's own login
// dialog (via "Login Kit"), asking for permission to read the given brand's
// posted-video list and view counts.
//
// Visit this URL with ?brand=<brand id> to kick off a connection for that brand,
// e.g. https://backend-building.vercel.app/api/auth/tiktok/start?brand=xxxxx
//
// Required env vars (set in Vercel):
//   TIKTOK_CLIENT_KEY
// The redirect_uri below must exactly match a "Redirect URI" registered on
// the TikTok app (developers.tiktok.com > your app > Login Kit).

export default function handler(req, res) {
  const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
  const { brand } = req.query;

  if (!CLIENT_KEY) {
    return res.status(500).send('Missing TIKTOK_CLIENT_KEY environment variable.');
  }
  if (!brand) {
    return res.status(400).send('Missing ?brand=<brand id> in the URL.');
  }

  const redirectUri = 'https://backend-building.vercel.app/api/auth/tiktok/callback';
  // user.info.stats added (2026-09-01) — follower_count/following_count/likes_count/video_count
  // all moved behind this scope specifically in TikTok's Feb 2024 field/scope migration; the
  // user.info.basic and user.info.profile scopes no longer carry them. See scout-tiktok.js's
  // follower-count fetch, which was silently failing without this. A brand already connected
  // under the old scope needs to reconnect (re-run this /start flow) before its stored token
  // actually carries the new permission — scopes are fixed at authorization time, not retroactive.
  const scope = ['user.info.profile', 'user.info.stats', 'video.list'].join(',');

  const authUrl =
    `https://www.tiktok.com/v2/auth/authorize/` +
    `?client_key=${encodeURIComponent(CLIENT_KEY)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(brand)}` +
    `&response_type=code`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}
