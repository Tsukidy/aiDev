# Paseo terminal-activity providers for pi and oh-my-pi

Place-ready patch set for [spec Tsukidy/aiDev#7](https://github.com/Tsukidy/aiDev/issues/7) /
[build ticket #8](https://github.com/Tsukidy/aiDev/issues/8): registers `pi` and
`omp` (oh-my-pi) as first-class terminal-activity providers in Paseo, so the
TUI's existing status dots, "Terminal finished" notifications, and needs-input
attention work for them exactly as they do for claude, codex, and opencode.
No new notification machinery — the providers plug into the registry Paseo
already has.

Nothing in this directory is installed by this repo. It is delivered for
**you** to place in the host build context; agents never write there.

## Contents

| File | Role |
| --- | --- |
| `paseo-agent-hooks-patch.mjs` | Idempotent, anchor-gated patch script: copies the two provider modules into `@getpaseo/server`'s `dist/server/terminal/agent-hooks/` and registers them in `AGENT_HOOK_PROVIDERS`. Syntax-checks its output and smoke-imports the patched registry before declaring success. |
| `providers/pi.js` | The `pi` provider (registry module). Carries the pi extension file it installs. |
| `providers/omp.js` | The `omp` provider (registry module). Carries the omp post-hook file it installs. |
| `Dockerfile.patchblock` | The block to paste into your Paseo image's Dockerfile. |
| `tests/verify.mjs` | Offline verification harness (53 checks) — see below. |
| `tests/adapters/*.mjs` | Test-only loader shims mimicking how pi and omp load hook modules. |

## Placement

1. Copy this directory to the root of your Paseo image **build context** as
   `paseo-pi-omp-terminal-activity/`.
2. Paste `Dockerfile.patchblock` into your Dockerfile, after the step that
   installs `@getpaseo/server`, and adjust `PASEO_SERVER_PKG_DIR` to where the
   image installs that package (the directory containing its `package.json`).
3. Rebuild. The patch runs at build time; a rebuild re-applies as a no-op.
4. After boot, enable the daemon's **Terminals** setting ("Enable terminal
   agent hooks", `daemon.enableTerminalAgentHooks`, default off). Toggling it
   on installs the hook files live; toggling it off removes them. Toggling is
   also what installs on an already-built image — the patch only registers
   the providers.

## What gets installed (only when the setting is on)

| Provider | Hook file | Observed events → activity |
| --- | --- | --- |
| `pi` | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/paseo-terminal-activity.js` | `before_agent_start` → running; `tool_execution_start` → running; `agent_end` → idle; `session_shutdown` → idle |
| `omp` | `~/.omp/agent/hooks/post/paseo-terminal-activity.js` | `input` → running; `turn_start` → running; `turn_end` → running; `tool_approval_requested` → needs-input; `tool_approval_resolved` → running; `agent_end` → idle *(guarded)*; `session_shutdown` → idle |

Both hook files are inert outside Paseo (they only act when `PASEO_TERMINAL_ID`
is set) and swallow every error — reporting can only degrade to invisibility,
never break the agent session. Resulting TUI semantics are upstream's own:
working dot while running; working→idle raises finished attention plus a
"Terminal finished" notification; needs-input shows as idle with needs-input
attention; focusing the tab clears attention; Ctrl-C/Escape while working
clears activity without a finished notification.

### The omp idle guard (spec deviation, per the spec's own re-verification clause)

The spec drafted `turn_end → idle (guarded by context reporting idle with no
pending messages)`. Current oh-my-pi documentation (v18.4.9) shows that cannot
work: `turn_end` fires at the end of **every** model/tool turn, carries **no**
idle/pending context, and does not signal a settle — guarding it would either
fire false "finished" notifications mid-queue or never fire at all. The
documented settle mechanism is `agent_end` with `event.willContinue` (an
automatic continuation is already scheduled) plus `ctx.isIdle()` /
`ctx.hasPendingMessages()`. So this patch set maps `turn_end → running` and
applies the guard on `agent_end`: idle is reported **only** when
`willContinue` is falsy and the context reports idle with no pending
messages, with the guard enforced twice (hook refuses to send anything else;
the resolver refuses to resolve any other payload to idle) and failing
closed: a context missing the documented methods reports nothing at all.
Spec user story
10 — a mid-queue agent never fires a false finished notification — is
satisfied by the documented mechanism. All other draft mappings matched
current documentation unchanged.

## Verification

Everything that can be verified without your container is verified here —
run:

```sh
node tests/verify.mjs                 # fetches @getpaseo/server@0.10.2 via npm pack (cached)
node tests/verify.mjs --tgz <file>    # offline, against a local tarball
```

The harness proves, against the real published server package: anchors match,
patched output is syntax-clean, a second application is a registry no-op, the
smoke import shows both providers registered; three mutated-layout drift
variants exit non-zero with re-derivation instructions and never half-patch;
every declared event of both providers resolves to its mapped activity by
direct execution (including all omp guard payloads); and both hook modules,
driven through pi/omp-shaped loaders against a stubbed hook CLI, stay inert
outside Paseo, send correct `hooks <provider> <event>` arguments per event,
carry the omp guard payload on stdin only for a genuine settle, and swallow
failing/missing-CLI errors.

What remains for your container (HITL — ticket #9): place the patch, rebuild,
enable the setting, and live-test a real pi and omp session — working dot,
finished notification, omp needs-input attention, interrupt clearing, and
attention clearing on focus.

## Provenance and drift

- Verified against `@getpaseo/server` **0.10.2** and `@getpaseo/cli` **0.10.2**
  (latest release v0.10.2, 2026-09-29), pi docs at **1.0.0**
  (github.com/earendil-works/pi, 2026-10-01), omp docs at **18.4.9**
  (github.com/can1357/oh-my-pi / omp.sh, 2026-10-01).
- When the base image moves past the verified layout, the patch **fails the
  build** with instructions (re-derive the anchors or pin
  `@getpaseo/server` to 0.10.2) rather than half-applying.
- omp named profiles (`~/.omp/profiles/<name>/agent/hooks/post/`) are not
  patched — the default profile path is. pi project-level extensions
  (`.pi/extensions`, trust-gated) are untouched; the pi hook installs
  user-level and always loads.
- Hook module payloads ride the CLI's stdin (read with a ~100 ms window);
  payloads are written to the spawned CLI's pipe immediately, so no timing
  dependence. Failure posture is asymmetric by design: build-time failures
  are loud; runtime hook failures are silent no-ops.
