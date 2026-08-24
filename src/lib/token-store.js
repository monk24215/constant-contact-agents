// token-store.js
// Durable storage for Constant Contact OAuth tokens, backed by Postgres.
//
// This is a copy of composer/src/lib/token-store.js, following this repo's
// intentional "each agent is self-contained" pattern. It reads and writes the
// SAME `oauth_tokens` row in the SAME token-store database, so all agents
// continue to share one source of truth.
//
// Why Postgres and not env vars / memory:
//   CC refresh tokens ROTATE on every refresh. The new refresh token must be
//   persisted atomically or the whole auth chain dies on the next cycle.
//   Railway containers restart; in-memory state would be lost. A single row
//   in Postgres is the source of truth, shared by every agent.
//
// ADDITION over the composer copy: withAdvisoryLock(), used by oauth.js to
// serialize refreshes. MCP clients fire tool calls concurrently, so this
// service can race itself in a way the once-per-minute poller cannot.

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

// NOTE: this service deliberately does NOT call initTokenStore(). The table is
// created and owned by auth/. Read-then-refresh only.

// Returns { access_token, refresh_token, expires_at, scope } or null.
export async function loadTokens(provider = 'constant_contact') {
  const { rows } = await getPool().query(
    'SELECT access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE provider = $1',
    [provider]
  );
  return rows[0] || null;
}

// Upsert the token set. Called after every refresh (the refresh token rotates).
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

// Serialize a critical section across all connections of this service using a
// Postgres session-level advisory lock. Safe to hold briefly; always released.
export async function withAdvisoryLock(key, fn) {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [key]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}
