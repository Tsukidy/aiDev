// Test adapter for pi extensions: mirrors pi's loader (direct import;
// default-export factory receives the ExtensionAPI). Firing passes a minimal
// ExtensionContext — the reporter never touches ctx.

import { loadHookModule, withPatchedEnv } from "./shared.mjs";

export const load = (extensionPath) => loadHookModule(extensionPath, "pi");

export function fire(loaded, env, event, payload = {}) {
  return withPatchedEnv(env, async () => {
    const handler = loaded.handlers.get(event);
    if (!handler) {
      throw new Error(`pi extension registered no handler for ${event}`);
    }
    await handler({ type: event, ...payload }, { mode: "tui", cwd: "/tmp" });
    await loaded.mod.__paseoFlushReports();
  });
}
