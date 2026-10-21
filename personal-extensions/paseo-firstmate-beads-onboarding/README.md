# Firstmate beads onboarding: the fleet's memory layer, from day one

Beads (`bd`) as memory for a Paseo + firstmate fleet: each project gets exactly
one memory database, created automatically at the project's base checkout the
moment Paseo creates its first workspace — before the mate ever plans, before
any crewmate exists. All agents of the fleet read and write that one store; the
mate additionally keeps a private database in its own home for knowledge that
transfers across projects. Design of record:
`docs/beads-memory-workflow.md`; spec: Tsukidy/aiDev issue #10.

Two halves, installed once per machine. After that, every future project is
onboarded by doing nothing: add the project to Paseo, tell the mate about it,
and the memory store simply exists.

| File | Role |
| --- | --- |
| `index.server.ts` + `paseo-plugin.json` | **Paseo daemon plugin** (the deterministic half): subscribes to `workspace.created`, dedups per project, resolves the project's base via the Paseo API's project record (`projectRootPath` — never the event's cwd, which for crewmate worktrees is the worktree), and runs `bd ready` → `bd init --quiet` at the base. Nothing else: no commits, no files beyond what `bd init` itself produces (init commits its own scaffolding — that is what carries the agent-facing files into worktrees and clones). Absent `bd`, a failed check, or a failed init each log a warning (`paseo plugin logs firstmate-beads-onboarding`) and leave the project retryable on its next workspace event. |
| `install-captain-orders.sh` | **Standing orders** (the behavioral half): appends the marked memory rules block to the mate's `data/captain.md` (never overwritten by the plugin, outranks the charter, read every session) and creates the mate-global memory database in the home (`bd init --quiet --stealth`). Idempotent; resolves the mate's home exactly as firstmate 0.3.4 does (`plugin-data/firstmate/config.json` → `~` expansion → default → legacy `plugins/firstmate/home`) and refuses politely when no home exists. |
| `tests/run.sh` | Offline verification: 9 handler tests + 2 build checks + 25 installer checks (see below). |

## Usage

```sh
# Once, per machine, from the repository root (launch the first mate at least
# once first, so its home exists):
node scripts/install.mjs                # the plugin and the standing orders, among the rest
paseo plugin ls                         # firstmate-beads-onboarding must be running

# Per project — nothing. Add the project to Paseo; the mate's standing order to
# adopt a project's base as a workspace closes the pre-worktree planning window:
# its create_workspace fires workspace.created, and the plugin onboards the base.
```

`scripts/install.mjs` registers the plugin from a copy of the files
`package.json` lists, under `$XDG_DATA_HOME/aidev` (by default `~/.local/share/aidev`), runs
`install-captain-orders.sh`, and records both for `scripts/uninstall.mjs`
(`scripts/README.md` has the details). A plugin of this id registered any
other way, such as `paseo plugin install` of this directory, is foreign to the
installer: it leaves that registration alone and never removes it.
`npm install && npm run typecheck` typechecks the source against the SDK.

The plugin needs `bd` on the daemon's PATH. The orders take effect at the mate's
next session start (the charter makes it read `data/captain.md` every session);
`paseo plugin reload firstmate` restarts it sooner.

## The invariant, and the two sharp edges it navigates

**Each project has exactly one beads database, at its base checkout.** bd's
directory discovery resolves any linked worktree to the base's `.beads` via
`git rev-parse --git-common-dir`, so base + all worktrees are one store with no
per-worktree setup. Evidence for every claim: `docs/research/beads-cli-memory-surface.md`.

- A `.beads/embeddeddolt/` directory **inside a worktree** splits the store
  silently — the trip-wire is that directory name specifically, and an agent
  running `bd init` in a worktree creates it. The plugin can never cause this:
  it only ever inits at bases (resolved from the Paseo API, not the event). The
  standing orders forbid agent-run `bd init` outright.
- **Fresh clones carry scaffolding but no records** — records live in the base's
  gitignored Dolt store. Recovery from a lost base is *restoring the base
  directory* (or `bd bootstrap` with a configured remote), never a second
  `bd init`, which would create a fresh empty store.

Accepted caveats (spec "Further Notes"): `bd init`'s scaffolding commit sweeps
unrelated pre-staged files in the index at that moment — onboard only with a
clean index; `--quiet` is not silent, the exit code is the one reliable signal;
`--stealth` in the mate's home silently `git init`s a non-git home (harmless)
and the home database has no sync or backup — its `.beads/` is the only copy,
so include it in host backups. Operator hygiene, decided at install time, not
by this delivery: bd ships anonymous metrics on by default (command names,
version, OS only) — `bd metrics off` disables them machine-wide.

## Verification

```sh
bash tests/run.sh
```

The harness drives binaries under test through stub executables on `PATH`
against real git repositories and a real temporary filesystem (prior art from
the superseded prototype, re-implemented fresh):

- **Plugin handler seam** (`tests/plugin.test.mjs`): the `workspace.created`
  handler is invoked directly with a stub Paseo API client and a scriptable
  stub `bd`. Asserts: fresh-base init (`bd ready` then `bd init --quiet`, both
  at the base); worktree-cwd events resolving to the base; concurrent events
  producing exactly one init; already-initialized no-op; second-event no-op;
  absent-`bd` degradation; failed init degrading **and retrying on the next
  event** (this test caught a real bug during development); failed ready-check
  not attempting init; unknown project id running nothing; and no plugin-owned
  commits or stray writes.
- **Build seam** (`tests/build.test.mjs`): the daemon builds the plugin from
  its source wherever it is installed, on every load, and resolves each import
  there, so `index.server.ts` imports only what the host supplies (Node
  builtins and `@getpaseo/plugin/server`) and a copy without `node_modules`
  builds (#33). Asserted from the imports, and, wherever `paseo` is on `PATH`,
  by building a copy of the files `package.json` lists (as the installer
  copies them) with Paseo's own compiler, resolved from that `paseo`'s CLI
  package; a compiler that cannot be found fails the check, and only a
  machine without `paseo` skips it.
- **Installer seam** (`tests/installer.test.sh`): synthetic mate homes covering
  every home-resolution branch (absolute, `~`, bare `~`, empty config value,
  missing config, corrupt config → default; legacy location; no home → refusal
  with no side effects), append-once idempotency, preservation of pre-existing
  orders, the seven standing-order rules, and the home-database step
  (`bd init --quiet --stealth` once, never twice).

Not an automated seam: live-daemon end-to-end behavior. Human checklist —
install both halves, add a project, watch the mate adopt the base, confirm the
store exists before planning, dispatch a crewmate, confirm its worktree write
is visible at the base, confirm the home database holds no project-flavored
records.

## Provenance

- Paseo: the SDK devDependencies (`@getpaseo/plugin` / `client` / `protocol`)
  are pinned at **0.11.2** in `package.json`: the plugin SDK contract
  (`server.on("workspace.created")`, `PluginServerContext` default-export
  contribution), the event payload (`{ id, projectId, cwd, name, archivedAt }`),
  the project record's `projectRootPath`. The daemon's behavior is verified
  against **0.12.0** (#33): it builds a directory plugin from its source where
  it lies, on every load; it keeps a plugin whose build failed registered; and
  `paseo plugin install <dir>`, `reload` and `logs` work as described.
- firstmate **0.3.4** (`@gpambrozio/paseo-firstmate`): home resolution
  (`server/config.ts`), never-overwritten `data/captain.md` with outranking
  semantics, the charter's read-it-every-session rule.
- beads **1.3.1** (c1c4b642a, the Paseo container's exact build): every
  CLI-behavior claim — `bd ready` exit codes, `bd init --quiet` /
  `--stealth` semantics, the scaffolding commit, worktree discovery, the
  `memory:` label surface, `bd supersede`, `bd ready --exclude-label`.
