'use strict';

const fs = require('fs');
const path = require('path');

function append(cfg, sessionId, event) {
  try {
    const dir = path.join(cfg.cacheDir, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId || 'unknown'}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch {}
}

module.exports = { append };
