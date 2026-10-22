// The orders step of install (8a): the two orders installers, each appending
// its own marked block to the first mate's data/captain.md, the beads one
// also creating the mate's home memory database. Shaped like the onboarding
// plugin step (onboarding-plugin.mjs): runtime-neutral, outside the target
// registry, and with nothing to reverse of its own, since uninstall strips
// the recorded blocks and removes the recorded beads-db paths itself:
//
//   preconditions(report)  the mate home resolvable; captain.md's blocks
//                          intact, and no marker name outside its marker
//                          line, which an orders script would misread
//   paths()                the mate home and captain.md (after preconditions)
//   describe()             its lines, printed by --dry-run
//   install(m, report, checkpoint)  captain.md's shared record and backup;
//                          then, per script: record what it may create,
//                          checkpoint, run it, settle the records
//
// A block is ours only when this install appended it: the intent to append it
// (what the file held, markedBlockIntent) and what bd init may create are
// recorded before the script runs, and settled after it, the block with the
// text the script put in front of it, so uninstall removes exactly that.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
	ONBOARDING_PLUGIN_DIR,
	REPO,
	backupOnce,
	blockBefore,
	blockRange,
	countLines,
	lexists,
	markers,
	noteSharedFile,
	readText,
	resolveMateHome,
	run,
} from './aidev-install.mjs';
import { add, backupOf, beadsDbItem, drop, ensure, first, items, markedBlockIntent, markedBlockItem, replace, sharedFile } from './manifest.mjs';

// What bd init --quiet --stealth creates in a non-git home
// (docs/research/beads-cli-memory-surface.md A2): its store, a gate lock, and
// a git repository.
const BEADS_CREATED_NAMES = ['.beads', '.beads.gate.lock', '.git'];

// Each script, the block it appends, and what else its call may create in the
// mate home: the beads installer runs bd init when .beads is absent.
const ORDERS = [
	{ script: join(REPO, 'scripts', 'install-standing-orders.sh'), block: 'aidev-standing-orders', creates: () => [] },
	{
		script: join(ONBOARDING_PLUGIN_DIR, 'install-captain-orders.sh'),
		block: 'paseo-beads-onboarding',
		creates: (home) => (lexists(join(home, '.beads')) ? [] : BEADS_CREATED_NAMES.map((n) => join(home, n))),
	},
];

export function ordersStep(ctx) {
	let mateHome = null;
	let captain = null;
	let captainText = null;
	const ourBlock = (m, id) => first(m, 'marked-block', (i) => i.path === captain && i.id === id);

	// captain.md's shared record and backup, written before the first script
	// so a killed run leaves them, and taken back after when the file is as
	// it was and the record is this run's.
	function recordCaptain(m) {
		const existed = sharedFile(m, captain)?.existedBefore ?? captainText !== null;
		const fresh = { record: !sharedFile(m, captain), backup: !backupOf(m, captain) };
		if (existed) backupOnce(ctx, m, captain);
		noteSharedFile(m, captain, existed);
		return { existed, fresh };
	}
	function settleCaptain(m, { existed, fresh }) {
		if (readText(captain) !== captainText || !fresh.record) return noteSharedFile(m, captain, existed);
		drop(m, sharedFile(m, captain));
		const b = backupOf(m, captain);
		if (fresh.backup && b) {
			rmSync(b.path, { force: true });
			drop(m, b);
		}
	}

	return {
		preconditions(report) {
			mateHome = resolveMateHome(ctx);
			if (!mateHome) return report.error(`first mate home not found under ${ctx.paseoHome} — launch the first mate once so its home exists (or set PASEO_HOME)`);
			captain = join(mateHome, 'data', 'captain.md');
			captainText = readText(captain);
			if (captainText === null) return;
			for (const o of ORDERS) {
				try {
					blockRange(captainText, o.block);
					for (const marker of markers(o.block)) {
						const name = marker.slice(5, -4);
						if (captainText.split(name).length - 1 !== countLines(captainText, marker)) {
							report.error(`${captain} mentions ${name} outside its marker line — the orders installer would misread it; reword it and re-run`);
						}
					}
				} catch (e) {
					report.error(`${captain}: ${e.message} — remove the partial block and re-run`);
				}
			}
		},

		paths: () => (mateHome ? [mateHome, captain] : []),

		describe: () => ORDERS.map((o) => `run ${o.script} (marked block ${o.block} in ${captain})`),

		install(m, report, checkpoint) {
			const state = recordCaptain(m);
			for (const o of ORDERS) {
				const pre = readText(captain) ?? '';
				if (!ourBlock(m, o.block) && !blockRange(pre, o.block)) add(m, markedBlockIntent(captain, o.block, pre));
				for (const p of o.creates(mateHome)) if (!lexists(p)) ensure(m, beadsDbItem(p), (i) => i.path === p);
				checkpoint();
				const r = run(ctx, 'bash', [o.script]);
				const post = readText(captain) ?? '';
				const item = ourBlock(m, o.block);
				if (item?.at) {
					if (blockRange(post, o.block)) replace(m, item, markedBlockItem(captain, o.block, blockBefore(post, item)));
					else drop(m, item);
				}
				for (const i of items(m, 'beads-db', (i) => !lexists(i.path))) drop(m, i);
				if (r.status !== 0) {
					report.error(`${o.script} failed (exit ${r.status})`);
					break;
				}
			}
			settleCaptain(m, state);
		},
	};
}
