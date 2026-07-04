'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const config = require('../lib/config');

function tmpdir(prefix = 'gguard-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Mock registry for every supported ecosystem. `known` maps name -> array of
// versions (maven key: "group:artifact"); anything else 404s.
function startMockRegistry(known) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
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
    if ((m = url.match(/^\/api\/v1\/crates\/([^/]+)$/))) {
      const versions = known[m[1]];
      if (!versions) return send(404, { errors: [{ detail: 'Not Found' }] });
      return send(200, { versions: versions.map((num) => ({ num })) });
    }
    if ((m = url.match(/^\/api\/v1\/versions\/([^/]+)\.json$/))) {
      const versions = known[m[1]];
      if (!versions) return send(404, 'This rubygem could not be found.', 'text/plain');
      return send(200, versions.map((number) => ({ number })));
    }
    if ((m = url.match(/^\/(.+)\/@v\/list$/))) {
      const versions = known[m[1]];
      if (!versions) return send(404, 'not found', 'text/plain');
      return send(200, versions.join('\n') + '\n', 'text/plain');
    }
    if ((m = url.match(/^\/(.+)\/([^/]+)\/maven-metadata\.xml$/))) {
      const versions = known[`${m[1].replace(/\//g, '.')}:${m[2]}`];
      if (!versions) return send(404, 'not found', 'text/plain');
      const xml = `<metadata><versioning><versions>${versions
        .map((v) => `<version>${v}</version>`)
        .join('')}</versions></versioning></metadata>`;
      return send(200, xml, 'application/xml');
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
      registries: { npm: url, pypi: url, crates: url, goproxy: url, rubygems: url, maven: url },
      cacheDir,
      fetchTimeoutMs: 1000,
      ...overrides,
    })
  );
  return config.load(projectDir);
}

module.exports = { tmpdir, startMockRegistry, makeCfg };
