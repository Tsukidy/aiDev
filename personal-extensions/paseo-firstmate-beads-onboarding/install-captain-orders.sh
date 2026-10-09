#!/usr/bin/env bash
#
# install-captain-orders.sh — the behavioral half of beads-as-memory onboarding.
#
# Appends the mate's memory standing orders to its data/captain.md (the surface
# the firstmate plugin never overwrites, which outranks the charter except the
# charter's hard rules, and which the charter requires the mate to read at the
# start of every session), and creates the mate's home memory database — the one
# deliberate exception to "no bd init outside a project base".
#
# Why data/captain.md and not data/charter.md: the plugin renders AGENTS.md from
# data/charter.md and stops following plugin charter updates once the captain
# edits that copy. Verified against firstmate 0.3.4 (server/config.ts,
# templates/data/captain.md, templates/data/charter.md).
#
# Idempotent: the orders block is guarded by the paseo-beads-onboarding markers;
# the home database is created only when the initialized-check says it is absent.
#
# The seven rules the block carries (spec, "Standing orders"):
#   1. spatial scope — which database is decided by which directory you stand in
#   2. never initialize — bd init belongs to onboarding alone
#   3. memory shape — one fact per record; supersede, never delete
#   4. the crewmate brief line
#   5. ambient promotion into AGENTS.md, outside the beads-managed markers
#   6. the bd remember boundary (home database only, never for project facts)
#   7. queue hygiene — memory records never masquerade as queued work

set -euo pipefail

die() {
	printf 'install-captain-orders: %s\n' "$1" >&2
	exit 1
}

PASEO_HOME="${PASEO_HOME:-$HOME/.paseo}"
config="$PASEO_HOME/plugin-data/firstmate/config.json"

command -v node >/dev/null 2>&1 ||
	die "node not found on PATH — it ships with Paseo; install Node.js first"

# The home when the config names none: plugin-data/firstmate/home (firstmate's
# defaultHome()). When the config names one, expand it the way the plugin does
# (resolveHome(): "" -> default, "~", "~/...", absolute paths only).
home=""
if [ -f "$config" ]; then
	home=$(node -e '
		const fs = require("fs");
		let h = "";
		try { h = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).home ?? ""; }
		catch {}
		process.stdout.write(String(h).trim());
	' "$config")
fi
case "$home" in
"") home="$PASEO_HOME/plugin-data/firstmate/home" ;;
"~") home="$HOME" ;;
"~/"*) home="$HOME/${home#"~/"}" ;;
esac
# Legacy location the plugin migrates away from only when it can.
if [ ! -d "$home" ] && [ -d "$PASEO_HOME/plugins/firstmate/home" ]; then
	home="$PASEO_HOME/plugins/firstmate/home"
fi
[ -d "$home" ] ||
	die "first mate home not found at $home — launch the first mate once so its home is created (or set PASEO_HOME)"

# One-time: the mate-global memory database. --stealth keeps agent files and git
# out of the home (it does silently `git init` a non-git home — harmless). No
# sync, no backup: the only copy is the home's .beads/, so include it in host
# backups. Skipped when bd is absent (the orders still install) or already run.
if command -v bd >/dev/null 2>&1; then
	if (cd "$home" && bd ready >/dev/null 2>&1); then
		printf 'home memory database already exists at %s\n' "$home"
	else
		(cd "$home" && bd init --quiet --stealth)
		printf 'created the mate-global memory database in %s (.beads/ — back it up; there is no other copy)\n' "$home"
	fi
else
	printf 'bd not found on PATH — the home memory database was NOT created; install beads and re-run this installer\n' >&2
fi

target="$home/data/captain.md"
if [ ! -f "$target" ]; then
	mkdir -p "$(dirname "$target")"
	printf '# Standing orders\n\n' >"$target"
	printf 'created %s\n' "$target"
fi

if grep -qF 'paseo-beads-onboarding:start' "$target"; then
	printf 'standing orders already installed at %s — no change\n' "$target"
	exit 0
fi

cat >>"$target" <<'ORDERS'

## Beads — the fleet's memory

<!-- paseo-beads-onboarding:start -->

Every project has exactly one beads memory database, at its **base checkout** —
the directory Paseo lists as the project's local checkout. Its records are
memory, not work: decisions with rationale, discoveries, gotchas, handoff notes.
You and every crewmate read and write that one store, from the base or from any
worktree of it (worktrees resolve the base's database automatically).

1. **Which database: decided by where you stand.** Standing in a project → that
   project's database. Standing in your home → your own memory, and only for
   facts not about any single project: Captain preferences, provider quirks,
   process lessons that transfer across projects. A fact about a project's code
   or product NEVER goes in your home database — walk to the project (or record
   from a worktree) and file it there.
2. **Never create a database.** `bd init` belongs to onboarding alone, and
   onboarding happens without you. If `bd` reports no database, report blocked;
   never initialize one anywhere. An agent-run `bd init` in a worktree splits
   the store silently — there is no error, the records just stop being shared.
3. **Memory shape.** One fact per record. The title states the fact; the body
   carries the context and rationale. Record at the moment of discovery, not
   batched. Correct an outdated record with a supersede link — never delete
   what was true when written:
   - Decision: `bd create -t decision -l memory:decision -d "…rationale…"`
   - Gotcha: `bd create -t task -l memory:gotcha -d "…"`
   - Handoff note: `bd create -t task -l memory:handoff -d "…"`
   - Read: `bd list --label-any memory:decision,memory:gotcha,memory:handoff`,
     then `bd show <id>`; search with `bd list --desc-contains "…"`
   - Correct: `bd supersede <old-id> --with <new-id>`
4. **Crewmate briefs** carry one standing line, every time: "record non-obvious
   findings and decisions in the project DB before reporting done."
5. **Promote what keeps proving stable** into the project's `AGENTS.md` — the
   distilled essentials only: no history, no rationale (that stays in the DB).
   Append **outside** the `<!-- BEGIN BEADS INTEGRATION … -->` …
   `<!-- END BEADS INTEGRATION -->` markers bd manages; bd never rewrites text
   outside them, but a template upgrade wipes anything inside. Keep AGENTS.md
   small — it is every session's context.
6. **`bd remember` is not project memory.** bd's own AGENTS.md block pushes
   `bd remember`; use it only in your home database, only for small
   cross-session facts. It has no type, no labels, no rationale body. Anything
   about a project goes to that project's database as a typed record.
7. **Memory is not queued work.** Open memory records appear in `bd ready`;
   when you or a crewmate read the queue, exclude them:
   `bd ready --exclude-label memory:decision,memory:gotcha,memory:handoff`.
   At session start, glance over your home database's records: any
   project-flavored entry belongs in that project's database — re-file it there
   and supersede it in the home, keeping the trail.

<!-- paseo-beads-onboarding:end -->
ORDERS

printf 'installed standing orders at %s\n' "$target"
printf 'the mate reads this file at the start of every session, so it takes effect at its next session; `paseo plugin reload firstmate` restarts it sooner\n'
