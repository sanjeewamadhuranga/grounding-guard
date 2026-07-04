'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const packages = require('../verifiers/packages');
const registryLib = require('../lib/registry');
const { tmpdir, startMockRegistry, makeCfg } = require('./helpers');

test('parseManifest: Cargo.toml plain, inline table, dotted table, skips', () => {
  const deps = packages.parseManifest(
    'Cargo.toml',
    `
[package]
name = "demo"

[dependencies]
serde = "1.0"
exactdep = "=2.3.4"
tokio = { version = "1.35", features = ["full"] }
renamed = { version = "0.5", package = "real-crate" }
local = { path = "../local" }
gitdep = { git = "https://example.com/x.git" }
ws = { workspace = true }

[dev-dependencies]
criterion = "0.5"

[dependencies.hyper]
version = "1.1"
`
  );
  assert.deepStrictEqual(
    deps.map((d) => [d.name, d.pin, d.exact]),
    [
      ['serde', '1.0', false],
      ['exactdep', '2.3.4', true],
      ['tokio', '1.35', false],
      ['real-crate', '0.5', false],
      ['criterion', '0.5', false],
      ['hyper', '1.1', false],
    ]
  );
});

test('parseManifest: go.mod require block, pseudo-versions, skips directives', () => {
  const deps = packages.parseManifest(
    'go.mod',
    `
module example.com/me/app

go 1.22

require (
	github.com/pkg/errors v0.9.1
	golang.org/x/sync v0.5.0 // indirect
	github.com/weird/pseudo v0.0.0-20230101120000-abcdef123456
)

require github.com/one/liner v1.2.3

replace github.com/pkg/errors => ../local-errors

replace github.com/a/b => github.com/c/d v9.9.9
`
  );
  const names = deps.map((d) => [d.name, d.pin]);
  assert.deepStrictEqual(names, [
    ['github.com/pkg/errors', 'v0.9.1'],
    ['golang.org/x/sync', 'v0.5.0'],
    ['github.com/weird/pseudo', null],
    ['github.com/one/liner', 'v1.2.3'],
  ]);
});

test('parseManifest: Gemfile constraints, exact pins, skips path/git', () => {
  const deps = packages.parseManifest(
    'Gemfile',
    `
source "https://rubygems.org"

gem "rails", "~> 7.1"
gem 'pg', '>= 1.1', '< 2.0'
gem "puma", "6.4.0"
gem "eq", "= 3.2.1"
gem "local", path: "../local"
gem "gh", git: "https://example.com/x.git"
gem "plain"
`
  );
  assert.deepStrictEqual(
    deps.map((d) => [d.name, d.pin, d.exact]),
    [
      ['rails', '7.1', false],
      ['pg', null, false],
      ['puma', '6.4.0', true],
      ['eq', '3.2.1', true],
      ['plain', null, false],
    ]
  );
});

test('parseManifest: pom.xml and build.gradle coordinates', () => {
  const pom = packages.parseManifest(
    'pom.xml',
    `
<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>propver</artifactId>
      <version>\${example.version}</version>
    </dependency>
  </dependencies>
</project>
`
  );
  assert.deepStrictEqual(
    pom.map((d) => [d.name, d.pin]),
    [
      ['com.google.guava:guava', '33.0.0-jre'],
      ['org.example:propver', null],
    ]
  );

  const gradle = packages.parseManifest(
    'build.gradle',
    `
dependencies {
    implementation 'com.squareup.okhttp3:okhttp:4.12.0'
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.1")
    implementation "org.dyn:dyn:\${dynVersion}"
    implementation 'org.plus:plus:1.+'
}
`
  );
  assert.deepStrictEqual(
    gradle.map((d) => [d.name, d.pin]),
    [
      ['com.squareup.okhttp3:okhttp', '4.12.0'],
      ['org.junit.jupiter:junit-jupiter', '5.10.1'],
      ['org.dyn:dyn', null],
      ['org.plus:plus', null],
    ]
  );
});

test('goEscape encodes capitals for the module proxy', () => {
  assert.strictEqual(registryLib.goEscape('github.com/Azure/azure-sdk'), 'github.com/!azure/azure-sdk');
});

test('versionKnown: exact and prefix semantics', () => {
  const versions = ['1.0.218', '1.0.219', '2.0.0'];
  assert.ok(packages.versionKnown(versions, '1.0.219', false));
  assert.ok(!packages.versionKnown(versions, '1.0', false));
  assert.ok(packages.versionKnown(versions, '1.0', true));
  assert.ok(!packages.versionKnown(versions, '3.0', true));
});

test('verify: fabricated crate blocks, range base prefix passes', async () => {
  const dir = tmpdir();
  const { server, url } = await startMockRegistry({ serde: ['1.0.218', '1.0.219'] });
  try {
    const cfg = makeCfg(dir, url);
    const findings = await packages.verify(
      path.join(dir, 'Cargo.toml'),
      `
[dependencies]
serde = "1.0"
rust-super-helpers = "3.1"
`,
      cfg
    );
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'block');
    assert.match(findings[0].message, /rust-super-helpers/);
    assert.match(findings[0].message, /crates\.io/);
  } finally {
    server.close();
  }
});

test('verify: fabricated Go module and unpublished version block', async () => {
  const dir = tmpdir();
  const { server, url } = await startMockRegistry({
    'github.com/pkg/errors': ['v0.8.0', 'v0.9.1'],
  });
  try {
    const cfg = makeCfg(dir, url);
    const findings = await packages.verify(
      path.join(dir, 'go.mod'),
      `
module example.com/me

require (
	github.com/pkg/errors v0.9.1
	github.com/fabricated/gohelper v1.0.0
)
`,
      cfg
    );
    assert.strictEqual(findings.length, 1);
    assert.match(findings[0].message, /github\.com\/fabricated\/gohelper/);

    const badVer = await packages.verify(
      path.join(dir, 'go.mod'),
      'module example.com/me\nrequire github.com/pkg/errors v9.9.9\n',
      cfg
    );
    assert.strictEqual(badVer[0].severity, 'block');
    assert.match(badVer[0].message, /v9\.9\.9 has never been published/);
  } finally {
    server.close();
  }
});

test('verify: fabricated gem and maven artifact block', async () => {
  const dir = tmpdir();
  const { server, url } = await startMockRegistry({
    rails: ['7.1.0', '7.1.3'],
    'com.google.guava:guava': ['32.0.0-jre', '33.0.0-jre'],
  });
  try {
    const cfg = makeCfg(dir, url);
    const gems = await packages.verify(
      path.join(dir, 'Gemfile'),
      'gem "rails", "~> 7.1"\ngem "rails-turbo-magic-pro"\n',
      cfg
    );
    assert.strictEqual(gems.length, 1);
    assert.match(gems[0].message, /rails-turbo-magic-pro/);
    assert.match(gems[0].message, /RubyGems/);

    const maven = await packages.verify(
      path.join(dir, 'build.gradle'),
      "dependencies { implementation 'com.google.guava:guava:33.0.0-jre'\nimplementation 'com.fabricated:helper-core:1.0.0' }",
      cfg
    );
    assert.strictEqual(maven.length, 1);
    assert.match(maven[0].message, /com\.fabricated:helper-core/);
    assert.match(maven[0].message, /Maven Central/);
  } finally {
    server.close();
  }
});
