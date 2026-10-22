# scripts

Repo-owned tooling for spec #11: the curation gate, the one-command installer
and uninstaller for an operator machine (ticket #21), the orders installer
they call, and the offline tests for all of it.

| File | Role |
| --- | --- |
| `verify-curation.mjs` | The curation gate (ticket #12): checks that `skills/` is a coherent, installable, correctly attributed skill set, including the pstack provenance manifest `skills/pstack-provenance.json` (#24) and `skills/NOTICE.md` (#26). The numbered rule list in the file's header comment is the one full description. Run against `skills/` (no args) or any fixture tree. Never walks or checks files inside `node_modules` (e.g. from a local `bun install`). |
| `tests/run.sh` | The whole offline suite: curation-gate fixtures plus the real tree, then the installer tests below and the onboarding plugin's own tests (`personal-extensions/paseo-firstmate-beads-onboarding/tests/run.sh`, whose build check compiles the plugin with the installed Paseo's compiler, and is skipped where `paseo` is not on PATH), the onboarding plugin step's decision table (`tests/onboarding-plugin.test.mjs`), the manifest's changes (`tests/manifest.test.mjs`), and the text in front of a marked block and an owned file's last write, read from their records (`tests/aidev-install.test.mjs`). |
| `install.mjs`, `uninstall.mjs` | The one-command operator setup and its manifest-driven reversal (ticket #21, spec #11 D5–D9). See below. |
| `lib/aidev-install.mjs`, `lib/manifest.mjs` | Their shared core, and the install manifest (item kinds, shapes, queries). |
| `lib/orders.mjs` | The orders step (#35): the two orders installers, each block recorded as an intent before its script runs and settled after, with a subset of the plugin step's contract. |
| `lib/onboarding-plugin.mjs` | The beads onboarding plugin step (#33): the copy, its registration in Paseo, the reload decision and uninstall's removal, with a target-like contract outside the target registry. |
| `lib/onboarding-skip-list.mjs` | That step's skip-list entry (#34): this checkout's root on the plugin's skip list, added before the plugin is registered, removed at uninstall. |
| `lib/targets.mjs`, `lib/claude-code-target.mjs` | The runtime-target contract and registry, and the Claude Code target (the only one implemented, D5; a pi or omp target is a sibling module). |
| `claude-code/session-start.sh` | The SessionStart routing hook the installer places (adapted from pstack-claude's, MIT). |
| `tests/test-install.sh`, `tests/test-install-plugin.sh`, `tests/test-install-skip-list.sh`, `tests/test-install-interrupt.sh` | The installer and uninstaller's stub-driven offline tests, run against sandboxed homes; the second holds the onboarding plugin step's cases (#33), the third its skip-list cases (#34), the fourth the installs killed at an external call (#35) or between the installer's own writes (#50). Run directly, or via `tests/run.sh`. |
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
node scripts/install.mjs --strict     # also fail when bun is missing, or when
                                      # run from a linked git worktree

node scripts/uninstall.mjs            # reverse what the manifest records
node scripts/uninstall.mjs --dry-run  # print the plan, touch nothing
node scripts/uninstall.mjs --purge    # also delete the beads databases the
                                      # setup created (asks; --yes skips asking)
```

Run them from the main checkout. The skills are copied from it, and the
onboarding plugin is copied out of it, so nothing installed depends on the
checkout staying where it is.

To roll back to an older version of this repository, uninstall with the
checkout that installed, then check out the older version and install from
it. An older checkout's `uninstall.mjs` cannot read a manifest of a newer
schema version (see the manifest, below): it refuses, names the version, and
touches nothing.

### What install does, in order

1. **Preconditions**, all checked before anything is written; any failure
   exits nonzero with nothing written: node ≥ 22.20; `npx`, `bd` and `paseo`
   on PATH (checked and reported, never installed); the Paseo daemon answers
   `paseo plugin ls`; the first mate's home exists (launch the mate once);
   every path below resolves inside `$HOME` after following symlinks
   (`CLAUDE_CONFIG_DIR`, `PASEO_HOME` and the XDG variables are honored only
   then); `settings.json` parses. The install writes the skip list (below)
   under `XDG_CONFIG_HOME`, so an `XDG_CONFIG_HOME` outside `$HOME` is
   refused, though the exclude list there is only read. `bun` is reported:
   missing, it is a warning naming poteto-mode's `watch-pr` and `ship-pr`
   (the Shipping and Babysit playbooks), and an error only under `--strict`.
   A run from a linked git worktree (`git rev-parse --git-dir` differs from
   `--git-common-dir`) is reported the same way, a warning and an error only
   under `--strict`, because the skip-list entry (below) would name the
   worktree.
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
   latter creates the mate's home memory database with `bd init`), then this
   checkout's root on the plugin's skip list (below), so the plugin never
   runs `bd init` in this repository, then the
   beads onboarding plugin: the files its `package.json` lists, copied under
   the data directory and installed with `paseo plugin install <copy>`. The
   daemon builds a plugin where it lies, on every load, so the copy must
   build on its own: the plugin's source imports only what the host supplies,
   which its own tests guard (#33). The plugin is recorded before the daemon
   is asked, because Paseo keeps a plugin whose build failed registered; the
   registration from the recorded copy is ours to reload and to remove at
   uninstall, and one of that id from anywhere else is left alone. A re-run
   reloads ours when Paseo reports it `failed`, or when it runs and the
   copy's files, as the run leaves them, differ from what the daemon last
   built successfully, which the manifest records. So a failed reload is
   retried, and an operator's edit of the copy reloads it once. A disabled
   plugin is left disabled, and its copy is still refreshed. A file a
   pre-#33 copy held that the copy no longer lists (its README.md) is left
   for uninstall to remove. If the plugin is registered from a copy an earlier
   install recorded elsewhere (the data directory moved), install refuses:
   uninstall first. The dry run prints the daemon call the run will make.
9. **The manifest** (below), plus NOTICE, `pstack-provenance.json` and every
   license file of `skills/`, with the repository's own `LICENSE`, under the
   data directory, so attribution travels with the install.

Re-running converges: after a partial failure (the manifest records what was
done), after a repo update (changed agents, hook files and the orders block
are refreshed, the skills re-copied), and after the exclude list changes
(skills, agents and the hook no longer wanted come back out). A file this
installer placed and the operator then edited is left as is, with a warning.

An install killed at an external call converges too (#35). Before each call,
the install records what the call may create and saves the manifest, as the
plugin step does for its plugin. The records cover the skills the CLI is
asked for, the directories the install may create, each orders block, and
what `bd init` creates in the mate's home. An orders block is recorded as an
intent to append it: the length and hash of the text the file held. After the
call, records of what it did not create are dropped, and a block's record is
settled with the text the script put in front of it. A re-run settles an
intent a killed run left the same way, anchored again at what the file holds
when its script runs, so a line the operator added since, or an upgrade of
the block before, is not taken for the script's and removed with the block.
The one exception is a `captain.md` the install created that holds only the
header the scripts write: the intent is anchored at the file's start, so the
header goes with the block. A re-run also drops `captain.md`'s record and
backup, which a killed run leaves, when nothing of ours is in the file and no
orders script has changed it (the record says so once one has).
So a re-run knows the skills a killed run copied as ours, and uninstall after
a kill at any call restores the pre-install state. One case needs the re-run
first: a kill inside the standing-orders script after it created `captain.md`
with its header, but before it appended the block. Uninstall straight after
leaves that header; uninstall after a re-run does not.
`tests/test-install-interrupt.sh` kills the install at each such call.

An install killed between its own file writes converges the same way (#50).
Each write is recorded, and the manifest saved, before it is made: a file
whose whole content is ours (an agent, a hook file, the sheet, a license
copy, the plugin's copy) with `next`, the hash the write leaves; our part of
a shared file (the hook entry, the `CLAUDE.md` block) with the shared file's
record; and a backup before its copy is made. A record whose file never
received its write is not read as the operator's edit: a re-run makes the
write, and uninstall leaves the file as it was and drops the backup. A
backup whose copy was never made is made by the next run, while the file
still holds what was recorded. The tests stop the install at kill points
that only they set (`AIDEV_TEST_KILL`): after each group of writes, and
between a write's record and the write.

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

### The beads onboarding skip list

`${XDG_CONFIG_HOME:-~/.config}/aidev/beads-onboarding-skip`, operator-owned:
the project bases the onboarding plugin never initializes. One absolute or
`~/` path per line; a `#` at the start of a line or after whitespace starts a
comment, so a `#` inside a path is part of the path. Before #37 a line like
`/srv/proj#note` meant `/srv/proj`; it now names a path that contains `#`, so
rewrite such a line as `/srv/proj #note`. The plugin reads the list on every
`workspace.created` event and compares real paths, so a symlinked path
matches. A listed project is skipped with a log line, and becomes eligible
again on its next workspace event once its line is gone. The full rules are
in the plugin's README.

By default the install adds this checkout's root (how aiDev carries beads
under its whitelist `.gitignore` is not decided yet):

- The install creates the file if absent, with a two-line comment header, or
  appends one line to the operator's, and records the entry in the manifest
  before writing it.
- It reads the list again just before writing, so a line the operator adds
  during the run is kept and counts. A list that can no longer be read then
  stops the install with an error: nothing is written or recorded, and the
  plugin is not registered.
- A list that already names this checkout, by any path to it, is the
  operator's: nothing is added and nothing recorded.
- Our entry, deleted by the operator, comes back on the next run.
- Uninstall removes only our line. The operator's lines stay byte for byte,
  and a list the install created and that holds nothing else is deleted.
- Uninstall removes our line even when the plugin of that id is registered
  from elsewhere (not ours, so uninstall leaves it running). That plugin may
  then onboard this checkout on its next workspace event, unless the
  operator lists it.
- The entry is the root of the checkout the install runs from, so run the
  install from the checkout Paseo knows as the project. From a linked git
  worktree that root is the worktree, not the base, so the install warns,
  and under `--strict` refuses before anything is written.

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
| `<data>/paseo-plugins/firstmate-beads-onboarding/` | the plugin source copy, registered in Paseo by `paseo plugin install` | `paseo plugin remove` (only a registration Paseo lists from this copy; a manifest from before #33 that recorded the copy but no plugin is upgraded to record it), then the copy is deleted |
| `${XDG_CONFIG_HOME:-~/.config}/aidev/beads-onboarding-skip` | one line: this checkout's root (the file is created if absent) | our line removed, also when the plugin's registration is not ours; the file is deleted if the install created it and nothing else is in it |
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

JSON at `<state>/install-manifest.json`: `schemaVersion` (5), `installedAt` (the
first install), `repoCommit` (the latest install), and `items`, each with a
`kind` and a `path`: `skill`, `agent`, `file` (with `sha256` at install time,
and `next` while a write is recorded but not settled;
`shared: true` for settings.json, CLAUDE.md and captain.md), `hook-entry`,
`marked-block` (with `before`, the text the install put in front of the
block, or, until the orders script that appends it has run, `at`, the length
and sha256 of the text the file held before it),
`plugin` (with `id` and `buildSha256`, the build the daemon last made of the
copy), `skip-entry` (with `entry` and the text put in front of it),
`backup` (with `of`), `dir`, `beads-db`, `skills-lock`. A re-run that
changes nothing leaves it byte-identical. Uninstall with no manifest refuses
and touches nothing. `lib/manifest.mjs` defines every kind and its fields,
and its one upgrade, from version 1: a manifest from before #33 whose
install failed at the daemon records the plugin's copy but no `plugin` item,
and reading it adds the item, with the copy directory's name as the id
(both installers name it after the id); the next save writes the current
version. Version 3 (#34) only adds `skip-entry`, so a version 2 is read as
is; the version went up so that an older checkout's uninstall refuses it (the
rollback note above) rather than leave our skip-list entry behind. Version 4
(#35) only adds `at` on `marked-block`, so a version 3 is read as is; an
older checkout's uninstall would strip such a block without the text it was
appended after, so it refuses a 4. Version 5 (#50) only adds `next`, and a
null `sha256`, on `agent` and `file`, so a version 4 is read as is; an older
checkout's uninstall would keep such a file as modified since install, so it
refuses a 5.

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
bash scripts/tests/test-install-skip-list.sh # its skip-list entry alone
bash scripts/tests/test-install-interrupt.sh # installs killed at an external call or between writes
node --test scripts/tests/onboarding-plugin.test.mjs   # the plugin step's decision table
node --test scripts/tests/manifest.test.mjs            # the manifest's changes
node --test scripts/tests/aidev-install.test.mjs       # a marked block's leading text and an owned file's write, from their records
```
