'use strict';

const path = require('path');
const registry = require('../lib/registry');

const MANIFEST_NAMES = new Set(['package.json', 'pyproject.toml']);

function isManifest(filePath) {
  const base = path.basename(filePath || '');
  return MANIFEST_NAMES.has(base) || /^requirements[\w.-]*\.txt$/.test(base);
}

// Specs that don't resolve against a public registry.
const NON_REGISTRY_SPEC = /^(workspace:|catalog:|file:|link:|portal:|npm:|git\+|git:|github:|gitlab:|bitbucket:|https?:)/;

function parsePackageJson(content) {
  let doc;
  try {
    doc = JSON.parse(content);
  } catch {
    return [];
  }
  const deps = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const obj = doc[section];
    if (!obj || typeof obj !== 'object') continue;
    for (const [name, spec] of Object.entries(obj)) {
      if (typeof spec !== 'string' || NON_REGISTRY_SPEC.test(spec)) continue;
      deps.push({ ecosystem: 'npm', name, spec });
    }
  }
  return deps;
}

// Parses one PEP 508-ish requirement line into { name, pin } or null.
function parseRequirementLine(raw) {
  let line = raw.replace(/(^|\s)#.*$/, '').trim();
  if (!line) return null;
  // option lines, includes, URLs, local paths, editables
  if (/^(-|--)/.test(line)) return null;
  if (/^(https?|git\+|file):/.test(line)) return null;
  if (/^[./]/.test(line)) return null;
  const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/);
  if (!m) return null;
  const name = m[1];
  const rest = m[3] || '';
  if (/@/.test(rest)) return null; // direct reference (name @ url)
  const pinMatch = rest.match(/==\s*([\w.!+*-]+)/);
  const pin = pinMatch && !pinMatch[1].includes('*') ? pinMatch[1] : null;
  return { ecosystem: 'pypi', name, spec: rest.trim() || null, pin };
}

function parseRequirementsTxt(content) {
  const deps = [];
  for (const raw of content.split('\n')) {
    const dep = parseRequirementLine(raw);
    if (dep) deps.push(dep);
  }
  return deps;
}

// Minimal extraction: quoted requirement strings inside any `dependencies`
// array of pyproject.toml ([project] dependencies, optional-dependencies
// groups, dependency-groups).
function parsePyprojectToml(content) {
  const deps = [];
  const collect = (block) => {
    for (const m of block.matchAll(/["']([^"']+)["']/g)) {
      const dep = parseRequirementLine(m[1]);
      if (dep) deps.push(dep);
    }
  };
  // [project] dependencies = [...]
  for (const m of content.matchAll(/^dependencies\s*=\s*(\[[^\]]*\])/gms)) collect(m[1]);
  // every array in [project.optional-dependencies] / [dependency-groups]
  for (const m of content.matchAll(
    /^\[(?:project\.optional-dependencies|dependency-groups)\]([\s\S]*?)(?=^\[|\s*$(?![\s\S]))/gm
  )) {
    for (const arr of m[1].matchAll(/=\s*(\[[^\]]*\])/g)) collect(arr[1]);
  }
  return deps;
}

function parseManifest(filePath, content) {
  const base = path.basename(filePath || '');
  if (base === 'package.json') return parsePackageJson(content);
  if (base === 'pyproject.toml') return parsePyprojectToml(content);
  if (/^requirements[\w.-]*\.txt$/.test(base)) return parseRequirementsTxt(content);
  return [];
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function latest(versions) {
  return versions.length ? [...versions].sort(compareVersions).pop() : null;
}

// Pulls the concrete base version out of an npm range spec ("^1.2.3" -> 1.2.3).
// Returns null for specs with no concrete version (*, latest, tags, ranges
// like ">=1 <2" are reduced to their first version literal).
function npmBaseVersion(spec) {
  if (!spec) return null;
  const m = spec.match(/\d+\.\d+\.\d+[\w.+-]*|\d+\.\d+|\d+(?=$|[\s.x*])/);
  return m ? m[0] : null;
}

function shouldSkipNpm(dep, cfg) {
  if (cfg.npmrc.skipAllNpm) return true;
  if (dep.name.startsWith('@')) {
    const scope = dep.name.split('/')[0];
    if (cfg.npmrc.skipScopes.has(scope)) return true;
  }
  return false;
}

async function verify(filePath, content, cfg) {
  const findings = [];
  const deps = parseManifest(filePath, content);
  for (const dep of deps) {
    if (cfg.isAllowed(dep.name)) continue;
    if (dep.ecosystem === 'npm' && shouldSkipNpm(dep, cfg)) continue;

    const info =
      dep.ecosystem === 'npm'
        ? await registry.npmPackage(dep.name, cfg)
        : await registry.pypiPackage(dep.name, cfg);

    if (info.unknown) {
      findings.push({
        verifier: 'packages',
        severity: 'info',
        name: dep.name,
        message: `could not verify "${dep.name}" (${info.reason || 'registry unreachable'})`,
      });
      continue;
    }

    if (!info.exists) {
      let hint = '';
      if (dep.ecosystem === 'npm') {
        const suggestion = await registry.npmSuggest(dep.name, cfg);
        if (suggestion && suggestion !== dep.name) hint = ` Did you mean "${suggestion}"?`;
      }
      findings.push({
        verifier: 'packages',
        severity: 'block',
        name: dep.name,
        message: `package "${dep.name}" does not exist on ${dep.ecosystem === 'npm' ? 'npm' : 'PyPI'}.${hint} Fabricated dependency names are a supply-chain risk (slopsquatting) — verify the real package name before adding it.`,
      });
      continue;
    }

    // Version-level checks
    if (dep.ecosystem === 'npm') {
      const base = npmBaseVersion(dep.spec);
      if (base && /\d+\.\d+\.\d+/.test(base) && !info.versions.includes(base)) {
        const exact = /^\s*v?\d/.test(dep.spec); // exact pin vs range
        findings.push({
          verifier: 'packages',
          severity: exact ? 'block' : 'warn',
          name: dep.name,
          message: `"${dep.name}@${dep.spec}": version ${base} has never been published (latest is ${latest(info.versions)}).`,
        });
      }
    } else if (dep.pin && !info.versions.includes(dep.pin)) {
      findings.push({
        verifier: 'packages',
        severity: 'block',
        name: dep.name,
        message: `"${dep.name}==${dep.pin}": version ${dep.pin} has never been published on PyPI (latest is ${latest(info.versions)}).`,
      });
    }
  }
  return findings;
}

module.exports = { verify, isManifest, parseManifest, parseRequirementLine, npmBaseVersion, latest };
