'use strict';

const path = require('path');
const registry = require('../lib/registry');

const MANIFEST_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
]);

const REGISTRY_LABEL = {
  npm: 'npm',
  pypi: 'PyPI',
  crates: 'crates.io',
  go: 'the Go module proxy',
  gem: 'RubyGems',
  maven: 'Maven Central',
};

function isManifest(filePath) {
  const base = path.basename(filePath || '');
  return MANIFEST_NAMES.has(base) || /^requirements[\w.-]*\.txt$/.test(base);
}

// Specs that don't resolve against a public registry.
const NON_REGISTRY_SPEC = /^(workspace:|catalog:|file:|link:|portal:|npm:|git\+|git:|github:|gitlab:|bitbucket:|https?:)/;

// Dep shape: { ecosystem, name, spec, pin, exact }
//   pin   — concrete version to check against published versions (null = skip)
//   exact — pin is an exact requirement (missing => block); otherwise it is
//           the base of a range (missing => warn)

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

// Parses one PEP 508-ish requirement line into a dep or null.
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
  return { ecosystem: 'pypi', name, spec: rest.trim() || null, pin, exact: !!pin };
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

function cargoDep(name, spec) {
  // Cargo specs are caret ranges unless prefixed with "="
  const exact = /^\s*=/.test(spec);
  const base = (spec.split(',')[0] || '').replace(/^[=^~><\s]+/, '').trim();
  const pin = /^\d/.test(base) ? base : null;
  return { ecosystem: 'crates', name, spec, pin, exact: exact && !!pin };
}

