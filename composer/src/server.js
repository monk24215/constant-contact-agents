// server.js
// The composer runs two ways:
//   1. On an internal timer (every POLL_MINUTES) — autonomous.
//   2. On demand via GET /run — for manual triggering / testing.
// Plus /healthz for Railway and / for a status page.

import express from 'express';
import crypto from 'node:crypto';
import { initTokenStore } from './lib/index.js';
import { runComposer } from './worker.js';

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 15);

// Optional: gate the status page (`/`) and the manual trigger (`/run`)
// behind a shared secret, the same capability-URL pattern mcp/ and auth/
// use. Stays OPTIONAL so existing deployments keep working unchanged — if
// unset, both routes remain open and a warning is logged at startup.
const COMPOSER_SHARED_SECRET = process.env.COMPOSER_SHARED_SECRET || null;

function keyMatches(candidate) {
  if (!COMPOSER_SHARED_SECRET) return true;
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(COMPOSER_SHARED_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireKey(req, res, next) {
  if (keyMatches(req.query.key)) return next();
  // 404, not 401 — don't advertise that a gated route exists to scanners.
  return res.status(404).json({ error: 'not found' });
}

let lastRun = null;
let running = false;

async function tick(trigger) {
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    const res = await runComposer();
    lastRun = { at: new Date().toISOString(), trigger, ...res };
    return lastRun;
  } catch (e) {
    lastRun = { at: new Date().toISOString(), trigger, fatal: e.message };
    console.error('[composer] fatal run error:', e.message);
    return lastRun;
  } finally {
    running = false;
  }
}

app.get('/', requireKey, (req, res) => {
  res.json({
    service: 'composer',
    pollMinutes: POLL_MINUTES,
    lastRun: lastRun || 'none yet',
  });
});

// Health endpoint for Railway. Intentionally ungated and minimal — no
// account or calendar data, just a liveness signal for the platform.
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/run', requireKey, async (req, res) => {
  const result = await tick('manual');
  res.json(result);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function initWithRetry(attempts = 10, delayMs = 3000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await initTokenStore();
      console.log('[composer] token store ready');
      return;
    } catch (e) {
      console.warn(`[composer] token store init ${i}/${attempts}: ${e.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function main() {
  if (!COMPOSER_SHARED_SECRET) {
    console.warn(
      '[composer] COMPOSER_SHARED_SECRET is not set. "/" and "/run" are ' +
        'open to anyone who finds this service\'s URL — "/run" lets them ' +
        'trigger a compose pass on demand. Set COMPOSER_SHARED_SECRET (e.g. ' +
        '`openssl rand -hex 24`) to require ?key=... on those routes.'
    );
  }
  app.listen(PORT, () => console.log(`[composer] listening on :${PORT}`));
  initWithRetry();
  // Autonomous loop.
  setInterval(() => tick('timer'), POLL_MINUTES * 60 * 1000);
  console.log(`[composer] will poll every ${POLL_MINUTES} min`);
}

main();
