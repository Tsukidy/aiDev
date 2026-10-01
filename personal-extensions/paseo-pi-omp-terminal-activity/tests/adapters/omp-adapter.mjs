// Test adapter for oh-my-pi post-hooks: mirrors omp's loader (direct import;
// default-export factory receives the ExtensionAPI). Firing passes the
// synthetic event payload; the same object doubles as the ExtensionContext so
// fixtures can carry both event fields (willContinue) and ctx methods
// (isIdle / hasPendingMessages).

import { loadHookModule, withPatchedEnv } from "./shared.mjs";

export const load = (hookPath) => loadHookModule(hookPath, "omp");

export function fire(loaded, env, event, payload = {}) {
  return withPatchedEnv(env, async () => {
    const handler = loaded.handlers.get(event);
    if (!handler) {
      throw new Error(`omp hook registered no handler for ${event}`);
    }
    const syntheticEvent = { type: event, ...payload };
    await handler(syntheticEvent, syntheticEvent);
    await loaded.mod.__paseoFlushReports();
  });
}
