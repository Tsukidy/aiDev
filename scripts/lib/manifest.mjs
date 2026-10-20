// The install manifest: the one contract between install.mjs and
// uninstall.mjs (ticket #21). Every item has a `kind` and a `path`; this
// module owns the item shapes and the queries, so neither side builds or
// searches items by hand.
//
//   skill         a skill the skills CLI installed for one runtime target (name, agent)
//   agent         an agent definition file whose whole content is ours (name, sha256)
//   file          a file whose whole content is ours (sha256), or, with
//                 `shared: true`, a file we only add parts to
//   hook-entry    our entry in a shared settings file (target, event, marker)
//   marked-block  our marked block in a shared text file (id, before: the text
//                 the install put in front of the block)
//   plugin        a Paseo plugin we installed (id)
//   backup        the pre-install copy of a file we modified (of)
//   dir           a directory the install created
//   beads-db      what `bd init` created while installing
//   skills-lock   the skills CLI's lock (existedBefore)
//
// `existedBefore` on a file says whether it was there before the install.

import { existsSync, readFileSync } from 'node:fs';

export const SCHEMA_VERSION = 1;
export const KINDS = ['skill', 'agent', 'file', 'hook-entry', 'marked-block', 'plugin', 'backup', 'dir', 'beads-db', 'skills-lock'];

export function newManifest(repoCommit) {
	return { schemaVersion: SCHEMA_VERSION, installedAt: new Date().toISOString(), repoCommit, items: [] };
}

export function readManifest(path) {
	if (!existsSync(path)) return null;
	const m = JSON.parse(readFileSync(path, 'utf8'));
	if (m.schemaVersion !== SCHEMA_VERSION || !Array.isArray(m.items)) {
		throw new Error(`unsupported manifest at ${path} (schemaVersion ${m.schemaVersion})`);
	}
	return m;
}

export const serialize = (m) => JSON.stringify(m, null, 2) + '\n';

// --- queries ----------------------------------------------------------------------

export const items = (m, kind, pred = () => true) => m.items.filter((i) => i.kind === kind && pred(i));
export const first = (m, kind, pred) => items(m, kind, pred)[0];
export const ownedFile = (m, path) => m.items.find((i) => (i.kind === 'agent' || (i.kind === 'file' && !i.shared)) && i.path === path);
export const sharedFile = (m, path) => first(m, 'file', (i) => i.shared && i.path === path);
export const backupOf = (m, path) => first(m, 'backup', (i) => i.of === path);
// Our parts (hook entries, marked blocks) in one shared file.
export const partsIn = (m, path) => m.items.filter((i) => (i.kind === 'hook-entry' || i.kind === 'marked-block') && i.path === path);

// --- changes ------------------------------------------------------------------------

export const add = (m, item) => {
	m.items.push(item);
	return item;
};
export const drop = (m, item) => {
	m.items = m.items.filter((i) => i !== item);
};
// Add an item unless one of the same kind already matches `pred`.
export const ensure = (m, item, pred) => first(m, item.kind, pred) ?? add(m, item);

// --- item constructors ----------------------------------------------------------------

export const skillItem = (name, agent, path) => ({ kind: 'skill', name, agent, path });
export const ownedFileItem = ({ kind = 'file', name, path, sha256, existedBefore }) => ({
	kind,
	...(name ? { name } : {}),
	path,
	sha256,
	existedBefore,
});
export const sharedFileItem = (path, existedBefore) => ({ kind: 'file', path, shared: true, existedBefore });
export const hookEntryItem = (target, path, event, marker) => ({ kind: 'hook-entry', target, path, event, marker });
export const markedBlockItem = (path, id, before) => ({ kind: 'marked-block', path, id, before });
export const pluginItem = (id, path) => ({ kind: 'plugin', id, path });
export const backupItem = (of, path, sha256) => ({ kind: 'backup', of, path, sha256 });
export const dirItem = (path) => ({ kind: 'dir', path });
export const beadsDbItem = (path) => ({ kind: 'beads-db', path });
export const skillsLockItem = (path, existedBefore) => ({ kind: 'skills-lock', path, existedBefore });
