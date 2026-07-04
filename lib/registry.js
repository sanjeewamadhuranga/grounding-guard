'use strict';

const fs = require('fs');
const path = require('path');

const TTL_HIT_MS = 24 * 60 * 60 * 1000; // package found: cache 24h
const TTL_MISS_MS = 60 * 60 * 1000; // package missing: cache 1h (may get published)

function cachePath(cfg, kind, name) {
  return path.join(cfg.cacheDir, 'registry', kind, `${encodeURIComponent(name)}.json`);
}

function readCache(cfg, kind, name) {
  try {
    const entry = JSON.parse(fs.readFileSync(cachePath(cfg, kind, name), 'utf8'));
    const ttl = entry.exists ? TTL_HIT_MS : TTL_MISS_MS;
    if (Date.now() - entry.fetchedAt < ttl) return entry;
  } catch {}
  return null;
}

function writeCache(cfg, kind, name, entry) {
  try {
    const file = cachePath(cfg, kind, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry));
  } catch {}
}

const USER_AGENT = 'grounding-guard/0.2 (Claude Code plugin; https://github.com/sanjeewamadhuranga/grounding-guard)';

async function fetchRaw(url, cfg, headers, missingStatuses) {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
    redirect: 'follow',
  });
  if (missingStatuses.includes(res.status)) return { missing: true, res };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { missing: false, res };
}

async function fetchJson(url, cfg, headers) {
  const { missing, res } = await fetchRaw(url, cfg, headers, [404]);
  if (missing) return { status: 404, body: null };
  return { status: res.status, body: await res.json() };
}

async function fetchText(url, cfg, missingStatuses = [404]) {
  const { missing, res } = await fetchRaw(url, cfg, { accept: '*/*' }, missingStatuses);
  if (missing) return { missing: true, text: null };
  return { missing: false, text: await res.text() };
}

// Returns { exists, versions } on a definitive answer, { unknown: true } when
// the registry could not be reached (caller must fail open).
async function npmPackage(name, cfg) {
  const cached = readCache(cfg, 'npm', name);
  if (cached) return cached;
  if (cfg.offline) return { unknown: true, reason: 'offline' };
  const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name;
  try {
    const { status, body } = await fetchJson(`${cfg.registries.npm}/${encoded}`, cfg, {
      // abbreviated metadata: orders of magnitude smaller than the full doc
      accept: 'application/vnd.npm.install-v1+json',
    });
    const entry =
      status === 404
        ? { fetchedAt: Date.now(), exists: false, versions: [] }
        : { fetchedAt: Date.now(), exists: true, versions: Object.keys(body.versions || {}) };
    writeCache(cfg, 'npm', name, entry);
    return entry;
  } catch (err) {
    return { unknown: true, reason: String(err && err.message) };
  }
}

async function pypiPackage(name, cfg) {
  const cached = readCache(cfg, 'pypi', name);
  if (cached) return cached;
  if (cfg.offline) return { unknown: true, reason: 'offline' };
  try {
    const { status, body } = await fetchJson(
      `${cfg.registries.pypi}/pypi/${encodeURIComponent(name)}/json`,
      cfg,
      { accept: 'application/json' }
    );
    const entry =
      status === 404
        ? { fetchedAt: Date.now(), exists: false, versions: [] }
        : { fetchedAt: Date.now(), exists: true, versions: Object.keys(body.releases || {}) };
    writeCache(cfg, 'pypi', name, entry);
    return entry;
  } catch (err) {
    return { unknown: true, reason: String(err && err.message) };
  }
}

async function cratesPackage(name, cfg) {
  const cached = readCache(cfg, 'crates', name);
  if (cached) return cached;
  if (cfg.offline) return { unknown: true, reason: 'offline' };
  try {
    const { status, body } = await fetchJson(
      `${cfg.registries.crates}/api/v1/crates/${encodeURIComponent(name)}`,
      cfg,
      { accept: 'application/json' }
    );
    const entry =
      status === 404
        ? { fetchedAt: Date.now(), exists: false, versions: [] }
        : {
            fetchedAt: Date.now(),
            exists: true,
            versions: (body.versions || []).map((v) => v.num),
          };
    writeCache(cfg, 'crates', name, entry);
    return entry;
  } catch (err) {
    return { unknown: true, reason: String(err && err.message) };
  }
}

// Go module proxy path encoding: uppercase letters become "!<lower>".
function goEscape(modulePath) {
  return modulePath.replace(/[A-Z]/g, (c) => '!' + c.toLowerCase());
}

async function goModule(modulePath, cfg) {
  const cached = readCache(cfg, 'go', modulePath);
  if (cached) return cached;
  if (cfg.offline) return { unknown: true, reason: 'offline' };
  try {
    // proxy returns 404 or 410 for unknown modules
    const { missing, text } = await fetchText(
      `${cfg.registries.goproxy}/${goEscape(modulePath)}/@v/list`,
      cfg,
      [404, 410]
    );
    const entry = missing
      ? { fetchedAt: Date.now(), exists: false, versions: [] }
      : { fetchedAt: Date.now(), exists: true, versions: text.split('\n').filter(Boolean) };
    writeCache(cfg, 'go', modulePath, entry);
    return entry;
  } catch (err) {
    return { unknown: true, reason: String(err && err.message) };
  }
}

async function gemPackage(name, cfg) {
  const cached = readCache(cfg, 'gem', name);
  if (cached) return cached;
  if (cfg.offline) return { unknown: true, reason: 'offline' };
  try {
    const { status, body } = await fetchJson(
      `${cfg.registries.rubygems}/api/v1/versions/${encodeURIComponent(name)}.json`,
      cfg,
      { accept: 'application/json' }
    );
    const entry =
      status === 404
        ? { fetchedAt: Date.now(), exists: false, versions: [] }
        : { fetchedAt: Date.now(), exists: true, versions: (body || []).map((v) => v.number) };
    writeCache(cfg, 'gem', name, entry);
    return entry;
  } catch (err) {
    return { unknown: true, reason: String(err && err.message) };
  }
}

async function mavenArtifact(groupId, artifactId, cfg) {
  const key = `${groupId}:${artifactId}`;
  const cached = readCache(cfg, 'maven', key);
  if (cached) return cached;
  if (cfg.offline) return { unknown: true, reason: 'offline' };
  try {
    const groupPath = groupId.replace(/\./g, '/');
    const { missing, text } = await fetchText(
      `${cfg.registries.maven}/${groupPath}/${artifactId}/maven-metadata.xml`,
      cfg
    );
    const versions = missing
      ? []
      : [...text.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    const entry = { fetchedAt: Date.now(), exists: !missing, versions };
    writeCache(cfg, 'maven', key, entry);
    return entry;
  } catch (err) {
    return { unknown: true, reason: String(err && err.message) };
  }
}

// Best-effort "did you mean" for a missing npm package. Never throws.
async function npmSuggest(name, cfg) {
  if (cfg.offline) return null;
  try {
    const { body } = await fetchJson(
      `${cfg.registries.npm}/-/v1/search?text=${encodeURIComponent(name)}&size=1`,
      cfg,
      { accept: 'application/json' }
    );
    const hit = body && body.objects && body.objects[0];
    return hit ? hit.package.name : null;
  } catch {
    return null;
  }
}

module.exports = {
  npmPackage,
  pypiPackage,
  npmSuggest,
  cratesPackage,
  goModule,
  gemPackage,
  mavenArtifact,
  goEscape,
};
