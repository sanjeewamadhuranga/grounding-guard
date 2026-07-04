#!/usr/bin/env bash
# Fail-open: if node is missing, never break the user's session.
command -v node >/dev/null 2>&1 || exit 0
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
exec node "$ROOT/bin/gguard" commit
