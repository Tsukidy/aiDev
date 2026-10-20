// Shared core of install.mjs and uninstall.mjs (ticket #21, spec #11 D6–D9):
// path resolution under $HOME, the install manifest, the file primitives
// that record what they touch, marked blocks, the settings hook entry, and
// running external CLIs. Zero npm dependencies.

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
	realpathSync,
	renameSync,
	rmSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILLS_SRC = join(REPO, 'skills');
export const SCHEMA_VERSION = 1;
// The skills CLI release whose source the flags below were read from
// (vercel-labs/skills a80e4c9 = npm skills@1.7.4). Pinned so a CLI release
// cannot change what install and uninstall do.
export const SKILLS_CLI = 'skills@1.7.4';
export const SKILLS_CLI_MIN_NODE = [22, 20];
export const ONBOARDING_PLUGIN_DIR = join(REPO, 'personal-extensions', 'paseo-firstmate-beads-onboarding');
// What bd init --quiet --stealth creates in a non-git home
// (docs/research/beads-cli-memory-surface.md A2): its store, a gate lock, and
// a git repository.
export const BEADS_CREATED_NAMES = ['.beads', '.beads.gate.lock', '.git'];

// --- output -------------------------------------------------------------------------

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
	const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
	const dataDir = join(xdg(env, 'XDG_DATA_HOME', home, '.local/share'), 'aidev');
	const stateDir = join(xdg(env, 'XDG_STATE_HOME', home, '.local/state'), 'aidev');
	return {
		env,
		home,
		claudeDir,
		dataDir,
		stateDir,
		manifestPath: join(stateDir, 'install-manifest.json'),
		backupsDir: join(stateDir, 'backups'),
		excludeFile: join(xdg(env, 'XDG_CONFIG_HOME', home, '.config'), 'aidev', 'install-exclude'),
		licensesDir: join(dataDir, 'licenses'),
		paseoHome: env.PASEO_HOME || join(home, '.paseo'),
		// The skills CLI keeps its global lock here (skill-lock.ts getSkillLockPath).
		skillsLockPath: env.XDG_STATE_HOME
			? join(env.XDG_STATE_HOME, 'skills', '.skill-lock.json')
			: join(home, '.agents', '.skill-lock.json'),
		// ...and its canonical copies here (installer.ts getCanonicalSkillsDir).
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

// --- hashing and files ------------------------------------------------------------------

export function sha256(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

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

export function writeAtomic(p, content, mode) {
	mkdirSync(dirname(p), { recursive: true });
	const tmp = `${p}.aidev-tmp`;
	writeFileSync(tmp, content);
	if (mode !== undefined) chmodSync(tmp, mode);
	renameSync(tmp, p);
}

// --- the manifest --------------------------------------------------------------------------

export function loadManifest(ctx) {
	const text = readText(ctx.manifestPath);
	if (text === null) return null;
	const m = JSON.parse(text);
	if (m.schemaVersion !== SCHEMA_VERSION || !Array.isArray(m.items)) {
		throw new Error(`unsupported manifest at ${ctx.manifestPath} (schemaVersion ${m.schemaVersion})`);
	}
	return m;
}

export function serializeManifest(m) {
	return JSON.stringify(m, null, 2) + '\n';
}

// Written only when it changed, so an install that changes nothing leaves the
// manifest byte-identical.
export function saveManifest(ctx, m) {
	const text = serializeManifest(m);
	if (readText(ctx.manifestPath) !== text) writeAtomic(ctx.manifestPath, text);
}

export function repoCommit() {
	const r = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
	return r.status === 0 ? r.stdout.trim() : 'unknown';
}

export const find = (m, pred) => m.items.find(pred);
export const fileRecord = (m, path) => find(m, (i) => (i.kind === 'file' || i.kind === 'agent') && i.path === path);
export const backupRecord = (m, path) => find(m, (i) => i.kind === 'backup' && i.of === path);

// Copy a pre-existing file aside the first time the install modifies it; a
// later run must not back up our own changes.
export function backupOnce(ctx, m, path) {
	if (!existsSync(path) || backupRecord(m, path)) return;
	const n = m.items.filter((i) => i.kind === 'backup').length + 1;
	const dest = join(ctx.backupsDir, `${String(n).padStart(3, '0')}-${basename(path)}`);
	mkdirSync(ctx.backupsDir, { recursive: true });
	copyFileSync(path, dest);
	m.items.push({ kind: 'backup', of: path, path: dest, sha256: fileSha(dest) });
}

// Place a file whose whole content is ours (an agent, the hook, the sheet, a
// license copy). A file recorded as ours is refreshed only while it still
// holds what we wrote; a pre-existing file of the same name is backed up
// first and restored at uninstall.
export function placeOwnedFile(ctx, m, report, { kind = 'file', name, path, content, mode }) {
	const want = sha256(content);
	const rec = fileRecord(m, path);
	const cur = fileSha(path);
	if (rec) {
		if (cur !== null && cur !== rec.sha256) {
			if (cur !== want) report.warn(`${path} was modified since install — left as is`);
			return false;
		}
		if (cur !== want) writeAtomic(path, content, mode);
		else if (mode !== undefined && (statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
		rec.sha256 = want;
		return cur !== want;
	}
	if (cur !== null) {
		backupOnce(ctx, m, path);
		report.say(`${path} already existed — backed up and replaced; uninstall restores it`);
	}
	writeAtomic(path, content, mode);
	const item = { kind, path, sha256: want, existedBefore: cur !== null };
	if (name) item.name = name;
	m.items.push(item);
	return true;
}

// Record (or refresh) the after-install hash of a file we share with others
// (settings.json, CLAUDE.md, captain.md): uninstall restores the backup when
// the file still holds exactly this, and strips only our parts otherwise.
export function noteSharedFile(m, path, existedBefore) {
	let rec = fileRecord(m, path);
	if (!rec) {
		rec = { kind: 'file', path, shared: true, existedBefore };
		m.items.push(rec);
	}
	rec.sha256 = fileSha(path);
}

// --- marked blocks ------------------------------------------------------------------------

export const markers = (id) => [`<!-- ${id}:start -->`, `<!-- ${id}:end -->`];

// The [start, end) character range of a marked block, from the start marker
// line through the end marker line and its newline; null when absent.
// Throws on a truncated or orphaned block.
export function blockRange(text, id) {
	const [s, e] = markers(id);
	const si = text.indexOf(s);
	const ei = text.indexOf(e);
	if (si < 0 && ei < 0) return null;
	if (si < 0 || ei < si) throw new Error(`a damaged ${id} block (markers out of order or missing)`);
	let end = ei + e.length;
	if (text[end] === '\n') end++;
	return [si, end];
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

// --- the settings hook entry ------------------------------------------------------------

export function readJsonObject(path) {
	const text = readText(path);
	if (text === null) return {};
	const v = JSON.parse(text);
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path} is not a JSON object`);
	return v;
}

export const hookHasCommand = (group, marker) =>
	Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(marker));

// Drop every hook whose command names our marker, then any group left empty,
// then the event and the hooks object if they end up empty.
export function removeHookEntry(settings, event, marker) {
	const groups = settings.hooks?.[event];
	if (!Array.isArray(groups)) return settings;
	const kept = [];
	for (const g of groups) {
		if (!hookHasCommand(g, marker)) {
			kept.push(g);
			continue;
		}
		const hooks = g.hooks.filter((h) => !(typeof h?.command === 'string' && h.command.includes(marker)));
		if (hooks.length) kept.push({ ...g, hooks });
	}
	if (kept.length) settings.hooks[event] = kept;
	else delete settings.hooks[event];
	if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
	return settings;
}

export const jsonText = (v) => JSON.stringify(v, null, 2) + '\n';

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

export function skillsCli(ctx, args) {
	return run(ctx, 'npx', ['--yes', SKILLS_CLI, ...args], { env: { DISABLE_TELEMETRY: '1' } });
}

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
		if (readdirSync(p).length === 0) {
			rmdirSync(p);
			return true;
		}
	} catch {}
	return false;
}

// --- the repo's skill tree ---------------------------------------------------------------------

export function repoSkills() {
	return readdirSync(SKILLS_SRC)
		.filter((d) => existsSync(join(SKILLS_SRC, d, 'SKILL.md')))
		.sort();
}

// Every <skill>/agents/<name>.md in the tree: the four carried agent
// definitions and the vendored effort agents.
export function repoAgents() {
	const out = [];
	for (const s of repoSkills()) {
		const dir = join(SKILLS_SRC, s, 'agents');
		if (!isDir(dir)) continue;
		for (const f of readdirSync(dir).sort()) if (f.endsWith('.md')) out.push({ name: f.slice(0, -3), src: join(dir, f) });
	}
	return out;
}

// Cross-skill dependencies by relative path: a `../` path in a skill's file
// that lands inside another skill directory. From a script (anything but
// Markdown) it is a hard dependency: the code fails without the other skill
// (poteto-mode's worktree-audit.mjs imports reflect's finder, #26). From
// Markdown it is a link that would dangle.
export function skillDependencies() {
	const skills = new Set(repoSkills());
	const deps = [];
	const walk = (dir, owner) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.name === 'node_modules') continue;
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p, owner);
			else if (e.isFile()) {
				let text;
				try {
					text = readFileSync(p, 'utf8');
				} catch {
					continue;
				}
				for (const match of text.matchAll(/(?:\.\.\/)+[A-Za-z0-9._-]+/g)) {
					const rel = relative(SKILLS_SRC, resolve(dirname(p), match[0]));
					if (rel.startsWith('..') || isAbsolute(rel)) continue;
					const target = rel.split(sep)[0];
					if (target !== owner && skills.has(target)) {
						deps.push({ from: owner, to: target, file: relative(SKILLS_SRC, p), hard: !p.endsWith('.md') });
					}
				}
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

// setup-pstack's default sheet: the one ```markdown fence in its SKILL.md
// (step 6, "Write the override sheet"), so the installer writes exactly the
// shape the skill documents.
export function defaultSheet() {
	const text = readFileSync(join(SKILLS_SRC, 'setup-pstack', 'SKILL.md'), 'utf8');
	const m = text.match(/\n```markdown\n([\s\S]*?)\n```\n/);
	if (!m) throw new Error('setup-pstack/SKILL.md has no ```markdown default sheet');
	return m[1] + '\n';
}

export { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, join, dirname, basename };
