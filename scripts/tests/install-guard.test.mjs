// The saved-manifest guard of lib/aidev-install.mjs (#35, #50), called
// directly: once an install has its checkpoint, a write to a path, or into a
// directory, the saved manifest does not name is refused, and so is a
// command run while a recorded item is unsaved. Its own file, because the
// guard holds for the rest of the process.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { installCheckpoint, makeDir, run, writeAtomic } from '../lib/aidev-install.mjs';
import { add, dirItem, newManifest, ownedFileItem } from '../lib/manifest.mjs';

const home = mkdtempSync(join(tmpdir(), 'aidev-guard-'));
after(() => rmSync(home, { recursive: true, force: true }));
const ctx = { env: { PATH: process.env.PATH }, home, manifestPath: join(home, 'state', 'install-manifest.json') };
const m = newManifest('test');
const checkpoint = installCheckpoint(ctx, m, [join(home, 'state')]);
const file = (path) => ownedFileItem({ path, sha256: null, existedBefore: false });

test('a write to a path the saved manifest does not name is refused', () => {
	assert.throws(() => writeAtomic(join(home, 'a.md'), 'a'), /would write .*a\.md, which the saved manifest does not name/);
});

test('a recorded path is still refused until the checkpoint saves it, then written', () => {
	const a = join(home, 'a.md');
	add(m, file(a));
	assert.throws(() => writeAtomic(a, 'a'), /saved manifest does not name/);
	checkpoint();
	writeAtomic(a, 'a');
	assert.equal(readFileSync(a, 'utf8'), 'a');
});

test('a directory the write would create must be saved too', () => {
	const dir = join(home, 'new');
	const b = join(dir, 'b.md');
	add(m, file(b));
	checkpoint();
	assert.throws(() => writeAtomic(b, 'b'), /would create the directory .*new, which the saved manifest does not name/);
	assert.throws(() => makeDir(dir), /would create the directory/);
	add(m, dirItem(dir));
	checkpoint();
	writeAtomic(b, 'b');
	assert.equal(readFileSync(b, 'utf8'), 'b');
});

test('a command waits for every recorded item to be saved; a read-only one does not', () => {
	add(m, file(join(home, 'c.md')));
	assert.throws(() => run(ctx, 'true', []), /would run true before the file item for .*c\.md is saved/);
	assert.equal(run(ctx, 'true', [], { readOnly: true }).status, 0);
	checkpoint();
	assert.equal(run(ctx, 'true', []).status, 0);
});
