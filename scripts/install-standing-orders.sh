#!/usr/bin/env bash
#
# install-standing-orders.sh — the behavioral half of the combined fleet
# workflow (spec #11, ticket #08).
#
# Appends the mate's combined-fleet standing orders to its data/captain.md (the
# surface the firstmate plugin never overwrites, which outranks the charter
# except the charter's hard rules, and which the charter requires the mate to
# read at the start of every session), following the beads onboarding
# installer's seam pattern: firstmate 0.3.4 home resolution, a marked block,
# append-once idempotency. The mate's memory database itself is the beads
# onboarding installer's job — this block only declares how the fleet behaves.
#
# Why data/captain.md and not data/charter.md: the plugin renders AGENTS.md
# from data/charter.md and stops following plugin charter updates once the
# captain edits that copy. Verified against firstmate 0.3.4 (server/config.ts,
# templates/data/captain.md, templates/data/charter.md).
#
# Idempotent: the orders block is guarded by the aidev-standing-orders
# markers; a truncated prior block (start marker without end) is refused
# instead of appended to.
#
# The seven elements the block carries (docs/combined-fleet-workflow.md §5):
#   1. the declared front door — grill → to-spec → to-tickets → GitHub labels
#   2. one memory wording — CONTEXT.md/ADRs, beads, AGENTS.md
#   3. the review gate — a fresh thermos-powered review report linked on the issue
#   4. brief doctrine — agreed seams + acceptance criteria + the execution doctrine
#   5. PR shape — pr + make-pr-easy-to-review
#   6. context hygiene — the paragraph rescued from ask-matt, adapted to the fleet
#   7. retro after landings
# plus the effort-dispatch note ticket 02 flagged: effort levels ride in the
# dispatch prompt, never as agent types (those are plugin-only).

set -euo pipefail

die() {
	printf 'install-standing-orders: %s\n' "$1" >&2
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

target="$home/data/captain.md"
if [ ! -f "$target" ]; then
	mkdir -p "$(dirname "$target")"
	printf '# Standing orders\n\n' >"$target"
	printf 'created %s\n' "$target"
fi

if grep -qF 'aidev-standing-orders:start' "$target"; then
	if grep -qF 'aidev-standing-orders:end' "$target"; then
		printf 'standing orders already installed at %s — no change\n' "$target"
		exit 0
	fi
	die "a truncated orders block (start marker without end) exists at $target — remove the partial block and re-run"
fi

cat >>"$target" <<'ORDERS'

## The combined fleet workflow

<!-- aidev-standing-orders:start -->

1. **The front door is declared.** New work enters through the planning half,
   never through the router's planning playbook: `/grill-with-docs` (or the
   stateless `/grilling` when there is no repo to leave a paper trail in) →
   `/to-spec` → `/to-tickets` → GitHub issues, shepherded through the
   five-label state machine (`needs-triage`, `needs-info`, `ready-for-agent`,
   `ready-for-human`, `wontfix`). `/poteto-mode` routes implementation-phase
   work only — never its planning playbook. A foggy effort too big for one
   session goes to `/wayfinder` first; wayfinder hands off, it does not build —
   it merges back in at `/to-spec`.
2. **One memory wording, no competing conventions.** Domain language lives in
   `CONTEXT.md` and the ADRs. Decisions-with-rationale and gotchas live in
   beads. `AGENTS.md` is the distilled ambient layer — essentials only, no
   rationale (that stays in the beads records). GitHub is what is happening;
   beads is why. When two homes for a fact seem to exist, this rule decides.
3. **The review gate is real.** No `reviewed-PR`/`+yolo` merge without a fresh
   review crewmate's `/code-review` report linked on the issue — the standards
   axis powered by `thermos`, the spec axis diffing against the originating
   issue. A stale report or a self-review does not open the gate.
4. **Briefs carry the contract.** Every crewmate brief states the agreed seams,
   the acceptance criteria, and the execution doctrine — the merged
   `tdd` at the brief's seams, `/blast-radius` before a risky edit,
   `/show-me-your-work` on unattended runs — and its backlog lines carry
   their tracker ids.
5. **PR shape.** Every PR follows `pr` (smallest visual change, shown before
   and after, merge-danger call) plus `make-pr-easy-to-review` (history
   hygiene); `babysit` is the action half of the review loop.
6. **Context hygiene.** The mate keeps grilling → spec → tickets in one
   unbroken window — no `/clear`, no `/compact`, until the tickets exist.
   Each crewmate starts fresh from its brief; work crosses sessions through
   the brief, never through a shared window. At any phase boundary choose
   deliberately, in this order: Continue → `/clear` → `/handoff` → subagent →
   `/compact` (the default of last resort). Mind the smart zone (~150k
   tokens): approaching it mid-phase, `/compact` at the nearest phase
   boundary — never push on degraded.
7. **Retro after landings.** After every merge, `/retro` for fleet-level
   environment lessons and `correct` for repo-level structural prevention: a
   repeated mistake becomes impossible, not merely scolded.

**Dispatching at an effort level:** effort-tiered agent types are
plugin-registered and absent from a skills-only install — when a skill names
an effort level, pass the level in the dispatch prompt text, never as an
agent type.

<!-- aidev-standing-orders:end -->
ORDERS

printf 'installed standing orders at %s\n' "$target"
printf 'the mate reads this file at the start of every session, so it takes effect at its next session; `paseo plugin reload firstmate` restarts it sooner\n'
