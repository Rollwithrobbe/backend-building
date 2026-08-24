// Step 2 of the Instagram OAuth flow: Instagram redirects back here with a ?code=.
// We exchange that code for a token and save the connection against the brand
// that was passed through as ?state= in step 1 (see start.js).
//
// This uses Instagram's own Business Login token endpoints (graph.instagram.com /
// api.instagram.com), which hand back the Instagram Business Account id directly —
// no Facebook Page lookup needed.
//
// Required env vars (set in Vercel):
//   INSTAGRAM_APP_ID
//   INSTAGRAM_APP_SECRET   - from Instagram API > API setup with Instagram login (never expose client-side)
//   SUPABASE_URL
//   SUPABASE_KEY

const REDIRECT_URI = 'https://backend-building.vercel.app/api/auth/instagram/callback';

export default async function handler(req, res) {
  const APP_ID = process.env.INSTAGRAM_APP_ID;
  const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!APP_ID || !APP_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).send('Missing required environment variables (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET / SUPABASE_URL / SUPABASE_KEY).');
  }

  const { code, state: brandId, error, error_description } = req.query;

  if (error) {
    return htmlPage(res, `Instagram login was cancelled or failed: ${escapeHtml(error_description || error)}`);
  }
  if (!code || !brandId) {
    return htmlPage(res, 'Missing code or brand reference — start the connection again from the /api/auth/instagram/start link.');
  }

  try {
    // 1. Exchange the auth code for a short-lived token (also hands back the IG user id directly)
    const form = new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code,
    });
    const shortRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const shortData = await shortRes.json();
    if (!shortData.access_token) {
      return htmlPage(res, `Could not exchange code for a token: ${escapeHtml(JSON.stringify(shortData))}`);
    }
    const igUserId = shortData.user_id;

    // 2. Exchange for a long-lived token (~60 days, refreshable)
    const longRes = await fetch(
      `https://graph.instagram.com/access_token` +
      `?grant_type=ig_exchange_token` +
      `&client_secret=${encodeURIComponent(APP_SECRET)}` +
      `&access_token=${encodeURIComponent(shortData.access_token)}`
    );
    const longData = await longRes.json();
    const longLivedToken = longData.access_token || shortData.access_token;
    const expiresInSeconds = longData.expires_in || 60 * 24 * 3600;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    // 3. Grab the username for a friendly confirmation message
    const meRes = await fetch(
      `https://graph.instagram.com/me?fields=username&access_token=${encodeURIComponent(longLivedToken)}`
    );
    const meData = await meRes.json();
    const username = meData.username || '(unknown)';

    // 4. Save it against the brand
    await fetch(`${SUPABASE_URL}/rest/v1/brands?id=eq.${encodeURIComponent(brandId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        instagram_business_account_id: igUserId,
        instagram_username: username,
        instagram_access_token: longLivedToken,
        instagram_token_expires_at: expiresAt,
      }),
    });

    return htmlPage(res, `Connected! Instagram account @${escapeHtml(username)} is now linked to this brand.`, true);
  } catch (err) {
    return htmlPage(res, `Unexpected error: ${escapeHtml(String(err))}`);
  }
}

function htmlPage(res, message, success) {
  res.status(200).send(`
    <!doctype html>
    <html><head><meta charset="utf-8"><title>Instagram connection</title></head>
    <body style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;">
      <h2>${success ? '✅ Success' : '⚠️ Something went wrong'}</h2>
      <p>${message}</p>
    </body></html>
  `);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
