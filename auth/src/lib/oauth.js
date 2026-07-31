// oauth.js
// Constant Contact v3 OAuth2 Authorization Code flow.
//
// Endpoints confirmed against the CC v3 developer portal:
//   authorize: https://authz.constantcontact.com/oauth2/default/v1/authorize
//   token:     https://authz.constantcontact.com/oauth2/default/v1/token
//
// Critical CC-specific gotchas handled here:
//   - `offline_access` scope is REQUIRED to receive a refresh token.
//   - Authorization code expires in 5 minutes and is single-use.
//   - Refresh tokens ROTATE: every refresh returns a NEW refresh token that
//     must be persisted, or the chain breaks.
//   - Token endpoint auth is HTTP Basic: base64(client_id:client_secret).

import { loadTokens, saveTokens } from './token-store.js';

const AUTHZ_BASE = 'https://authz.constantcontact.com/oauth2/default/v1';

// Scopes: account read/write covers campaigns + contacts; offline_access is
// mandatory for a refresh token. Adjust if you later narrow permissions.
const DEFAULT_SCOPES = ['contact_data', 'campaign_data', 'offline_access'];

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

// Step 1: build the URL the user visits once to authorize the app.
export function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: requireEnv('CC_CLIENT_ID'),
    redirect_uri: requireEnv('CC_REDIRECT_URI'),
    response_type: 'code',
    scope: DEFAULT_SCOPES.join(' '),
    state: state || 'cc-agents',
  });
  return `${AUTHZ_BASE}/authorize?${params.toString()}`;
}

// Step 2: exchange the short-lived auth code for the initial token pair.
export async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    redirect_uri: requireEnv('CC_REDIRECT_URI'),
    grant_type: 'authorization_code',
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
      `Token exchange failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  await saveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSeconds: data.expires_in,
    scope: data.scope,
  });

  return data;
}

// Refresh using the stored (rotating) refresh token. Persists the NEW pair.
export async function refreshAccessToken() {
  const stored = await loadTokens();
  if (!stored) {
    throw new Error('No stored tokens. App must be authorized first.');
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
        'app must be re-authorized via /authorize.'
    );
  }

  await saveTokens({
    accessToken: data.access_token,
    // CC rotates the refresh token; fall back to old only if absent.
    refreshToken: data.refresh_token || stored.refresh_token,
    expiresInSeconds: data.expires_in,
    scope: data.scope || stored.scope,
  });

  return data;
}

// Returns a valid access token, refreshing proactively if it expires soon.
export async function getValidAccessToken() {
  const stored = await loadTokens();
  if (!stored) {
    throw new Error('No stored tokens. Visit /authorize to authorize the app.');
  }
  const expiresAt = new Date(stored.expires_at).getTime();
  const skewMs = 5 * 60 * 1000; // refresh 5 min before expiry
  if (Date.now() >= expiresAt - skewMs) {
    const refreshed = await refreshAccessToken();
    return refreshed.access_token;
  }
  return stored.access_token;
}

export { DEFAULT_SCOPES };
