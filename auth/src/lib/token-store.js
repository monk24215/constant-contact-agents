// token-store.js
// Durable storage for Constant Contact OAuth tokens, backed by Postgres.
//
// Why Postgres and not env vars / memory:
//   CC refresh tokens ROTATE on every refresh. The new refresh token must be
//   persisted atomically or the whole auth chain dies on the next cycle.
//   Railway containers restart; in-memory state would be lost. A single row
//   in Postgres is the source of truth, shared by every agent.

import pg from 'pg';

const { Pool } = pg;

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Reference the token-store Postgres service ' +
          'in this service\'s variables: DATABASE_URL=${{token-store.DATABASE_URL}}'
      );
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

// Called once at startup by any service. Idempotent.
export async function initTokenStore() {
  const sql = `
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider       TEXT PRIMARY KEY,
      access_token   TEXT NOT NULL,
      refresh_token  TEXT NOT NULL,
      expires_at     TIMESTAMPTZ NOT NULL,
      scope          TEXT,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  await getPool().query(sql);
}

// Returns { access_token, refresh_token, expires_at, scope } or null.
export async function loadTokens(provider = 'constant_contact') {
  const { rows } = await getPool().query(
    'SELECT access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE provider = $1',
    [provider]
  );
  return rows[0] || null;
}

// Upsert the token set. Called after initial authorization AND after every
// refresh (because the refresh token rotates).
export async function saveTokens(
  { accessToken, refreshToken, expiresInSeconds, scope },
  provider = 'constant_contact'
) {
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  await getPool().query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (provider) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at    = EXCLUDED.expires_at,
       scope         = EXCLUDED.scope,
       updated_at    = now()`,
    [provider, accessToken, refreshToken, expiresAt, scope || null]
  );
}

export async function hasTokens(provider = 'constant_contact') {
  return (await loadTokens(provider)) !== null;
}
