// The one rule for what this plugin's server source may import: what the host
// supplies, since the daemon builds the plugin where it lies with nothing
// installed beside it (#33). Applied by the build test (build.test.mjs) and by
// the installer tests' stub daemon (scripts/tests/lib/cli-stub.mjs).
import { isBuiltin } from "node:module";

// Every module specifier a source file imports or re-exports.
export const imports = (text) => [
	...[...text.matchAll(/^\s*(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]),
	...[...text.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
];

// What the host supplies: Node's builtins and the server SDK.
export const hostSupplied = (specifier) => isBuiltin(specifier) || specifier === "@getpaseo/plugin/server";
