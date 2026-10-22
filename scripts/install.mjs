#!/usr/bin/env node
//
// install.mjs — the one-command, non-interactive, idempotent operator setup
// for the combined fleet (ticket #21; spec #11 D5–D9). Usage:
//
//   node scripts/install.mjs [--dry-run] [--strict]
//
// Steps (each runtime target owns 2–7; lib/targets.mjs has the contract):
//   1. preconditions — node ≥ 22.20, npx, bd, paseo on PATH and the Paseo
//      daemon answering; bun, and a run from a linked git worktree,
//      reported (a warning, an error under --strict); the first mate's home
//      resolvable and its captain.md blocks intact; every target inside
//      $HOME; the exclude list must not drop a skill another installed
//      skill's code needs. Any failure exits nonzero before anything is
//      written.
//   2. the curated skills (skills/ minus the operator's exclude list) through
//      the skills CLI, user level, per target
//   3–4. the four carried agents and the ten effort agents of installed skills
//   5. the SessionStart routing hook → one entry in the target's settings
//   6. pstack-models.md, setup-pstack's default, only if absent
//   7. a marked block in the target's CLAUDE.md including the sheet
//   8. the standing-orders and beads captain-orders installers (their own
//      idempotency; lib/orders.mjs), this checkout's root on the beads
//      onboarding skip list, and the beads onboarding plugin, registered with
//      Paseo from a copy (`paseo plugin install`, or `reload` to rebuild
//      ours; lib/onboarding-plugin.mjs)
//   9. the install manifest under $XDG_STATE_HOME/aidev, with a backup of
//      every pre-existing file modified; NOTICE and licenses beside the install
//
// Re-running converges: after a partial failure, after a repo update, and
// after the exclude list changes (what is no longer wanted comes back out).
// What an external call (the skills CLI, an orders script, the daemon) may
// create is recorded, and the manifest saved, before the call (#35), and so
// is each of the installer's own file writes (#50), so a run killed at any of
// them leaves a manifest a re-run and uninstall go by.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	REPO,
	SKILLS_SRC,
	findOnPath,
	insideHome,
	isDir,
	loadManifest,
	makeReport,
	missingDirs,
	nodeVersionOk,
	parseFlags,
	placeOwnedFile,
	readExcludeList,
	repoCommit,
	repoSkills,
	resolveContext,
	saveManifest,
	skillDependencies,
	testKillPoint,
	worktreeCommonDir,
} from './lib/aidev-install.mjs';
import { dirItem, drop, ensure, items, newManifest } from './lib/manifest.mjs';
import { onboardingPlugin } from './lib/onboarding-plugin.mjs';
import { ordersStep } from './lib/orders.mjs';
import { installTargets } from './lib/targets.mjs';

const report = makeReport('install');
const flags = parseFlags(process.argv.slice(2), ['--dry-run', '--strict'], 'install');
const ctx = resolveContext(process.env);
const orders = ordersStep(ctx);
const plugin = onboardingPlugin(ctx);

// --- 1. preconditions -------------------------------------------------------------

if (!nodeVersionOk()) report.error(`node ${process.versions.node} is too old: the skills CLI needs node ≥ 22.20`);
for (const tool of ['npx', 'bd', 'paseo']) {
	if (!findOnPath(tool, ctx.env)) report.error(`${tool} not found on PATH (checked and reported, never installed)`);
}
const warnOrStrictError = (msg) => (flags.strict ? report.error(`${msg} (--strict)`) : report.warn(msg));
const bun = findOnPath('bun', ctx.env);
if (bun) report.say(`bun: found at ${bun}`);
else warnOrStrictError("bun: not found — poteto-mode's PR tooling (scripts watch-pr and ship-pr, which the Shipping and Babysit playbooks run) needs it; install bun yourself");
const common = worktreeCommonDir();
if (common) warnOrStrictError(`${REPO} is a linked git worktree (of ${common}): the beads onboarding skip list would name it, not the main checkout Paseo knows as the project — run the install from the main checkout`);

orders.preconditions(report);

let m;
try {
	m = loadManifest(ctx);
} catch (e) {
	report.error(e.message);
}
plugin.preconditions(m, report);

const targets = installTargets(ctx);
const licenseFiles = readdirSync(SKILLS_SRC)
	.filter((f) => /^(LICENSE.*|NOTICE.*\.md|pstack-provenance\.json)$/.test(f))
	.map((f) => ({ src: join(SKILLS_SRC, f), dest: join(ctx.licensesDir, f) }));
