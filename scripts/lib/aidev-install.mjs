// Shared core of install.mjs and uninstall.mjs (ticket #21, spec #11 D6–D9):
// paths under $HOME, file primitives that record what they touch in the
// manifest (lib/manifest.mjs), marked blocks, external commands, and the
// repo's skill tree. Runtime-specific code lives in the targets (lib/targets.mjs).
// Zero npm dependencies.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	rmdirSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	add,
	backupItem,
	backupOf,
	backupPending,
	drop,
	items,
	ownedFile,
	ownedFileItem,
	ownedFiles,
	partsIn,
	readManifest,
	recordWrite,
	serialize,
	settleBackup,
	settleWrite,
	sharedFile,
	sharedFileItem,
} from './manifest.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILLS_SRC = join(REPO, 'skills');
// The skills CLI release whose source the flags were read from
// (vercel-labs/skills a80e4c9 = npm skills@1.7.4). Pinned so a CLI release
// cannot change what install and uninstall do.
export const SKILLS_CLI = 'skills@1.7.4';
const SKILLS_CLI_MIN_NODE = [22, 20];
export const ONBOARDING_PLUGIN_DIR = join(REPO, 'personal-extensions', 'paseo-firstmate-beads-onboarding');
// The repo's Paseo plugins, in install order. A plugin directory is installed
// only once it is listed here.
export const PASEO_PLUGIN_DIRS = [ONBOARDING_PLUGIN_DIR];

// --- output and flags ---------------------------------------------------------------

export function makeReport(tool) {
	const r = {
		errors: [],
		warnings: [],
		say: (msg) => console.log(`${tool}: ${msg}`),
		warn: (msg) => {
			r.warnings.push(msg);
			console.error(`${tool}: warning: ${msg}`);
		},
		error: (msg) => {
			r.errors.push(msg);
			console.error(`${tool}: error: ${msg}`);
		},
		die: (msg) => {
			console.error(`${tool}: ${msg}`);
			process.exit(1);
		},
	};
	return r;
}

export function parseFlags(argv, known, tool) {
	const flags = {};
	for (const a of argv) {
		if (!known.includes(a)) {
			console.error(`${tool}: unknown argument ${a} (known: ${known.join(' ')})`);
			process.exit(2);
		}
		flags[a.replace(/^--/, '')] = true;
	}
	return flags;
}

// A kill point of the installer tests (#50): with AIDEV_TEST_KILL naming the
// point, which nothing but those tests sets, the process SIGKILLs itself there.
function testKillPoint(ctx, point) {
	if (ctx.env.AIDEV_TEST_KILL === point) process.kill(process.pid, 'SIGKILL');
}

// A path under HOME as ~/…, as a kill point names it.
const tilde = (ctx, p) => `~/${relative(ctx.home, p)}`;

// --- paths ----------------------------------------------------------------------------

// An XDG base directory: the variable when it holds an absolute path (the
// spec says relative values are invalid and ignored), else the default.
function xdg(env, name, home, fallback) {
	const v = env[name];
	return v && isAbsolute(v) ? v : join(home, fallback);
}

export function resolveContext(env) {
	const home = env.HOME;
	if (!home || !isAbsolute(home) || !existsSync(home)) {
		console.error('aidev: HOME must name an existing absolute directory');
		process.exit(1);
	}
	const dataDir = join(xdg(env, 'XDG_DATA_HOME', home, '.local/share'), 'aidev');
	const stateDir = join(xdg(env, 'XDG_STATE_HOME', home, '.local/state'), 'aidev');
	const configDir = join(xdg(env, 'XDG_CONFIG_HOME', home, '.config'), 'aidev');
	return {
		env,
		home,
		claudeDir: env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'),
		dataDir,
		stateDir,
		manifestPath: join(stateDir, 'install-manifest.json'),
		backupsDir: join(stateDir, 'backups'),
		excludeFile: join(configDir, 'install-exclude'),
		// The beads onboarding plugin's skip list (#34): operator-owned; the
		// install adds one entry to it. The plugin resolves the same path.
		skipListFile: join(configDir, 'beads-onboarding-skip'),
		licensesDir: join(dataDir, 'licenses'),
		paseoHome: env.PASEO_HOME || join(home, '.paseo'),
		// Where the skills CLI keeps its global lock (skill-lock.ts
		// getSkillLockPath). Deliberately not xdg(): the CLI takes any
		// non-empty XDG_STATE_HOME as is, and this must name the same file.
		// A relative value then fails the inside-HOME precondition.
		skillsLockPath: env.XDG_STATE_HOME
			? join(env.XDG_STATE_HOME, 'skills', '.skill-lock.json')
			: join(home, '.agents', '.skill-lock.json'),
		// ...and its canonical copies (installer.ts getCanonicalSkillsDir).
		canonicalSkillsDir: join(home, '.agents', 'skills'),
	};
}

