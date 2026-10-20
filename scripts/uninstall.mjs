#!/usr/bin/env node
//
// uninstall.mjs — reverses exactly what install.mjs recorded in its manifest
// (ticket #21; spec #11 D8). Usage:
//
//   node scripts/uninstall.mjs [--dry-run] [--purge [--yes]]
//
// No manifest → refuses, nothing touched. Otherwise, in order: the skills it
// installed (through the skills CLI), the agents, hook files, license copies
// and plugin copy it placed (each only while it still holds what was
// installed; a file edited since, like a tuned model sheet, is kept and
// reported), its settings hook entry and marked blocks (stripped from
// settings.json, CLAUDE.md and captain.md; when the result equals the
// pre-install backup, the backup's exact bytes come back), the onboarding
// plugin, and the directories it created, if empty. Beads databases the setup
// created are kept unless --purge, which asks for confirmation on a terminal
// (or takes --yes) before anything is touched.

import { createInterface } from 'node:readline/promises';
import {
	SKILLS_CLI,
	existsSync,
	fileSha,
	findOnPath,
	insideHome,
	jsonText,
	loadManifest,
	makeReport,
	paseoPluginIds,
	parseFlags,
	readFileSync,
	readJsonObject,
	readSkillsLock,
	readText,
	removeEmptyDir,
	removeHookEntry,
	rmSync,
	run,
	resolveContext,
	saveManifest,
	skillsCli,
	stripBlock,
	writeAtomic,
} from './lib/aidev-install.mjs';

const report = makeReport('uninstall');
const flags = parseFlags(process.argv.slice(2), ['--dry-run', '--purge', '--yes'], 'uninstall');
const ctx = resolveContext(process.env);

let m;
try {
	m = loadManifest(ctx);
} catch (e) {
	report.die(`${e.message} — refusing, nothing touched`);
}
if (!m) report.die(`no install manifest at ${ctx.manifestPath} — refusing to guess what to remove; nothing touched`);

const of = (kind) => m.items.filter((i) => i.kind === kind);
const kept = [];

// --- preconditions ---------------------------------------------------------------

for (const i of m.items) {
	for (const p of [i.path, i.of].filter(Boolean)) {
		if (!insideHome(ctx, p)) report.error(`manifest names a path outside HOME (${ctx.home}): ${p}`);
	}
}
if (of('skill').length && !findOnPath('npx', ctx.env)) report.error('npx not found on PATH — needed to remove the skills through the skills CLI');
if (of('plugin').length && !findOnPath('paseo', ctx.env)) report.error('paseo not found on PATH — needed to remove the onboarding plugin');
if (report.errors.length) report.die('nothing touched');

const dbs = of('beads-db');
if (flags.purge && dbs.length && !flags.yes && !flags['dry-run']) {
	if (!process.stdin.isTTY) report.die('--purge needs confirmation: run it on a terminal, or add --yes — nothing touched');
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await rl.question(`--purge deletes these beads databases, which the setup created:\n${dbs.map((d) => `  ${d.path}\n`).join('')}Type "purge" to delete them: `);
	rl.close();
	if (answer.trim() !== 'purge') report.die('not confirmed — nothing touched');
}

// --- plan -------------------------------------------------------------------------

const ownedFiles = m.items.filter((i) => (i.kind === 'agent' || i.kind === 'file') && !i.shared);
const sharedFiles = m.items.filter((i) => i.kind === 'file' && i.shared);
if (flags['dry-run']) {
	const plan = [
		...(of('skill').length ? [`skills remove (${SKILLS_CLI}, user level): ${of('skill').map((s) => s.name).join(' ')}`] : []),
		...ownedFiles.map((f) => `remove ${f.path} if unchanged since install${backupOf(f.path) ? ', then restore the operator\'s original' : ''}`),
		...sharedFiles.map((f) => `strip our block/entry from ${f.path}`),
		...of('plugin').map((p) => `paseo plugin remove ${p.id}`),
		...dbs.map((d) => (flags.purge ? `purge ${d.path}` : `keep ${d.path} (beads database; --purge removes it)`)),
		`remove ${ctx.manifestPath} and the directories the install created, if empty`,
	];
	console.log('uninstall --dry-run: nothing touched. The plan:');
	for (const line of plan) console.log(`  - ${line}`);
	process.exit(0);
}

function backupOf(path) {
	return m.items.find((i) => i.kind === 'backup' && i.of === path);
}
const drop = (item) => {
	m.items = m.items.filter((i) => i !== item);
};
const dropBackup = (path) => {
	const b = backupOf(path);
	if (!b) return;
	rmSync(b.path, { force: true });
	drop(b);
};
const fail = (msg) => {
	saveManifest(ctx, m);
	report.die(`${msg}; the manifest keeps what is left — fix and re-run uninstall`);
};

// --- skills -----------------------------------------------------------------------

