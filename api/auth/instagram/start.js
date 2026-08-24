// Step 1 of the Instagram OAuth flow: redirects the browser to Instagram's own
// Business Login dialog, asking for permission to read the given brand's
// Instagram data. This uses the dedicated "Instagram API with Instagram login"
// product — a separate Instagram App ID/Secret from the generic Facebook app
// credentials — so no Facebook Page linkage is required at all.
//
// Visit this URL with ?brand=<brand id> to kick off a connection for that brand,
// e.g. https://backend-building.vercel.app/api/auth/instagram/start?brand=xxxxx
//
// Required env vars (set in Vercel):
//   INSTAGRAM_APP_ID
// The redirect_uri below must exactly match the "Redirect URL" registered on
// the Meta app (Instagram API > API setup with Instagram login > Set up business login).

export default function handler(req, res) {
  const APP_ID = process.env.INSTAGRAM_APP_ID;
  const { brand } = req.query;

  if (!APP_ID) {
    return res.status(500).send('Missing INSTAGRAM_APP_ID environment variable.');
  }
  if (!brand) {
    return res.status(400).send('Missing ?brand=<brand id> in the URL.');
  }

  const redirectUri = 'https://backend-building.vercel.app/api/auth/instagram/callback';
  const scope = ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages', 'instagram_business_manage_insights'].join(',');

  const authUrl =
    `https://www.instagram.com/oauth/authorize` +
    `?client_id=${encodeURIComponent(APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(brand)}` +
    `&response_type=code`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}
