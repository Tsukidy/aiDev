// The beads onboarding plugin's skip list (#34): an operator-owned file
// (ctx.skipListFile) of project bases the plugin never runs `bd init` in, one
// absolute or ~/ path per line, matched by real path; a `#` at a line's start
// or after whitespace starts a comment, so a `#` inside a path is part of it.
// The plugin reads it on every workspace.created event; its parsing there
// (index.server.ts, which may import only what the host supplies) is the twin
// of entries() and sameDir() below.
//
// The install adds this checkout's root, so the plugin never onboards the
// skill source itself; the entry is recorded before it is written, and the
// plugin step (onboarding-plugin.mjs) adds it before it registers the plugin.
// Uninstall removes that one line, after the registration is gone. An entry
// the operator already has for this checkout is theirs: nothing is added,
// nothing recorded.

import { rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { REPO, lexists, readText, realResolve, writeShared } from './aidev-install.mjs';
import { add, drop, first, items, replace, skipEntryItem } from './manifest.mjs';

// What a skip list the install creates starts with.
const TITLE = '# Paseo projects the firstmate-beads-onboarding plugin never initializes beads in:\n';
export const HEADER = `${TITLE}# one absolute or ~/ path per line, matched by real path; a # at the start of a line or after whitespace starts a comment.\n`;
// A list the #34 install created starts with that install's header, from
// before a `#` inside a path was part of it; uninstall deletes it as ours too.
const CREATED_HEADERS = [HEADER, `${TITLE}# one absolute or ~/ path per line, matched by real path; # starts a comment.\n`];

export const entries = (text) =>
	text
		.split('\n')
		.map((l) => l.replace(/(^|\s)#.*/, '').trim())
		.filter(Boolean);

// Whether a list entry names dir: both sides by real path, ~ being home.
export function sameDir(entry, dir, home) {
	const p = entry === '~' ? home : entry.startsWith('~/') ? join(home, entry.slice(2)) : entry;
	return isAbsolute(p) && realResolve(p) === realResolve(dir);
}

// What a list needs for root to be on it:
//   add       no entry names root: append ours
//   current   an entry names root, and our record says it is ours
//   operator  an entry names root that we did not add: left alone
export function skipAction({ text, root, home, recorded }) {
	if (!entries(text ?? '').some((e) => sameDir(e, root, home))) return 'add';
	return recorded ? 'current' : 'operator';
}

// The list with our line appended, and what was put in front of it (a newline
// when the list did not end in one), so uninstall can take back exactly that.
export function appendEntry(text, entry) {
	if (text === null) return { text: `${HEADER}${entry}\n`, before: '' };
	const before = text === '' || text.endsWith('\n') ? '' : '\n';
	return { text: `${text}${before}${entry}\n`, before };
}

// The list without our line: exactly what we appended, while it is still the
// end of the list; else the last line that is our entry. null when the list
// holds nothing but what we wrote.
export function removeEntry(text, { entry, before = '', existedBefore }) {
	const tail = `${before}${entry}\n`;
	let out;
	if (text.endsWith(tail)) out = text.slice(0, -tail.length);
	else {
		const lines = text.split('\n');
		const i = lines.findLastIndex((l) => l.trim() === entry);
		if (i < 0) return text;
		lines.splice(i, 1);
		out = lines.join('\n');
	}
	return !existedBefore && (CREATED_HEADERS.includes(out) || out.trim() === '') ? null : out;
}

export function onboardingSkipList(ctx) {
	const path = ctx.skipListFile;
	const root = REPO;
	const ours = (m) => first(m, 'skip-entry', (i) => i.path === path && i.entry === root);
	const describe = ({ action }) => {
		if (action === 'add') return `add ${root} to the beads onboarding skip list ${path}`;
		if (action === 'current') return `${root} is on the beads onboarding skip list ${path} already`;
		return `${path} already lists ${root} (the operator's entry) — left as is`;
	};

	return {
		path,

		preconditions(report) {
			if (lexists(path) && readText(path) === null) report.error(`${path} (the beads onboarding skip list) is not a readable file — fix or remove it and re-run`);
		},

		plan(m) {
			const text = readText(path);
			const record = ours(m);
			return { action: skipAction({ text, root, home: ctx.home, recorded: Boolean(record) }), record, text };
		},

		describe,

		// Recorded and checkpointed before the list is written, so an
		// interrupted run leaves no entry uninstall cannot find. Our entry,
		// deleted since, comes back (as our hook entry does).
		install(m, { action, record, text }, report, checkpoint) {
			report.say(describe({ action }));
			if (action !== 'add') return;
			const next = appendEntry(text, root);
			const item = skipEntryItem(path, root, text !== null && (record?.existedBefore ?? true), next.before);
			if (record) replace(m, record, item);
			else add(m, item);
			checkpoint();
			writeShared(path, next.text);
		},

		reversePlan: (m) => items(m, 'skip-entry').map((i) => `remove ${i.entry} from the beads onboarding skip list ${i.path}`),

		reverse(m) {
			for (const i of items(m, 'skip-entry')) {
				const text = readText(i.path);
				if (text !== null) {
					const out = removeEntry(text, i);
					if (out === null) rmSync(i.path, { force: true });
					else if (out !== text) writeShared(i.path, out);
				}
				drop(m, i);
			}
		},
	};
}
