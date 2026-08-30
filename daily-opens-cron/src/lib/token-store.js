// token-store.js
// Durable storage for Constant Contact OAuth tokens, backed by Postgres.
//
// Copy of mcp/src/lib/token-store.js — reads/writes the SAME oauth_tokens row
// in the SAME token-store database as every other agent in this repo.

import pg from 'pg';

const { Pool } = pg;

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Reference the token-store Postgres service ' +
          "in this service's variables: DATABASE_URL=${{token-store.DATABASE_URL}}"
      );
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

// NOTE: this service deliberately does NOT call initTokenStore(). The table is
// created and owned by auth/. Read-then-refresh only.

export async function loadTokens(provider = 'constant_contact') {
  const { rows } = await getPool().query(
    'SELECT access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE provider = $1',
    [provider]
  );
  return rows[0] || null;
}

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

// Also used by this service's oauth.js, sharing the lock key with mcp/'s copy.
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
