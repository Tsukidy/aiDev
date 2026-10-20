#!/bin/sh
# Claude Code SessionStart hook placed by scripts/install.mjs (ticket #21,
# spec #11 D7): injects the poteto-mode routing mandate unless the pstack
# model sheet says `session hook: off`.
#
# Adapted from pstack-claude's plugins/pstack/hooks/session-start.sh @ 94f5ce9
# (MIT; see the licenses directory beside this install). Upstream serves three
# runtimes from a plugin root; this copy serves Claude Code only and reads its
# two companions from its own directory, where the installer puts them:
# session-start-context.md (skills/setup-pstack/hooks/) and read-sheet.sh
# (skills/setup-pstack/scripts/).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md"

# A sheet that cannot be decoded counts as missing, so injection stays on.
if [ -f "$sheet" ] && [ -r "$sheet" ] && normalized=$(sh "$here/read-sheet.sh" "$sheet"); then
	:
else
	normalized=
fi
if printf '%s\n' "$normalized" | grep -qx 'session hook: off'; then
	exit 0
fi

cat "$here/session-start-context.md"
