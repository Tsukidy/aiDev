// The install manifest: the one contract between install.mjs and
// uninstall.mjs (ticket #21). Every item has a `kind` and a `path`; this
// module owns the item shapes and the queries, so neither side builds or
// searches items by hand.
//
//   skill         a skill the skills CLI installed for one runtime target (name, agent)
//   agent         an agent definition file whose whole content is ours (name, sha256)
//   file          a file whose whole content is ours (sha256), or, with
//                 `shared: true`, a file we only add parts to (format: text | json;
//                 changedByInstall: an orders script changed it, #35)
//   hook-entry    our entry in a shared settings file (target, event, marker)
//   marked-block  our marked block in a shared text file (id, before: the text
//                 the install put in front of the block), or, until the orders
//                 script that appends it has run, the intent to append one
//                 (at: the length and sha256 of the text the file held then;
//                 blockBefore in aidev-install.mjs reads it in place of before)
//   plugin        a Paseo plugin we register (id) from our copy (path): the one
//                 record of it, written before the daemon is asked (see
//                 upgradeUnrecordedPlugin for manifests from before #33);
//                 buildSha256 hashes the copy's build inputs as of the
//                 daemon's last successful install or reload of it
//   skip-entry    our line (entry) in the operator's beads onboarding skip
//                 list (path), written after it is recorded; before: what
//                 the install put in front of it (#34)
//   provider-entry  our provider (id) in Paseo's config.json (path), a part
//                 of that shared file (#40); keys: the entry's keys we set at
//                 our last write; pendingReload: written, or about to be, and
//                 the daemon not yet reloaded since
//   backup        the pre-install copy of a file we modified (of), or, with
//                 `link`, the symlink we replaced
//   dir           a directory the install created
//   beads-db      what `bd init` created while installing
//   skills-lock   the skills CLI's lock (existedBefore)
//
// `existedBefore` on a file says whether it was there before the install.
// Each in-process write is recorded before it is made (#50). An agent or a
// file whose whole content is ours then carries `next`, the sha256 the write
// leaves, beside `sha256`, what we wrote before it (for a new record, what
// the file held: the operator's, or null); recordWrite and settleWrite below
// change the two. A backup is recorded `pending` before its copy is made,
// with the sha256 of the file it copies; settleBackup clears it.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

// 2 since #33: a version-1 manifest is upgraded once on read (below) and
// saved as the current version by whichever run writes it next. 3 since #34,
// which added skip-entry: a version 2 needs no upgrade, and an older
// checkout's uninstall refuses a version 3 instead of leaving our entry. 4
// since #35, which lets a marked-block be an intent (at, no before): a
// version 3 needs no upgrade, and an older checkout's uninstall would strip
// an unsettled block without the text it was appended after, so it refuses a 4.
// 5 since #50, which records a write before it is made (next on a file, and
// pending on a backup): a version 4 needs no upgrade, and an older
// checkout's uninstall would misread a record that has not settled, so it
// refuses a 5.
// 6 since #40, which adds provider-entry: a version 5 needs no upgrade, and an
// older checkout's uninstall would leave our provider in Paseo's config, so
// it refuses a 6.
export const SCHEMA_VERSION = 6;
export const KINDS = ['skill', 'agent', 'file', 'hook-entry', 'marked-block', 'provider-entry', 'plugin', 'skip-entry', 'backup', 'dir', 'beads-db', 'skills-lock'];

export function newManifest(repoCommit) {
	return { schemaVersion: SCHEMA_VERSION, installedAt: new Date().toISOString(), repoCommit, items: [] };
}

export function readManifest(path) {
	if (!existsSync(path)) return null;
	const m = JSON.parse(readFileSync(path, 'utf8'));
	const v = m.schemaVersion;
	if (!Number.isInteger(v) || v < 1 || v > SCHEMA_VERSION || !Array.isArray(m.items)) {
		throw new Error(`unsupported manifest at ${path} (schemaVersion ${m.schemaVersion})`);
	}
	if (m.schemaVersion === 1) upgradeUnrecordedPlugin(m);
	m.schemaVersion = SCHEMA_VERSION;
	return m;
}

// The one upgrade, from version 1. Before #33, an install that failed at
// `paseo plugin install` recorded the plugin's copy (its paseo-plugin.json
// among the files whose whole content is ours) but no plugin item, though
// Paseo kept the plugin registered from the copy. The item is rebuilt from the
// recorded copy directory, whose name is the plugin id: both installers name
// it so, and uninstall still removes only a registration Paseo lists under
// that id from that directory. Nothing is read from the copy itself, which may
// be gone or edited.
function upgradeUnrecordedPlugin(m) {
	if (items(m, 'plugin').length) return;
	const declared = ownedFiles(m).find((i) => basename(i.path) === 'paseo-plugin.json');
	if (declared) add(m, pluginItem(basename(dirname(declared.path)), dirname(declared.path)));
}

export const serialize = (m) => JSON.stringify(m, null, 2) + '\n';

// --- queries ----------------------------------------------------------------------

export const items = (m, kind, pred = () => true) => m.items.filter((i) => i.kind === kind && pred(i));
export const first = (m, kind, pred) => items(m, kind, pred)[0];
export const ownedFile = (m, path) => m.items.find((i) => (i.kind === 'agent' || (i.kind === 'file' && !i.shared)) && i.path === path);
export const sharedFile = (m, path) => first(m, 'file', (i) => i.shared && i.path === path);
export const backupOf = (m, path) => first(m, 'backup', (i) => i.of === path);
// Our parts (hook entries, marked blocks, provider entries) in one shared file.
const isPart = (i) => i.kind === 'hook-entry' || i.kind === 'marked-block' || i.kind === 'provider-entry';
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
// Put a new item where an old one was.
export const replace = (m, old, item) => {
	const i = m.items.indexOf(old);
	if (i < 0) throw new Error(`cannot replace a ${old.kind} item that is not in the manifest (${old.path})`);
	m.items[i] = item;
	return item;
};
// The write about to be made to a file whose whole content is ours (#50)...
export const recordWrite = (item, sha256) => {
	item.next = sha256;
};
// ...and, once it is made or known never to have been, its record settled.
export const settleWrite = (item, made) => {
	if (item.next === undefined) return;
	if (made) item.sha256 = item.next;
	delete item.next;
};

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
export const providerEntryItem = (path, id) => ({ kind: 'provider-entry', path, id });
export const markedBlockItem = (path, id, before) => ({ kind: 'marked-block', path, id, before });
// The intent to append a block to a file holding `text` (#35).
export const markedBlockIntent = (path, id, text) => ({
	kind: 'marked-block',
	path,
	id,
	at: { length: text.length, sha256: createHash('sha256').update(text).digest('hex') },
});
export const pluginItem = (id, path, buildSha256) => ({ kind: 'plugin', id, path, ...(buildSha256 ? { buildSha256 } : {}) });
export const skipEntryItem = (path, entry, existedBefore, before) => ({ kind: 'skip-entry', path, entry, existedBefore, before });
export const backupItem = (of, path, sha256) => ({ kind: 'backup', of, path, sha256 });
export const backupPending = (of, path, sha256) => ({ ...backupItem(of, path, sha256), pending: true });
export const settleBackup = (item) => {
	delete item.pending;
};
export const dirItem = (path) => ({ kind: 'dir', path });
export const beadsDbItem = (path) => ({ kind: 'beads-db', path });
export const skillsLockItem = (path, existedBefore) => ({ kind: 'skills-lock', path, existedBefore });
