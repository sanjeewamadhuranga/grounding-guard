'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const config = require('../lib/config');

function tmpdir(prefix = 'gguard-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Mock npm+PyPI registry. `known` maps name -> array of versions; anything
// else 404s.
function startMockRegistry(known) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let m;
    if (url.startsWith('/-/v1/search')) {
      return send(200, { objects: [{ package: { name: 'express' } }] });
    }
    if ((m = url.match(/^\/pypi\/([^/]+)\/json$/))) {
      const versions = known[m[1]];
      if (!versions) return send(404, { message: 'Not Found' });
      const releases = {};
      for (const v of versions) releases[v] = [];
      return send(200, { releases });
    }
    const name = url.slice(1);
    const versions = known[name];
    if (!versions) return send(404, { error: 'Not found' });
    const versionsObj = {};
    for (const v of versions) versionsObj[v] = {};
    return send(200, { versions: versionsObj });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// Builds a project dir whose .gguard.json points every registry at `url`
// and isolates the cache, then loads the effective config.
function makeCfg(projectDir, url, overrides = {}) {
  const cacheDir = path.join(projectDir, '.cache');
  fs.writeFileSync(
    path.join(projectDir, '.gguard.json'),
    JSON.stringify({
      registries: { npm: url, pypi: url },
      cacheDir,
      fetchTimeoutMs: 1000,
      ...overrides,
    })
  );
  return config.load(projectDir);
}

module.exports = { tmpdir, startMockRegistry, makeCfg };
