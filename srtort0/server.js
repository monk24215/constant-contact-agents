// auth service
// One job: get the app authorized against the user's Constant Contact account
// ONE time, capture the rotating refresh token into durable storage, and then
// serve as the health/status surface for the auth chain.
//
// After the one-time click, every other agent uses the shared cc-client to
// mint fresh access tokens automatically. The user never returns here unless
// the refresh chain is deliberately broken/revoked.

import express from 'express';
import crypto from 'node:crypto';
import {
  initTokenStore,
  loadTokens,
  hasTokens,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
} from '@cc-agents/cc-client';
import { getAccountSummary } from '@cc-agents/cc-client';

const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory state token for CSRF protection on the OAuth round-trip.
let pendingState = null;

app.get('/', async (req, res) => {
  let authorized = false;
  try {
    authorized = await hasTokens();
  } catch (e) {
    return res
      .status(500)
      .send(page('Setup error', `<p>Token store not reachable.</p><pre>${escapeHtml(e.message)}</pre>`));
  }

  if (authorized) {
    const t = await loadTokens();
    return res.send(
      page(
        'Constant Contact — Authorized ✅',
        `<p>The app is authorized. Tokens are stored and auto-refreshing.</p>
         <p><b>Access token expires:</b> ${escapeHtml(new Date(t.expires_at).toISOString())}</p>
         <p><b>Scope:</b> ${escapeHtml(t.scope || 'n/a')}</p>
         <p><a href="/verify">Run a live API check →</a></p>
         <hr><p>Need to re-authorize? <a href="/authorize">Start over</a>.</p>`
      )
    );
  }

  return res.send(
    page(
      'Constant Contact — Authorization needed',
      `<p>The app is not yet authorized against your Constant Contact account.</p>
       <p style="margin-top:24px">
         <a href="/authorize" style="background:#0a66c2;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
           Authorize Constant Contact
         </a>
       </p>
       <p style="margin-top:16px;color:#666">You'll be sent to Constant Contact to log in and click "Allow" once.</p>`
    )
  );
});

app.get('/authorize', (req, res) => {
  pendingState = crypto.randomBytes(16).toString('hex');
  const url = buildAuthorizeUrl(pendingState);
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res
      .status(400)
      .send(page('Authorization denied', `<pre>${escapeHtml(String(error_description || error))}</pre>`));
  }
  if (!code) {
    return res.status(400).send(page('Missing code', '<p>No authorization code returned.</p>'));
  }
  if (pendingState && state !== pendingState) {
    return res.status(400).send(page('State mismatch', '<p>Possible CSRF. Please retry from /authorize.</p>'));
  }

  try {
    await exchangeCodeForTokens(code);
    pendingState = null;
    return res.send(
      page(
        'Authorized ✅',
        `<p>Success. Tokens stored and the system is now self-refreshing.</p>
         <p>You can close this tab. You won't need to come back here.</p>
         <p><a href="/">Back to status</a></p>`
      )
    );
  } catch (e) {
    return res
      .status(500)
      .send(page('Token exchange failed', `<pre>${escapeHtml(e.message)}</pre><p><a href="/authorize">Retry</a></p>`));
  }
});

// Live sanity check: mint a token and hit a real CC endpoint.
app.get('/verify', async (req, res) => {
  try {
    await getValidAccessToken();
    const summary = await getAccountSummary();
    res.send(
      page(
        'Live API check ✅',
        `<p>Successfully called Constant Contact with a fresh token.</p>
         <pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre>`
      )
    );
  } catch (e) {
    res.status(500).send(page('API check failed', `<pre>${escapeHtml(e.message)}</pre>`));
  }
});

// Health endpoint for Railway.
app.get('/healthz', (req, res) => res.json({ ok: true }));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.5;color:#111}
      h1{font-size:22px} pre{background:#f5f5f5;padding:12px;border-radius:8px;overflow:auto;font-size:13px}
      a{color:#0a66c2}
    </style></head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`;
}

// Init the token store with retry, but NEVER block/crash the web server on it.
// Railway may bring Postgres up slightly after this service; crash-looping
// would be worse than serving a "DB not ready" status page for a few seconds.
async function initWithRetry(attempts = 10, delayMs = 3000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await initTokenStore();
      console.log('[auth] token store ready');
      return;
    } catch (e) {
      console.warn(`[auth] token store init attempt ${i}/${attempts} failed: ${e.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error('[auth] token store still unavailable after retries; routes will report errors until DB is reachable');
}

function main() {
  app.listen(PORT, () => {
    console.log(`[auth] listening on :${PORT}`);
  });
  // Fire-and-forget; server is already accepting connections.
  initWithRetry();
}

main();
