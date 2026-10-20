// The Claude Code runtime target (spec #11 D5: the only one implemented; the
// contract is in targets.mjs). It owns install steps 2–7 of ticket #21: the
// curated skills through the skills CLI, the carried and effort agents, the
// SessionStart routing hook and its settings entry, the default model sheet,
// and the CLAUDE.md include.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	REPO,
	SKILLS_SRC,
	backupOnce,
	blockRange,
	jsonLike,
	lexists,
	noteSharedFile,
	placeOwnedFile,
	readJsonObject,
	readSkillsLock,
	readText,
	repoAgents,
	reverseOwnedFile,
	reverseSharedFile,
	skillsCli,
	upsertBlock,
	writeShared,
} from './aidev-install.mjs';
import {
	add,
	drop,
	ensure,
	first,
	hookEntryItem,
	items,
	markedBlockItem,
	ownedFile,
	partsIn,
	sharedFile,
	skillItem,
	skillsLockItem,
} from './manifest.mjs';

const NAME = 'claude-code';
const SHEET_BLOCK = 'aidev-pstack-sheet';
const HOOK_MATCHER = 'startup|resume|clear|compact';
const ROUTER = 'poteto-mode'; // the skill the routing hook's mandate invokes

// --- the settings.json hook entry (Claude Code's format) ---------------------------------

const isOurs = (hook, marker) => typeof hook?.command === 'string' && hook.command.includes(marker);
const groupHas = (group, marker) => Array.isArray(group?.hooks) && group.hooks.some((h) => isOurs(h, marker));

// Drop every hook whose command names our marker, then any group left empty,
// then the event and the hooks object if they end up empty.
function stripHookEntry(settings, { event, marker }) {
	const groups = settings.hooks?.[event];
	if (!Array.isArray(groups)) return settings;
	const kept = [];
	for (const g of groups) {
		if (!groupHas(g, marker)) kept.push(g);
		else {
			const hooks = g.hooks.filter((h) => !isOurs(h, marker));
			if (hooks.length) kept.push({ ...g, hooks });
		}
	}
	if (kept.length) settings.hooks[event] = kept;
	else delete settings.hooks[event];
	if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
	return settings;
}

// POSIX single-quote a path for the hook command (Claude Code runs it in a shell).
const shQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

// setup-pstack's default sheet: the one ```markdown fence in its SKILL.md
// (step 6, "Write the override sheet"), so the installer writes exactly the
// shape the skill documents.
function defaultSheet() {
	const text = readFileSync(join(SKILLS_SRC, 'setup-pstack', 'SKILL.md'), 'utf8');
	const m = text.match(/\n```markdown\n([\s\S]*?)\n```\n/);
	if (!m) throw new Error('setup-pstack/SKILL.md has no ```markdown default sheet');
	return m[1] + '\n';
}

