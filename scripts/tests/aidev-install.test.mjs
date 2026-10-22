// The text in front of a marked block, read from its manifest item
// (lib/aidev-install.mjs blockBefore, #35), called directly: a settled
// `before` as recorded, or, for an intent, what lies between the text the
// file held and the block while that text is still the file's prefix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockBefore } from '../lib/aidev-install.mjs';
import { markedBlockIntent, markedBlockItem } from '../lib/manifest.mjs';

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

test('an intent returns nothing when the block starts inside the text held', () => {
	assert.equal(blockBefore(`# Orders\n\n${block}Never push.\n`, markedBlockIntent(path, 'x', held)), '');
});

test('an intent returns nothing when the text held has changed', () => {
	assert.equal(blockBefore(`# Orders\n\nAlways push.\n\n## H\n\n${block}`, markedBlockIntent(path, 'x', held)), '');
});
