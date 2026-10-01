// Shared scaffolding for the loader-shim test adapters. The loader-specific
// bits (how each agent invokes a hook module's handlers) stay in the
// per-agent adapters; only the genuinely common pieces live here: loading a
// default-export factory that registers handlers via pi.on(), and hermetic
// process.env patching so tests can simulate terminals with and without the
// Paseo terminal environment.

import { pathToFileURL } from "node:url";

const ENV_KEYS_TO_CLEAR = [
  "PASEO_TERMINAL_ID",
  "PASEO_ACTIVITY_TOKEN",
  "PASEO_TERMINAL_ACTIVITY_URL",
  "PASEO_HOOK_CLI",
];

// Loads a hook module the way both pi and omp do: direct import; the
// default-export factory receives the ExtensionAPI and registers handlers
// with pi.on(event, handler).
export async function loadHookModule(hookPath, label) {
  const mod = await import(pathToFileURL(hookPath).href);
  if (typeof mod.default !== "function") {
    throw new Error(`${label} hook modules must default-export a factory`);
  }
  const handlers = new Map();
  const api = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
  await mod.default(api);
  return { mod, handlers };
}

// Runs fn with process.env patched: ENV_KEYS_TO_CLEAR are removed first, then
// entries set to undefined in `env` stay deleted, everything else is set.
// Restores the previous environment afterwards.
export async function withPatchedEnv(env, fn) {
  const saved = new Map(
    ENV_KEYS_TO_CLEAR.map((key) => [key, process.env[key]]),
  );
  for (const key of ENV_KEYS_TO_CLEAR) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
