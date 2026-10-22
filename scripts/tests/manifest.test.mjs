// The install manifest's changes (lib/manifest.mjs), called directly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, dirItem, newManifest, pluginItem, replace } from '../lib/manifest.mjs';

test('replace puts the new item where the old one was', () => {
	const m = newManifest('abc');
	const before = add(m, dirItem('/h/a'));
	const old = add(m, pluginItem('p', '/h/copy'));
	const after = add(m, dirItem('/h/b'));
	replace(m, old, pluginItem('p', '/h/copy', 'sha'));
	assert.deepEqual(m.items, [before, { kind: 'plugin', id: 'p', path: '/h/copy', buildSha256: 'sha' }, after]);
});

test('replace throws when the old item is not in the manifest, and changes nothing', () => {
	const m = newManifest('abc');
	add(m, dirItem('/h/a'));
	assert.throws(() => replace(m, pluginItem('p', '/h/copy'), pluginItem('p', '/h/copy', 'sha')), /not in the manifest/);
	assert.deepEqual(m.items, [{ kind: 'dir', path: '/h/a' }]);
	assert.equal(Object.hasOwn(m.items, '-1'), false);
});
