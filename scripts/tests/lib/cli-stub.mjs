// The stub CLIs of the installer tests (lib/install-harness.sh puts a thin
// wrapper per name on PATH): npx (only `skills@<pin> add|remove`, which copies
// skill directories and keeps a lock file the way skills@1.7.4 does in copy
// mode), paseo (a plugin list kept outside the sandbox, in STUB_STATE), bd
// (`ready` and `init`) and bun. Every call is logged to STUB_LOG as
// `<name>|<args>|<cwd>`; STUB_FAIL lists `<name>-<command>` calls to fail.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';

const [name, ...args] = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, `${name}|${args.join(' ')}|${process.cwd()}\n`);
const home = process.env.HOME;
const state = process.env.STUB_STATE;
mkdirSync(state, { recursive: true });
const fail = (process.env.STUB_FAIL ?? '').split(',');

function listAfter(flag) {
	const i = args.indexOf(flag);
	if (i < 0) return [];
	const out = [];
	for (let j = i + 1; j < args.length && !args[j].startsWith('-'); j++) out.push(args[j]);
	return out;
}

if (name === 'npx') {
	// npx --yes skills@<pin> <add|remove> ...
	const [, pkg, cmd] = args;
	if (args[0] !== '--yes' || !pkg.startsWith('skills@')) process.exit(64);
	if (fail.includes(`skills-${cmd}`)) process.exit(1);
	const claude = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
	const lockPath = process.env.XDG_STATE_HOME
		? join(process.env.XDG_STATE_HOME, 'skills', '.skill-lock.json')
		: join(home, '.agents', '.skill-lock.json');
	const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { version: 3, skills: {} };
	const names = listAfter('-s');
	if (cmd === 'add') {
		const source = args[3];
		for (const n of names) {
			const dest = join(claude, 'skills', n);
			rmSync(dest, { recursive: true, force: true });
			cpSync(join(source, n), dest, { recursive: true });
			lock.skills[n] = { source, sourceType: 'local' };
		}
	} else if (cmd === 'remove') {
		for (const n of names) {
			rmSync(join(claude, 'skills', n), { recursive: true, force: true });
			delete lock.skills[n];
		}
	} else process.exit(64);
	mkdirSync(join(lockPath, '..'), { recursive: true });
	writeFileSync(lockPath, JSON.stringify(lock, null, 2));
	process.exit(0);
}

if (name === 'paseo') {
	// Plays the daemon the way Paseo 0.12 does (plugins/index.js): `install
	// <dir>` registers the plugin before building it and keeps it, as failed,
	// when the build fails; an id already configured is refused; `reload`
	// rebuilds, and is refused for a disabled plugin. Like Paseo's, the build
	// reads the copy where it lies (plugins/compiler.js): it fails when the
	// copy's index.server.ts imports anything the host does not supply (Node
	// builtins and @getpaseo/plugin/server), and always under
	// STUB_FAIL=paseo-build.
	const file = join(state, 'paseo-plugins.json');
	const plugins = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
	const save = () => writeFileSync(file, JSON.stringify(plugins));
	const [group, cmd, arg] = args;
	if (group !== 'plugin') process.exit(64);
	if (fail.includes(`paseo-${cmd}`)) process.exit(1);
	const builds = (dir) => {
		const source = readFileSync(join(dir, 'index.server.ts'), 'utf8');
		const specifiers = [...source.matchAll(/^\s*(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);
		return !fail.includes('paseo-build') && specifiers.every((s) => isBuiltin(s) || s === '@getpaseo/plugin/server');
	};
	const start = (p) => {
		p.status = builds(p.path) ? 'running' : 'failed';
		save();
		if (p.status === 'failed') process.exit(1);
	};
	if (cmd === 'ls') {
		process.stdout.write(JSON.stringify(plugins));
	} else if (cmd === 'install') {
		const id = JSON.parse(readFileSync(join(arg, 'paseo-plugin.json'), 'utf8')).id;
		if (plugins.some((p) => p.id === id)) process.exit(1);
		plugins.push({ id, path: arg });
		start(plugins.at(-1));
	} else if (cmd === 'remove') {
		const i = plugins.findIndex((p) => p.id === arg);
		if (i < 0) process.exit(1);
		plugins.splice(i, 1);
		save();
	} else if (cmd === 'reload') {
		const p = plugins.find((x) => x.id === arg);
		if (!p) process.exit(1);
		if (p.status === 'disabled') {
			console.error(`Plugin is disabled: ${arg}`);
			process.exit(1);
		}
		start(p);
	} else process.exit(64);
	process.exit(0);
}

if (name === 'bd') {
	if (fail.includes(`bd-${args[0]}`)) process.exit(1);
	if (args[0] === 'ready') process.exit(existsSync('.beads') ? 0 : 1);
	if (args[0] === 'init') {
		// bd init --stealth in a non-git directory also runs git init
		// (docs/research/beads-cli-memory-surface.md A2).
		mkdirSync('.beads');
		writeFileSync('.beads/config.yaml', 'stub\n');
		if (!existsSync('.git')) mkdirSync('.git');
		process.exit(0);
	}
	process.exit(64);
}

if (name === 'bun') process.exit(0);
process.exit(64);
