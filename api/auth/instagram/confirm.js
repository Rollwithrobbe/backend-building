// Step 3 (only reached when a user manages multiple Instagram accounts): saves
// whichever account they picked on the callback.js picker screen against the brand.
//
// Required env vars (set in Vercel):
//   SUPABASE_URL
//   SUPABASE_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).send('Missing required environment variables (SUPABASE_URL / SUPABASE_KEY).');
  }

  const { brand, ig_id, ig_username, page_token, expires_at } = req.body || {};
  if (!brand || !ig_id || !page_token) {
    return res.status(400).send('Missing required fields.');
  }

  await fetch(`${SUPABASE_URL}/rest/v1/brands?id=eq.${encodeURIComponent(brand)}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      instagram_business_account_id: ig_id,
      instagram_username: ig_username,
      instagram_access_token: page_token,
      instagram_token_expires_at: expires_at,
    }),
  });

  res.status(200).send(`
    <!doctype html>
    <html><head><meta charset="utf-8"><title>Instagram connection</title></head>
    <body style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;">
      <h2>✅ Success</h2>
      <p>Connected! Instagram account @${escapeHtml(ig_username || '')} is now linked to this brand.</p>
    </body></html>
  `);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
