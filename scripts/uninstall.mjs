#!/usr/bin/env node
//
// uninstall.mjs — reverses exactly what install.mjs recorded in its manifest
// (ticket #21; spec #11 D8). Usage:
//
//   node scripts/uninstall.mjs [--dry-run] [--purge [--yes]]
//
// No manifest → refuses, nothing touched. Otherwise, in order: the crew
// provider in Paseo's config.json, followed by `paseo reload`, then each Paseo
// plugin's registration from its recorded copy (while the copy still exists),
// then our entry in the beads onboarding skip list,
// the skills (through the skills CLI, per runtime target), every file whose
// whole content is ours (each only while it still holds what was installed;
// an edited one, like a tuned model sheet, is kept and reported; a replaced
// operator file comes back), our parts of shared files (the hook entry in
// settings.json, the marked blocks in CLAUDE.md and captain.md; when the
// result equals the pre-install backup, the backup's exact bytes come back),
// and the directories the install created, if empty. Beads databases the
// setup created are kept unless --purge, which asks on a terminal (or takes
// --yes) before anything is touched.

import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
	SKILLS_CLI,
	findOnPath,
	insideHome,
	loadManifest,
	makeReport,
	parseFlags,
	readSkillsLock,
	removeEmptyDir,
	resolveContext,
	saveManifest,
	skillsCli,
	reverseOwnedFile,
	reverseSharedFile,
} from './lib/aidev-install.mjs';
import { crewProvider, stripProviderEntry } from './lib/crew-provider.mjs';
import { backupOf, drop, items, ownedFiles, sharedPaths } from './lib/manifest.mjs';
import { onboardingSkipList } from './lib/onboarding-skip-list.mjs';
import { pluginsStep } from './lib/paseo-plugins.mjs';
import { targetByName } from './lib/targets.mjs';

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

const kept = [];
const keep = (note) => note && kept.push(note);
const owned = ownedFiles(m);
const crewPaths = items(m, 'provider-entry').map((i) => i.path);
const shared = sharedPaths(m).filter((p) => !crewPaths.includes(p));
const dbs = items(m, 'beads-db');
const plugins = pluginsStep(ctx);
const skipList = onboardingSkipList(ctx);
const crew = crewProvider(ctx);

// --- preconditions ---------------------------------------------------------------

for (const i of m.items) {
	for (const p of [i.path, i.of].filter(Boolean)) {
		if (!insideHome(ctx, p)) report.error(`manifest names a path outside HOME (${ctx.home}): ${p}`);
	}
}
if (items(m, 'skill').length && !findOnPath('npx', ctx.env)) report.error('npx not found on PATH — needed to remove the skills through the skills CLI');
plugins.reversePreconditions(m, report, flags['dry-run']);
if (report.errors.length) report.die('nothing touched');

if (flags.purge && dbs.length && !flags.yes && !flags['dry-run']) {
	if (!process.stdin.isTTY) report.die('--purge needs confirmation: run it on a terminal, or add --yes — nothing touched');
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await rl.question(`--purge deletes these beads databases, which the setup created:\n${dbs.map((d) => `  ${d.path}\n`).join('')}Type "purge" to delete them: `);
	rl.close();
	if (answer.trim() !== 'purge') report.die('not confirmed — nothing touched');
}

if (flags['dry-run']) {
	const skillsByAgent = Map.groupBy(items(m, 'skill'), (s) => s.agent);
	const plan = [
		...crew.reversePlan(m),
		...plugins.reversePlan(m),
		...skipList.reversePlan(m),
		...[...skillsByAgent].map(([agent, s]) => `skills remove (${SKILLS_CLI}, ${agent}, user level): ${s.map((x) => x.name).join(' ')}`),
		...owned.map((f) => `remove ${f.path} if unchanged since install${backupOf(m, f.path) ? ", then restore the operator's original" : ''}`),
		...shared.map((p) => `strip our parts from ${p}`),
		...dbs.map((d) => (flags.purge ? `purge ${d.path}` : `keep ${d.path} (beads database; --purge removes it)`)),
		`remove ${ctx.manifestPath} and the directories the install created, if empty`,
	];
	console.log('uninstall --dry-run: nothing touched. The plan:');
	for (const line of plan) console.log(`  - ${line}`);
	process.exit(0);
}

const fail = (msg) => {
	saveManifest(ctx, m);
	report.die(`${msg}; the manifest keeps what is left — fix and re-run uninstall`);
};

// One of our parts taken back out of a parsed JSON file, by its kind.
const stripPart = (v, part) => (part.kind === 'provider-entry' ? stripProviderEntry(v, part) : targetByName(ctx, part.target).stripHookEntry(v, part));

// --- the crew provider, then the Paseo plugins, before their source copies go,
// then our skip-list entry: the reverse of install's order. Paseo keeps plugin
// registrations in config.json too, so the crew provider is taken back before
// `paseo plugin remove` rewrites the file, while it can still match its backup.

try {
	for (const note of crew.reverse(m, report)) keep(note);
} catch (e) {
	fail(`cannot strip the crew provider: ${e.message}`);
}
saveManifest(ctx, m);
plugins.reverse(m, fail);
skipList.reverse(m);
saveManifest(ctx, m);

// --- skills, per runtime target ------------------------------------------------------------

for (const [agent, skills] of Map.groupBy(items(m, 'skill'), (s) => s.agent)) {
	const r = skillsCli(ctx, ['remove', '-g', '-y', '-a', agent, '-s', ...skills.map((s) => s.name)]);
	const left = skills.filter((s) => existsSync(s.path));
	for (const s of skills) if (!left.includes(s)) drop(m, s);
	if (r.status !== 0 || left.length) fail(`skills CLI remove failed (exit ${r.status}; still present: ${left.map((s) => s.name).join(' ') || 'none'})`);
}
// The CLI keeps its lock after the last skill goes; a lock the install
// created and that now lists no skills is removed.
for (const l of items(m, 'skills-lock')) {
	const lock = readSkillsLock(ctx);
	if (!l.existedBefore && lock && Object.keys(lock.skills ?? {}).length === 0) rmSync(l.path, { force: true });
	drop(m, l);
}
saveManifest(ctx, m);

// --- files whose whole content is ours -------------------------------------------------

for (const f of owned) keep(reverseOwnedFile(m, f));
saveManifest(ctx, m);

// --- files we share: strip our parts; the backup's bytes when that is all it was --------

for (const p of sharedPaths(m)) {
	try {
		keep(reverseSharedFile(m, p, stripPart));
	} catch (e) {
		fail(`cannot strip our parts from ${p}: ${e.message}`);
	}
}
saveManifest(ctx, m);

// --- beads databases ----------------------------------------------------------------------

for (const d of dbs) {
	if (flags.purge) {
		rmSync(d.path, { recursive: true, force: true });
		report.say(`purged ${d.path}`);
	} else if (existsSync(d.path)) kept.push(`${d.path} (created by the setup's bd init; uninstall --purge removes it)`);
	drop(m, d);
}

// --- the manifest and the directories the install created ---------------------------------

const leftover = m.items.filter((i) => i.kind !== 'dir');
if (leftover.length) fail(`unexpected manifest items left: ${leftover.map((i) => `${i.kind} ${i.path}`).join(', ')}`);
rmSync(ctx.manifestPath, { force: true });
removeEmptyDir(ctx.backupsDir);
for (const d of items(m, 'dir').map((i) => i.path).sort((a, b) => b.length - a.length)) removeEmptyDir(d);

for (const k of kept) report.say(`kept ${k}`);
report.say('done');
