// Terminal-activity provider for pi, the terminal coding agent
// (github.com/earendil-works/pi, formerly badlogic/pi-mono).
//
// Event names verified against pi 1.0.0 documentation (2026-10-01,
// packages/coding-agent/docs/extensions.md + src/core/extensions/types.ts):
// before_agent_start, tool_execution_start, agent_end, session_shutdown —
// all unchanged since 0.52.x.
//
// Install shape verified against @getpaseo/server 0.10.2
// (dist/server/terminal/agent-hooks/agent-hook-installer.js): plugin-file
// install, resolved as
//   ${PI_CODING_AGENT_DIR or ~/.pi/agent}/extensions/paseo-terminal-activity.js
// pi loads every .ts/.js file directly inside <agent-dir>/extensions/.
//
// This module is copied verbatim into the server package as
// dist/server/terminal/agent-hooks/pi/pi.js by paseo-agent-hooks-patch.mjs,
// and must stay dependency-free (node builtins only).

const PI_EVENT_STATES = {
    before_agent_start: "running",
    tool_execution_start: "running",
    agent_end: "idle",
    session_shutdown: "idle",
};

// The pi extension file this provider installs. Kept as one self-contained
// string, mirroring upstream's OPENCODE_PLUGIN_SOURCE; the event table inside
// is interpolated from PI_EVENT_STATES above so there is one source of truth.
// Plain template literal: the code inside must not contain backticks or a
// literal dollar-brace.
export const PI_HOOK_SOURCE = `
// Paseo terminal-activity reporter (marker: paseo hooks pi). Installed by
// Paseo; idempotent file, removed wholesale when the Paseo setting is
// disabled. Inert outside Paseo terminals: it only ever reports when
// PASEO_TERMINAL_ID is set, and every failure is swallowed so reporting can
// only degrade to invisibility.
import { spawn } from "node:child_process";

const PASEO_EVENT_STATES = ${JSON.stringify(PI_EVENT_STATES)};

// Serialize reports so an older busy report cannot overtake a newer idle one.
let pendingReport = Promise.resolve();

function reportPaseoEvent(event) {
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
              ["hooks", "pi", event],
              { stdio: "ignore", detached: true },
            );
            child.on("error", () => resolveReport());
            child.on("close", () => resolveReport());
            // Detached + unref: the shutdown report survives pi exiting.
            child.unref();
          } catch {
            resolveReport();
          }
        }),
    )
    .catch(() => {});
  return pendingReport;
}

// Test seam: resolves once every enqueued report has been handed to the CLI.
export function __paseoFlushReports() {
  return pendingReport;
}

export default function (pi) {
  for (const event of Object.keys(PASEO_EVENT_STATES)) {
    pi.on(event, () => {
      try {
        // Fire-and-forget: pi awaits handlers, so never block the agent loop.
        reportPaseoEvent(event);
      } catch {}
    });
  }
}
`.trimStart();

export function createPiInstallStrategy() {
    return {
        kind: "plugin-file",
        configDir: ".pi/agent",
        configFile: "extensions/paseo-terminal-activity.js",
        configDirEnvOverride: "PI_CODING_AGENT_DIR",
        hookMarker: "paseo hooks pi",
        source: PI_HOOK_SOURCE,
    };
}

export const piAgentHookProvider = {
    id: "pi",
    events: Object.keys(PI_EVENT_STATES).map((event) => ({ event })),
    install: createPiInstallStrategy(),
    async resolveActivity({ event }) {
        return PI_EVENT_STATES[event] ?? null;
    },
};
