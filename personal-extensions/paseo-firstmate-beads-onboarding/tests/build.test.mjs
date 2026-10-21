// The daemon builds this plugin from its source, where it is installed, every
// time it loads it (Paseo's plugins/compiler.js), and resolves each import
// there. A copy installed without node_modules therefore builds only while the
// source imports nothing but what the host supplies (#33). These tests guard
// that: always by reading the imports, and, wherever Paseo is installed, by
// building a copy of the files package.json lists, as the installer copies
// them, with Paseo's own compiler.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostSupplied, imports } from "./host-supplied.mjs";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).files;

test("index.server.ts imports only what the host supplies", () => {
	const found = imports(readFileSync(join(pluginDir, "index.server.ts"), "utf8"));
	assert.ok(found.includes("@getpaseo/plugin/server"), "the import scan sees the SDK import");
	assert.deepEqual(found.filter((s) => !hostSupplied(s)), []);
});

// Paseo's plugin compiler, beside the main of the @getpaseo/server that the
// CLI package of the `paseo` on PATH resolves (nested in it or flat beside
// it): null without paseo on PATH, an Error when paseo is there but the
// compiler is not.
function paseoCompiler() {
	const bin = (process.env.PATH ?? "")
		.split(":")
		.filter(Boolean)
		.map((d) => join(d, "paseo"))
		.find((p) => existsSync(p));
	if (!bin) return null;
	let pkg = dirname(realpathSync(bin));
	while (!existsSync(join(pkg, "package.json")) && dirname(pkg) !== pkg) pkg = dirname(pkg);
	let server;
	try {
		server = createRequire(join(pkg, "package.json")).resolve("@getpaseo/server");
	} catch (e) {
		return new Error(`paseo is on PATH (${bin}), but @getpaseo/server does not resolve from ${pkg}: ${e.message}`);
	}
	const compiler = join(dirname(server), "plugins", "compiler.js");
	return existsSync(compiler) ? compiler : new Error(`paseo is on PATH (${bin}), but its plugin compiler is not at ${compiler}`);
}
const compiler = paseoCompiler();

test("Paseo's compiler builds the installed copy, which has no node_modules", { skip: compiler === null && "Paseo is not installed (no paseo on PATH)" }, async () => {
	if (compiler instanceof Error) throw compiler;
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
