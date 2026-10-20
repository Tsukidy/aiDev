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
	drop,
	items,
	ownedFile,
	ownedFileItem,
	partsIn,
	readManifest,
	serialize,
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
// What bd init --quiet --stealth creates in a non-git home
// (docs/research/beads-cli-memory-surface.md A2): its store, a gate lock, and
// a git repository.
export const BEADS_CREATED_NAMES = ['.beads', '.beads.gate.lock', '.git'];

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
	return {
		env,
		home,
		claudeDir: env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'),
		dataDir,
		stateDir,
		manifestPath: join(stateDir, 'install-manifest.json'),
		backupsDir: join(stateDir, 'backups'),
		excludeFile: join(xdg(env, 'XDG_CONFIG_HOME', home, '.config'), 'aidev', 'install-exclude'),
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

export const loadManifest = (ctx) => readManifest(ctx.manifestPath);

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

// Copy a pre-existing file aside the first time the install modifies it; a
// later run must not back up our own changes, and must never overwrite a
// backup an earlier uninstall kept. With `keepLink` (a file we replace
// whole), a symlink is recorded as the link itself, so uninstall puts the
// link back instead of a copy.
export function backupOnce(ctx, m, path, { keepLink = false } = {}) {
	if (!lexists(path) || backupOf(m, path)) return;
	if (keepLink && lstatSync(path).isSymbolicLink()) {
		add(m, { ...backupItem(path, path, null), link: readlinkSync(path) });
		return;
	}
	if (!existsSync(path)) return;
	mkdirSync(ctx.backupsDir, { recursive: true });
	let n = items(m, 'backup').length + 1;
	let dest;
	do dest = join(ctx.backupsDir, `${String(n++).padStart(3, '0')}-${basename(path)}`);
	while (existsSync(dest));
	copyFileSync(path, dest);
	add(m, backupItem(path, dest, fileSha(dest)));
}

// Place a file whose whole content is ours (an agent, a hook file, the sheet,
// a license copy). A file recorded as ours is refreshed only while it still
// holds what we wrote; a pre-existing file of the same name is backed up
// first and restored at uninstall. Returns whether the file changed.
export function placeOwnedFile(ctx, m, report, { kind = 'file', name, path, content, mode }) {
	const want = sha256(content);
	const rec = ownedFile(m, path);
	const cur = fileSha(path);
	if (rec) {
		if (cur !== null && cur !== rec.sha256) {
			if (cur !== want) report.warn(`${path} was modified since install — left as is`);
			return false;
		}
		if (cur !== want) writeAtomic(path, content, { mode });
		rec.sha256 = want;
		return cur !== want;
	}
	if (cur !== null) {
		backupOnce(ctx, m, path, { keepLink: true });
		report.say(`${path} already existed — backed up and replaced; uninstall restores it`);
	}
	writeAtomic(path, content, { mode });
	add(m, ownedFileItem({ kind, name, path, sha256: want, existedBefore: cur !== null }));
	return true;
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
	else if (b && existsSync(b.path)) {
		writeAtomic(item.path, readFileSync(b.path), { mode: statSync(b.path).mode & 0o7777 });
		rmSync(b.path, { force: true });
	}
	if (b) drop(m, b);
	return null;
}

// Record (or refresh) a file we add parts to (settings.json, CLAUDE.md,
// captain.md) and its format: uninstall strips only our parts from it.
export function noteSharedFile(m, path, existedBefore, format) {
	const rec = sharedFile(m, path) ?? add(m, sharedFileItem(path, existedBefore, format));
	rec.sha256 = fileSha(path);
}

// How each shared-file format is read, stripped of one of our parts,
// compared and written back. `stripHook` comes from the runtime target that
// recorded the hook entry.
const CODECS = {
	text: {
		parse: (t) => t,
		strip: (v, part) => stripBlock(v, part.id, part.before),
		same: (a, b) => a === b,
		empty: (v) => v === '',
		render: (v) => v,
	},
	json: {
		parse: (t) => JSON.parse(t),
		strip: (v, part, stripHook) => stripHook(part)(v, part),
		same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
		empty: (v) => Object.keys(v).length === 0,
		render: (v, like) => jsonLike(v, like),
	},
};

// Take our parts back out of a shared file. When what is left equals the
// pre-install backup, the backup's exact bytes come back; when the install
// created the file and nothing else is in it, it goes. Otherwise only our
// parts are removed and the backup is kept. Returns a "kept" note, or null.
export function reverseSharedFile(m, path, stripHook) {
	const parts = partsIn(m, path);
	const rec = sharedFile(m, path);
	const b = backupOf(m, path);
	for (const i of [...parts, rec, b]) if (i) drop(m, i);
	const text = readText(path);
	if (text === null) return b ? `${b.path} (backup of ${path}, which was deleted after install)` : null;
	const codec = CODECS[rec?.format ?? (parts.some((p) => p.kind === 'hook-entry') ? 'json' : 'text')];
	let v = codec.parse(text);
	for (const part of [...parts].reverse()) v = codec.strip(v, part, stripHook);
	const original = b && existsSync(b.path) ? readFileSync(b.path, 'utf8') : null;
	if (original !== null && codec.same(codec.parse(original), v)) {
		writeShared(path, readFileSync(b.path));
		rmSync(b.path, { force: true });
		return null;
	}
	if (!b && rec && !rec.existedBefore && codec.empty(v)) {
		rmSync(path, { force: true });
		return null;
	}
	const result = codec.render(v, text);
	if (result !== text) writeShared(path, result);
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
// the body of the one already there. Returns the new text and the separator
// put in front of an appended block (uninstall removes it with the block).
export function upsertBlock(text, id, body) {
	const [s, e] = markers(id);
	const block = `${s}\n${body}${e}\n`;
	const range = text === null ? null : blockRange(text, id);
	if (range) return { text: text.slice(0, range[0]) + block + text.slice(range[1]), before: '' };
	if (!text) return { text: block, before: '' };
	const before = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
	return { text: text + before + block, before };
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

export function paseoPluginIds(ctx) {
	const r = run(ctx, 'paseo', ['plugin', 'ls', '--json'], { capture: true });
	if (r.status !== 0) return null;
	try {
		const list = JSON.parse(r.stdout);
		return Array.isArray(list) ? list.map((p) => p.id) : null;
	} catch {
		return null;
	}
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
