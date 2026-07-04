---
name: gguard-report
description: Summarize Grounding Guard findings for this session or recent sessions — fabricated packages, unpublished versions, unresolved imports, and nonexistent git SHAs that were caught and corrected.
---

# Grounding Guard Report

Summarize what Grounding Guard caught.

1. Find the session logs: `~/.cache/grounding-guard/sessions/*.jsonl`. Each line is one finding event with `ts`, `mode`, `verifier`, `severity`, `name`, `message`. Prefer the file matching the current session id if known; otherwise use the most recently modified files (last 24h).
2. Read the relevant log file(s) and aggregate:
   - Total findings by verifier (`packages`, `imports`, `gitrefs`) and severity (`block`, `warn`, `info`).
   - List each distinct fabricated reference caught (name + one-line reason).
   - Note which were blocking (Claude was forced to self-correct) vs. warnings.
3. Present a short report:
   - Headline count ("Grounding Guard caught N fabricated references this session").
   - Table or list of findings.
   - If zero findings: say so plainly — that is the desired state.

Do not re-verify anything against registries here; this skill only reports what the hooks already logged.