const skills = of('skill');
if (skills.length) {
	const names = skills.map((s) => s.name);
	const agent = skills[0].agent;
	const r = skillsCli(ctx, ['remove', '-g', '-y', '-a', agent, '-s', ...names]);
	const left = skills.filter((s) => existsSync(s.path));
	for (const s of skills) if (!left.includes(s)) drop(s);
	if (r.status !== 0 || left.length) fail(`skills CLI remove failed (exit ${r.status}; still present: ${left.map((s) => s.name).join(' ') || 'none'})`);
}
// The CLI keeps its lock after the last skill goes; a lock the install
// created and that now lists no skills is removed.
for (const l of of('skills-lock')) {
	const lock = readSkillsLock(ctx);
	if (!l.existedBefore && lock && Object.keys(lock.skills ?? {}).length === 0) rmSync(l.path, { force: true });
	drop(l);
}
saveManifest(ctx, m);

// --- files whose whole content is ours ----------------------------------------------

for (const f of ownedFiles) {
	const cur = fileSha(f.path);
	const b = backupOf(f.path);
	if (cur === null) {
		// already gone
	} else if (cur === f.sha256) {
		rmSync(f.path, { force: true });
	} else {
		kept.push(`${f.path} (modified since install${b ? `; the pre-install original is at ${b.path}` : ''})`);
		drop(f);
		if (b) drop(b); // kept on disk, reported above
		continue;
	}
	if (b) {
		writeAtomic(f.path, readFileSync(b.path));
		dropBackup(f.path);
	}
	drop(f);
}
saveManifest(ctx, m);

// --- files we share: strip our parts; the backup's bytes when that is all it was ---

for (const f of sharedFiles) {
	const text = readText(f.path);
	const b = backupOf(f.path);
	if (text !== null) {
		const isJson = f.path.endsWith('.json');
		let result;
		try {
			if (isJson) {
				let v = JSON.parse(text);
				for (const h of m.items.filter((i) => i.kind === 'hook-entry' && i.path === f.path)) v = removeHookEntry(v, h.event, h.marker);
				result = v;
			} else {
				result = text;
				const blocks = m.items.filter((i) => i.kind === 'marked-block' && i.path === f.path);
				for (const blk of blocks.reverse()) result = stripBlock(result, blk.id, blk.before);
			}
		} catch (e) {
			fail(`cannot strip our parts from ${f.path}: ${e.message}`);
		}
		const original = b ? readFileSync(b.path, 'utf8') : null;
		const same = original === null ? false : isJson ? JSON.stringify(readJsonObject(b.path)) === JSON.stringify(result) : original === result;
		if (same) writeAtomic(f.path, readFileSync(b.path));
		else if (!b && !f.existedBefore && (isJson ? Object.keys(result).length === 0 : result === '')) rmSync(f.path, { force: true });
		else writeAtomic(f.path, isJson ? jsonText(result) : result);
		if (!same && b) report.say(`${f.path} changed since install: removed only our parts (pre-install copy kept at ${b.path})`);
		if (!same && b) drop(b);
	}
	if (backupOf(f.path)) dropBackup(f.path);
	m.items = m.items.filter((i) => !((i.kind === 'hook-entry' || i.kind === 'marked-block') && i.path === f.path));
	drop(f);
}
saveManifest(ctx, m);

// --- the onboarding plugin -----------------------------------------------------------

for (const p of of('plugin')) {
	const ids = paseoPluginIds(ctx);
	if (ids === null) fail('`paseo plugin ls --json` failed — is the Paseo daemon running?');
	if (ids.includes(p.id)) {
		const r = run(ctx, 'paseo', ['plugin', 'remove', p.id]);
		if (r.status !== 0) fail(`paseo plugin remove ${p.id} failed (exit ${r.status})`);
	}
	drop(p);
}
saveManifest(ctx, m);

// --- beads databases --------------------------------------------------------------------

for (const d of dbs) {
	if (flags.purge) {
		rmSync(d.path, { recursive: true, force: true });
		report.say(`purged ${d.path}`);
	} else if (existsSync(d.path)) kept.push(`${d.path} (created by the setup's bd init; uninstall --purge removes it)`);
	drop(d);
}

// --- the manifest and the directories the install created ---------------------------------

const leftover = m.items.filter((i) => i.kind !== 'dir' && i.kind !== 'backup');
if (leftover.length) fail(`unexpected manifest items left: ${leftover.map((i) => i.kind).join(', ')}`);
const dirs = m.items.filter((i) => i.kind === 'dir').map((i) => i.path);
const backups = m.items.filter((i) => i.kind === 'backup');
for (const b of backups) kept.push(`${b.path} (backup of ${b.of})`);
rmSync(ctx.manifestPath, { force: true });
removeEmptyDir(ctx.backupsDir);
for (const d of dirs.sort((a, b) => b.length - a.length)) removeEmptyDir(d);

for (const k of kept) report.say(`kept ${k}`);
report.say('done');
