// The daemon builds this plugin from its source, where it is installed, every
// time it loads it (Paseo's plugins/compiler.js), and resolves each import
// there. A copy installed without node_modules therefore builds only while the
// source imports nothing but what the host supplies (#33). These tests guard
// that: always by reading the imports, and, wherever Paseo is installed, by
// building a copy of the files package.json lists, as the installer copies
// them, with Paseo's own compiler.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).files;

// Every module specifier a source file imports or re-exports.
const imports = (text) => [
	...[...text.matchAll(/^\s*(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]),
	...[...text.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
];

// What the host supplies: Node's builtins and the server SDK.
const hostSupplied = (specifier) => isBuiltin(specifier) || specifier === "@getpaseo/plugin/server";

test("index.server.ts imports only what the host supplies", () => {
	const found = imports(readFileSync(join(pluginDir, "index.server.ts"), "utf8"));
	assert.ok(found.includes("@getpaseo/plugin/server"), "the import scan sees the SDK import");
	assert.deepEqual(found.filter((s) => !hostSupplied(s)), []);
});

// Paseo's plugin compiler beside the `paseo` on PATH (its CLI package's
// sibling @getpaseo/server), or null when Paseo is not installed.
function paseoCompiler() {
	const bin = (process.env.PATH ?? "")
		.split(":")
		.filter(Boolean)
		.map((d) => join(d, "paseo"))
		.find((p) => existsSync(p));
	if (!bin) return null;
	const cli = dirname(dirname(realpathSync(bin)));
	return join(dirname(cli), "server", "dist", "server", "server", "plugins", "compiler.js");
}
const compiler = paseoCompiler();

test("Paseo's compiler builds the installed copy, which has no node_modules", { skip: !compiler && "Paseo is not installed (no paseo on PATH)" }, async () => {
	assert.ok(existsSync(compiler), `paseo is on PATH, but its plugin compiler is not at ${compiler}`);
	const { compilePlugin } = await import(pathToFileURL(compiler).href);
	const copy = mkdtempSync(join(tmpdir(), "beads-onboarding-build-"));
	try {
		for (const f of files) copyFileSync(join(pluginDir, f), join(copy, f));
		const { serverBundle } = await compilePlugin({ server: join(copy, "index.server.ts") });
		assert.match(serverBundle, /createOnboardingHandler/);
	} finally {
		rmSync(copy, { recursive: true, force: true });
	}
});
