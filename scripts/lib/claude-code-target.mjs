// The Claude Code runtime target (spec #11 D5: the only implemented target).
// It owns install steps 2–7 of ticket #21: the curated skills through the
// skills CLI, the carried and effort agents, the SessionStart routing hook and
// its settings entry, the default model sheet, and the CLAUDE.md include.
// A pi or omp target would be a sibling module with the same three methods;
// uninstall needs none of them, because it is driven by the manifest records
// each target leaves behind.

import {
	REPO,
	SKILLS_SRC,
	backupOnce,
	defaultSheet,
	existsSync,
	fileRecord,
	fileSha,
	find,
	hookHasCommand,
	join,
	jsonText,
	lexists,
	markers,
	blockRange,
	noteSharedFile,
	placeOwnedFile,
	readFileSync,
	readJsonObject,
	readSkillsLock,
	readText,
	repoAgents,
	skillsCli,
	writeAtomic,
} from './aidev-install.mjs';

const AGENT = 'claude-code';
const SHEET_BLOCK = 'aidev-pstack-sheet';
const HOOK_MATCHER = 'startup|resume|clear|compact';

export function claudeCodeTarget(ctx) {
	const d = ctx.claudeDir;
	const hookDir = join(ctx.dataDir, 'claude-code', 'hooks');
	const t = {
		name: AGENT,
		skillsDir: join(d, 'skills'),
		agentsDir: join(d, 'agents'),
		settings: join(d, 'settings.json'),
		claudeMd: join(d, 'CLAUDE.md'),
		sheet: join(d, 'pstack-models.md'),
		hookScript: join(hookDir, 'session-start.sh'),
		hookFiles: [
			{ src: join(REPO, 'scripts', 'claude-code', 'session-start.sh'), dest: join(hookDir, 'session-start.sh'), mode: 0o755 },
			{ src: join(SKILLS_SRC, 'setup-pstack', 'hooks', 'session-start-context.md'), dest: join(hookDir, 'session-start-context.md'), mode: 0o644 },
			{ src: join(SKILLS_SRC, 'setup-pstack', 'scripts', 'read-sheet.sh'), dest: join(hookDir, 'read-sheet.sh'), mode: 0o755 },
		],
	};
	t.hookCommand = JSON.stringify(t.hookScript);
	t.agents = repoAgents().map((a) => ({ ...a, dest: join(t.agentsDir, `${a.name}.md`) }));

	// Every path this target writes directly (the skills CLI writes the rest).
	t.paths = () => [t.skillsDir, t.settings, t.claudeMd, t.sheet, ...t.agents.map((a) => a.dest), ...t.hookFiles.map((f) => f.dest)];

	t.preconditions = (report) => {
		try {
			readJsonObject(t.settings);
		} catch (e) {
			report.error(`${t.settings} does not parse as a JSON object (${e.message}) — fix it and re-run`);
		}
		const md = readText(t.claudeMd);
		if (md !== null) {
			try {
				blockRange(md, SHEET_BLOCK);
			} catch (e) {
				report.error(`${t.claudeMd}: ${e.message} — remove the partial block and re-run`);
			}
		}
	};

	// A skill name already present for Claude Code, in the skills CLI's lock,
	// or in its canonical directory, and not installed by us, belongs to
	// someone else: installing over it would make the CLI's remove delete the
	// operator's copy and lock entry at uninstall. Those are skipped.
	t.planSkills = (m, desired) => {
		const ours = new Set(m.items.filter((i) => i.kind === 'skill').map((i) => i.name));
		const lock = readSkillsLock(ctx)?.skills ?? {};
		const collisions = desired.filter(
			(n) => !ours.has(n) && (lexists(join(t.skillsDir, n)) || n in lock || lexists(join(ctx.canonicalSkillsDir, n))),
		);
		return {
			add: desired.filter((n) => !collisions.includes(n)),
			remove: [...ours].filter((n) => !desired.includes(n)).sort(),
			collisions,
		};
	};

	t.describe = (plan) => [
		...(plan.remove.length ? [`skills remove (${t.name}, user level): ${plan.remove.join(' ')}`] : []),
		`skills add (${t.name}, user level, copy) from ${SKILLS_SRC} → ${t.skillsDir}/<name>: ${plan.add.length} skills`,
		...t.agents.map((a) => `agent ${a.dest}`),
		...t.hookFiles.map((f) => `hook file ${f.dest}`),
		`SessionStart hook entry (${HOOK_MATCHER}) in ${t.settings}`,
		`model sheet ${t.sheet} (only if absent)`,
		`marked block ${SHEET_BLOCK} in ${t.claudeMd} including @${t.sheet}`,
	];

	t.install = (m, plan, report) => {
		// 2. Skills, through the skills CLI: user level (-g), Claude Code only,
		// copies (with one agent the CLI copies anyway; --copy makes it explicit).
		if (!find(m, (i) => i.kind === 'skills-lock')) {
			m.items.push({ kind: 'skills-lock', path: ctx.skillsLockPath, existedBefore: existsSync(ctx.skillsLockPath) });
		}
		if (plan.remove.length) {
			const r = skillsCli(ctx, ['remove', '-g', '-y', '-a', AGENT, '-s', ...plan.remove]);
			if (r.status !== 0) return report.error(`skills CLI remove failed (exit ${r.status})`);
			m.items = m.items.filter((i) => !(i.kind === 'skill' && plan.remove.includes(i.name)));
		}
		let failed = false;
		if (plan.add.length) {
			const r = skillsCli(ctx, ['add', SKILLS_SRC, '-g', '-y', '--copy', '-a', AGENT, '-s', ...plan.add]);
			failed = r.status !== 0;
			if (failed) report.error(`skills CLI add failed (exit ${r.status}); re-run install to converge`);
		}
		// Record what landed, even after a failure, so uninstall can reverse it.
		for (const n of plan.add) {
			const path = join(t.skillsDir, n);
			if (existsSync(join(path, 'SKILL.md')) && !find(m, (i) => i.kind === 'skill' && i.name === n)) {
				m.items.push({ kind: 'skill', name: n, agent: AGENT, path });
			}
		}
		if (failed) return;

		// 3–4. The four carried agents and the ten effort agents, by bare name.
		for (const a of t.agents) placeOwnedFile(ctx, m, report, { kind: 'agent', name: a.name, path: a.dest, content: readFileSync(a.src) });

		// 5. The routing hook: its files, then one identifiable settings entry.
		for (const f of t.hookFiles) placeOwnedFile(ctx, m, report, { path: f.dest, content: readFileSync(f.src), mode: f.mode });
		const existed = existsSync(t.settings);
		const settings = readJsonObject(t.settings);
		const groups = settings.hooks?.SessionStart;
		if (!(Array.isArray(groups) && groups.some((g) => hookHasCommand(g, t.hookScript)))) {
			backupOnce(ctx, m, t.settings);
			settings.hooks ??= {};
			settings.hooks.SessionStart ??= [];
			settings.hooks.SessionStart.push({ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: t.hookCommand }] });
			writeAtomic(t.settings, jsonText(settings));
			noteSharedFile(m, t.settings, fileRecord(m, t.settings)?.existedBefore ?? existed);
		}
		if (!find(m, (i) => i.kind === 'hook-entry' && i.path === t.settings)) {
			m.items.push({ kind: 'hook-entry', path: t.settings, event: 'SessionStart', marker: t.hookScript });
		}

		// 6. The model sheet, setup-pstack's default shape, only when absent.
		if (!existsSync(t.sheet)) {
			placeOwnedFile(ctx, m, report, { path: t.sheet, content: defaultSheet() });
		} else if (!fileRecord(m, t.sheet)) {
			report.say(`${t.sheet} already exists — kept as is`);
		}

		// 7. The CLAUDE.md block with the sheet include.
		const [start, end] = markers(SHEET_BLOCK);
		const block = `${start}\n@${t.sheet}\n${end}\n`;
		const before = readText(t.claudeMd);
		const range = before === null ? null : blockRange(before, SHEET_BLOCK);
		let after;
		let sep = '';
		if (range) after = before.slice(0, range[0]) + block + before.slice(range[1]);
		else if (before === null || before === '') after = block;
		else {
			sep = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
			after = before + sep + block;
		}
		if (after !== before) {
			backupOnce(ctx, m, t.claudeMd);
			writeAtomic(t.claudeMd, after);
			noteSharedFile(m, t.claudeMd, fileRecord(m, t.claudeMd)?.existedBefore ?? before !== null);
		}
		if (!find(m, (i) => i.kind === 'marked-block' && i.path === t.claudeMd)) {
			m.items.push({ kind: 'marked-block', path: t.claudeMd, id: SHEET_BLOCK, before: sep });
		}
	};

	return t;
}

export { fileSha };
