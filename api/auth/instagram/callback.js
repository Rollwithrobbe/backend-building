// Step 2 of the Instagram OAuth flow: Facebook redirects back here with a ?code=.
// We exchange that code for a token, find the Instagram Business account(s) the
// logged-in user manages, and save the connection against the brand that was
// passed through as ?state= in step 1 (see start.js).
//
// Required env vars (set in Vercel):
//   FACEBOOK_APP_ID
//   FACEBOOK_APP_SECRET   - from App Settings > Basic > App secret (never expose client-side)
//   SUPABASE_URL
//   SUPABASE_KEY

const REDIRECT_URI = 'https://backend-building.vercel.app/api/auth/instagram/callback';

export default async function handler(req, res) {
  const APP_ID = process.env.FACEBOOK_APP_ID;
  const APP_SECRET = process.env.FACEBOOK_APP_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!APP_ID || !APP_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).send('Missing required environment variables (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / SUPABASE_URL / SUPABASE_KEY).');
  }

  const { code, state: brandId, error, error_description } = req.query;

  if (error) {
    return htmlPage(res, `Facebook login was cancelled or failed: ${escapeHtml(error_description || error)}`);
  }
  if (!code || !brandId) {
    return htmlPage(res, 'Missing code or brand reference — start the connection again from the /api/auth/instagram/start link.');
  }

  try {
    // 1. Exchange the auth code for a short-lived user access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(APP_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&client_secret=${encodeURIComponent(APP_SECRET)}` +
      `&code=${encodeURIComponent(code)}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return htmlPage(res, `Could not exchange code for a token: ${escapeHtml(JSON.stringify(tokenData))}`);
    }

    // 2. Exchange the short-lived token for a long-lived one (~60 days)
    const longRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(APP_ID)}` +
      `&client_secret=${encodeURIComponent(APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(tokenData.access_token)}`
    );
    const longData = await longRes.json();
    const longLivedToken = longData.access_token || tokenData.access_token;
    const expiresInSeconds = longData.expires_in || tokenData.expires_in || 60 * 24 * 3600;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    // 3. List the Facebook Pages this user manages, with their linked Instagram Business account
    const pagesRes = await fetch(
      `https://graph.facebook.com/v20.0/me/accounts` +
      `?fields=name,access_token,instagram_business_account{id,username}` +
      `&access_token=${encodeURIComponent(longLivedToken)}`
    );
    const pagesData = await pagesRes.json();
    const pages = (pagesData.data || []).filter((p) => p.instagram_business_account);

    if (pages.length === 0) {
      return htmlPage(
        res,
        'No Instagram Business/Creator account was found on any Facebook Page you manage. ' +
        'Make sure the Instagram account is set to Business or Creator, and is linked to a Facebook Page you administer, then try again.'
      );
    }

    if (pages.length === 1) {
      // Only one match — save it straight away, no picker needed
      const page = pages[0];
      await saveConnection(SUPABASE_URL, SUPABASE_KEY, brandId, page, expiresAt);
      return htmlPage(
        res,
        `Connected! Instagram account @${escapeHtml(page.instagram_business_account.username)} is now linked to this brand.`,
        true
      );
    }

    // Multiple Instagram accounts available — let the user pick which one belongs to this brand
    const options = pages
      .map((p, i) => {
        const ig = p.instagram_business_account;
        return `
          <form method="POST" action="/api/auth/instagram/confirm" style="margin:8px 0;">
            <input type="hidden" name="brand" value="${escapeHtml(brandId)}">
            <input type="hidden" name="ig_id" value="${escapeHtml(ig.id)}">
            <input type="hidden" name="ig_username" value="${escapeHtml(ig.username)}">
            <input type="hidden" name="page_token" value="${escapeHtml(p.access_token)}">
            <input type="hidden" name="expires_at" value="${escapeHtml(expiresAt)}">
            <button type="submit" style="padding:10px 16px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer;font-size:15px;">
              @${escapeHtml(ig.username)} <span style="color:#888;">(Page: ${escapeHtml(p.name)})</span>
            </button>
          </form>`;
      })
      .join('');

    return res.status(200).send(`
      <!doctype html>
      <html><head><meta charset="utf-8"><title>Pick an Instagram account</title></head>
      <body style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;">
        <h2>Which Instagram account is this brand?</h2>
        <p style="color:#666;">You manage multiple Instagram accounts — pick the one that belongs to this brand.</p>
        ${options}
      </body></html>
    `);
  } catch (err) {
    return htmlPage(res, `Unexpected error: ${escapeHtml(String(err))}`);
  }
}

async function saveConnection(SUPABASE_URL, SUPABASE_KEY, brandId, page, expiresAt) {
  const ig = page.instagram_business_account;
  await fetch(`${SUPABASE_URL}/rest/v1/brands?id=eq.${encodeURIComponent(brandId)}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      instagram_business_account_id: ig.id,
      instagram_username: ig.username,
      instagram_access_token: page.access_token,
      instagram_token_expires_at: expiresAt,
    }),
  });
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
