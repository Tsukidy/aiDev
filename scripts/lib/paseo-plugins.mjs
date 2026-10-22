// The Paseo plugins step of install and uninstall (#33, #39): every plugin of
// the repo (repoPlugins), each registered from its own copy. Shaped like a
// runtime target (targets.mjs), but runtime-neutral and outside that registry:
//
//   preconditions(m, report)  install's read-only checks: each plugin's id and
//                             file list, the daemon's plugin list, a
//                             registration from a copy that has since moved
//   paths()                   every path it writes (after preconditions)
//   plan(m)                   → one { step, ... } per plugin (step: see pluginStep)
//   describe(plans)           its lines, printed by --dry-run
//   install(m, plans, report, checkpoint)  per plugin, in order: place the
//                             copy, record the plugin, make the step's daemon
//                             call; a failed call stops the step
//   reversePreconditions(m, report, dryRun)  uninstall's checks: paseo and the
//                             daemon's plugin list, when a plugin is recorded
//   reversePlan(m)            uninstall's --dry-run lines
//   reverse(m, fail)          for each recorded plugin, remove the registration
//                             Paseo lists under its id from its recorded copy,
//                             if there is one, then the record
//
// The daemon builds a directory plugin from its source where it lies, on every
// load, and keeps one whose build failed registered (Paseo's plugins/compiler.js
// and plugins/index.js). The copy is therefore the files the plugin's
// package.json lists, nothing installed beside them, and the plugin is recorded
// before the daemon is asked.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { REPO, findOnPath, ownedFileAction, placeOwnedFile, run, sha256 } from './aidev-install.mjs';
import { add, drop, first, items, pluginItem, replace } from './manifest.mjs';

const EXTENSIONS_SRC = join(REPO, 'personal-extensions');

// The repo's Paseo plugins, as skills/ is its skills: every directory of
// personal-extensions/ that holds a paseo-plugin.json, in sorted order.
export const repoPlugins = () =>
	readdirSync(EXTENSIONS_SRC)
		.sort()
		.map((d) => join(EXTENSIONS_SRC, d))
		.filter((d) => existsSync(join(d, 'paseo-plugin.json')));

// The daemon's plugin registrations as { id, path, status }, or null when the
// daemon does not answer (`paseo plugin ls --json`). `path` is the directory
// as registered (path.resolve'd, not real-pathed). `status` is one of
// running | failed | disabled (Paseo's resolvePluginStatus): disabled means
// the plugin, or all plugins, are switched off, and Paseo then refuses to
// reload it; failed means its build or start failed, and it stays registered.
export function daemonPlugins(ctx) {
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

export function pluginsStep(ctx) {
	let plugins = [];
	let registered = null;

	return {
		preconditions(m, report) {
			plugins = repoPlugins().map((dir) => {
				const source = (name) => join(dir, name);
				const id = JSON.parse(readFileSync(source('paseo-plugin.json'), 'utf8')).id;
				const copy = join(ctx.dataDir, 'paseo-plugins', id);
				const listed = JSON.parse(readFileSync(source('package.json'), 'utf8')).files;
				const bad = invalidFileEntries(listed, dir);
				if (bad.length) report.error(`${source('package.json')} "files" must list plain names of files in ${dir}: ${bad.join(', ')}`);
				const files = bad.length ? [] : listed.map((name) => ({ path: join(copy, name), content: readFileSync(source(name)) }));
				return { id, dir, copy, files };
			});
			// Two directories of one id would share one copy and one registration.
			for (const [id, same] of Map.groupBy(plugins, (p) => p.id)) {
				if (same.length > 1) report.error(`plugin id ${id} is declared by more than one paseo-plugin.json: ${same.map((p) => p.dir).join(', ')}`);
			}
			if (findOnPath('paseo', ctx.env)) {
				registered = daemonPlugins(ctx);
				if (!registered) report.error('`paseo plugin ls --json` failed — is the Paseo daemon running?');
			}
			// A plugin of ours registered from a copy an earlier install recorded
			// elsewhere: the data directory moved, and a new copy would orphan it.
			for (const { id, copy } of plugins) {
				const moved = m && registered && first(m, 'plugin', (i) => i.id === id && i.path !== copy && registrationOf(registered, i)?.ours);
				if (moved) report.error(`plugin ${id} is registered from ${moved.path}, which an earlier install recorded, but the data directory is now ${ctx.dataDir} — run uninstall first, then install`);
			}
		},

		paths: () => plugins.flatMap((p) => p.files.map((f) => f.path)),

		// The copy's files as placing them will leave them (an edited file of
		// ours is kept), and their hash: what the daemon builds when it next
		// loads the plugin. The build is stale until a successful install or
		// reload records that hash.
		plan: (m) =>
			plugins.map((plugin) => {
				const { id, copy, files } = plugin;
				const planned = files.map((f) => ownedFileAction(m, f));
				const buildSha256 = sha256(files.map((f, i) => `${basename(f.path)} ${sha256(planned[i].bytes)}\n`).join(''));
				const record = first(m, 'plugin', (i) => i.id === id && i.path === copy);
				const registration = registrationOf(registered, { id, path: copy });
				return { plugin, step: pluginStep({ id, copy, registration, stale: record?.buildSha256 !== buildSha256 }), planned, record, buildSha256 };
			}),

		describe: (plans) => plans.map((p) => describeStep(p.step)),

		install(m, plans, report, checkpoint) {
			for (const { plugin, step, planned, record, buildSha256 } of plans) {
				const { id, copy, files } = plugin;
				report.say(describeStep(step));
				if (step.kind === 'foreign') continue;
				// Recorded, and checkpointed, before the daemon is asked: a failed
				// build leaves the plugin registered, and the call can be interrupted.
				const item = record ?? add(m, pluginItem(id, copy));
				files.forEach((f, i) => placeOwnedFile(ctx, m, report, checkpoint, f, planned[i]));
				checkpoint();
				const call = CALLS[step.kind]?.(step);
				if (!call) continue;
				const r = run(ctx, 'paseo', ['plugin', ...call]);
				if (r.status !== 0) return report.error(`paseo plugin ${call.join(' ')} failed (exit ${r.status}) — \`paseo plugin ls\` shows why; re-run to retry`);
				replace(m, item, pluginItem(id, copy, buildSha256));
			}
		},

		reversePreconditions(m, report, dryRun) {
			if (!items(m, 'plugin').length) return;
			if (!findOnPath('paseo', ctx.env)) return report.error('paseo not found on PATH — needed to remove the recorded Paseo plugins');
			if (dryRun) return;
			registered = daemonPlugins(ctx);
			if (registered === null) report.error('`paseo plugin ls --json` failed — is the Paseo daemon running?');
		},

		reversePlan: (m) => items(m, 'plugin').map((p) => `paseo plugin remove ${p.id}, if Paseo lists it from ${p.path}`),

		// Only a registration from the recorded copy is ours; the record goes
		// once that registration is gone, or Paseo has none.
		reverse(m, fail) {
			for (const p of items(m, 'plugin')) {
				if (registrationOf(registered, p)?.ours) {
					const r = run(ctx, 'paseo', ['plugin', 'remove', p.id]);
					if (r.status !== 0) fail(`paseo plugin remove ${p.id} failed (exit ${r.status})`);
				}
				drop(m, p);
			}
		},
	};
}
