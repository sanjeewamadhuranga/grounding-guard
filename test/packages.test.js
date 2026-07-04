'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const packages = require('../verifiers/packages');
const { tmpdir, startMockRegistry, makeCfg } = require('./helpers');

test('parseManifest: package.json sections and non-registry specs', () => {
  const deps = packages.parseManifest(
    'package.json',
    JSON.stringify({
      dependencies: {
        express: '^4.18.2',
        internal: 'workspace:*',
        local: 'file:../local',
        repo: 'github:user/repo',
        aliased: 'npm:real-pkg@1.0.0',
      },
      devDependencies: { vitest: '3.0.0' },
    })
  );
  const names = deps.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ['express', 'vitest']);
});

test('parseManifest: requirements.txt skips options, URLs, paths', () => {
  const deps = packages.parseManifest(
    'requirements.txt',
    [
      '# comment',
      '-r base.txt',
      '--index-url https://private/simple',
      'requests==2.31.0',
      'flask>=2.0',
      'numpy',
      './local-pkg',
      'pkg @ https://example.com/pkg.whl',
      'https://example.com/direct.whl',
    ].join('\n')
  );
  assert.deepStrictEqual(
    deps.map((d) => [d.name, d.pin]),
    [
      ['requests', '2.31.0'],
      ['flask', null],
      ['numpy', null],
    ]
  );
});

test('parseManifest: pyproject.toml dependency arrays', () => {
  const deps = packages.parseManifest(
    'pyproject.toml',
    `
[project]
name = "demo"
dependencies = [
  "requests==2.31.0",
  "pydantic>=2",
]

[project.optional-dependencies]
dev = ["pytest"]
`
  );
  assert.deepStrictEqual(deps.map((d) => d.name), ['requests', 'pydantic', 'pytest']);
});

test('npmBaseVersion extracts concrete versions from ranges', () => {
  assert.strictEqual(packages.npmBaseVersion('^1.2.3'), '1.2.3');
  assert.strictEqual(packages.npmBaseVersion('~0.4.1-beta.1'), '0.4.1-beta.1');
  assert.strictEqual(packages.npmBaseVersion('4.18.2'), '4.18.2');
  assert.strictEqual(packages.npmBaseVersion('*'), null);
  assert.strictEqual(packages.npmBaseVersion('latest'), null);
});

test('verify: fabricated npm package blocks, real one passes, allowlist skips', async () => {
  const dir = tmpdir();
  const { server, url } = await startMockRegistry({ express: ['4.18.2', '4.19.0'] });
  try {
    const cfg = makeCfg(dir, url, { allow: ['@myorg/*'] });
    const manifest = JSON.stringify({
      dependencies: {
        express: '^4.18.2',
        'definitely-fabricated-pkg-xq12': '^2.0.0',
        '@myorg/private-thing': '1.0.0',
      },
    });
    const findings = await packages.verify(path.join(dir, 'package.json'), manifest, cfg);
    const blocks = findings.filter((f) => f.severity === 'block');
    assert.strictEqual(blocks.length, 1);
    assert.match(blocks[0].message, /definitely-fabricated-pkg-xq12/);
    assert.match(blocks[0].message, /Did you mean "express"/);
  } finally {
    server.close();
  }
});

test('verify: unpublished exact npm pin blocks, unpublished range base warns', async () => {
  const dir = tmpdir();
  const { server, url } = await startMockRegistry({ express: ['4.18.2'] });
  try {
    const cfg = makeCfg(dir, url);
    const exact = await packages.verify(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { express: '9.9.9' } }),
      cfg
    );
    assert.strictEqual(exact[0].severity, 'block');
    assert.match(exact[0].message, /9\.9\.9 has never been published/);

    const range = await packages.verify(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { express: '^9.9.9' } }),
      cfg
    );
    assert.strictEqual(range[0].severity, 'warn');
  } finally {
    server.close();
  }
});

test('verify: fabricated PyPI package and version block', async () => {
  const dir = tmpdir();
  const { server, url } = await startMockRegistry({ requests: ['2.31.0'] });
  try {
    const cfg = makeCfg(dir, url);
    const findings = await packages.verify(
      path.join(dir, 'requirements.txt'),
      'requests==2.31.0\nrequests-supercharged-pro==1.0.0\n',
      cfg
    );
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'block');
    assert.match(findings[0].message, /requests-supercharged-pro/);

    const badPin = await packages.verify(path.join(dir, 'requirements.txt'), 'requests==99.0.0\n', cfg);
    assert.strictEqual(badPin[0].severity, 'block');
  } finally {
    server.close();
  }
});

test('verify: unreachable registry fails open (info only)', async () => {
  const dir = tmpdir();
  const cfg = makeCfg(dir, 'http://127.0.0.1:1', { fetchTimeoutMs: 300 });
  const findings = await packages.verify(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { anything: '1.0.0' } }),
    cfg
  );
  assert.ok(findings.every((f) => f.severity === 'info'));
});

test('verify: private default registry in .npmrc disables npm checks', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.npmrc'), 'registry=https://npm.internal.corp/\n');
  const cfg = makeCfg(dir, 'http://127.0.0.1:1');
  const findings = await packages.verify(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { 'corp-internal-pkg': '1.0.0' } }),
    cfg
  );
  assert.strictEqual(findings.length, 0);
});
