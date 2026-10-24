// Only lib/aidev-install.mjs creates or changes files or runs commands for
// the installer, so the saved-manifest guard there sees every write and call
// (#35, #50). Every other installer module (install.mjs, uninstall.mjs,
// lib/*.mjs) may import node:fs to read and to remove, never to write, and
// never imports node:child_process. Run with a tree as INSTALLER_TREE to
// check another checkout.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const tree = resolve(process.env.INSTALLER_TREE ?? join(import.meta.dirname, '..', '..'));
const CORE = 'scripts/lib/aidev-install.mjs';
const WRITERS = new Set([
	'appendFileSync',
	'chmodSync',
	'chownSync',
	'copyFileSync',
	'cpSync',
	'createWriteStream',
	'linkSync',
	'mkdirSync',
	'mkdtempSync',
	'openSync',
	'renameSync',
	'symlinkSync',
	'truncateSync',
	'utimesSync',
	'writeFileSync',
	'writeSync',
]);
const FIX = `write through placeOwnedFile, placeSharedFile, checkpointedWrite or makeDir, and run commands through run(), all from ${CORE}`;

const modules = [
	...['install.mjs', 'uninstall.mjs'].map((f) => join(tree, 'scripts', f)),
	...readdirSync(join(tree, 'scripts', 'lib'))
		.filter((f) => f.endsWith('.mjs'))
		.map((f) => join(tree, 'scripts', 'lib', f)),
].filter((p) => relative(tree, p) !== CORE);

function violations(path) {
	const text = readFileSync(path, 'utf8');
	const out = [];
	for (const [, names, from] of text.matchAll(/import\s*(\{[^}]*\}|\*\s*as\s+\w+|\w+)\s*from\s*'((?:node:)?(?:fs|fs\/promises|child_process))'/g)) {
		if (from.endsWith('child_process')) out.push(`imports ${from}`);
		else if (!names.startsWith('{') || from.endsWith('promises')) out.push(`imports all of ${from}`);
		else for (const n of names.slice(1, -1).split(',').map((s) => s.trim().split(/\s+as\s+/)[0])) if (WRITERS.has(n)) out.push(`imports ${n} from ${from}`);
	}
	return out.map((v) => `${relative(tree, path)} ${v} — ${FIX}`);
}

test('no installer module but the core writes files or runs commands itself', () => {
	assert.deepEqual(modules.flatMap(violations), []);
});
