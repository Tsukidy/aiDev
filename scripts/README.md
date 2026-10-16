# scripts

Repo-owned tooling for spec #11. Nothing here installs `skills/` itself — that
is `npx skills add` from this repo, per machine (design of record:
`docs/combined-fleet-workflow.md` §5.3).

| File | Role |
| --- | --- |
| `verify-curation.mjs` | The curation gate (ticket #12): duplicate names, unresolvable references, frontmatter validity, the `pstack:` ban. Run against `skills/` (no args) or any fixture tree. |
| `tests/run.sh` | The whole offline suite: curation-gate fixtures plus the real tree, then the installer tests below. |
| `install-standing-orders.sh` | The behavioral half of the combined fleet workflow (ticket #08): appends the marked standing-orders block to the first mate's `data/captain.md`. See below. |
| `tests/test-standing-orders.sh` | The installer's stub-driven offline harness (run directly, or via `tests/run.sh`). |

## install-standing-orders.sh

The mate's behavioral contract for the combined fleet: the declared front door
(grill → to-spec → to-tickets → GitHub labels), one memory wording
(CONTEXT.md/ADRs + beads + AGENTS.md), the review gate, brief doctrine, PR
shape, context hygiene (the paragraph rescued from the retired `ask-matt`), and
retro after landings — plus the effort-dispatch note (effort levels ride in the
dispatch prompt; effort-tiered agent types are plugin-only). Seven elements,
one marked block (`aidev-standing-orders:start` … `:end`), appended to
`data/captain.md`.

Why `data/captain.md`: the firstmate plugin never overwrites it, it outranks
the charter except the charter's hard rules, and the charter makes the mate
read it at the start of every session (verified against firstmate 0.3.4 — same
seam, and same home resolution, as the beads onboarding installer's
`install-captain-orders.sh`, which this complements: that one installs the
memory rules and the home database, this one the workflow rules).

```sh
# Once, per machine, after launching the first mate at least once (its home
# must exist). Honors PASEO_HOME; needs node on PATH (it ships with Paseo).
./install-standing-orders.sh
```

Idempotent: run it any number of times, the block lands exactly once; any
orders the captain wrote before or after the block are preserved; a truncated
prior block (start marker without end) is refused instead of appended to; and
when no mate home resolves it exits nonzero before touching anything.

**When the orders take effect:** at the mate's next session start — the
charter makes it read `data/captain.md` every session, and the file is only
read at session start, so a running mate does not pick the block up mid-flight.
`paseo plugin reload firstmate` restarts the mate sooner. Crewmates pick the
doctrine up through their briefs (element 4 makes briefs carry it), so their
take-effect is the first brief dispatched after the install.

## Verification

```sh
bash tests/run.sh                        # everything, offline
node scripts/verify-curation.mjs         # the curation gate alone
bash scripts/tests/test-standing-orders.sh   # the installer alone
```
