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
import { blockBefore, loadManifest, ownedFileAction, recordedWrite, reverseOwnedFile, sha256 } from '../lib/aidev-install.mjs';
import { backupItem, markedBlockIntent, markedBlockItem, newManifest, ownedFileItem, recordWrite, serialize } from '../lib/manifest.mjs';

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
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A home whose agent file holds `text` (null: absent), and a manifest with
// that file's record as a run killed in its write left it: `sha256` what we
// wrote before (null: nothing), `next` the content of the write. With
// `backup`, the operator's file's backup is recorded too, and copied when
// `copied`.
function killedInWrite({ text, sha = null, backup = false, copied = true }) {
	const home = mkdtempSync(join(tmpdir(), 'aidev-'));
	dirs.push(home);
	const ctx = { home, manifestPath: join(home, 'manifest.json'), backupsDir: join(home, 'backups'), env: {} };
	const path = join(home, 'agent.md');
	if (text !== null) writeFileSync(path, text);
	const m = newManifest('x');
	const record = ownedFileItem({ kind: 'agent', name: 'agent', path, sha256: sha, existedBefore: backup });
	recordWrite(record, sha256(ours));
	m.items.push(record);
	if (backup) {
		const copy = join(ctx.backupsDir, '001-agent.md');
		if (copied) {
			mkdirSync(ctx.backupsDir);
			writeFileSync(copy, theirs);
		}
		m.items.push(backupItem(path, copy, sha256(theirs)));
	}
	writeFileSync(ctx.manifestPath, serialize(m));
	return { ctx, path, copy: join(ctx.backupsDir, '001-agent.md') };
}

test('loading settles a write the file holds as what we last wrote', () => {
	const { ctx, path } = killedInWrite({ text: ours });
	const m = loadManifest(ctx);
	assert.deepEqual(m.items, [ownedFileItem({ kind: 'agent', name: 'agent', path, sha256: sha256(ours), existedBefore: false })]);
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'current');
});

test('loading settles a write the file does not hold as never made', () => {
	const older = 'ours, older\n';
	const { ctx, path } = killedInWrite({ text: older, sha: sha256(older) });
	const m = loadManifest(ctx);
	assert.equal(m.items[0].sha256, sha256(older));
	assert.equal('next' in m.items[0], false);
	assert.equal(ownedFileAction(m, { path, content: ours }).action, 'write');
});

test("a write never made over the operator's file replaces it, and on a new file writes it", () => {
	const over = killedInWrite({ text: theirs, backup: true });
	assert.equal(ownedFileAction(loadManifest(over.ctx), { path: over.path, content: ours }).action, 'replace');
	const fresh = killedInWrite({ text: null });
	assert.equal(ownedFileAction(loadManifest(fresh.ctx), { path: fresh.path, content: ours }).action, 'write');
});

test('loading drops a backup never copied', () => {
	const { ctx } = killedInWrite({ text: theirs, backup: true, copied: false });
	assert.deepEqual(
		loadManifest(ctx).items.map((i) => i.kind),
		['agent'],
	);
});

test("taking back a write never made leaves the operator's file and discards its backup", () => {
	const { ctx, path, copy } = killedInWrite({ text: theirs, backup: true });
	const m = loadManifest(ctx);
	assert.equal(reverseOwnedFile(m, m.items[0]), null);
	assert.equal(readFileSync(path, 'utf8'), theirs);
	assert.equal(existsSync(copy), false);
	assert.deepEqual(m.items, []);
});

test('taking back a write never made keeps the backup of a file changed since', () => {
	const { ctx, path, copy } = killedInWrite({ text: theirs, backup: true });
	writeFileSync(path, 'edited\n');
	const m = loadManifest(ctx);
	assert.match(reverseOwnedFile(m, m.items[0]), /001-agent\.md/);
	assert.equal(readFileSync(copy, 'utf8'), theirs);
	assert.deepEqual(m.items, []);
});

test('a recorded write saves its records, then copies the backup, then writes', () => {
	const { ctx, path, copy } = killedInWrite({ text: theirs });
	const m = newManifest('x');
	const seen = [];
	const checkpoint = () => seen.push(['saved', m.items.map((i) => i.kind), existsSync(copy)]);
	recordedWrite(ctx, m, checkpoint, path, {
		backup: true,
		write: () => {
			seen.push(['write', readFileSync(copy, 'utf8')]);
			writeFileSync(path, ours);
		},
	});
	assert.deepEqual(seen, [
		['saved', ['backup'], false],
		['write', theirs],
	]);
});
