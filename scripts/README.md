# scripts

Repo-owned tooling for spec #11: the curation gate, the one-command installer
and uninstaller for an operator machine (ticket #21), the orders installer
they call, and the offline tests for all of it.

| File | Role |
| --- | --- |
| `verify-curation.mjs` | The curation gate (ticket #12): checks that `skills/` is a coherent, installable, correctly attributed skill set, including the pstack provenance manifest `skills/pstack-provenance.json` (#24) and `skills/NOTICE.md` (#26). The numbered rule list in the file's header comment is the one full description. Run against `skills/` (no args) or any fixture tree. Never walks or checks files inside `node_modules` (e.g. from a local `bun install`). |
| `tests/run.sh` | The whole offline suite: curation-gate fixtures plus the real tree, then the installer tests below and the onboarding plugin's own tests (`personal-extensions/paseo-firstmate-beads-onboarding/tests/run.sh`, whose build check compiles the plugin with the installed Paseo's compiler). |
| `install.mjs`, `uninstall.mjs` | The one-command operator setup and its manifest-driven reversal (ticket #21, spec #11 D5–D9). See below. |
| `lib/aidev-install.mjs`, `lib/manifest.mjs` | Their shared core, and the install manifest (item kinds, shapes, queries). |
| `lib/targets.mjs`, `lib/claude-code-target.mjs` | The runtime-target contract and registry, and the Claude Code target (the only one implemented, D5; a pi or omp target is a sibling module). |
| `claude-code/session-start.sh` | The SessionStart routing hook the installer places (adapted from pstack-claude's, MIT). |
| `tests/test-install.sh`, `tests/test-install-plugin.sh` | The installer and uninstaller's stub-driven offline tests, run against sandboxed homes; the second holds the onboarding plugin step's cases (#33). Run directly, or via `tests/run.sh`. |
| `tests/lib/install-harness.sh`, `tests/lib/cli-stub.mjs` | Their shared harness (sourced): sandboxes, helpers, and the stub CLIs (`npx`, `paseo`, `bd`, `bun`). |
| `install-standing-orders.sh` | The behavioral half of the combined fleet workflow (ticket #08): appends the marked standing-orders block to the first mate's `data/captain.md`. `install.mjs` runs it. See below. |
| `tests/test-standing-orders.sh` | That installer's stub-driven offline harness (run directly, or via `tests/run.sh`). |

## install.mjs and uninstall.mjs

One command sets up an operator machine for the combined fleet on Claude
Code, and one command takes it back off. Both need node ≥ 22.20 (it ships with
Paseo) and nothing else from npm.

```sh
node scripts/install.mjs              # install, or converge an existing install
node scripts/install.mjs --dry-run    # print the plan, write nothing
node scripts/install.mjs --strict     # also fail when bun is missing

node scripts/uninstall.mjs            # reverse what the manifest records
node scripts/uninstall.mjs --dry-run  # print the plan, touch nothing
node scripts/uninstall.mjs --purge    # also delete the beads databases the
                                      # setup created (asks; --yes skips asking)
```

Run them from the main checkout. The skills are copied from it, and the
onboarding plugin is copied out of it, so nothing installed depends on the
checkout staying where it is.

### What install does, in order

1. **Preconditions**, all checked before anything is written; any failure
   exits nonzero with nothing written: node ≥ 22.20; `npx`, `bd` and `paseo`
   on PATH (checked and reported, never installed); the Paseo daemon answers
   `paseo plugin ls`; the first mate's home exists (launch the mate once);
   every path below resolves inside `$HOME` after following symlinks
   (`CLAUDE_CONFIG_DIR`, `PASEO_HOME` and the XDG variables are honored only
   then); `settings.json` parses. `bun` is reported: missing, it is a warning
   naming poteto-mode's `watch-pr` and `ship-pr` (the Shipping and Babysit
   playbooks), and an error only under `--strict`.
2. **Skills**: every skill in `skills/` minus the exclude list, through the
   pinned skills CLI, user level, Claude Code only, as copies:
   `npx --yes skills@1.7.4 add <repo>/skills -g -y --copy -a claude-code -s <names…>`.
   A name that already exists in the Claude Code skills directory, in the
   skills CLI's lock, or in `~/.agents/skills`, and that this installer did not
   put there, is skipped with a warning: installing over it would make the
   CLI's remove delete the operator's copy at uninstall. Remove the other copy
   (`npx skills remove -g <name>`) and re-run to install this repo's.
3. **The four carried agents** (`thermo-nuclear-review-subagent`,
   `thermo-nuclear-code-quality-review-subagent`, `comment-sicko`,
   `poteto-agent`) and 4. **the ten effort agents** (`effort-<level>`,
   `poteto-agent-<level>` for low, medium, high, xhigh, max; vendored from
   pstack-claude under `skills/setup-pstack/agents/`) into the Claude Code
   agents directory, so they dispatch by bare name. An agent follows the
   skill that carries it: excluding `thermos` leaves out its two reviewers.
5. **The SessionStart routing hook**: the hook script, its mandate text and
   the sheet reader under the data directory, plus one entry in Claude Code's
   `settings.json` (matcher `startup|resume|clear|compact`), identified by the
   hook script's path. Other hooks and keys are never touched, and the file
   keeps its indentation and mode. The hook injects the poteto-mode mandate
   unless the sheet says `session hook: off`; with `poteto-mode` excluded it
   is not installed.
6. **The model sheet** `pstack-models.md`, setup-pstack's default shape, only
   if absent. `setup-pstack` stays available to re-tune it.
7. **A marked block** (`aidev-pstack-sheet:start` … `:end`) in the global
   `CLAUDE.md` holding `@<claude>/pstack-models.md`; the file is created if
   missing, and text outside the markers is never touched.
8. **The orders and the plugin**: `install-standing-orders.sh` and the beads
   onboarding `install-captain-orders.sh` (each idempotent on its own; the
   latter creates the mate's home memory database with `bd init`), then the
   beads onboarding plugin, copied under the data directory and installed
   with `paseo plugin install <copy>`. The daemon builds a plugin where it
   lies, on every load, so the copy must build on its own: the plugin's
   source imports only what the host supplies (its own tests guard this,
   #33). A registration from the copy is ours whether or not the manifest
   recorded it, because Paseo keeps a plugin whose build failed registered:
   a re-run reloads ours when it failed or runs from an out-of-date copy, and
   uninstall removes it. A disabled plugin is left disabled, and one of that
   id registered from anywhere else is left alone. The dry run prints the
   daemon call the run will make.
9. **The manifest** (below), plus NOTICE, `pstack-provenance.json` and every
   license file of `skills/`, with the repository's own `LICENSE`, under the
   data directory, so attribution travels with the install.

Re-running converges: after a partial failure (the manifest records what was
done), after a repo update (changed agents, hook files and the orders block
are refreshed, the skills re-copied), and after the exclude list changes
(skills, agents and the hook no longer wanted come back out). A file this
installer placed and the operator then edited is left as is, with a warning.

What the install finds already there is not adopted: an orders block in
`captain.md`, an `aidev-pstack-sheet` block in `CLAUDE.md`, or our hook
entry in `settings.json` that this install did not add is left in place and
never removed by uninstall. Shared files that are symlinks (dotfiles) are
written through, so they stay symlinks; an operator agent we replace is put
back at uninstall exactly as it was, a symlink as that symlink. A hook entry
the operator deletes after install comes back on the next install run.

### The exclude list

`${XDG_CONFIG_HOME:-~/.config}/aidev/install-exclude`, operator-owned (the
installer only reads it): one skill name per line, `#` starts a comment.
Excluding a skill that another installed skill's code needs is refused before
anything is written: a `../<skill>/` path from a script into another skill
(today: poteto-mode's `scripts/worktree-audit.mjs` imports `reflect`'s
`find-transcript.mjs`, so exclude both or neither). A Markdown link into an
excluded skill only warns. A name that is not a skill warns.

### Every path written

`<claude>` is `$CLAUDE_CONFIG_DIR`, else `~/.claude`; `<data>` is
`${XDG_DATA_HOME:-~/.local/share}/aidev`; `<state>` is
`${XDG_STATE_HOME:-~/.local/state}/aidev`; `<mate>` is the first mate's home
(by default `$PASEO_HOME/plugin-data/firstmate/home`).

| Path | What | Uninstall |
| --- | --- | --- |
| `<claude>/skills/<name>/` | the curated skills (written by the skills CLI) | `skills remove` through the CLI |
| `${XDG_STATE_HOME}/skills/.skill-lock.json`, else `~/.agents/.skill-lock.json` | the skills CLI's own lock (written by the CLI) | the CLI drops our entries; a lock the install created and that ends empty is deleted |
| `<claude>/agents/<name>.md` | 4 carried + 10 effort agents | deleted if unchanged; a pre-existing file of that name is restored from its backup |
| `<data>/claude-code/hooks/session-start.sh`, `session-start-context.md`, `read-sheet.sh` | the routing hook | deleted if unchanged |
| `<claude>/settings.json` | one SessionStart entry | our entry removed; the backup's exact bytes when nothing else changed |
| `<claude>/pstack-models.md` | the default sheet, only if absent | deleted if unchanged, else kept and reported |
| `<claude>/CLAUDE.md` | the `aidev-pstack-sheet` block | our block removed; the file is deleted if the install created it and nothing else is in it |
| `<mate>/data/captain.md` | the `aidev-standing-orders` and `paseo-beads-onboarding` blocks (written by the two orders installers) | both blocks and the headings in front of them removed |
| `<mate>/.beads`, `.beads.gate.lock`, `.git` | the mate's home memory database, when `bd init` created it during install | kept; `--purge` deletes them |
| `<data>/paseo-plugins/firstmate-beads-onboarding/` | the plugin source copy, registered in Paseo by `paseo plugin install` | `paseo plugin remove` (a registration from this copy, recorded or not), then the copy is deleted |
| `<data>/licenses/` | NOTICE, provenance manifest, licenses | deleted |
| `<state>/install-manifest.json` | the manifest | deleted last |
| `<state>/backups/` | a copy of every pre-existing file the install modified | consumed by uninstall; a backup it cannot restore is kept and reported |
| any directory above that did not exist | | removed if empty |

The npx package cache under `~/.npm` is npm's and is left alone.

### Known limits

- `create-skill`'s validator (`scripts/quick_validate.py`) needs PyYAML,
  which nothing here installs or checks, and it rejects the
  `user-invocable` / `disable-model-invocation` frontmatter many skills here
  use (PR #22 review). The installer does not touch either.
- `create-skill` and Claude Code's built-in `skill-creator` may overlap in
  their triggers; exclude one if that bites.
- Only `install-standing-orders.sh` upgrades its block in place; the beads
  captain-orders block stays at the version first installed (below).

### The manifest

JSON at `<state>/install-manifest.json`: `schemaVersion`, `installedAt` (the
first install), `repoCommit` (the latest install), and `items`, each with a
`kind` and a `path`: `skill`, `agent`, `file` (with `sha256` at install time;
`shared: true` for settings.json, CLAUDE.md and captain.md), `hook-entry`,
`marked-block` (with the text the install put in front of the block),
`plugin`, `backup` (with `of`), `dir`, `beads-db`, `skills-lock`. A re-run that
changes nothing leaves it byte-identical. Uninstall with no manifest refuses
and touches nothing. `lib/manifest.mjs` defines every kind and its fields.

### The orders block upgrade story

`install-standing-orders.sh` replaces an older version of its own block in
place (only between and including its markers), so a re-run of `install.mjs`
after a repo update carries new orders to the mate. The beads
`install-captain-orders.sh` is append-once and keeps an older block of its
own: to refresh it, uninstall and install again.

### After install: the real-session checks (#18)

The offline suite cannot start Claude Code. In a new session after a real
install: `/skills` (or the skill list) shows the curated skills, including
`question-guidelines` and `triage`; the session starts with the poteto-mode
mandate (and does not after `session hook: off` is set in the sheet and a new
session starts); and the four carried agents and ten effort agents dispatch
by bare name (`subagent_type: "thermo-nuclear-review-subagent"`,
`"effort-high"`, `"poteto-agent-max"`, …). Then uninstall and confirm the
machine is back to its pre-install state.

## install-standing-orders.sh

The mate's behavioral contract for the combined fleet: the declared front door
(grill → to-spec → to-tickets → GitHub labels), one memory wording
(CONTEXT.md/ADRs + beads + AGENTS.md), the review gate, brief doctrine, PR
shape, context hygiene (the paragraph rescued from the retired `ask-matt`), and
retro after landings — plus the effort-dispatch note (on Claude Code the
installer above registers the effort agents; elsewhere effort levels ride in
the dispatch prompt). The PR-shape
element makes `pr` govern PR descriptions over poteto-mode's Opening a PR
playbook, while titles keep its Conventional Commits rule, without editing
the vendored playbook. Seven elements,
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
# install.mjs runs it for you.
./install-standing-orders.sh
```

Idempotent: run it any number of times, the block lands exactly once; a
machine holding an older version of the block gets the current one in place
(only the text between and including the markers changes, #27); any
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
bash scripts/tests/run.sh                    # everything, offline
node scripts/verify-curation.mjs             # the curation gate alone
bash scripts/tests/test-standing-orders.sh   # the orders installer alone
bash scripts/tests/test-install.sh           # install.mjs and uninstall.mjs alone
bash scripts/tests/test-install-plugin.sh    # their onboarding plugin step alone
```
