'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const gitrefs = require('../verifiers/gitrefs');
const { tmpdir } = require('./helpers');

test('extractShaCandidates requires hex with both letters and digits', () => {
  const text = 'fixes 1234567, refs deadbee1 and abc123def456, word abcdefg';
  assert.deepStrictEqual(gitrefs.extractShaCandidates(text), ['deadbee1', 'abc123def456']);
});

test('verify: real SHA passes, fabricated SHA warns', () => {
  const dir = tmpdir();
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
      .toString()
      .trim();
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');
  const realSha = git('rev-parse', 'HEAD');

  const clean = gitrefs.verify(`reverts ${realSha}`, dir);
  assert.strictEqual(clean.length, 0);

  const findings = gitrefs.verify('reverts commit a1b2c3d4e5f60718', dir);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].severity, 'warn');
  assert.match(findings[0].message, /a1b2c3d4e5f60718/);
});
