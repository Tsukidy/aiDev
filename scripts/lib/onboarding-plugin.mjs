// The beads onboarding plugin step of install and uninstall (#33). Shaped like
// a runtime target (targets.mjs), but runtime-neutral and outside that registry:
//
//   preconditions(m, report)  install's read-only checks: the plugin's id and
//                             file list, the daemon's plugin list, a
//                             registration from a copy that has since moved,
//                             the skip list
//   paths()                   every path it writes (after preconditions)
//   plan(m)                   → { step, skip, ... } (step: see pluginStep)
//   describe(plan)            its lines, printed by --dry-run
//   install(m, plan, report, checkpoint)  add this checkout to the skip list;
//                             once it is listed, place the copy, record the
//                             plugin, make the step's daemon call
//   reversePreconditions(m, report, dryRun)  uninstall's checks: paseo and the
//                             daemon's plugin list, when a plugin is recorded
//   reversePlan(m)            uninstall's --dry-run lines
//   reverse(m, fail)          for each recorded plugin, remove the registration
//                             Paseo lists under its id from its recorded copy,
//                             if there is one, then the record; then our
//                             skip-list entry
//
// The daemon builds a directory plugin from its source where it lies, on every
// load, and keeps one whose build failed registered (Paseo's plugins/compiler.js
// and plugins/index.js). The copy is therefore the files the plugin's
// package.json lists, nothing installed beside them, and the plugin is recorded
// before the daemon is asked. This checkout is on the plugin's skip list
// (onboarding-skip-list.mjs) before the plugin is registered, and until it is
// removed, so the plugin never onboards the skill source itself (#34).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ONBOARDING_PLUGIN_DIR, findOnPath, ownedFileAction, placeOwnedFile, run, sha256 } from './aidev-install.mjs';
import { add, drop, first, items, pluginItem, replace } from './manifest.mjs';
import { onboardingSkipList } from './onboarding-skip-list.mjs';

// The daemon's plugin registrations as { id, path, status }, or null when the
// daemon does not answer (`paseo plugin ls --json`). `path` is the directory
// as registered (path.resolve'd, not real-pathed). `status` is one of
// running | failed | disabled (Paseo's resolvePluginStatus): disabled means
// the plugin, or all plugins, are switched off, and Paseo then refuses to
// reload it; failed means its build or start failed, and it stays registered.
export function paseoPlugins(ctx) {
	const r = run(ctx, 'paseo', ['plugin', 'ls', '--json'], { capture: true });
	if (r.status !== 0) return null;
	try {
		const list = JSON.parse(r.stdout);
		return Array.isArray(list) ? list.map(({ id, path, status }) => ({ id, path, status })) : null;
	} catch {
		return null;
	}
}

// A plugin's registration, if Paseo has one under its id, with `ours` when it
// is from the given copy. Ownership is by path because the id can be
// registered from elsewhere: by hand, or from another directory.
export function registrationOf(plugins, { id, path }) {
	const r = plugins.find((p) => p.id === id);
	return r ? { ...r, ours: r.path === path } : null;
}

// The one daemon call our plugin needs, as a tagged step:
//   install  Paseo does not have it: register the copy
//   foreign  registered from another path (path): left alone
//   reload   ours, and failed, or running a build older than the copy
//   none     ours, and current, or disabled (Paseo refuses to reload a
//            disabled plugin, and builds the copy when it is enabled)
export function pluginStep({ id, copy, registration, stale }) {
	if (!registration) return { kind: 'install', id, path: copy };
	if (!registration.ours) return { kind: 'foreign', id, path: registration.path };
	if (registration.status === 'failed' || (registration.status === 'running' && stale)) return { kind: 'reload', id, path: copy };
	return { kind: 'none', id, path: copy, status: registration.status };
}

const CALLS = { install: (step) => ['install', step.path], reload: (step) => ['reload', step.id] };

export function describeStep(step) {
	if (step.kind === 'foreign') return `plugin ${step.id} is registered from ${step.path}, not this installer's copy — left as is`;
	const call = CALLS[step.kind];
	return `plugin ${step.id}: copy to ${step.path}, then ${call ? `paseo plugin ${call(step).join(' ')}` : `no daemon call (Paseo reports it ${step.status})`}`;
}

// The "files" entries a copy cannot hold: anything but the plain name of a
// file in dir (a path, a glob, a directory, a missing file).
export function invalidFileEntries(listed, dir) {
	if (!Array.isArray(listed)) return ['(no "files" array)'];
	return listed.filter((name) => {
		if (typeof name !== 'string' || name !== basename(name) || name === '.' || name === '..' || /[*?[\]{}!]/.test(name)) return true;
		const p = join(dir, name);
		return !(existsSync(p) && statSync(p).isFile());
	});
}

