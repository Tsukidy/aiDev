// The runtime targets the installer knows (spec #11 D5: only Claude Code is
// implemented; pi and omp are later tickets). Adding one is adding a module
// that returns an object with this contract, and listing it here:
//
//   name                   the skills CLI agent name (`-a <name>`), recorded on its skill items
//   label                  how messages name the runtime
//   paths()                every path it writes itself (checked inside $HOME, parents tracked)
//   preconditions(report)  read-only checks; report.error() stops the install before any write
//   planSkills(m, desired) → { desired, add, remove, collisions } for its skills directory
//   describe(plan)         the --dry-run lines
//   install(m, plan, report)  do it, recording every item in the manifest m
//   stripHookEntry(settings, item)  reverse one of its hook-entry items (uninstall)
//
// Everything else install and uninstall do (orders, plugin, licenses,
// manifest, directories) is runtime-neutral.

import { claudeCodeTarget } from './claude-code-target.mjs';

const FACTORIES = { 'claude-code': claudeCodeTarget };

export const installTargets = (ctx) => Object.values(FACTORIES).map((make) => make(ctx));
export const targetByName = (ctx, name) => FACTORIES[name]?.(ctx);
