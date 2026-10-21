// The install manifest: the one contract between install.mjs and
// uninstall.mjs (ticket #21). Every item has a `kind` and a `path`; this
// module owns the item shapes and the queries, so neither side builds or
// searches items by hand.
//
//   skill         a skill the skills CLI installed for one runtime target (name, agent)
//   agent         an agent definition file whose whole content is ours (name, sha256)
//   file          a file whose whole content is ours (sha256), or, with
//                 `shared: true`, a file we only add parts to (format: text | json)
//   hook-entry    our entry in a shared settings file (target, event, marker)
//   marked-block  our marked block in a shared text file (id, before: the text
//                 the install put in front of the block)
//   plugin        a Paseo plugin we register (id) from our copy (path): the one
//                 record of it, written before the daemon is asked (see
//                 upgradeUnrecordedPlugin for manifests from before #33)
//   backup        the pre-install copy of a file we modified (of), or, with
//                 `link`, the symlink we replaced
//   dir           a directory the install created
//   beads-db      what `bd init` created while installing
//   skills-lock   the skills CLI's lock (existedBefore)
//
// `existedBefore` on a file says whether it was there before the install.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

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
	return upgradeUnrecordedPlugin(m);
}

// The one upgrade. Before #33, an install that failed at `paseo plugin
// install` recorded the plugin's copy (its paseo-plugin.json among the files
// whose whole content is ours) but no plugin item, though Paseo kept the
// plugin registered from the copy. The item is rebuilt from the copy, with the
// id its recorded paseo-plugin.json declares, so the plugin item stays the one
// record install and uninstall act on.
function upgradeUnrecordedPlugin(m) {
	if (items(m, 'plugin').length) return m;
	const declared = ownedFiles(m).find((i) => basename(i.path) === 'paseo-plugin.json');
	let id;
	try {
		id = declared && JSON.parse(readFileSync(declared.path, 'utf8')).id;
	} catch {}
	if (typeof id === 'string') add(m, pluginItem(id, dirname(declared.path)));
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
const isPart = (i) => i.kind === 'hook-entry' || i.kind === 'marked-block';
export const partsIn = (m, path) => m.items.filter((i) => isPart(i) && i.path === path);
// Every file whose whole content is ours, and every file we only add parts to.
export const ownedFiles = (m) => m.items.filter((i) => i.kind === 'agent' || (i.kind === 'file' && !i.shared));
export const sharedPaths = (m) => [...new Set(m.items.filter((i) => isPart(i) || (i.kind === 'file' && i.shared)).map((i) => i.path))];

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
export const sharedFileItem = (path, existedBefore, format = 'text') => ({ kind: 'file', path, shared: true, format, existedBefore });
export const hookEntryItem = (target, path, event, marker) => ({ kind: 'hook-entry', target, path, event, marker });
export const markedBlockItem = (path, id, before) => ({ kind: 'marked-block', path, id, before });
export const pluginItem = (id, path) => ({ kind: 'plugin', id, path });
export const backupItem = (of, path, sha256) => ({ kind: 'backup', of, path, sha256 });
export const dirItem = (path) => ({ kind: 'dir', path });
export const beadsDbItem = (path) => ({ kind: 'beads-db', path });
export const skillsLockItem = (path, existedBefore) => ({ kind: 'skills-lock', path, existedBefore });
