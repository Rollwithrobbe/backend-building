// Step 1 of the Instagram OAuth flow: redirects the browser to Facebook's login
// dialog, asking for permission to read the given brand's Instagram data.
//
// Visit this URL with ?brand=<brand id> to kick off a connection for that brand,
// e.g. https://backend-building.vercel.app/api/auth/instagram/start?brand=xxxxx
//
// Required env vars (set in Vercel):
//   FACEBOOK_APP_ID
// The redirect_uri below must exactly match a "Valid OAuth Redirect URI"
// registered on the Meta app (Facebook Login for Business > Instellingen).

export default function handler(req, res) {
  const APP_ID = process.env.FACEBOOK_APP_ID;
  const { brand } = req.query;

  if (!APP_ID) {
    return res.status(500).send('Missing FACEBOOK_APP_ID environment variable.');
  }
  if (!brand) {
    return res.status(400).send('Missing ?brand=<brand id> in the URL.');
  }

  const redirectUri = 'https://backend-building.vercel.app/api/auth/instagram/callback';
  const scope = ['instagram_basic', 'instagram_manage_insights', 'pages_show_list'].join(',');

  const authUrl =
    `https://www.facebook.com/v20.0/dialog/oauth` +
    `?client_id=${encodeURIComponent(APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(brand)}` +
    `&response_type=code`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}
