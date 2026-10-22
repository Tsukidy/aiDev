// Records read back by lib/aidev-install.mjs, called directly. The text in
// front of a marked block (blockBefore, #35): a settled `before` as recorded,
// or, for an intent, what lies between the text the file held and the block
// while that text is still the file's prefix. A write recorded before it is
// made (#50): what loading, placing and taking back a file whose whole
// content is ours read from its record and its backup, and the order of a
// recorded write.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { blockBefore, checkpointedWrite, loadManifest, ownedFileAction, reverseOwnedFile, sha256 } from '../lib/aidev-install.mjs';
import { backupItem, backupPending, markedBlockIntent, markedBlockItem, newManifest, ownedFileItem, recordWrite, serialize } from '../lib/manifest.mjs';

const path = '/h/captain.md';
const block = '<!-- x:start -->\nbody\n<!-- x:end -->\n';
const held = '# Orders\n\nNever push.\n';

test('a settled item returns its before, empty or not', () => {
	const text = `${held}\n## H\n\n${block}`;
	assert.equal(blockBefore(text, markedBlockItem(path, 'x', '\n## H\n\n')), '\n## H\n\n');
	assert.equal(blockBefore(text, markedBlockItem(path, 'x', '')), '');
});

test('an intent returns what the script put between the text held and the block', () => {
	assert.equal(blockBefore(`${held}\n## H\n\n${block}`, markedBlockIntent(path, 'x', held)), '\n## H\n\n');
	assert.equal(blockBefore(`${held}${block}`, markedBlockIntent(path, 'x', held)), '');
});

test('an intent at an empty file returns everything before the block', () => {
	assert.equal(blockBefore(`# Orders\n\n${block}`, markedBlockIntent(path, 'x', '')), '# Orders\n\n');
});

test('an intent returns nothing when the block is absent', () => {
	assert.equal(blockBefore(`${held}\n## H\n\n`, markedBlockIntent(path, 'x', held)), '');
});

test('an intent returns nothing when the text held has changed', () => {
	assert.equal(blockBefore(`# Orders\n\nAlways push.\n\n## H\n\n${block}`, markedBlockIntent(path, 'x', held)), '');
});

// --- a write recorded before it is made (#50) ---------------------------------

const ours = 'ours\n';
const theirs = 'the operator\'s\n';
const older = 'ours, older\n';
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function home() {
	const dir = mkdtempSync(join(tmpdir(), 'aidev-'));
	dirs.push(dir);
	return { home: dir, manifestPath: join(dir, 'manifest.json'), backupsDir: join(dir, 'backups'), env: {} };
}

// A manifest as a run killed inside placing agent.md left it, loaded. The
// file holds `text` (null: absent); the record starts at `sha` and records the
// write of ours. With `backup`, the operator's file's backup is recorded too,
// pending, and copied when `copied`; `done` marks it settled.
function loadedAfterKill({ text, sha = text === null ? null : sha256(text), backup = false, copied = true, done = false }) {
	const ctx = home();
	const path = join(ctx.home, 'agent.md');
	const copy = join(ctx.backupsDir, '001-agent.md');
	if (text !== null) writeFileSync(path, text);
	const m = newManifest('x');
	const record = ownedFileItem({ kind: 'agent', name: 'agent', path, sha256: sha, existedBefore: backup });
	recordWrite(record, sha256(ours));
	m.items.push(record);
	if (backup) {
		if (copied) {
			mkdirSync(ctx.backupsDir);
			writeFileSync(copy, theirs);
		}
		m.items.push((done ? backupItem : backupPending)(path, copy, sha256(theirs)));
	}
	writeFileSync(ctx.manifestPath, serialize(m));
	return { m: loadManifest(ctx), path, copy };
}

const kinds = (m) => m.items.map((i) => i.kind);

test('a recorded write the file holds is what we last wrote', () => {
	const { m, path } = loadedAfterKill({ text: ours, sha: null });
	assert.deepEqual(m.items, [ownedFileItem({ kind: 'agent', name: 'agent', path, sha256: sha256(ours), existedBefore: false })]);
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'current');
});

test('an update never made leaves what we wrote before, to write again', () => {
	const { m, path } = loadedAfterKill({ text: older });
	assert.deepEqual([m.items[0].sha256, 'next' in m.items[0]], [sha256(older), false]);
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'write');
});

test('a new file never written is not ours', () => {
	assert.deepEqual(loadedAfterKill({ text: null }).m.items, []);
});

test("a write over the operator's file, never made before its backup was copied, was not made", () => {
	const { m, path } = loadedAfterKill({ text: theirs, backup: true, copied: false });
	assert.deepEqual(m.items, []);
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'replace');
});

test('...even when the operator\'s file holds what ours would', () => {
	const { m } = loadedAfterKill({ text: ours, sha: sha256(ours), backup: true, copied: false });
	assert.deepEqual(m.items, []);
});

test("a write over the operator's file, never made once its backup was copied, starts from their file", () => {
	const { m, path } = loadedAfterKill({ text: theirs, backup: true });
	assert.deepEqual(kinds(m), ['agent', 'backup']);
	assert.equal('pending' in m.items[1], false);
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'write');
	assert.equal(reverseOwnedFile(m, m.items[0]), null);
	assert.equal(readFileSync(path, 'utf8'), theirs);
	assert.deepEqual(m.items, []);
});

test("...and an edit of their file since is kept, with its backup", () => {
	const { m, path, copy } = loadedAfterKill({ text: theirs, backup: true });
	writeFileSync(path, 'edited\n');
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'kept');
	assert.match(reverseOwnedFile(m, m.items[0]), /modified since install; the pre-install original is at .*001-agent\.md/);
	assert.equal(readFileSync(path, 'utf8'), 'edited\n');
	assert.equal(readFileSync(copy, 'utf8'), theirs);
});

test('a settled backup whose copy is gone keeps its record', () => {
	const { m } = loadedAfterKill({ text: ours, sha: sha256(ours), backup: true, copied: false, done: true });
	assert.deepEqual(kinds(m), ['agent', 'backup']);
});

test('a checkpointed write saves its records, then copies the backup, then writes', () => {
	const ctx = home();
	const path = join(ctx.home, 'settings.json');
	const copy = join(ctx.backupsDir, '001-settings.json');
	writeFileSync(path, theirs);
	const m = newManifest('x');
	const seen = [];
	const checkpoint = () => seen.push(['saved', structuredClone(m.items), existsSync(copy)]);
	checkpointedWrite(ctx, m, checkpoint, path, { backup: true }, () => {
		seen.push(['write', readFileSync(copy, 'utf8')]);
		writeFileSync(path, ours);
	});
	assert.deepEqual(seen, [
		['saved', [backupPending(path, copy, sha256(theirs))], false],
		['write', theirs],
	]);
	assert.deepEqual(m.items, [backupItem(path, copy, sha256(theirs))]);
});
