#!/usr/bin/env node
//
// install.mjs — the one-command, non-interactive, idempotent operator setup
// for the combined fleet (ticket #21; spec #11 D5–D9). Usage:
//
//   node scripts/install.mjs [--dry-run] [--strict]
//
// Steps (the Claude Code target owns 2–7, lib/claude-code-target.mjs):
//   1. preconditions — node ≥ 22.20, npx, bd, paseo on PATH and the Paseo
//      daemon answering; bun reported (a warning, an error under --strict);
//      the first mate's home resolvable; every target inside $HOME; the
//      exclude list must not drop a skill another installed skill's code needs.
//      Any failure exits nonzero before anything is written.
//   2. the curated skills (skills/ minus the operator's exclude list) through
//      the skills CLI, user level, Claude Code target
//   3–4. the four carried agents and the ten effort agents → <claude>/agents/
//   5. the SessionStart routing hook → one entry in <claude>/settings.json
//   6. <claude>/pstack-models.md, setup-pstack's default, only if absent
//   7. a marked block in <claude>/CLAUDE.md including the sheet
//   8. the standing-orders and beads captain-orders installers (their own
//      idempotency), and the beads onboarding plugin via `paseo plugin install`
//   9. the install manifest under $XDG_STATE_HOME/aidev, with a backup of
//      every pre-existing file modified; NOTICE and licenses beside the install
//
// Re-running converges: after a partial failure, after a skills update, and
// after the exclude list changes (skills no longer wanted are removed).

import {
	BEADS_CREATED_NAMES,
	ONBOARDING_PLUGIN_DIR,
	REPO,
	SCHEMA_VERSION,
	SKILLS_SRC,
	backupOnce,
	existsSync,
	fileRecord,
	findOnPath,
	insideHome,
	isDir,
	join,
	lexists,
	loadManifest,
	makeReport,
	missingDirs,
	mkdirSync,
	noteSharedFile,
	nodeVersionOk,
	paseoPluginIds,
	parseFlags,
	placeOwnedFile,
	readExcludeList,
	readFileSync,
	readText,
	readdirSync,
	repoCommit,
	repoSkills,
	resolveContext,
	resolveMateHome,
	run,
	saveManifest,
	skillDependencies,
} from './lib/aidev-install.mjs';
import { claudeCodeTarget } from './lib/claude-code-target.mjs';

const report = makeReport('install');
const flags = parseFlags(process.argv.slice(2), ['--dry-run', '--strict'], 'install');
const ctx = resolveContext(process.env);
const PLUGIN_ID = JSON.parse(readFileSync(join(ONBOARDING_PLUGIN_DIR, 'paseo-plugin.json'), 'utf8')).id;
const pluginDest = join(ctx.dataDir, 'paseo-plugins', PLUGIN_ID);
const PLUGIN_FILES = ['index.server.ts', 'paseo-plugin.json', 'package.json', 'tsconfig.json', 'README.md'];
const ORDERS = [
	{ script: join(REPO, 'scripts', 'install-standing-orders.sh'), block: 'aidev-standing-orders' },
	{ script: join(ONBOARDING_PLUGIN_DIR, 'install-captain-orders.sh'), block: 'paseo-beads-onboarding', beads: true },
];

// --- 1. preconditions -------------------------------------------------------------

if (!nodeVersionOk()) report.error(`node ${process.versions.node} is too old: the skills CLI needs node ≥ 22.20`);
for (const tool of ['npx', 'bd', 'paseo']) {
	if (!findOnPath(tool, ctx.env)) report.error(`${tool} not found on PATH (checked and reported, never installed)`);
}
const bun = findOnPath('bun', ctx.env);
if (bun) report.say(`bun: found at ${bun}`);
else {
	const msg =
		"bun: not found — poteto-mode's PR tooling (scripts watch-pr and ship-pr, which the Shipping and Babysit playbooks run) needs it; install bun yourself";
	if (flags.strict) report.error(`${msg} (--strict)`);
	else report.warn(msg);
}

const mateHome = resolveMateHome(ctx);
if (!mateHome) report.error(`first mate home not found under ${ctx.paseoHome} — launch the first mate once so its home exists (or set PASEO_HOME)`);

const target = claudeCodeTarget(ctx);
const targets = [
	ctx.claudeDir,
	ctx.dataDir,
	ctx.stateDir,
	ctx.paseoHome,
	ctx.skillsLockPath,
	ctx.canonicalSkillsDir,
	...target.paths(),
	...(mateHome ? [mateHome, join(mateHome, 'data', 'captain.md')] : []),
];
for (const p of targets) {
	if (!insideHome(ctx, p)) report.error(`refusing to write outside HOME (${ctx.home}): ${p}`);
}
target.preconditions(report);

let pluginIds = null;
if (findOnPath('paseo', ctx.env)) {
	pluginIds = paseoPluginIds(ctx);
	if (!pluginIds) report.error('`paseo plugin ls --json` failed — is the Paseo daemon running?');
}

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

let m;
try {
	m = loadManifest(ctx);
} catch (e) {
	report.error(e.message);
}
if (report.errors.length) report.die(`${report.errors.length} precondition(s) failed — nothing was written`);

m ??= { schemaVersion: SCHEMA_VERSION, installedAt: new Date().toISOString(), repoCommit: '', items: [] };
const commit = repoCommit();
if (m.repoCommit !== commit) m.repoCommit = commit;

// --- plan ---------------------------------------------------------------------------

