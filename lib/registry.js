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

async function fetchJson(url, cfg, headers) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
    redirect: 'follow',
  });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, body: await res.json() };
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

module.exports = { npmPackage, pypiPackage, npmSuggest };
