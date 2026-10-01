// Terminal-activity provider for oh-my-pi (omp), the coding agent by
// Stencil Labs (github.com/can1357/oh-my-pi, npm @oh-my-pi/pi-coding-agent,
// docs at omp.sh).
//
// Event names and payload shapes verified against current omp documentation
// (2026-10-01, omp.sh/docs/hooks + extension-authoring, and
// packages/coding-agent/src/extensibility/ at v18.4.9):
//   input, turn_start, turn_end, tool_approval_requested,
//   tool_approval_resolved, agent_end, session_shutdown — all current.
//
// Mapping note (deviation from the spec's draft, per its own re-verification
// requirement): omp's `turn_end` fires at the end of EVERY model/tool turn,
// carries no idle or pending context, and does not mean the agent is
// settling — so mapping turn_end to a guarded idle would fire false
// "finished" notifications mid-queue. The documented settle mechanism is
// `agent_end` (+ event.willContinue marking scheduled continuations) with
// ctx.isIdle() / ctx.hasPendingMessages(). So:
//   turn_end  → running   (loop still in progress; harmless refresh)
//   agent_end → idle      (guarded: only when willContinue is falsy and the
//                          context reports idle with no pending messages)
// User story preserved: an omp agent with queued messages never reports idle.
//
// Install shape verified against @getpaseo/server 0.10.2
// (dist/server/terminal/agent-hooks/agent-hook-installer.js): plugin-file
// install, resolved as ~/.omp/agent/hooks/post/paseo-terminal-activity.js.
// omp discovers direct .ts/.js files in the hooks `post/` directory (docs
// recommend observers live in `post/`). Note: a named omp profile
// (~/.omp/profiles/<name>/...) would not see this file; the default profile
// path is what gets patched.
//
// This module is copied verbatim into the server package as
// dist/server/terminal/agent-hooks/omp/omp.js by paseo-agent-hooks-patch.mjs,
// and must stay dependency-free (node builtins only).

// The omp post-hook file this provider installs. Kept as one self-contained
// string, mirroring upstream's OPENCODE_PLUGIN_SOURCE. Plain template literal:
// the code inside must not contain backticks or a literal dollar-brace.
export const OMP_HOOK_SOURCE = `
// Paseo terminal-activity reporter (marker: paseo hooks omp). Installed by
// Paseo into the omp hooks post/ directory; removed wholesale when the Paseo
// setting is disabled. Inert outside Paseo terminals: it only ever reports
// when PASEO_TERMINAL_ID is set, and every failure is swallowed so reporting
// can only degrade to invisibility.
import { spawn } from "node:child_process";

// Serialize reports so an older busy report cannot overtake a newer idle one.
let pendingReport = Promise.resolve();

function reportPaseoEvent(event, payload) {
  if (!process.env.PASEO_TERMINAL_ID) {
    return;
  }
  pendingReport = pendingReport
    .then(
      () =>
        new Promise((resolveReport) => {
          try {
            const child = spawn(
              process.env.PASEO_HOOK_CLI || "paseo",
              ["hooks", "omp", event],
              { stdio: payload ? ["pipe", "ignore", "ignore"] : "ignore", detached: true },
            );
            if (payload) {
              child.stdin.on("error", () => {});
              child.stdin.end(payload);
            }
            child.on("error", () => resolveReport());
            child.on("close", () => resolveReport());
            // Detached + unref: the shutdown report survives omp exiting.
            child.unref();
          } catch {
            resolveReport();
          }
        }),
    )
    .catch(() => {});
  return pendingReport;
}

// True only when the context reports the agent idle with nothing queued.
// Fails closed: if the context lacks the documented isIdle/hasPendingMessages
// methods (a version outside the verified contract), report nothing rather
// than risk a false settle — status reporting degrades to invisibility.
function isIdleWithNoPending(ctx) {
  try {
    if (
      typeof ctx?.isIdle !== "function" ||
      typeof ctx?.hasPendingMessages !== "function"
    ) {
      return false;
    }
    return !!ctx.isIdle() && !ctx.hasPendingMessages();
  } catch {
    return false;
  }
}

// Test seam: resolves once every enqueued report has been handed to the CLI.
export function __paseoFlushReports() {
  return pendingReport;
}

export default function (pi) {
  pi.on("input", () => {
    try {
      // Observer only: return nothing so the input transform is untouched.
      reportPaseoEvent("input");
    } catch {}
  });
  pi.on("turn_start", () => {
    try {
      reportPaseoEvent("turn_start");
    } catch {}
  });
  pi.on("turn_end", () => {
    try {
      // Mid-loop progress, not a settle boundary (see provider notes).
      reportPaseoEvent("turn_end");
    } catch {}
  });
  pi.on("tool_approval_requested", () => {
    try {
      reportPaseoEvent("tool_approval_requested");
    } catch {}
  });
  pi.on("tool_approval_resolved", () => {
    try {
      reportPaseoEvent("tool_approval_resolved");
    } catch {}
  });
  pi.on("agent_end", (event, ctx) => {
    try {
      // willContinue: an automatic continuation is already scheduled — not a
      // user-visible settle. Otherwise report only a genuine settle, carrying
      // the guard result for the resolver to double-check.
      if (event?.willContinue) {
        return;
      }
      if (!isIdleWithNoPending(ctx)) {
        return;
      }
      reportPaseoEvent("agent_end", JSON.stringify({ idle: true, pendingMessages: 0 }));
    } catch {}
  });
  pi.on("session_shutdown", () => {
    try {
      reportPaseoEvent("session_shutdown");
    } catch {}
  });
}
`.trimStart();

export function createOmpInstallStrategy() {
    return {
        kind: "plugin-file",
        configDir: ".omp/agent/hooks/post",
        configFile: "paseo-terminal-activity.js",
        hookMarker: "paseo hooks omp",
        source: OMP_HOOK_SOURCE,
    };
}

const OMP_EVENT_STATES = {
    input: "running",
    turn_start: "running",
    turn_end: "running",
    tool_approval_requested: "needs-input",
    tool_approval_resolved: "running",
    session_shutdown: "idle",
};

export const ompAgentHookProvider = {
    id: "omp",
    events: [
        { event: "input" },
        { event: "turn_start" },
        { event: "turn_end" },
        { event: "tool_approval_requested" },
        { event: "tool_approval_resolved" },
        { event: "agent_end" },
        { event: "session_shutdown" },
    ],
    install: createOmpInstallStrategy(),
    async resolveActivity({ event, input }) {
        if (event !== "agent_end") {
            return OMP_EVENT_STATES[event] ?? null;
        }
        // Guarded settle: the hook only sends the payload when its context
        // reported idle with no pending messages, and the resolver refuses to
        // resolve anything else (defense in depth — a missing or malformed
        // payload never produces a false "finished").
        let raw = null;
        try {
            raw = input ? await input.read() : null;
        } catch {
            return null;
        }
        if (!raw) {
            return null;
        }
        let payload;
        try {
            payload = JSON.parse(raw);
        } catch {
            return null;
        }
        if (payload?.idle === true && payload?.pendingMessages === 0) {
            return "idle";
        }
        return null;
    },
};