export function onboardingPlugin(ctx) {
	let id;
	let copy;
	let files = [];
	let plugins = null;
	const source = (name) => join(ONBOARDING_PLUGIN_DIR, name);
	const skip = onboardingSkipList(ctx);

	return {
		preconditions(m, report) {
			id = JSON.parse(readFileSync(source('paseo-plugin.json'), 'utf8')).id;
			copy = join(ctx.dataDir, 'paseo-plugins', id);
			const listed = JSON.parse(readFileSync(source('package.json'), 'utf8')).files;
			const bad = invalidFileEntries(listed, ONBOARDING_PLUGIN_DIR);
			if (bad.length) report.error(`${source('package.json')} "files" must list plain names of files in ${ONBOARDING_PLUGIN_DIR}: ${bad.join(', ')}`);
			else files = listed.map((name) => ({ path: join(copy, name), content: readFileSync(source(name)) }));
			if (findOnPath('paseo', ctx.env)) {
				plugins = paseoPlugins(ctx);
				if (!plugins) report.error('`paseo plugin ls --json` failed — is the Paseo daemon running?');
			}
			// Our plugin registered from a copy an earlier install recorded
			// elsewhere: the data directory moved, and a new copy would orphan it.
			const moved = m && plugins && first(m, 'plugin', (i) => i.id === id && i.path !== copy && registrationOf(plugins, i)?.ours);
			if (moved) report.error(`plugin ${id} is registered from ${moved.path}, which an earlier install recorded, but the data directory is now ${ctx.dataDir} — run uninstall first, then install`);
			skip.preconditions(report);
		},

		paths: () => [skip.path, ...files.map((f) => f.path)],

		// The copy's files as placing them will leave them (an edited file of
		// ours is kept), and their hash: what the daemon builds when it next
		// loads the plugin. The build is stale until a successful install or
		// reload records that hash.
		plan(m) {
			const planned = files.map((f) => ownedFileAction(m, f));
			const buildSha256 = sha256(files.map((f, i) => `${basename(f.path)} ${sha256(planned[i].bytes)}\n`).join(''));
			const record = first(m, 'plugin', (i) => i.id === id && i.path === copy);
			const registration = registrationOf(plugins, { id, path: copy });
			return { step: pluginStep({ id, copy, registration, stale: record?.buildSha256 !== buildSha256 }), skip: skip.plan(m), planned, record, buildSha256 };
		},

		describe: (plan) => [skip.describe(plan.skip), describeStep(plan.step)],

		install(m, { step, planned, record, buildSha256 }, report, checkpoint) {
			if (!skip.install(m, report, checkpoint)) return;
			report.say(describeStep(step));
			if (step.kind === 'foreign') return;
			// Recorded, and checkpointed, before the daemon is asked: a failed
			// build leaves the plugin registered, and the call can be interrupted.
			const item = record ?? add(m, pluginItem(id, copy));
			files.forEach((f, i) => placeOwnedFile(ctx, m, report, checkpoint, f, planned[i]));
			checkpoint();
			const call = CALLS[step.kind]?.(step);
			if (!call) return;
			const r = run(ctx, 'paseo', ['plugin', ...call]);
			if (r.status !== 0) return report.error(`paseo plugin ${call.join(' ')} failed (exit ${r.status}) — \`paseo plugin ls\` shows why; re-run to retry`);
			replace(m, item, pluginItem(id, copy, buildSha256));
		},

		reversePreconditions(m, report, dryRun) {
			if (!items(m, 'plugin').length) return;
			if (!findOnPath('paseo', ctx.env)) return report.error('paseo not found on PATH — needed to remove the onboarding plugin');
			if (dryRun) return;
			plugins = paseoPlugins(ctx);
			if (plugins === null) report.error('`paseo plugin ls --json` failed — is the Paseo daemon running?');
		},

		reversePlan: (m) => [...items(m, 'plugin').map((p) => `paseo plugin remove ${p.id}, if Paseo lists it from ${p.path}`), ...skip.reversePlan(m)],

		// Only a registration from the recorded copy is ours; the record goes
		// once that registration is gone, or Paseo has none.
		reverse(m, fail) {
			for (const p of items(m, 'plugin')) {
				if (registrationOf(plugins, p)?.ours) {
					const r = run(ctx, 'paseo', ['plugin', 'remove', p.id]);
					if (r.status !== 0) fail(`paseo plugin remove ${p.id} failed (exit ${r.status})`);
				}
				drop(m, p);
			}
			skip.reverse(m);
		},
	};
}
