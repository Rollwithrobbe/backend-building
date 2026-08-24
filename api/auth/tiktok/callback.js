// Step 2 of the TikTok OAuth flow: TikTok redirects back here with a ?code=.
// We exchange that code for a token and save the connection against the brand
// that was passed through as ?state= in step 1 (see start.js).
//
// Required env vars (set in Vercel):
//   TIKTOK_CLIENT_KEY
//   TIKTOK_CLIENT_SECRET   - from developers.tiktok.com > your app > Login Kit (never expose client-side)
//   SUPABASE_URL
//   SUPABASE_KEY

const REDIRECT_URI = 'https://backend-building.vercel.app/api/auth/tiktok/callback';

export default async function handler(req, res) {
  const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
  const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!CLIENT_KEY || !CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).send('Missing required environment variables (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / SUPABASE_URL / SUPABASE_KEY).');
  }

  const { code, state: brandId, error, error_description } = req.query;

  if (error) {
    return htmlPage(res, `TikTok login was cancelled or failed: ${escapeHtml(error_description || error)}`);
  }
  if (!code || !brandId) {
    return htmlPage(res, 'Missing code or brand reference — start the connection again from the /api/auth/tiktok/start link.');
  }

  try {
    // 1. Exchange the auth code for an access token (hands back open_id too — TikTok's user id)
    const form = new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    });
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: form.toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return htmlPage(res, `Could not exchange code for a token: ${escapeHtml(JSON.stringify(tokenData))}`);
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 86400) * 1000).toISOString();
    const refreshExpiresAt = new Date(Date.now() + (tokenData.refresh_expires_in || 365 * 86400) * 1000).toISOString();

    // 2. Grab the username for a friendly confirmation message
    const meRes = await fetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=display_name,username',
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    const meData = await meRes.json();
    const username = meData?.data?.user?.username || meData?.data?.user?.display_name || '(unknown)';

    // 3. Save it against the brand
    await fetch(`${SUPABASE_URL}/rest/v1/brands?id=eq.${encodeURIComponent(brandId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        tiktok_open_id: tokenData.open_id,
        tiktok_username: username,
        tiktok_access_token: tokenData.access_token,
        tiktok_refresh_token: tokenData.refresh_token,
        tiktok_token_expires_at: expiresAt,
        tiktok_refresh_expires_at: refreshExpiresAt,
      }),
    });

    return htmlPage(res, `Connected! TikTok account @${escapeHtml(username)} is now linked to this brand.`, true);
  } catch (err) {
    return htmlPage(res, `Unexpected error: ${escapeHtml(String(err))}`);
  }
}

function htmlPage(res, message, success) {
  res.status(200).send(`
    <!doctype html>
    <html><head><meta charset="utf-8"><title>TikTok connection</title></head>
    <body style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;">
      <h2>${success ? '✅ Success' : '⚠️ Something went wrong'}</h2>
      <p>${message}</p>
    </body></html>
  `);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
