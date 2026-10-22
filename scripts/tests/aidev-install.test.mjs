// Records read back by lib/aidev-install.mjs, called directly. The text in
// front of a marked block (blockBefore, #35): a settled `before` as recorded,
// or, for an intent, what lies between the text the file held and the block
// while that text is still the file's prefix. A write recorded before it is
// made (#50): what placing, settling and taking back a file whose whole
// content is ours read from its record, and a backup whose copy is not made.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backupOnce, blockBefore, ownedFileAction, reverseOwnedFile, settleOwnedFile, sha256 } from '../lib/aidev-install.mjs';
import { backupItem, markedBlockIntent, markedBlockItem, newManifest, ownedFileItem } from '../lib/manifest.mjs';

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

// A manifest holding one owned-file record, as a run killed after recording
// its write left it, over a file holding `text` (null: absent), with a
// backup copy of the operator's file when `backup` is set.
function killedBeforeWrite({ text, sha = null, backup = false }) {
	const dir = mkdtempSync(join(tmpdir(), 'aidev-'));
	const path = join(dir, 'agent.md');
	if (text !== null) writeFileSync(path, text);
	const m = newManifest('x');
	const record = ownedFileItem({ kind: 'agent', name: 'agent', path, sha256: sha, existedBefore: backup });
	record.next = sha256(ours);
	m.items.push(record);
	if (backup) {
		writeFileSync(join(dir, '001-agent.md'), theirs);
		m.items.push(backupItem(path, join(dir, '001-agent.md'), sha256(theirs)));
	}
	return { dir, path, m, record };
}

test('a recorded write that was made is current, and settles', () => {
	const { path, m, record } = killedBeforeWrite({ text: ours });
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'current');
	settleOwnedFile(m, record);
	assert.deepEqual([record.sha256, 'next' in record], [sha256(ours), false]);
});

test("a recorded write never made over the operator's file replaces it again", () => {
	const { path, m } = killedBeforeWrite({ text: theirs, backup: true });
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'replace');
});

test('a recorded write never made on a new file writes it', () => {
	const { path, m } = killedBeforeWrite({ text: null });
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'write');
});

test('a recorded update never made writes over what we wrote before', () => {
	const { path, m } = killedBeforeWrite({ text: 'ours, older\n', sha: sha256('ours, older\n') });
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'write');
});

test("taking back a write never made leaves the operator's file and drops the backup", () => {
	const { dir, path, m, record } = killedBeforeWrite({ text: theirs, backup: true });
	assert.equal(reverseOwnedFile(m, record), null);
	assert.equal(readFileSync(path, 'utf8'), theirs);
	assert.equal(existsSync(join(dir, '001-agent.md')), false);
	assert.deepEqual(m.items, []);
});

test('settling a write never made on a file never ours drops the record', () => {
	const { path, m, record } = killedBeforeWrite({ text: theirs });
	settleOwnedFile(m, record);
	assert.equal(readFileSync(path, 'utf8'), theirs);
	assert.deepEqual(m.items, []);
});

// A backup recorded, and checkpointed, but its copy never made.
function backupNotCopied() {
	const dir = mkdtempSync(join(tmpdir(), 'aidev-'));
	const path = join(dir, 'settings.json');
	const copy = join(dir, 'backups', '001-settings.json');
	writeFileSync(path, theirs);
	const m = newManifest('x');
	m.items.push(backupItem(path, copy, sha256(theirs)));
	return { ctx: { backupsDir: join(dir, 'backups') }, path, copy, m };
}

test('a backup whose copy was never made is made while the file holds what was recorded', () => {
	const { ctx, path, copy, m } = backupNotCopied();
	let saves = 0;
	backupOnce(ctx, m, () => saves++, path);
	assert.equal(readFileSync(copy, 'utf8'), theirs);
	assert.equal(m.items.length, 1);
	assert.equal(saves, 0);
});

test('a backup whose copy was never made is not made from a file changed since', () => {
	const { ctx, path, copy, m } = backupNotCopied();
	writeFileSync(path, ours);
	backupOnce(ctx, m, () => {}, path);
	assert.equal(existsSync(copy), false);
});
