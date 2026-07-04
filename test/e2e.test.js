'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { tmpdir, startMockRegistry, makeCfg } = require('./helpers');

const GGUARD = path.join(__dirname, '..', 'bin', 'gguard');

// Async spawn: the mock registry server runs in THIS process, so the event
// loop must stay free to answer the child's requests (spawnSync would
// deadlock it into timeouts).
function runHook(mode, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GGUARD, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('close', (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test('e2e write: fabricated dependency in package.json -> exit 2 with feedback', async () => {
  const dir = tmpdir();
  const { server, url } = await startMockRegistry({ express: ['4.18.2'] });
  try {
    makeCfg(dir, url);
    const manifest = path.join(dir, 'package.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({ dependencies: { express: '^4.18.2', 'hallucinated-helper-lib': '^3.1.0' } })
    );
    const res = await runHook('write', {
      session_id: 'e2e-test',
      cwd: dir,
      tool_name: 'Write',
      tool_input: { file_path: manifest, content: '' },
    });
    assert.strictEqual(res.status, 2);
    assert.match(res.stderr, /hallucinated-helper-lib/);
    assert.match(res.stderr, /does not exist on npm/);
  } finally {
    server.close();
  }
});

test('e2e write: clean manifest -> silent exit 0', async () => {
  const dir = tmpdir();
  const { server, url } = await startMockRegistry({ express: ['4.18.2'] });
  try {
    makeCfg(dir, url);
    const manifest = path.join(dir, 'package.json');
    fs.writeFileSync(manifest, JSON.stringify({ dependencies: { express: '^4.18.2' } }));
    const res = await runHook('write', {
      session_id: 'e2e-test',
      cwd: dir,
      tool_name: 'Write',
      tool_input: { file_path: manifest, content: '' },
    });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout.trim(), '');
    assert.strictEqual(res.stderr.trim(), '');
  } finally {
    server.close();
  }
});

test('e2e write: unknown JS import -> non-blocking additionalContext warning', async () => {
  const dir = tmpdir();
  makeCfg(dir, 'http://127.0.0.1:1');
  const file = path.join(dir, 'app.js');
  const added = "import ghost from 'not-a-real-lib-xyz';\n";
  fs.writeFileSync(file, added);
  const res = await runHook('write', {
    session_id: 'e2e-test',
    cwd: dir,
    tool_name: 'Write',
    tool_input: { file_path: file, content: added },
  });
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /not-a-real-lib-xyz/);
});

test('e2e write: Edit only scans added text, pre-existing imports ignored', async () => {
  const dir = tmpdir();
  makeCfg(dir, 'http://127.0.0.1:1');
  const file = path.join(dir, 'app.js');
  fs.writeFileSync(file, "import old from 'preexisting-unknown-lib';\nconst x = 1;\n");
  const res = await runHook('write', {
    session_id: 'e2e-test',
    cwd: dir,
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'const x = 1;', new_string: 'const x = 2;' },
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), '');
});

test('e2e offline: unreachable registry never blocks (fail-open)', async () => {
  const dir = tmpdir();
  makeCfg(dir, 'http://127.0.0.1:1', { fetchTimeoutMs: 300 });
  const manifest = path.join(dir, 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ dependencies: { 'whatever-lib': '1.0.0' } }));
  const res = await runHook('write', {
    session_id: 'e2e-test',
    cwd: dir,
    tool_name: 'Write',
    tool_input: { file_path: manifest, content: '' },
  });
  assert.strictEqual(res.status, 0);
});

test('e2e commit: fabricated package in modified manifest -> permission deny', async () => {
  const dir = tmpdir();
  const { server, url } = await startMockRegistry({ express: ['4.18.2'] });
  const { execFileSync } = require('child_process');
  try {
    makeCfg(dir, url);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'fabricated-commit-dep': '1.0.0' } })
    );
    const res = await runHook('commit', {
      session_id: 'e2e-test',
      cwd: dir,
      tool_name: 'Bash',
      tool_input: { command: 'git add -A && git commit -m "add deps"' },
    });
    assert.strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /fabricated-commit-dep/);
  } finally {
    server.close();
  }
});

test('e2e commit: non-git command ignored instantly', async () => {
  const res = await runHook('commit', {
    session_id: 'e2e-test',
    cwd: tmpdir(),
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), '');
});

test('e2e: malformed stdin fails open', () => {
  const res = spawnSync(process.execPath, [GGUARD, 'write'], {
    input: 'not json at all',
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(res.status, 0);
});
