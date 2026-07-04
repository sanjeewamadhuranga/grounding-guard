---
name: gguard-config
description: Configure Grounding Guard — set per-verifier modes (block/warn/off), allowlist private or internal package names, point at private registries, or adjust timeouts.
---

# Grounding Guard Config

Help the user create or edit their Grounding Guard configuration.

Config files (later overrides earlier, deep-merged):
1. `~/.gguard.json` — user defaults
2. `.gguard.json` in the project root — per-project overrides

Full schema with defaults:

```json
{
  "verifiers": {
    "packages": "block",
    "imports": "warn",
    "gitrefs": "warn"
  },
  "allow": ["@myorg/*", "internal-*"],
  "registries": {
    "npm": "https://registry.npmjs.org",
    "pypi": "https://pypi.org"
  },
  "timeoutMs": 5000,
  "fetchTimeoutMs": 2500,
  "offline": false
}
```

Field notes:
- `verifiers.<name>`: `"block"` (deny/exit-2), `"warn"` (non-blocking feedback), `"off"`.
- `allow`: glob patterns (`*` wildcard) of package/module names never checked against public registries. Use for private packages and monorepo-internal names.
- Private npm registries in `.npmrc` are detected automatically: a non-npmjs default registry disables npm checks entirely; scoped overrides (`@scope:registry=...`) disable checks for that scope.
- `offline: true` forces cache-only operation (never blocks on network).

Workflow:
1. Ask (or infer from the request) what the user wants changed.
2. Read the existing `.gguard.json` if present; merge, don't clobber.
3. Write the file and show the resulting effective config.
4. If the user reports false positives on private packages, add allowlist patterns rather than turning the packages verifier off.