licenseFiles.push({ src: join(REPO, 'LICENSE'), dest: join(ctx.licensesDir, 'LICENSE-repository') });
const written = [
	ctx.paseoHome,
	ctx.skillsLockPath,
	ctx.canonicalSkillsDir,
	ctx.manifestPath,
	join(ctx.backupsDir, 'x'),
	...licenseFiles.map((f) => f.dest),
	...plugin.paths(),
	...targets.flatMap((t) => t.paths()),
	...orders.paths(),
];
for (const p of written) {
	if (!insideHome(ctx, p)) report.error(`refusing to write outside HOME (${ctx.home}): ${p}`);
}
for (const t of targets) t.preconditions(report);

// The exclude list (operator-owned, never written by us) and the dependency
// guard: dropping a skill that installed code imports is refused.
const all = repoSkills();
const excluded = readExcludeList(ctx);
for (const n of excluded) if (!all.includes(n)) report.warn(`exclude list ${ctx.excludeFile} names ${n}, which is not a skill in ${SKILLS_SRC}`);
const desired = all.filter((n) => !excluded.includes(n));
for (const dep of skillDependencies()) {
	if (!desired.includes(dep.from) || desired.includes(dep.to)) continue;
	if (dep.hard) report.error(`excluding ${dep.to} breaks ${dep.from}: ${dep.file} needs it — exclude both or neither`);
	else report.warn(`excluding ${dep.to} leaves a dangling link in ${dep.from} (${dep.file})`);
}

if (report.errors.length) report.die(`${report.errors.length} precondition(s) failed — nothing was written`);

const commit = repoCommit();
m ??= newManifest(commit);
m.repoCommit = commit;

// --- plan ---------------------------------------------------------------------------

const plans = targets.map((t) => {
	const plan = t.planSkills(m, desired);
	for (const n of plan.collisions) {
		report.warn(`skill ${n} is already installed for ${t.label} from elsewhere (its skills directory, the skills-CLI lock or ~/.agents/skills) — skipped; remove it there and re-run to install this repo's copy`);
	}
	return plan;
});
const pluginPlan = plugin.plan(m);

if (flags['dry-run']) {
	const plan = [
		...targets.flatMap((t, i) => t.describe(plans[i])),
		...licenseFiles.map((f) => `license/notice copy ${f.dest}`),
		...orders.describe(),
		...plugin.describe(pluginPlan),
		`manifest ${ctx.manifestPath}`,
	];
	console.log('install --dry-run: nothing written. The plan:');
	for (const line of plan) console.log(`  - ${line}`);
	process.exit(0);
}

// --- execute ------------------------------------------------------------------------

const watched = missingDirs(ctx, [...written, ...targets.map((t) => join(t.paths()[0], 'x'))]);
// Save the manifest, naming every directory the install may create, before
// each external call, so an interrupted run leaves nothing uninstall cannot
// find. finish() drops the directories that were never created.
const checkpoint = () => {
	for (const d of watched) ensure(m, dirItem(d), (i) => i.path === d);
	saveManifest(ctx, m);
};
const finish = (code) => {
	for (const i of items(m, 'dir', (i) => !isDir(i.path))) drop(m, i);
	saveManifest(ctx, m);
	if (code) report.die('stopped after an error; the manifest records what was done — re-run to converge, or uninstall');
	report.say(`done; manifest at ${ctx.manifestPath}`);
	if (report.warnings.length) report.say(`${report.warnings.length} warning(s) above`);
	process.exit(0);
};

// Steps 2–7, per target.
targets.forEach((t, i) => t.install(m, plans[i], report, checkpoint));
if (report.errors.length) finish(1);

// Attribution travels with the install: NOTICE, the provenance manifest and
// every license file of the tree, plus the repository's own license.
for (const f of licenseFiles) placeOwnedFile(ctx, m, report, checkpoint, { path: f.dest, content: readFileSync(f.src) });
testKillPoint(ctx, 'licenses');

// Step 8a: the orders installers.
orders.install(m, report, checkpoint);
if (report.errors.length) finish(1);

// Step 8b: the onboarding plugin.
plugin.install(m, pluginPlan, report, checkpoint);
if (report.errors.length) finish(1);

finish(0);
