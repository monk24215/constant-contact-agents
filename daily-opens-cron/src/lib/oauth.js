// oauth.js
// Constant Contact v3 OAuth2 — refresh + access-token retrieval only.
//
// Copy of mcp/src/lib/oauth.js, following this repo's "each agent is
// self-contained" pattern. Deliberately can only refresh an existing chain,
// never start a new one — initial authorization stays owned by auth/.
//
// Shares REFRESH_LOCK_KEY with mcp/'s copy on purpose: both services hit the
// same Postgres database, and the advisory lock is global to the database,
// not per-process — reusing the key lets this cron job and the always-on MCP
// service serialize refreshes against each other too, not just against
// themselves.
//
// Critical CC-specific gotchas (unchanged):
//   - Refresh tokens ROTATE: every refresh returns a NEW refresh token that
//     must be persisted, or the chain breaks.
//   - Token endpoint auth is HTTP Basic: base64(client_id:client_secret).

import { loadTokens, saveTokens, withAdvisoryLock } from './token-store.js';

const AUTHZ_BASE = 'https://authz.constantcontact.com/oauth2/default/v1';

// Same key as mcp/src/lib/oauth.js — intentional, see comment above.
const REFRESH_LOCK_KEY = 828_141_001;

// Refresh this long before actual expiry.
const SKEW_MS = 5 * 60 * 1000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function basicAuthHeader() {
  const id = requireEnv('CC_CLIENT_ID');
  const secret = requireEnv('CC_CLIENT_SECRET');
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

function isStale(stored) {
  return Date.now() >= new Date(stored.expires_at).getTime() - SKEW_MS;
}

// Refresh using the stored (rotating) refresh token. Persists the NEW pair.
async function refreshAccessToken() {
  const stored = await loadTokens();
  if (!stored) {
    throw new Error('No stored tokens. App must be authorized first via auth/.');
  }

  const body = new URLSearchParams({
    refresh_token: stored.refresh_token,
    grant_type: 'refresh_token',
  });

  const res = await fetch(`${AUTHZ_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Token refresh failed (${res.status}): ${JSON.stringify(data)}. ` +
        'If this is invalid_grant, the refresh token chain is broken and the ' +
        'app must be re-authorized via the auth service /authorize.'
    );
  }

  await saveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || stored.refresh_token,
    expiresInSeconds: data.expires_in,
    scope: data.scope || stored.scope,
  });

  return data.access_token;
}

// Returns a valid access token, refreshing proactively if it expires soon.
export async function getValidAccessToken() {
  const stored = await loadTokens();
  if (!stored) {
    throw new Error(
      'No stored tokens. Authorize the app via the auth service /authorize.'
    );
  }
  if (!isStale(stored)) return stored.access_token;

  return withAdvisoryLock(REFRESH_LOCK_KEY, async () => {
    const fresh = await loadTokens();
    if (fresh && !isStale(fresh)) return fresh.access_token;
    return refreshAccessToken();
  });
}
