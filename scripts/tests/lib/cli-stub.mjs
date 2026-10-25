// The stub CLIs of the installer tests (lib/install-harness.sh puts a thin
// wrapper per name on PATH): npx (only `skills@<pin> add|remove`, which copies
// skill directories and keeps a lock file the way skills@1.7.4 does in copy
// mode), paseo (a plugin list kept outside the sandbox, in STUB_STATE, and
// `reload`, which keeps the providers config.json names there), bd
// (`ready` and `init`) and bun. Every call is logged to STUB_LOG as
// `<name>|<args>|<cwd>`; STUB_FAIL lists `<name>-<command>` calls to fail,
// plus paseo-build (every plugin build fails). STUB_INTERRUPT lists
// `<name>-<command>` calls that, once done (a plugin install or reload once
// the daemon has built the plugin and saved its status), SIGKILL install.mjs
// and every process between it and the stub, as Ctrl-C would; a paseo entry
// may name one plugin, as paseo-install:<id>, to kill only at its call;
// skills-add-partway copies the first half of the skills asked for, writes
// the lock for those, then kills. The build applies the plugin's own
// host-supplied rule.
// `skills add` plays the operator editing the beads onboarding skip list
// mid-run, after the installer's plan has read it: STUB_SKIP_APPEND appends
// that line to the list, then STUB_SKIP_MODE chmods it.
// With STUB_PLUGINS_IN_CONFIG set, `paseo plugin install` and `remove` also
// rewrite config.json's plugins, as Paseo 0.13 does (plugins/index.js
// configStore.patch), leaving an empty plugins object behind as it does.
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { hostSupplied, imports } from '../../../personal-extensions/paseo-firstmate-beads-onboarding/tests/host-supplied.mjs';

const [name, ...args] = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, `${name}|${args.join(' ')}|${process.cwd()}\n`);
const home = process.env.HOME;
const state = process.env.STUB_STATE;
mkdirSync(state, { recursive: true });
const fail = (process.env.STUB_FAIL ?? '').split(',');
const interrupts = (process.env.STUB_INTERRUPT ?? '').split(',');

// Linux only: the ancestors come from /proc. The chain is walked before
// anything is killed, so a stub run outside the installer kills nothing, and
// install.mjs goes first: killed bottom-up, it would see the stub's exit and
// start the next call before the signal reached it.
function killInstaller() {
	const chain = [];
	for (let pid = process.ppid; pid > 1; ) {
		chain.push(pid);
		if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some((a) => a.endsWith('/install.mjs'))) {
			for (const p of chain.reverse()) process.kill(p, 'SIGKILL');
			return;
		}
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
	}
	throw new Error("install.mjs is not among the stub's ancestors");
}

const exit = (call, code, id) => {
	if (interrupts.includes(call) || (id && interrupts.includes(`${call}:${id}`))) killInstaller();
	process.exit(code);
};

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
	let call = `skills-${cmd}`;
	if (cmd === 'add') {
		const config = isAbsolute(process.env.XDG_CONFIG_HOME ?? '') ? process.env.XDG_CONFIG_HOME : join(home, '.config');
		const skipList = join(config, 'aidev', 'beads-onboarding-skip');
		if (process.env.STUB_SKIP_APPEND) appendFileSync(skipList, `${process.env.STUB_SKIP_APPEND}\n`);
		if (process.env.STUB_SKIP_MODE) chmodSync(skipList, process.env.STUB_SKIP_MODE);
		const source = args[3];
		if (interrupts.includes('skills-add-partway')) {
			call = 'skills-add-partway';
			names.splice(Math.ceil(names.length / 2));
		}
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
	exit(call, 0);
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
	const patchConfigPlugins = (edit) => {
		if (!process.env.STUB_PLUGINS_IN_CONFIG) return;
		const config = join(process.env.PASEO_HOME || join(home, '.paseo'), 'config.json');
		const c = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
		c.plugins ??= {};
		edit(c.plugins);
		writeFileSync(config, JSON.stringify(c, null, 2) + '\n');
	};
	const [group, cmd, arg] = args;
	if (group === 'reload') {
		// Plays `paseo reload` the way Paseo 0.13 does (daemon-config-store.js
		// reload): the daemon reads config.json again and applies its
		// agents.providers live, and fails when the file does not parse. The
		// providers it then knows are kept in paseo-providers.json.
		if (fail.includes('paseo-reload')) process.exit(1);
		const config = join(process.env.PASEO_HOME || join(home, '.paseo'), 'config.json');
		const providers = existsSync(config) ? (JSON.parse(readFileSync(config, 'utf8')).agents?.providers ?? {}) : {};
		writeFileSync(join(state, 'paseo-providers.json'), JSON.stringify(providers));
		exit('paseo-reload', 0);
	}
	if (group !== 'plugin') process.exit(64);
	if (fail.includes(`paseo-${cmd}`)) process.exit(1);
	const id = cmd === 'install' ? JSON.parse(readFileSync(join(arg, 'paseo-plugin.json'), 'utf8')).id : arg;
	const builds = (dir) => !fail.includes('paseo-build') && imports(readFileSync(join(dir, 'index.server.ts'), 'utf8')).every(hostSupplied);
	const start = (p) => {
		p.status = builds(p.path) ? 'running' : 'failed';
		save();
		if (p.status === 'failed') exit(`paseo-${cmd}`, 1, id);
	};
	if (cmd === 'ls') {
		process.stdout.write(JSON.stringify(plugins));
	} else if (cmd === 'install') {
		if (plugins.some((p) => p.id === id)) process.exit(1);
		plugins.push({ id, path: arg });
		patchConfigPlugins((p) => {
			p[id] = { source: 'directory', path: arg, enabled: true };
		});
		start(plugins.at(-1));
	} else if (cmd === 'remove') {
		const i = plugins.findIndex((p) => p.id === id);
		if (i < 0) process.exit(1);
		plugins.splice(i, 1);
		patchConfigPlugins((p) => {
			delete p[id];
		});
		save();
	} else if (cmd === 'reload') {
		const p = plugins.find((x) => x.id === id);
		if (!p) process.exit(1);
		if (p.status === 'disabled') {
			console.error(`Plugin is disabled: ${id}`);
			process.exit(1);
		}
		start(p);
	} else process.exit(64);
	exit(`paseo-${cmd}`, 0, id);
}

if (name === 'bd') {
	if (fail.includes(`bd-${args[0]}`)) process.exit(1);
	if (args[0] === 'ready') exit('bd-ready', existsSync('.beads') ? 0 : 1);
	if (args[0] === 'init') {
		// bd init --stealth in a non-git directory also runs git init
		// (docs/research/beads-cli-memory-surface.md A2).
		mkdirSync('.beads');
		writeFileSync('.beads/config.yaml', 'stub\n');
		if (!existsSync('.git')) mkdirSync('.git');
		exit('bd-init', 0);
	}
	process.exit(64);
}

if (name === 'bun') process.exit(0);
process.exit(64);
