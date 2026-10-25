// The crew provider step of install and uninstall (#40, spec #11 D16): one
// provider entry in Paseo's config.json, built on Paseo's claude provider,
// which every crewmate runs on once the captain selects it as the crew
// provider in FirstMate settings. The installer never selects it: providers
// are the operator's, and so is any key of the entry the repo does not set.
// On it the daemon gives an agent none of Paseo's tools, so a crewmate has no
// create_agent (nor a schedule, which starts agents too), and Claude Code
// refuses its Workflow tool. Shaped like the skip-list step
// (onboarding-skip-list.mjs): runtime-neutral, outside the target registry,
// one path:
//
//   preconditions(report)  install's read-only check: config.json, if there
//                          is one, is a JSON object, and so are its agents,
//                          agents.providers and our entry
//   path                   the one path it writes
//   plan(m)                → { action, pendingReload } (action: see providerAction)
//   describe(plan)         its line, printed by --dry-run
//   install(m, report, checkpoint)  read the file afresh; when the entry is
//                          absent or not the repo's: record it as a part of
//                          the shared file, with pendingReload and the keys
//                          the repo sets, and write it; then, while the record
//                          says pendingReload, reload
//   recorded(m)            whether the manifest records our entry
//   reversePlan(m)         uninstall's --dry-run line
//   reload(report)         uninstall's reload, once it has stripped the entry
//                          (stripProviderEntry, through its shared-file pass);
//                          a failed reload only warns
//
// The daemon picks the entry up with `paseo reload` (Paseo 0.13,
// daemon-config-store.js: agents.providers is reloadable). A new or changed
// provider gets a client of its own; no running agent is restarted or closed.
// The reload applies the whole file, so an operator's edit not yet reloaded
// is applied with it.

import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { jsonLike, placeSharedFile, readText, run } from './aidev-install.mjs';
import { add, first, items, providerEntryItem } from './manifest.mjs';

export const CREW_PROVIDER_ID = 'claude-crew';
export const CREW_PROVIDER = {
	extends: 'claude',
	label: 'Claude Code (crew)',
	description: 'FirstMate crewmates: Claude Code without Paseo tools or Workflow runs (installed by aiDev)',
	paseoTools: { enabled: false },
	disallowedTools: ['Workflow'],
};
const REPO_KEYS = Object.keys(CREW_PROVIDER);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// What config.json needs for the crew provider. Only the keys the repo sets
// are ours; any other key of the entry (say `enabled`, which Paseo's settings
// toggle) is the operator's. `keys` are the keys we set at our last write.
//   add       absent: add ours
//   update    ours, but a key the repo sets differs (a repo update, or an
//             edit), or a key we set the repo no longer does: the repo's again
//   current   ours, with every key as the repo has it
//   operator  present, and not added by this install: left alone
export function providerAction({ current, recorded, keys = [] }) {
	if (current === undefined) return 'add';
	if (!recorded) return 'operator';
	const same = REPO_KEYS.every((k) => isDeepStrictEqual(current[k], CREW_PROVIDER[k]));
	const stale = keys.some((k) => !REPO_KEYS.includes(k) && k in current);
	return same && !stale ? 'current' : 'update';
}

// A parsed config.json without our provider; then without providers and
// agents, if that leaves them empty.
export function stripProviderEntry(config, { id }) {
	const providers = config.agents?.providers;
	if (!isObject(providers) || !(id in providers)) return config;
	delete providers[id];
	if (Object.keys(providers).length === 0) delete config.agents.providers;
	if (Object.keys(config.agents).length === 0) delete config.agents;
	return config;
}

// config.json's text parsed, { config }, or why the step cannot add to it,
// { error }. No file is an empty config.
function parse(path, text) {
	let config;
	try {
		config = text === null ? {} : JSON.parse(text);
	} catch (e) {
		return { error: `${path} does not parse (${e.message}) — fix it and re-run` };
	}
	const paths = [
		['the file', config],
		['agents', config?.agents],
		['agents.providers', config?.agents?.providers],
		[`agents.providers.${CREW_PROVIDER_ID}`, config?.agents?.providers?.[CREW_PROVIDER_ID]],
	];
	for (const [key, v] of paths) {
		if (v !== undefined && !isObject(v)) return { error: `${path}: ${key} is not a JSON object — fix it and re-run` };
	}
	return { config };
}

export function crewProvider(ctx) {
	const path = join(ctx.paseoHome, 'config.json');
	const ours = (m) => first(m, 'provider-entry', (i) => i.path === path && i.id === CREW_PROVIDER_ID);
	const read = (m) => {
		const text = readText(path);
		const { config, error } = parse(path, text);
		if (error) return { error };
		const record = ours(m);
		const current = config.agents?.providers?.[CREW_PROVIDER_ID];
		const action = providerAction({ current, recorded: Boolean(record), keys: record?.keys });
		return { text, config, record, current, action, pendingReload: Boolean(record?.pendingReload) };
	};
	const describe = ({ action, pendingReload }) => {
		const id = CREW_PROVIDER_ID;
		if (action === 'add') return `add the crew provider ${id} to ${path}, then paseo reload`;
		if (action === 'update') return `put the crew provider ${id} in ${path} back as the repo has it, then paseo reload`;
		if (action === 'current') return `the crew provider ${id} is in ${path} already${pendingReload ? ', then paseo reload (an earlier run did not)' : ''}`;
		return `${path} already has a provider ${id}, not added by this install — left as is, so crewmates selecting it may not get the crew limits`;
	};

	return {
		path,

		preconditions(report) {
			const { error } = parse(path, readText(path));
			if (error) report.error(error);
		},

		plan(m) {
			const { action, pendingReload } = read(m);
			return { action, pendingReload };
		},

		describe,

		// Read afresh, so an edit since the plan counts. The entry is recorded,
		// as owing a reload, before the file is written.
		install(m, report, checkpoint) {
			const { error, text, config, record, current, action, pendingReload } = read(m);
			if (error) return report.error(error);
			if (action === 'operator') return report.warn(describe({ action }));
			report.say(describe({ action, pendingReload }));
			let item = record;
			if (action !== 'current') {
				const kept = { ...current };
				for (const k of record?.keys ?? []) delete kept[k];
				config.agents ??= {};
				config.agents.providers ??= {};
				config.agents.providers[CREW_PROVIDER_ID] = { ...kept, ...structuredClone(CREW_PROVIDER) };
				item ??= add(m, providerEntryItem(path, CREW_PROVIDER_ID));
				item.keys = REPO_KEYS;
				item.pendingReload = true;
				placeSharedFile(ctx, m, checkpoint, path, jsonLike(config, text), 'json');
			}
			if (!item.pendingReload) return;
			const r = run(ctx, 'paseo', ['reload']);
			if (r.status !== 0) return report.error(`paseo reload failed (exit ${r.status}) — the crew provider is in ${path}, but the daemon has not loaded it; re-run to retry`);
			delete item.pendingReload;
		},

		recorded: (m) => items(m, 'provider-entry').length > 0,

		reversePlan: (m) => (items(m, 'provider-entry').length ? [`paseo reload, so the daemon drops the crew provider ${CREW_PROVIDER_ID}`] : []),

		reload(report) {
			const r = run(ctx, 'paseo', ['reload']);
			if (r.status !== 0) report.warn(`paseo reload failed (exit ${r.status}) — ${path} no longer has the crew provider ${CREW_PROVIDER_ID}, but the daemon keeps it until it reloads (\`paseo reload\`) or restarts`);
		},
	};
}