// Resolve a path that may not exist yet: the real path of its longest
// existing prefix, plus the rest. Symlinks anywhere along the way count.
export function realResolve(p) {
	let head = resolve(p);
	const rest = [];
	while (!existsSync(head)) {
		const parent = dirname(head);
		if (parent === head) break;
		rest.unshift(basename(head));
		head = parent;
	}
	let real;
	try {
		real = realpathSync(head);
	} catch {
		real = head;
	}
	return join(real, ...rest);
}

export function insideHome(ctx, p) {
	if (!isAbsolute(p)) return false;
	const home = realResolve(ctx.home);
	const r = realResolve(p);
	return r === home || r.startsWith(home + sep);
}

export function findOnPath(name, env) {
	for (const dir of (env.PATH ?? '').split(':')) {
		if (!dir) continue;
		const p = join(dir, name);
		try {
			accessSync(p, constants.X_OK);
			if (statSync(p).isFile()) return p;
		} catch {}
	}
	return null;
}

export function nodeVersionOk() {
	const [maj, min] = process.versions.node.split('.').map(Number);
	const [wantMaj, wantMin] = SKILLS_CLI_MIN_NODE;
	return maj > wantMaj || (maj === wantMaj && min >= wantMin);
}

// The first mate's home, resolved the way firstmate 0.3.4 does and the way
// install-standing-orders.sh and install-captain-orders.sh do: the config's
// `home` ("" → default, "~", "~/…", absolute), then the legacy location.
// Returns null when no home directory exists.
export function resolveMateHome(ctx) {
	const config = join(ctx.paseoHome, 'plugin-data', 'firstmate', 'config.json');
	let h = '';
	if (existsSync(config)) {
		try {
			h = String(JSON.parse(readFileSync(config, 'utf8')).home ?? '').trim();
		} catch {}
	}
	if (h === '') h = join(ctx.paseoHome, 'plugin-data', 'firstmate', 'home');
	else if (h === '~') h = ctx.home;
	else if (h.startsWith('~/')) h = join(ctx.home, h.slice(2));
	const legacy = join(ctx.paseoHome, 'plugins', 'firstmate', 'home');
	if (!isDir(h) && isDir(legacy)) h = legacy;
	return isDir(h) ? h : null;
}