export function claudeCodeTarget(ctx) {
	const d = ctx.claudeDir;
	const hookDir = join(ctx.dataDir, 'claude-code', 'hooks');
	const skillsDir = join(d, 'skills');
	const agentsDir = join(d, 'agents');
	const settings = join(d, 'settings.json');
	const claudeMd = join(d, 'CLAUDE.md');
	const sheet = join(d, 'pstack-models.md');
	const hookScript = join(hookDir, 'session-start.sh');
	const hookFiles = [
		{ src: join(REPO, 'scripts', 'claude-code', 'session-start.sh'), dest: hookScript, mode: 0o755 },
		{ src: join(SKILLS_SRC, 'setup-pstack', 'hooks', 'session-start-context.md'), dest: join(hookDir, 'session-start-context.md'), mode: 0o644 },
		{ src: join(SKILLS_SRC, 'setup-pstack', 'scripts', 'read-sheet.sh'), dest: join(hookDir, 'read-sheet.sh'), mode: 0o755 },
	];
	const agents = repoAgents().map((a) => ({ ...a, dest: join(agentsDir, `${a.name}.md`) }));

	// --- step 5: the routing hook, added or (when its skill is excluded) taken out --------

	function installHook(m, report) {
		for (const f of hookFiles) placeOwnedFile(ctx, m, report, { path: f.dest, content: readFileSync(f.src), mode: f.mode });
		const text = readText(settings);
		const json = readJsonObject(settings);
		const ours = first(m, 'hook-entry', (i) => i.path === settings);
		if ((json.hooks?.SessionStart ?? []).some((g) => groupHas(g, hookScript))) {
			if (!ours) report.say(`${settings} already has a SessionStart entry for ${hookScript}, not added by this install — left as is`);
			return;
		}
		// Absent: add it (again, if the operator deleted ours since install).
		backupOnce(ctx, m, settings);
		json.hooks ??= {};
		json.hooks.SessionStart ??= [];
		json.hooks.SessionStart.push({ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: shQuote(hookScript) }] });
		writeShared(settings, jsonLike(json, text));
		if (!ours) add(m, hookEntryItem(NAME, settings, 'SessionStart', hookScript));
		noteSharedFile(m, settings, sharedFile(m, settings)?.existedBefore ?? text !== null, 'json');
	}

	// The same reversal uninstall uses: settings.json holds only our hook entry.
	function removeHook(m, report) {
		if (partsIn(m, settings).length) {
			const kept = reverseSharedFile(m, settings, () => stripHookEntry);
			if (kept) report.say(`kept ${kept}`);
		}
		for (const f of hookFiles) {
			const rec = ownedFile(m, f.dest);
			const kept = rec && reverseOwnedFile(m, rec);
			if (kept) report.say(`kept ${kept}`);
		}
	}

	return {
		name: NAME,
		label: 'Claude Code',
		stripHookEntry,

		paths: () => [skillsDir, settings, claudeMd, sheet, ...agents.map((a) => a.dest), ...hookFiles.map((f) => f.dest)],

		preconditions(report) {
			try {
				readJsonObject(settings);
			} catch (e) {
				report.error(`${settings} does not parse as a JSON object (${e.message}) — fix it and re-run`);
			}
			const md = readText(claudeMd);
			if (md !== null) {
				try {
					blockRange(md, SHEET_BLOCK);
				} catch (e) {
					report.error(`${claudeMd}: ${e.message} — remove the partial block and re-run`);
				}
			}
		},

		// A skill name already present for Claude Code, in the skills CLI's
		// lock, or in its canonical directory, and not installed by us, belongs
		// to someone else: installing over it would make the CLI's remove
		// delete the operator's copy and lock entry at uninstall. Skipped.
		planSkills(m, desired) {
			const ours = new Set(items(m, 'skill', (i) => i.agent === NAME).map((i) => i.name));
			const lock = readSkillsLock(ctx)?.skills ?? {};
			const collisions = desired.filter(
				(n) => !ours.has(n) && (lexists(join(skillsDir, n)) || n in lock || lexists(join(ctx.canonicalSkillsDir, n))),
			);
			return {
				desired,
				add: desired.filter((n) => !collisions.includes(n)),
				remove: [...ours].filter((n) => !desired.includes(n)).sort(),
				collisions,
			};
		},

		describe: (plan) => [
			...(plan.remove.length ? [`skills remove (${NAME}, user level): ${plan.remove.join(' ')}`] : []),
			`skills add (${NAME}, user level, copy) from ${SKILLS_SRC} → ${skillsDir}/<name>: ${plan.add.length} skills`,
			...agents.filter((a) => plan.desired.includes(a.skill)).map((a) => `agent ${a.dest}`),
			...(plan.desired.includes(ROUTER)
				? [...hookFiles.map((f) => `hook file ${f.dest}`), `SessionStart hook entry (${HOOK_MATCHER}) in ${settings}`]
				: [`no routing hook: ${ROUTER} is excluded`]),
			`model sheet ${sheet} (only if absent)`,
			`marked block ${SHEET_BLOCK} in ${claudeMd} including @${sheet}`,
		],

		install(m, plan, report) {
			// Step 2. Skills through the skills CLI: user level (-g), Claude Code
			// only, copies (with one agent the CLI copies anyway; --copy says so).
			ensure(m, skillsLockItem(ctx.skillsLockPath, existsSync(ctx.skillsLockPath)), () => true);
			if (plan.remove.length) {
				const r = skillsCli(ctx, ['remove', '-g', '-y', '-a', NAME, '-s', ...plan.remove]);
				if (r.status !== 0) return report.error(`skills CLI remove failed (exit ${r.status})`);
				for (const i of items(m, 'skill', (i) => i.agent === NAME && plan.remove.includes(i.name))) drop(m, i);
			}
			let failed = false;
			if (plan.add.length) {
				const r = skillsCli(ctx, ['add', SKILLS_SRC, '-g', '-y', '--copy', '-a', NAME, '-s', ...plan.add]);
				failed = r.status !== 0;
				if (failed) report.error(`skills CLI add failed (exit ${r.status}); re-run install to converge`);
			}
			// Record what landed, even after a failure, so uninstall can reverse it.
			for (const n of plan.add) {
				const path = join(skillsDir, n);
				if (existsSync(join(path, 'SKILL.md'))) ensure(m, skillItem(n, NAME, path), (i) => i.agent === NAME && i.name === n);
			}
			if (failed) return;

			// Steps 3–4. The carried and effort agents of every installed skill,
			// by bare name; an agent whose skill is now excluded comes back out.
			const wanted = agents.filter((a) => plan.desired.includes(a.skill));
			for (const a of wanted) placeOwnedFile(ctx, m, report, { kind: 'agent', name: a.name, path: a.dest, content: readFileSync(a.src) });
			for (const rec of items(m, 'agent', (i) => !wanted.some((a) => a.dest === i.path))) {
				const kept = reverseOwnedFile(m, rec);
				if (kept) report.say(`kept ${kept}`);
			}

			// Step 5. The routing hook mandates the router, so it follows it.
			if (plan.desired.includes(ROUTER)) installHook(m, report);
			else {
				report.warn(`${ROUTER} is excluded, so the SessionStart routing hook is not installed`);
				removeHook(m, report);
			}

			// Step 6. The model sheet, setup-pstack's default shape, only when absent.
			if (!existsSync(sheet)) placeOwnedFile(ctx, m, report, { path: sheet, content: defaultSheet() });
			else if (!ownedFile(m, sheet)) report.say(`${sheet} already exists — kept as is`);

			// Step 7. The CLAUDE.md block with the sheet include.
			const before = readText(claudeMd);
			const ours = first(m, 'marked-block', (i) => i.path === claudeMd && i.id === SHEET_BLOCK);
			if (!ours && before !== null && blockRange(before, SHEET_BLOCK)) {
				report.say(`${claudeMd} already has an ${SHEET_BLOCK} block, not added by this install — left as is`);
				return;
			}
			const up = upsertBlock(before, SHEET_BLOCK, `@${sheet}\n`);
			if (up.text !== before) {
				backupOnce(ctx, m, claudeMd);
				writeShared(claudeMd, up.text);
				noteSharedFile(m, claudeMd, sharedFile(m, claudeMd)?.existedBefore ?? before !== null);
			}
			if (!ours) add(m, markedBlockItem(claudeMd, SHEET_BLOCK, up.before));
		},
	};
}
