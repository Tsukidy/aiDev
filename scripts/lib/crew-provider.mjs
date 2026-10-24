// The crew provider step of install and uninstall (#40, spec #11 D16): one
// provider entry in Paseo's config.json, built on Paseo's claude provider,
// which every crewmate runs on once the captain selects it as the crew
// provider in FirstMate settings. The installer never selects it: providers
// are the operator's. On it the daemon gives an agent none of Paseo's tools,
// so a crewmate has no create_agent (nor a schedule, which starts agents
// too), and Claude Code refuses its Workflow tool. Shaped like the skip-list
// step (onboarding-skip-list.mjs): runtime-neutral, outside the target
// registry, one path:
//
//   preconditions(report)  install's read-only check: config.json, if there
//                          is one, is a JSON object, and so are its agents
//                          and agents.providers
//   path                   the one path it writes
//   plan(m)                → { action, pendingReload } (action: see providerAction)
//   describe(plan)         its line, printed by --dry-run
//   install(m, report, checkpoint)  read the file afresh; when the entry is
//                          absent or not the repo's: record it as a part of
//                          the shared file, with pendingReload, and write it;
//                          then, while the record says pendingReload, reload
//   reversePlan(m)         uninstall's --dry-run lines
//   reverse(m, report)     for each recorded entry, strip it (the backup's
//                          bytes come back when nothing else changed), then
//                          reload; a failed reload only warns
//
// The daemon picks the entry up with `paseo reload` (Paseo 0.13,
// daemon-config-store.js: agents.providers is reloadable). A new or changed
// provider gets a client of its own; no running agent is restarted or closed.
// The reload applies the whole file, so an operator's edit not yet reloaded
// is applied with it.

import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { jsonLike, placeSharedFile, readJsonObject, readText, reverseSharedFile, run } from './aidev-install.mjs';
import { add, first, items, providerEntryItem } from './manifest.mjs';

export const CREW_PROVIDER_ID = 'claude-crew';
export const CREW_PROVIDER = {
	extends: 'claude',
	label: 'Claude Code (crew)',
	description: 'FirstMate crewmates: Claude Code without Paseo tools or Workflow runs (installed by aiDev)',
	paseoTools: { enabled: false },
	disallowedTools: ['Workflow'],
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// What config.json needs for the crew provider:
//   add       absent: add ours
//   update    ours, but not as the repo has it (a repo update, or an edit): the repo's again
//   current   ours, as the repo has it
//   operator  present, and not added by this install: left alone
export function providerAction({ current, recorded }) {
	if (current === undefined) return 'add';
	if (!recorded) return 'operator';
	return isDeepStrictEqual(current, CREW_PROVIDER) ? 'current' : 'update';
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

export function crewProvider(ctx) {
	const path = join(ctx.paseoHome, 'config.json');
	const ours = (m) => first(m, 'provider-entry', (i) => i.path === path && i.id === CREW_PROVIDER_ID);
	const read = (m) => {
		const text = readText(path);
		const config = readJsonObject(path);
		const record = ours(m);
		const action = providerAction({ current: config.agents?.providers?.[CREW_PROVIDER_ID], recorded: Boolean(record) });
		return { text, config, record, action };
	};
	const describe = ({ action, pendingReload }) => {
		const id = CREW_PROVIDER_ID;
		if (action === 'add') return `add the crew provider ${id} to ${path}, then paseo reload`;
		if (action === 'update') return `put the crew provider ${id} in ${path} back as the repo has it, then paseo reload`;
		if (action === 'current') return `the crew provider ${id} is in ${path} already${pendingReload ? ', then paseo reload (an earlier run did not)' : ''}`;
		return `${path} already has a provider ${id}, not added by this install — left as is`;
	};
	const reload = () => run(ctx, 'paseo', ['reload']);

	return {
		path,

		preconditions(report) {
			let config;
			try {
				config = readJsonObject(path);
			} catch (e) {
				return report.error(`${path} does not parse as a JSON object (${e.message}) — fix it and re-run`);
			}
			for (const [key, v] of [
				['agents', config.agents],
				['agents.providers', config.agents?.providers],
			]) {
				if (v !== undefined && !isObject(v)) report.error(`${path}: ${key} is not a JSON object — fix it and re-run`);
			}
		},

		plan(m) {
			const { action, record } = read(m);
			return { action, pendingReload: Boolean(record?.pendingReload) };
		},

		describe,

		// Read afresh, so an edit since the plan counts. The entry is recorded,
		// as owing a reload, before the file is written.
		install(m, report, checkpoint) {
			const { text, config, record, action } = read(m);
			report.say(describe({ action, pendingReload: record?.pendingReload }));
			if (action === 'operator') return;
			let item = record;
			if (action !== 'current') {
				config.agents ??= {};
				config.agents.providers ??= {};
				config.agents.providers[CREW_PROVIDER_ID] = structuredClone(CREW_PROVIDER);
				item ??= add(m, providerEntryItem(path, CREW_PROVIDER_ID));
				item.pendingReload = true;
				placeSharedFile(ctx, m, checkpoint, path, jsonLike(config, text), 'json');
			}
			if (!item.pendingReload) return;
			const r = reload();
			if (r.status !== 0) return report.error(`paseo reload failed (exit ${r.status}) — the crew provider is in ${path}, but the daemon has not loaded it; re-run to retry`);
			delete item.pendingReload;
		},

		reversePlan: (m) => items(m, 'provider-entry').map((i) => `paseo reload, once the crew provider ${i.id} is stripped from ${i.path}`),

		// Returns the "kept" notes of the files it put back.
		reverse(m, report) {
			const kept = [];
			for (const i of items(m, 'provider-entry')) {
				kept.push(reverseSharedFile(m, i.path, () => stripProviderEntry));
				const r = reload();
				if (r.status !== 0) report.warn(`paseo reload failed (exit ${r.status}) — ${i.path} no longer has the crew provider ${i.id}, but the daemon keeps it until it reloads (\`paseo reload\`) or restarts`);
			}
			return kept.filter(Boolean);
		},
	};
}