function parseCargoToml(content) {
  const deps = [];
  for (const raw of content.split(/^\[/m).slice(1)) {
    const close = raw.indexOf(']');
    if (close === -1) continue;
    const header = raw.slice(0, close).replace(/["']/g, '');
    const body = raw.slice(close + 1);

    // [dependencies.serde] style table
    const single = header.match(/(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]+)$/);
    if (single) {
      if (/^\s*(path|git|workspace)\s*=/m.test(body)) continue;
      const pkg = body.match(/^\s*package\s*=\s*["']([^"']+)["']/m);
      const ver = body.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
      if (ver) deps.push(cargoDep(pkg ? pkg[1] : single[1], ver[1]));
      continue;
    }

    if (!/(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)$/.test(header)) continue;
    for (const line of body.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      let [, name, value] = m;
      let spec = null;
      if (/^["']/.test(value)) {
        spec = value.replace(/^["']/, '').replace(/["'],?\s*$/, '');
      } else if (value.startsWith('{')) {
        if (/\b(path|git|workspace)\s*=/.test(value)) continue;
        const pkg = value.match(/package\s*=\s*["']([^"']+)["']/);
        if (pkg) name = pkg[1];
        const ver = value.match(/version\s*=\s*["']([^"']+)["']/);
        if (!ver) continue;
        spec = ver[1];
      } else {
        continue;
      }
      deps.push(cargoDep(name, spec));
    }
  }
  return deps;
}

const GO_PSEUDO_VERSION = /-\d{14}-[0-9a-f]{12}$/;

function parseGoMod(content) {
  const deps = [];
  const text = content.replace(/\/\/.*$/gm, '');
  // matches "require mod vX" one-liners and "mod vX" lines inside require blocks;
  // replace/exclude/module/go lines don't fit the shape
  for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.~-]+(?:\/[\w.~-]+)+)\s+(v[\w.+-]+)\s*$/gm)) {
    const [, mod, ver] = m;
    if (!mod.split('/')[0].includes('.')) continue; // module paths start with a domain
    deps.push({
      ecosystem: 'go',
      name: mod,
      spec: ver,
      // pseudo-versions never appear in the proxy's @v/list
      pin: GO_PSEUDO_VERSION.test(ver) ? null : ver,
      exact: true,
    });
  }
  return deps;
}

function parseGemfile(content) {
  const deps = [];
  for (const m of content.matchAll(/^\s*gem\s+["']([A-Za-z0-9_.-]+)["']([^\n]*)$/gm)) {
    const [, name, rest] = m;
    if (/(\bpath:|\bgit:|\bgithub:|:path\b|:git\b|:github\b)/.test(rest)) continue;
    const strings = [...rest.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    const constraints = strings.filter((s) => /^\s*(~>|>=|<=|>|<|=|\d)/.test(s));
    let pin = null;
    let exact = false;
    for (const c of constraints) {
      const cm = c.match(/^\s*(~>|>=|<=|>|<|=)?\s*([\w.]+)\s*$/);
      if (!cm) continue;
      if (!cm[1] || cm[1] === '=') {
        pin = cm[2];
        exact = true;
        break;
      }
      if (cm[1] === '~>' && !pin) pin = cm[2];
    }
    deps.push({ ecosystem: 'gem', name, spec: constraints.join(', ') || null, pin, exact });
  }
  return deps;
}

function parsePomXml(content) {
  const deps = [];
  for (const m of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = m[1];
    const g = block.match(/<groupId>([^<]+)<\/groupId>/);
    const a = block.match(/<artifactId>([^<]+)<\/artifactId>/);
    if (!g || !a) continue;
    if (g[1].includes('${') || a[1].includes('${')) continue;
    const v = block.match(/<version>([^<]+)<\/version>/);
    const ver = v ? v[1].trim() : null;
    // property references and range versions: existence check only
    const pin = ver && !ver.includes('${') && /^\d/.test(ver) ? ver : null;
    deps.push({ ecosystem: 'maven', name: `${g[1].trim()}:${a[1].trim()}`, spec: ver, pin, exact: true });
  }
  return deps;
}

function parseGradle(content) {
  const deps = [];
  const re =
    /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|classpath|kapt|ksp)\s*[( ]\s*["']([\w.-]+):([\w.-]+):([^"':]+)["']/g;
  for (const m of content.matchAll(re)) {
    const [, g, a, v] = m;
    const dynamic = v.includes('$') || v.includes('+') || /^latest\./.test(v);
    deps.push({ ecosystem: 'maven', name: `${g}:${a}`, spec: v, pin: dynamic ? null : v, exact: true });
  }
  return deps;
}

function parseManifest(filePath, content) {
  const base = path.basename(filePath || '');
  if (base === 'package.json') return parsePackageJson(content);
  if (base === 'pyproject.toml') return parsePyprojectToml(content);
  if (base === 'Cargo.toml') return parseCargoToml(content);
  if (base === 'go.mod') return parseGoMod(content);
  if (base === 'Gemfile') return parseGemfile(content);
  if (base === 'pom.xml') return parsePomXml(content);
  if (base === 'build.gradle' || base === 'build.gradle.kts') return parseGradle(content);
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
function npmBaseVersion(spec) {
  if (!spec) return null;
  const m = spec.match(/\d+\.\d+\.\d+[\w.+-]*|\d+\.\d+|\d+(?=$|[\s.x*])/);
  return m ? m[0] : null;
}

// True if pin is a published version — exact match, or (for range bases) a
// prefix of one ("1.0" satisfied by "1.0.219").
function versionKnown(versions, pin, prefixOk) {
  if (versions.includes(pin)) return true;
  if (!prefixOk) return false;
  return versions.some((v) => v.startsWith(pin + '.'));
}

function shouldSkipNpm(dep, cfg) {
  if (cfg.npmrc.skipAllNpm) return true;
  if (dep.name.startsWith('@')) {
    const scope = dep.name.split('/')[0];
    if (cfg.npmrc.skipScopes.has(scope)) return true;
  }
  return false;
}

function lookup(dep, cfg) {
  switch (dep.ecosystem) {
    case 'npm':
      return registry.npmPackage(dep.name, cfg);
    case 'pypi':
      return registry.pypiPackage(dep.name, cfg);
    case 'crates':
      return registry.cratesPackage(dep.name, cfg);
    case 'go':
      return registry.goModule(dep.name, cfg);
    case 'gem':
      return registry.gemPackage(dep.name, cfg);
    case 'maven': {
      const [group, artifact] = dep.name.split(':');
      return registry.mavenArtifact(group, artifact, cfg);
    }
    default:
      return { unknown: true, reason: `unsupported ecosystem ${dep.ecosystem}` };
  }
}

async function verify(filePath, content, cfg) {
  const findings = [];
  const deps = parseManifest(filePath, content);
  for (const dep of deps) {
    if (cfg.isAllowed(dep.name)) continue;
    if (dep.ecosystem === 'npm' && shouldSkipNpm(dep, cfg)) continue;

    const info = await lookup(dep, cfg);
    const label = REGISTRY_LABEL[dep.ecosystem] || dep.ecosystem;

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
        message: `package "${dep.name}" does not exist on ${label}.${hint} Fabricated dependency names are a supply-chain risk (slopsquatting) — verify the real package name before adding it.`,
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
    } else if (dep.pin && !versionKnown(info.versions, dep.pin, !dep.exact)) {
      findings.push({
        verifier: 'packages',
        severity: dep.exact ? 'block' : 'warn',
        name: dep.name,
        message: `"${dep.name}" ${dep.spec || dep.pin}: version ${dep.pin} has never been published on ${label} (latest is ${latest(info.versions)}).`,
      });
    }
  }
  return findings;
}

module.exports = {
  verify,
  isManifest,
  parseManifest,
  parseRequirementLine,
  npmBaseVersion,
  latest,
  versionKnown,
};
