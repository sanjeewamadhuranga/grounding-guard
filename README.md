# Grounding Guard [![Listed on ClaudePluginHub](https://www.claudepluginhub.com/badge/sanjeewamadhuranga-grounding-guard)](https://www.claudepluginhub.com/plugins/sanjeewamadhuranga-grounding-guard?ref=badge)

**Hook-enforced ground-truth verification for Claude Code.** Catches fabricated package names, unpublished versions, unresolvable imports, and nonexistent git SHAs *before* they land — and feeds the correction back to Claude so it fixes itself in-loop, usually without you noticing.

## Why

LLM coding agents sometimes "rush to completion": they invent plausible-looking package names, pin versions that were never published, or reference commit SHAs that don't exist. Beyond wasted debugging time, fabricated package names are a real supply-chain attack surface — attackers pre-register commonly hallucinated names (**slopsquatting**).

Advisory prompts and best-practice skills can be skipped by the model. Hooks can't. Grounding Guard verifies mechanically, at the harness level.

## What it checks

| Verifier | Trigger | Checks | Default |
|---|---|---|---|
| `packages` | edits to `package.json`, `requirements*.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `pom.xml`, `build.gradle(.kts)`; manifests touched at commit time | package exists on npm / PyPI / crates.io / Go module proxy / RubyGems / Maven Central; pinned version was actually published | **block** |
| `imports` | new `import`/`require` statements in JS/TS/Python edits | bare specifier resolves against `node_modules`/declared deps; Python module is stdlib, installed, or declared (with common alias mapping, e.g. `cv2` → `opencv-python`) | warn |
| `gitrefs` | `git commit` commands | every SHA mentioned in the commit message exists in the repo | warn |

**Block** findings return exit 2 from the PostToolUse hook — Claude sees the reason ("package `foo-utils` does not exist on npm. Did you mean `foo-util`?") and corrects itself immediately. At commit time, hard failures deny the command with the reason. **Warn** findings are injected as non-blocking context.

## Install

```
/plugin marketplace add sanjeewamadhuranga/grounding-guard
/plugin install grounding-guard@grounding-guard-marketplace
```

Requires Node ≥ 18 on PATH (already true for every Claude Code install).

## Configure

`~/.gguard.json` (user-wide) and `.gguard.json` in your project root (wins on conflict):

```json
{
  "verifiers": { "packages": "block", "imports": "warn", "gitrefs": "warn" },
  "allow": ["@myorg/*", "internal-*"]
}
```

Or just run `/gguard-config` and describe what you want.

- **Private packages**: names matching `allow` globs are never checked. Private npm registries in `.npmrc` are auto-detected (non-npmjs default registry ⇒ npm checks off; `@scope:registry=` ⇒ that scope skipped). Monorepo `workspace:`, `file:`, `git:` and similar specs are always skipped.
- **Report**: `/gguard-report` summarizes everything caught this session.

## Design guarantees

- **Fail-open.** Registry unreachable, node missing, parse error, deadline exceeded (5s hard cap) — the hook exits 0 and your session continues. Verification never becomes the thing that breaks your flow.
- **Fast.** Registry answers are cached locally (24h positive / 1h negative) in `~/.cache/grounding-guard/`; repeat checks are offline-fast. Verifiers only run when a diff touches a manifest or adds an import.
- **Private.** Your code never leaves your machine. The only network traffic is package *names/versions* queried against the public registries you already publish lockfiles for. No telemetry.

## Limitations (v0.2)

- Range specs (`^1.2.3`, `~> 7.1`, cargo caret defaults) get a warn (not block) when the base version was never published; exact pins block. Go pseudo-versions and dynamic Gradle versions (`1.+`, `${prop}`) get existence checks only.
- Python import→distribution mapping uses a curated alias list; unknown aliases produce warnings, not blocks (by design — imports verifier is warn-only by default).
- API symbol verification (calls against installed type definitions) is planned for v0.2.

## License

MIT
