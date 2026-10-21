// The daemon builds this plugin from its source, where it is installed, every
// time it loads it (Paseo's plugins/compiler.js), and resolves each import
// there. A copy installed without node_modules therefore builds only while the
// source imports nothing but what the host supplies (#33). These tests guard
// that: always by reading the imports, and, on a machine with Paseo installed,
// by building a bare copy with Paseo's own compiler.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every module specifier in a source file, and whether its statement is
// type-only (`import type …` / `export type … from`).
function imports(text) {
	const found = [];
	for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)) {
		found.push({ specifier: m[2], typeOnly: Boolean(m[1]) });
	}
	for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)) found.push({ specifier: m[1], typeOnly: false });
	return found;
}

// What the host supplies: Node's builtins, the server SDK, and protocol types
// (erased, and exempt from resolution in the compiler).
const hostSupplied = ({ specifier, typeOnly }) =>
	isBuiltin(specifier) || specifier === "@getpaseo/plugin/server" || (typeOnly && specifier.startsWith("@getpaseo/protocol/"));

test("index.server.ts imports only what the host supplies", () => {
	const found = imports(readFileSync(join(pluginDir, "index.server.ts"), "utf8"));
	assert.ok(found.some((i) => i.specifier === "@getpaseo/plugin/server"), "the import scan sees the SDK import");
	assert.deepEqual(
		found.filter((i) => !hostSupplied(i)).map((i) => i.specifier),
		[],
	);
});

// Paseo's server package beside the running node (the global npm root), if any.
const compiler = join(dirname(dirname(process.execPath)), "lib", "node_modules", "@getpaseo", "server", "dist", "server", "server", "plugins", "compiler.js");

test("Paseo's compiler builds a copy that has no node_modules", { skip: !existsSync(compiler) && `no Paseo compiler at ${compiler}` }, async () => {
	const { compilePlugin } = await import(pathToFileURL(compiler).href);
	const copy = mkdtempSync(join(tmpdir(), "beads-onboarding-build-"));
	try {
		for (const f of ["index.server.ts", "paseo-plugin.json", "package.json", "tsconfig.json"]) copyFileSync(join(pluginDir, f), join(copy, f));
		const { serverBundle } = await compilePlugin({ server: join(copy, "index.server.ts") });
		assert.match(serverBundle, /createOnboardingHandler/);
	} finally {
		rmSync(copy, { recursive: true, force: true });
	}
});
