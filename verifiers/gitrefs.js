'use strict';

const { execFileSync } = require('child_process');

// Candidate SHAs: 7-40 hex chars containing at least one digit AND one letter,
// so issue numbers ("1234567") and ordinary words don't match.
function extractShaCandidates(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    const sha = m[0];
    if (/[a-f]/.test(sha) && /\d/.test(sha)) out.add(sha);
  }
  return [...out];
}

function shaExists(sha, cwd) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{object}`], {
      cwd,
      stdio: 'ignore',
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function verify(text, cwd) {
  const findings = [];
  for (const sha of extractShaCandidates(text)) {
    if (!shaExists(sha, cwd)) {
      findings.push({
        verifier: 'gitrefs',
        severity: 'warn',
        name: sha,
        message: `commit references SHA ${sha}, which does not exist in this repository — likely fabricated; use \`git log\` to find the real one.`,
      });
    }
  }
  return findings;
}

module.exports = { verify, extractShaCandidates };