export function isDir(p) {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function lexists(p) {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

// --- files ------------------------------------------------------------------------------

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function fileSha(p) {
	try {
		return sha256(readFileSync(p));
	} catch {
		return null;
	}
}

export function readText(p) {
	try {
		return readFileSync(p, 'utf8');
	} catch {
		return null;
	}
}

// Replace a file atomically. An existing file keeps its mode (settings.json
// is 0600) unless a mode is given, and the temporary copy is private until
// that mode is set. With `through`, a symlink is written through, so a
// dotfiles link stays a link; without it, the path itself is replaced.
export function writeAtomic(p, content, { mode, through = false } = {}) {
	let dest = p;
	if (through) {
		try {
			if (lstatSync(p).isSymbolicLink()) dest = realpathSync(p);
		} catch {}
	}
	let keep = mode;
	if (keep === undefined) {
		try {
			keep = statSync(dest).mode & 0o7777;
		} catch {
			keep = 0o666 & ~process.umask();
		}
	}
	mkdirSync(dirname(dest), { recursive: true });
	const tmp = `${dest}.aidev-tmp`;
	writeFileSync(tmp, content, { mode: 0o600 });
	chmodSync(tmp, keep);
	renameSync(tmp, dest);
}

// Write a file we only add parts to: through symlinks, keeping its mode.
export const writeShared = (p, content) => writeAtomic(p, content, { through: true });

// Read the manifest, settling what a killed run left in flight (#50), in
// memory only, so a dry run stays read-only. A recorded write was made when
// the file holds its content and did not before; then it is what we last
// wrote. Otherwise the record keeps what the file held, and goes when that
// was nothing, or when the write was over the operator's file and its backup
// was never copied. A pending backup whose copy exists was copied; one whose
// copy does not was never taken.
export function loadManifest(ctx) {
	const m = readManifest(ctx.manifestPath);
	if (!m) return m;
	for (const rec of ownedFiles(m)) {
		if (rec.next === undefined) continue;
		const made = fileSha(rec.path) === rec.next && rec.sha256 !== rec.next;
		const backup = backupOf(m, rec.path);
		const uncopied = backup?.pending && !existsSync(backup.path);
		if (!made && (rec.sha256 === null || uncopied)) drop(m, rec);
		else settleWrite(rec, made);
	}
	for (const b of items(m, 'backup', (b) => b.pending)) {
		if (existsSync(b.path)) settleBackup(b);
		else drop(m, b);
	}
	return m;
}

// Written only when it changed, so an install that changes nothing leaves the
// manifest byte-identical.
export function saveManifest(ctx, m) {
	const text = serialize(m);
	if (readText(ctx.manifestPath) !== text) writeAtomic(ctx.manifestPath, text);
}

export function repoCommit() {
	const r = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
	return r.status === 0 ? r.stdout.trim() : 'unknown';
}

// The git directory shared by every checkout of the repository when this
// checkout is a linked worktree of it; null for a main checkout, or no git.
// git may print either path relative to REPO, and one real-pathed while the
// other is not, so both are compared by real path. --path-format=absolute
// would need git 2.31, and an older rev-parse echoes it back as a path.
export function worktreeCommonDir() {
	const r = spawnSync('git', ['-C', REPO, 'rev-parse', '--git-dir', '--git-common-dir'], { encoding: 'utf8' });
	if (r.status !== 0) return null;
	const [dir, common] = r.stdout.trim().split('\n').map((p) => realResolve(resolve(REPO, p)));
	return dir === common ? null : common;
}

// What comes before one in-process write (#50), once the caller has recorded
// what the write creates: with `backup`, the file's pre-install copy is
// recorded too; then the manifest is saved, and the copy, if any, made. The
// orders scripts write captain.md after this; every other write goes
// through checkpointedWrite.
export function prepareWrite(ctx, m, checkpoint, path, { backup = false, keepLink = false } = {}) {
	const copy = backup ? recordBackup(ctx, m, path, keepLink) : null;
	checkpoint();
	testKillPoint(ctx, `record ${tilde(ctx, path)}`);
	if (!copy) return;
	mkdirSync(dirname(copy.path), { recursive: true });
	copyFileSync(path, `${copy.path}.aidev-tmp`);
	renameSync(`${copy.path}.aidev-tmp`, copy.path);
	settleBackup(copy);
	testKillPoint(ctx, `copied ${tilde(ctx, path)}`);
}

// One in-process write: prepareWrite, then `write`.
export function checkpointedWrite(ctx, m, checkpoint, path, options, write) {
	prepareWrite(ctx, m, checkpoint, path, options);
	write();
	testKillPoint(ctx, `written ${tilde(ctx, path)}`);
}

// Record a pre-existing file's copy the first time the install modifies it;
// a later run must not back up our own changes, and must never overwrite a
// backup an earlier uninstall kept. With `keepLink` (a file we replace
// whole), a symlink is recorded as the link itself, so uninstall puts the
// link back instead of a copy. Returns the backup still to be copied, or null.
function recordBackup(ctx, m, path, keepLink) {
	if (!lexists(path) || backupOf(m, path)) return null;
	if (keepLink && lstatSync(path).isSymbolicLink()) {
		add(m, { ...backupItem(path, path, null), link: readlinkSync(path) });
		return null;
	}
	if (!existsSync(path)) return null;
	let n = items(m, 'backup').length + 1;
	let dest;
	do dest = join(ctx.backupsDir, `${String(n++).padStart(3, '0')}-${basename(path)}`);
	while (existsSync(dest));
	return add(m, backupPending(path, dest, fileSha(path)));
}

// Delete a backup's copy and its record.
export function discardBackup(m, b) {
	if (!b.link) rmSync(b.path, { force: true });
	drop(m, b);
}

// What placing a file whose whole content is ours will do, read from the
// manifest and the disk without changing either: `action` is `current` (it
// already holds the content), `write` (absent, or ours and unedited since we
// wrote it, or the operator's file a killed run recorded but never wrote),
// `replace` (someone else's file: backed up, then replaced, and
// restored at uninstall) or `kept` (ours, but edited since: left as is);
// `record` is its manifest item, if any; `bytes` is what it holds afterwards.
// A plan reads this, and placeOwnedFile acts on the same result.
export function ownedFileAction(m, { path, content }) {
	const record = ownedFile(m, path);
	const cur = fileSha(path);
	let action;
	if (!record) action = cur === null ? 'write' : 'replace';
	else if (cur !== null && cur !== record.sha256) action = 'kept';
	else action = cur === sha256(content) ? 'current' : 'write';
	return { action, record, bytes: action === 'kept' ? readFileSync(path) : content };
}

// Place a file whose whole content is ours (an agent, a hook file, the sheet,
// a license copy, the plugin's copy), as ownedFileAction says (or said, when
// the caller planned with it), through checkpointedWrite. A new record
// starts at what the file holds, so until the write settles it, a reader
// takes the file as it was: the operator's, backed up, or nothing.
export function placeOwnedFile(ctx, m, report, checkpoint, { kind = 'file', name, path, content, mode }, planned = ownedFileAction(m, { path, content })) {
	const { action, record, bytes } = planned;
	const want = sha256(content);
	if (action === 'kept' && sha256(bytes) !== want) report.warn(`${path} was modified since install — left as is`);
	if (action === 'kept' || action === 'current') return;
	const rec = record ?? add(m, ownedFileItem({ kind, name, path, sha256: fileSha(path), existedBefore: action === 'replace' }));
	recordWrite(rec, want);
	if (action === 'replace') report.say(`${path} already existed — backed up and replaced; uninstall restores it`);
	checkpointedWrite(ctx, m, checkpoint, path, { backup: action === 'replace', keepLink: true }, () => writeAtomic(path, content, { mode }));
	settleWrite(rec, true);
}

// Take back a file placed by placeOwnedFile: delete it while it still holds
// what we wrote, then put back the operator's original if we replaced one.
// A file edited since install is kept. Returns a "kept" note, or null.
export function reverseOwnedFile(m, item) {
	const cur = fileSha(item.path);
	const b = backupOf(m, item.path);
	drop(m, item);
	if (cur !== null && cur !== item.sha256) {
		if (b) drop(m, b); // left on disk; the note says where
		const original = b?.link ? `; it replaced a link to ${b.link}` : b ? `; the pre-install original is at ${b.path}` : '';
		return `${item.path} (modified since install${original})`;
	}
	if (cur !== null) rmSync(item.path, { force: true });
	if (b?.link) symlinkSync(b.link, item.path);
	else if (b && existsSync(b.path)) writeAtomic(item.path, readFileSync(b.path), { mode: statSync(b.path).mode & 0o7777 });
	if (b) discardBackup(m, b);
	return null;
}

// Record (or refresh) a file we add parts to (settings.json, CLAUDE.md,
// captain.md) and its format: uninstall strips only our parts from it.
export function noteSharedFile(m, path, existedBefore, format) {
	const rec = sharedFile(m, path) ?? add(m, sharedFileItem(path, existedBefore, format));
	rec.sha256 = fileSha(path);
	return rec;
}

// prepareWrite for a file we add parts to, once the caller has recorded the
// new part: the file's record, and its backup when it was there before the
// install, are recorded with it. Returns whether it was.
export function prepareSharedWrite(ctx, m, checkpoint, path, format) {
	const { existedBefore } = noteSharedFile(m, path, existsSync(path), format);
	prepareWrite(ctx, m, checkpoint, path, { backup: existedBefore });
	return existedBefore;
}

// Write a file we add parts to: prepareSharedWrite, then the write.
export function placeSharedFile(ctx, m, checkpoint, path, content, format) {
	prepareSharedWrite(ctx, m, checkpoint, path, format);
	writeShared(path, content);
	testKillPoint(ctx, `written ${tilde(ctx, path)}`);
	noteSharedFile(m, path, true, format);
}

// How each shared-file format is read, stripped of one of our parts,
// compared and written back. A JSON part is taken out by the caller's
// `strip(v, part)`: a hook entry's from the runtime target that recorded it,
// a provider entry's from the crew provider step.
const CODECS = {
	text: {
		parse: (t) => t,
		strip: (v, part) => stripBlock(v, part.id, blockBefore(v, part)),
		same: (a, b) => a === b,
		empty: (v) => v === '',
		render: (v) => v,
	},
	json: {
		parse: (t) => JSON.parse(t),
		strip: (v, part, strip) => strip(v, part),
		same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
		empty: (v) => Object.keys(v).length === 0,
		render: (v, like) => jsonLike(v, like),
	},
};

// Take our parts back out of a shared file. When what is left equals the
// pre-install backup, the backup's exact bytes come back; when the install
// created the file and nothing else is in it, it goes. Otherwise only our
// parts are removed and the backup is kept. Returns a "kept" note, or null.
// The records go only once the file and its backup have been read, so a file
// that no longer parses throws with them still in the manifest.
export function reverseSharedFile(m, path, strip) {
	const parts = partsIn(m, path);
	const rec = sharedFile(m, path);
	const b = backupOf(m, path);
	const text = readText(path);
	const codec = CODECS[rec?.format ?? (parts.some((p) => p.kind === 'hook-entry') ? 'json' : 'text')];
	let v = text === null ? null : codec.parse(text);
	for (const part of text === null ? [] : [...parts].reverse()) v = codec.strip(v, part, strip);
	const original = b && existsSync(b.path) ? codec.parse(readFileSync(b.path, 'utf8')) : null;
	for (const i of [...parts, rec, b]) if (i) drop(m, i);
	if (text === null) return b ? `${b.path} (backup of ${path}, which was deleted after install)` : null;
	if (original !== null && codec.same(original, v)) {
		writeShared(path, readFileSync(b.path));
		rmSync(b.path, { force: true });
		return null;
	}
	if (!b && rec && !rec.existedBefore && codec.empty(v)) {
		rmSync(path, { force: true });
		return null;
	}
	if (!codec.same(codec.parse(text), v)) writeShared(path, codec.render(v, text));
	return b ? `${b.path} (pre-install copy of ${path}, which changed since install; only our parts were removed)` : null;
}

// How many times `line` stands as a whole line in `text`.
export function countLines(text, line) {
	let n = 0;
	for (let i = text.indexOf(line); i >= 0; i = text.indexOf(line, i + 1)) {
		const end = i + line.length;
		if ((i === 0 || text[i - 1] === '\n') && (end === text.length || text[end] === '\n')) n++;
	}
	return n;
}

// --- marked blocks -----------------------------------------------------------------------

export const markers = (id) => [`<!-- ${id}:start -->`, `<!-- ${id}:end -->`];

// Index of `line` where it stands as a whole line, or -1.
function lineIndex(text, line) {
	for (let i = text.indexOf(line); i >= 0; i = text.indexOf(line, i + 1)) {
		const end = i + line.length;
		if ((i === 0 || text[i - 1] === '\n') && (end === text.length || text[end] === '\n')) return i;
	}
	return -1;
}

// The [start, end) range of a marked block, from its start marker line
// through its end marker line and newline; null when absent. Markers count
// only as whole lines. Throws on a truncated or orphaned block.
export function blockRange(text, id) {
	const [s, e] = markers(id);
	const si = lineIndex(text, s);
	const ei = lineIndex(text, e);
	if (si < 0 && ei < 0) return null;
	if (si < 0 || ei < si) throw new Error(`a damaged ${id} block (markers missing or out of order)`);
	let end = ei + e.length;
	if (text[end] === '\n') end++;
	return [si, end];
}

// Insert a marked block at the end of `text` (null = no file yet), or replace
// the body of the one already there. Returns the new text, whether the block
// was appended, and the separator put in front of an appended block
// (uninstall removes it with the block).
export function upsertBlock(text, id, body) {
	const [s, e] = markers(id);
	const block = `${s}\n${body}${e}\n`;
	const range = text === null ? null : blockRange(text, id);
	if (range) return { text: text.slice(0, range[0]) + block + text.slice(range[1]), before: '', appended: false };
	if (!text) return { text: block, before: '', appended: true };
	const before = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
	return { text: text + before + block, before, appended: true };
}

// The text the install put in front of a marked block, from its manifest
// item: `before` once recorded, or, for an intent (`at`: what the file held
// before the orders script ran, #35), whatever now lies between that text,
// while it is still the file's prefix, and the block; '' when it is not.
export function blockBefore(text, item) {
	if (item.before !== undefined) return item.before;
	const range = blockRange(text, item.id);
	const { length, sha256: hash } = item.at;
	if (!range || sha256(text.slice(0, length)) !== hash) return '';
	return text.slice(length, range[0]);
}

// Remove a marked block plus the text the install put in front of it
// (`before`, e.g. a heading) when that text still directly precedes it.
export function stripBlock(text, id, before) {
	const range = blockRange(text, id);
	if (!range) return text;
	let [start, end] = range;
	if (before && text.slice(0, start).endsWith(before)) start -= before.length;
	return text.slice(0, start) + text.slice(end);
}

// --- JSON files -------------------------------------------------------------------------

export function readJsonObject(path) {
	const text = readText(path);
	if (text === null) return {};
	const v = JSON.parse(text);
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path} is not a JSON object`);
	return v;
}

// Serialize like `like` (the file's previous text): same indentation, same
// final newline. Two spaces and a newline for a new file.
export function jsonLike(v, like) {
	const indent = like?.match(/\n([ \t]+)\S/)?.[1] ?? '  ';
	return JSON.stringify(v, null, indent) + (like == null || like.endsWith('\n') ? '\n' : '');
}

// --- external commands ----------------------------------------------------------------------

export function run(ctx, cmd, args, { cwd, capture = false, env = {} } = {}) {
	const r = spawnSync(cmd, args, {
		cwd: cwd ?? ctx.home,
		env: { ...ctx.env, ...env },
		encoding: 'utf8',
		stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
	});
	return { status: r.error ? 127 : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export const skillsCli = (ctx, args) => run(ctx, 'npx', ['--yes', SKILLS_CLI, ...args], { env: { DISABLE_TELEMETRY: '1' } });

export function readSkillsLock(ctx) {
	try {
		return JSON.parse(readFileSync(ctx.skillsLockPath, 'utf8'));
	} catch {
		return null;
	}
}

// --- directories --------------------------------------------------------------------------------

// The directories that do not exist yet between each path and HOME.
export function missingDirs(ctx, paths) {
	const home = resolve(ctx.home);
	const out = new Set();
	for (const p of paths) {
		let d = dirname(resolve(p));
		while (d !== home && d.startsWith(home + sep) && !existsSync(d)) {
			out.add(d);
			d = dirname(d);
		}
	}
	return [...out];
}

export function removeEmptyDir(p) {
	try {
		if (readdirSync(p).length === 0) rmdirSync(p);
	} catch {}
}

// --- the repo's skill tree ---------------------------------------------------------------------

export const repoSkills = () => readdirSync(SKILLS_SRC).filter((d) => existsSync(join(SKILLS_SRC, d, 'SKILL.md'))).sort();

// Every <skill>/agents/<name>.md in the tree, with the skill that carries it:
// the four carried agent definitions and the vendored effort agents.
export function repoAgents() {
	const out = [];
	for (const skill of repoSkills()) {
		const dir = join(SKILLS_SRC, skill, 'agents');
		if (!isDir(dir)) continue;
		for (const f of readdirSync(dir).sort()) if (f.endsWith('.md')) out.push({ name: f.slice(0, -3), skill, src: join(dir, f) });
	}
	return out;
}

// Cross-skill dependencies by relative path: a `../` path in a skill's file
// that lands inside another skill directory. From a script (anything but
// Markdown) it is a hard dependency: the code fails without the other skill
// (poteto-mode's worktree-audit.mjs imports reflect's finder, #26). From
// Markdown it is a link that would dangle. Broader than the curation gate's
// reference grammar on purpose: the gate checks Markdown syntax, this checks
// whatever a script can import.
export function skillDependencies() {
	const skills = new Set(repoSkills());
	const deps = [];
	const walk = (dir, owner) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.name === 'node_modules') continue;
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p, owner);
			if (!e.isFile()) continue;
			const text = readText(p) ?? '';
			for (const match of text.matchAll(/(?:\.\.\/)+[A-Za-z0-9._-]+/g)) {
				const rel = relative(SKILLS_SRC, resolve(dirname(p), match[0]));
				const target = rel.split(sep)[0];
				if (rel.startsWith('..') || target === owner || !skills.has(target)) continue;
				deps.push({ from: owner, to: target, file: relative(SKILLS_SRC, p), hard: !p.endsWith('.md') });
			}
		}
	};
	for (const s of skills) walk(join(SKILLS_SRC, s), s);
	return deps;
}

export function readExcludeList(ctx) {
	const text = readText(ctx.excludeFile);
	if (text === null) return [];
	return text
		.split('\n')
		.map((l) => l.replace(/#.*/, '').trim())
		.filter(Boolean);
}
