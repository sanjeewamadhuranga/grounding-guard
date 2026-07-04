'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  // per-verifier mode: "block" | "warn" | "off"
  verifiers: {
    packages: 'block',
    imports: 'warn',
    gitrefs: 'warn',
  },
  // glob patterns for package names that should never be checked against
  // public registries (private/internal packages)
  allow: [],
  registries: {
    npm: 'https://registry.npmjs.org',
    pypi: 'https://pypi.org',
    crates: 'https://crates.io',
    goproxy: 'https://proxy.golang.org',
    rubygems: 'https://rubygems.org',
    maven: 'https://repo1.maven.org/maven2',
  },
  timeoutMs: 5000,
  fetchTimeoutMs: 2500,
  offline: false,
  cacheDir: path.join(os.homedir(), '.cache', 'grounding-guard'),
};

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function merge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

// Parse .npmrc files to detect private registries. If the default registry is
// overridden, npm existence checks would produce false positives, so npm
// checking is disabled entirely. Scoped registry overrides disable checks for
// that scope only.
function npmrcOverrides(cwd) {
  const result = { skipAllNpm: false, skipScopes: new Set() };
  const files = [path.join(cwd || '', '.npmrc'), path.join(os.homedir(), '.npmrc')];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const m = line.match(/^(@[^:=]+)?:?registry\s*=\s*(.+)$/);
      if (!m) continue;
      const scope = m[1];
      const url = m[2].trim();
      const isPublic = /^https?:\/\/registry\.npmjs\.org\/?$/.test(url);
      if (scope) {
        if (!isPublic) result.skipScopes.add(scope);
      } else if (!isPublic) {
        result.skipAllNpm = true;
      }
    }
  }
  return result;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function load(cwd) {
  const user = readJsonSafe(path.join(os.homedir(), '.gguard.json'));
  const project = cwd ? readJsonSafe(path.join(cwd, '.gguard.json')) : null;
  const cfg = merge(merge(DEFAULTS, user), project);
  cfg.allowMatchers = (cfg.allow || []).map(globToRegExp);
  cfg.npmrc = npmrcOverrides(cwd);
  cfg.isAllowed = (name) => cfg.allowMatchers.some((re) => re.test(name));
  return cfg;
}

module.exports = { load, DEFAULTS, npmrcOverrides, globToRegExp };
