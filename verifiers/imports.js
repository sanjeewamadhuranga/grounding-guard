'use strict';

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const JS_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

// Common Python stdlib top-level modules (curated; not exhaustive).
const PY_STDLIB = new Set(
  `os sys re json math typing pathlib subprocess itertools functools collections dataclasses
   asyncio logging unittest datetime time random string io abc enum copy hashlib http urllib
   socket threading multiprocessing queue tempfile shutil glob argparse configparser csv
   sqlite3 uuid base64 pickle struct traceback warnings weakref contextlib inspect importlib
   types textwrap statistics decimal fractions numbers array bisect heapq secrets ssl select
   signal errno stat platform getpass calendar zoneinfo tomllib zipfile tarfile gzip bz2 lzma
   fnmatch filecmp fileinput linecache codecs unicodedata html xml email mimetypes binascii
   webbrowser wsgiref ftplib smtplib socketserver xmlrpc ipaddress concurrent ctypes venv ast
   dis tokenize keyword builtins __future__ pdb cProfile profile timeit doctest pydoc site
   operator gc atexit`.split(/\s+/).filter(Boolean)
);

// import name -> PyPI distribution name, for packages whose import differs
const PY_DIST_ALIASES = {
  cv2: 'opencv-python',
  PIL: 'Pillow',
  sklearn: 'scikit-learn',
  yaml: 'PyYAML',
  bs4: 'beautifulsoup4',
  dotenv: 'python-dotenv',
  dateutil: 'python-dateutil',
  jwt: 'PyJWT',
  OpenSSL: 'pyOpenSSL',
  serial: 'pyserial',
  Crypto: 'pycryptodome',
  github: 'PyGithub',
  docx: 'python-docx',
  pptx: 'python-pptx',
  fitz: 'PyMuPDF',
  attr: 'attrs',
  websockets: 'websockets',
};

function extractJsSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /import\s+[^'";]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^'";]*?from\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isBareJsSpecifier(spec) {
  return !/^[./#]/.test(spec) && !spec.startsWith('node:') && !spec.startsWith('bun:') && !spec.startsWith('data:');
}

function findUp(startDir, predicate) {
  let dir = startDir;
  for (;;) {
    const hit = predicate(dir);
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function jsPackageResolvable(pkg, fromFile) {
  const startDir = path.dirname(path.resolve(fromFile));
  return !!findUp(startDir, (dir) => {
    if (fs.existsSync(path.join(dir, 'node_modules', pkg))) return true;
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          if (doc[section] && doc[section][pkg] !== undefined) return true;
        }
      } catch {}
    }
    return false;
  });
}

function verifyJs(filePath, addedSource, cfg) {
  const findings = [];
  const seen = new Set();
  for (const spec of extractJsSpecifiers(addedSource)) {
    if (!isBareJsSpecifier(spec)) continue;
    const pkg = packageNameOf(spec);
    if (seen.has(pkg) || builtinModules.includes(pkg) || cfg.isAllowed(pkg)) continue;
    seen.add(pkg);
    if (!jsPackageResolvable(pkg, filePath)) {
      findings.push({
        verifier: 'imports',
        severity: 'warn',
        name: pkg,
        message: `import "${pkg}" is not installed and not declared in any package.json up the tree — verify the package name is real before relying on it.`,
      });
    }
  }
  return findings;
}

function extractPyModules(source) {
  const mods = new Set();
  for (const m of source.matchAll(/^\s*import\s+([A-Za-z_][\w]*(?:\s*,\s*[A-Za-z_][\w]*)*)/gm)) {
    for (const name of m[1].split(',')) mods.add(name.trim().split('.')[0]);
  }
  for (const m of source.matchAll(/^\s*from\s+([A-Za-z_][\w]*)[\w.]*\s+import\b/gm)) {
    mods.add(m[1]);
  }
  return [...mods];
}

function normalizePyName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function collectDeclaredPyDeps(startDir) {
  const declared = new Set();
  findUp(startDir, (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (entry === 'pyproject.toml' || /^requirements[\w.-]*\.txt$/.test(entry)) {
        try {
          const text = fs.readFileSync(path.join(dir, entry), 'utf8');
          for (const m of text.matchAll(/^[\s"']*([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) {
            declared.add(normalizePyName(m[1]));
          }
        } catch {}
      }
    }
    // stop at the first dir containing a python project marker
    return fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, '.git'));
  });
  return declared;
}

function pyModuleInSitePackages(mod, startDir) {
  const venvNames = ['.venv', 'venv', 'env'];
  return !!findUp(startDir, (dir) => {
    for (const venv of venvNames) {
      const lib = path.join(dir, venv, 'lib');
      if (!fs.existsSync(lib)) continue;
      let pyDirs = [];
      try {
        pyDirs = fs.readdirSync(lib).filter((d) => d.startsWith('python'));
      } catch {}
      for (const pyDir of pyDirs) {
        const site = path.join(lib, pyDir, 'site-packages');
        if (
          fs.existsSync(path.join(site, mod)) ||
          fs.existsSync(path.join(site, `${mod}.py`))
        ) {
          return true;
        }
      }
    }
    return false;
  });
}

function verifyPy(filePath, addedSource, cfg) {
  const findings = [];
  const startDir = path.dirname(path.resolve(filePath));
  const declared = collectDeclaredPyDeps(startDir);
  for (const mod of extractPyModules(addedSource)) {
    if (PY_STDLIB.has(mod) || cfg.isAllowed(mod)) continue;
    const dist = PY_DIST_ALIASES[mod] || mod;
    if (declared.has(normalizePyName(dist)) || declared.has(normalizePyName(mod))) continue;
    if (pyModuleInSitePackages(mod, startDir)) continue;
    findings.push({
      verifier: 'imports',
      severity: 'warn',
      name: mod,
      message: `import "${mod}" is not installed and not declared in requirements/pyproject — verify the module name is real (distribution may be "${dist}").`,
    });
  }
  return findings;
}

function verify(filePath, addedSource, cfg) {
  const ext = path.extname(filePath || '');
  if (JS_EXTS.has(ext)) return verifyJs(filePath, addedSource, cfg);
  if (ext === '.py') return verifyPy(filePath, addedSource, cfg);
  return [];
}

module.exports = { verify, extractJsSpecifiers, extractPyModules, packageNameOf, JS_EXTS };
