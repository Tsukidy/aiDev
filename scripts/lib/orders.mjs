// The orders step of install (8a): the two orders installers, each appending
// its own marked block to the first mate's data/captain.md, the beads one
// also creating the mate's home memory database. A subset of the Paseo
// plugins step's contract (paseo-plugins.mjs): runtime-neutral, outside
// the target registry, no plan, and nothing to reverse of its own, since
// uninstall strips the recorded blocks and removes the recorded beads-db
// paths itself:
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

import { join } from 'node:path';
import {
	ONBOARDING_PLUGIN_DIR,
	REPO,
	blockBefore,
	blockRange,
	countLines,
	discardBackup,
	lexists,
	markers,
	noteSharedFile,
	prepareSharedWrite,
	readText,
	resolveMateHome,
	run,
} from './aidev-install.mjs';
import { add, backupOf, beadsDbItem, drop, ensure, first, items, markedBlockIntent, markedBlockItem, partsIn, replace, sharedFile } from './manifest.mjs';

// What bd init --quiet --stealth creates in a non-git home
// (docs/research/beads-cli-memory-surface.md A2): its store, a gate lock, and
// a git repository.
const BEADS_CREATED_NAMES = ['.beads', '.beads.gate.lock', '.git'];
// What both scripts write first to a captain.md they create.
const HEADER = '# Standing orders\n\n';

// Each script, the block it appends, and the beads database its call may
// create in the mate home: the beads installer runs bd init when .beads is absent.
const ORDERS = [
	{ script: join(REPO, 'scripts', 'install-standing-orders.sh'), block: 'aidev-standing-orders', beadsDb: () => [] },
	{
		script: join(ONBOARDING_PLUGIN_DIR, 'install-captain-orders.sh'),
		block: 'paseo-beads-onboarding',
		beadsDb: (home) => (lexists(join(home, '.beads')) ? [] : BEADS_CREATED_NAMES.map((n) => join(home, n))),
	},
];

export function ordersStep(ctx) {
	let mateHome = null;
	let captain = null;
	const ourBlock = (m, id) => first(m, 'marked-block', (i) => i.path === captain && i.id === id);

	// captain.md's shared record and backup, written before the first script
	// so a killed run leaves them, and taken back after when nothing of ours
	// is recorded in the file and no script of any run has changed it (an
	// upgrade of a block that is not ours marks the record changedByInstall):
	// then the backup has nothing of the install's to undo, and a change since
	// a killed run is the operator's.
	const recordCaptain = (m, checkpoint) => prepareSharedWrite(ctx, m, checkpoint, captain, 'text');
	function settleCaptain(m, existed) {
		if (partsIn(m, captain).length || sharedFile(m, captain).changedByInstall) return noteSharedFile(m, captain, existed);
		drop(m, sharedFile(m, captain));
		const b = backupOf(m, captain);
		if (b) discardBackup(m, b);
	}

	return {
		preconditions(report) {
			mateHome = resolveMateHome(ctx);
			if (!mateHome) return report.error(`first mate home not found under ${ctx.paseoHome} — launch the first mate once so its home exists (or set PASEO_HOME)`);
			captain = join(mateHome, 'data', 'captain.md');
			const captainText = readText(captain);
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
			const existed = recordCaptain(m, checkpoint);
			for (const o of ORDERS) {
				const pre = readText(captain) ?? '';
				const ours = ourBlock(m, o.block);
				if (!blockRange(pre, o.block)) {
					// Anchored at what the file holds now, an intent a killed run left
					// too: what came in since (the operator's line, an upgrade of the
					// block before) is not the script's to be removed with its block.
					// A file the install created that holds only the header is
					// anchored at its start: the header is the script's, written by a
					// run that was killed or failed before the block.
					const anchor = !existed && pre === HEADER ? '' : pre;
					if (!ours) add(m, markedBlockIntent(captain, o.block, anchor));
					else if (ours.at) replace(m, ours, markedBlockIntent(captain, o.block, anchor));
				}
				for (const p of o.beadsDb(mateHome)) if (!lexists(p)) ensure(m, beadsDbItem(p), (i) => i.path === p);
				checkpoint();
				const r = run(ctx, 'bash', [o.script]);
				const post = readText(captain) ?? '';
				if (post !== pre) sharedFile(m, captain).changedByInstall = true;
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
			settleCaptain(m, existed);
		},
	};
}
