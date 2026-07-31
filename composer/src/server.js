// server.js
// The composer runs two ways:
//   1. On an internal timer (every POLL_MINUTES) — autonomous.
//   2. On demand via GET /run — for manual triggering / testing.
// Plus /healthz for Railway and / for a status page.

import express from 'express';
import { initTokenStore } from './lib/index.js';
import { runComposer } from './worker.js';

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 15);

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

app.get('/', (req, res) => {
  res.json({
    service: 'composer',
    pollMinutes: POLL_MINUTES,
    lastRun: lastRun || 'none yet',
  });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/run', async (req, res) => {
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
  app.listen(PORT, () => console.log(`[composer] listening on :${PORT}`));
  initWithRetry();
  // Autonomous loop.
  setInterval(() => tick('timer'), POLL_MINUTES * 60 * 1000);
  console.log(`[composer] will poll every ${POLL_MINUTES} min`);
}

main();
