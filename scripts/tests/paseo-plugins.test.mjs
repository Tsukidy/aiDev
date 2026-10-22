// The Paseo plugins step's decision table (lib/paseo-plugins.mjs,
// #33), called directly: which daemon call each registration needs, and the
// line that names it. The sandbox cases of test-install-plugin.sh drive the
// same step end to end.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeStep, invalidFileEntries, pluginStep, registrationOf } from '../lib/paseo-plugins.mjs';

const id = 'firstmate-beads-onboarding';
const copy = '/home/u/.local/share/aidev/paseo-plugins/firstmate-beads-onboarding';
const step = (registration, stale) => pluginStep({ id, copy, registration, stale });
const ours = (status) => ({ id, path: copy, status, ours: true });

test('registrationOf: ours only from the copy; none when Paseo has no such id', () => {
	const plugins = [{ id, path: copy, status: 'running' }];
	assert.equal(registrationOf(plugins, { id, path: copy }).ours, true);
	assert.equal(registrationOf(plugins, { id, path: '/elsewhere' }).ours, false);
	assert.equal(registrationOf(plugins, { id: 'other', path: copy }), null);
});

test('not registered → install the copy', () => {
	for (const stale of [true, false]) assert.deepEqual(step(null, stale), { kind: 'install', id, path: copy });
});

test('registered from another path → foreign, whatever its status', () => {
	for (const status of ['running', 'failed', 'disabled']) {
		assert.deepEqual(step({ id, path: '/elsewhere', status, ours: false }, true), { kind: 'foreign', id, path: '/elsewhere' });
	}
});

test('ours and failed → reload, stale or not', () => {
	for (const stale of [true, false]) assert.deepEqual(step(ours('failed'), stale), { kind: 'reload', id, path: copy });
});

test('ours and running → reload when stale, else nothing', () => {
	assert.deepEqual(step(ours('running'), true), { kind: 'reload', id, path: copy });
	assert.deepEqual(step(ours('running'), false), { kind: 'none', id, path: copy, status: 'running' });
});

test('ours and disabled → nothing, stale or not (Paseo refuses to reload it)', () => {
	for (const stale of [true, false]) assert.deepEqual(step(ours('disabled'), stale), { kind: 'none', id, path: copy, status: 'disabled' });
});

test('describeStep names the call, or why there is none', () => {
	assert.equal(describeStep(step(null, true)), `plugin ${id}: copy to ${copy}, then paseo plugin install ${copy}`);
	assert.equal(describeStep(step(ours('failed'), false)), `plugin ${id}: copy to ${copy}, then paseo plugin reload ${id}`);
	assert.equal(describeStep(step(ours('disabled'), true)), `plugin ${id}: copy to ${copy}, then no daemon call (Paseo reports it disabled)`);
	assert.equal(
		describeStep(step({ id, path: '/elsewhere', status: 'running', ours: false }, true)),
		`plugin ${id} is registered from /elsewhere, not this installer's copy — left as is`,
	);
});

test('invalidFileEntries: only plain names of existing files pass', () => {
	const dir = mkdtempSync(join(tmpdir(), 'onboarding-files-'));
	try {
		writeFileSync(join(dir, 'index.server.ts'), '');
		mkdirSync(join(dir, 'server'));
		assert.deepEqual(invalidFileEntries(['index.server.ts'], dir), []);
		assert.deepEqual(invalidFileEntries(['index.server.ts', '*.ts', 'server', 'server/x.ts', '../x', 'missing.json', 7], dir), [
			'*.ts',
			'server',
			'server/x.ts',
			'../x',
			'missing.json',
			7,
		]);
		assert.deepEqual(invalidFileEntries(undefined, dir), ['(no "files" array)']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