const skillPlan = target.planSkills(m, desired);
for (const n of skillPlan.collisions) {
	report.warn(`skill ${n} is already installed from elsewhere (Claude Code skills dir, skills-CLI lock or ~/.agents/skills) — skipped; remove it there and re-run to install this repo's copy`);
}
const licenseFiles = readdirSync(SKILLS_SRC)
	.filter((f) => /^(LICENSE.*|NOTICE.*\.md|pstack-provenance\.json)$/.test(f))
	.map((f) => ({ src: join(SKILLS_SRC, f), dest: join(ctx.licensesDir, f) }));
licenseFiles.push({ src: join(REPO, 'LICENSE'), dest: join(ctx.licensesDir, 'LICENSE-repository') });
const pluginOurs = m.items.some((i) => i.kind === 'plugin' && i.id === PLUGIN_ID);
const pluginForeign = pluginIds?.includes(PLUGIN_ID) && !pluginOurs;

if (flags['dry-run']) {
	const plan = [
		...target.describe(skillPlan),
		...licenseFiles.map((f) => `license/notice copy ${f.dest}`),
		...ORDERS.map((o) => `run ${o.script} (marked block ${o.block} in ${join(mateHome, 'data', 'captain.md')})`),
		pluginForeign
			? `plugin ${PLUGIN_ID}: already installed outside this installer — left as is`
			: `plugin ${PLUGIN_ID}: copy to ${pluginDest}, then paseo plugin install ${pluginDest}`,
		`manifest ${ctx.manifestPath}`,
	];
	console.log('install --dry-run: nothing written. The plan:');
	for (const line of plan) console.log(`  - ${line}`);
	process.exit(0);
}

// --- execute ------------------------------------------------------------------------

const captain = join(mateHome, 'data', 'captain.md');
const watched = missingDirs(ctx, [
	...target.paths(),
	join(target.skillsDir, 'x'),
	ctx.skillsLockPath,
	ctx.manifestPath,
	join(ctx.backupsDir, 'x'),
	...licenseFiles.map((f) => f.dest),
	...PLUGIN_FILES.map((f) => join(pluginDest, f)),
	captain,
]);
const finish = (code) => {
	mkdirSync(ctx.stateDir, { recursive: true }); // the manifest lives here
	for (const d of watched) {
		if (isDir(d) && !m.items.some((i) => i.kind === 'dir' && i.path === d)) m.items.push({ kind: 'dir', path: d });
	}
	saveManifest(ctx, m);
	if (code) report.die(`stopped after an error; the manifest records what was done — re-run to converge, or uninstall`);
	report.say(`done; manifest at ${ctx.manifestPath}`);
	if (report.warnings.length) report.say(`${report.warnings.length} warning(s) above`);
	process.exit(0);
};

// Steps 2–7.
target.install(m, skillPlan, report);
if (report.errors.length) finish(1);

// Attribution travels with the install: NOTICE, the provenance manifest and
// every license file of the tree, plus the repository's own license.
for (const f of licenseFiles) placeOwnedFile(ctx, m, report, { path: f.dest, content: readFileSync(f.src) });

// Step 8a: the two orders installers, each appending its own marked block.
// What each appends is recorded, so uninstall removes exactly that.
const captainExisted = fileRecord(m, captain)?.existedBefore ?? existsSync(captain);
for (const o of ORDERS) {
	const pre = readText(captain) ?? '';
	const beadsBefore = o.beads ? BEADS_CREATED_NAMES.filter((n) => lexists(join(mateHome, n))) : [];
	if (captainExisted) backupOnce(ctx, m, captain);
	const r = run(ctx, 'bash', [o.script]);
	if (r.status !== 0) {
		report.error(`${o.script} failed (exit ${r.status})`);
		break;
	}
	const post = readText(captain) ?? '';
	const start = `<!-- ${o.block}:start -->`;
	if (!m.items.some((i) => i.kind === 'marked-block' && i.path === captain && i.id === o.block)) {
		const si = post.indexOf(start);
		const before = post.startsWith(pre) && si >= pre.length ? post.slice(pre.length, si) : '';
		m.items.push({ kind: 'marked-block', path: captain, id: o.block, before });
	}
	if (o.beads) {
		for (const n of BEADS_CREATED_NAMES) {
			const p = join(mateHome, n);
			if (!beadsBefore.includes(n) && lexists(p) && !m.items.some((i) => i.kind === 'beads-db' && i.path === p)) {
				m.items.push({ kind: 'beads-db', path: p });
			}
		}
	}
	if (post !== pre) noteSharedFile(m, captain, captainExisted);
}
if (report.errors.length) finish(1);

// Step 8b: the onboarding plugin, from a copy under the data directory, so the
// daemon never depends on where this checkout lives or which branch it is on.
if (pluginForeign) {
	report.say(`plugin ${PLUGIN_ID} is already installed outside this installer — left as is`);
} else {
	let changed = false;
	for (const f of PLUGIN_FILES) {
		changed = placeOwnedFile(ctx, m, report, { path: join(pluginDest, f), content: readFileSync(join(ONBOARDING_PLUGIN_DIR, f)) }) || changed;
	}
	if (!pluginIds.includes(PLUGIN_ID)) {
		const r = run(ctx, 'paseo', ['plugin', 'install', pluginDest]);
		if (r.status !== 0) {
			report.error(`paseo plugin install ${pluginDest} failed (exit ${r.status})`);
			finish(1);
		}
	} else if (changed) {
		run(ctx, 'paseo', ['plugin', 'reload', PLUGIN_ID]);
	}
	if (!pluginOurs) m.items.push({ kind: 'plugin', id: PLUGIN_ID, path: pluginDest });
}

finish(0);
