// firstmate-beads-onboarding — one beads memory database per project, at the base
// checkout, before any agent of the first-mate fleet can write memory anywhere.
//
// Design of record: docs/beads-memory-workflow.md in the aiDev repository; spec:
// Tsukidy/aiDev issue #10. The plugin is the deterministic half of the design: it
// subscribes to exactly one lifecycle event, workspace.created, and guarantees the
// project's store exists at the project's base checkout. The behavioral half —
// where memories go and what shape they take — lives in the mate's standing orders
// (install-captain-orders.sh) and is never this plugin's business.
//
// Handler contract (spec: "Handler contract"):
// - Dedup: per-process map keyed by project id, distinguishing in-flight from
//   completed. Concurrent workspace.created events for one project yield exactly
//   one initialization; a second worktree event for an already-onboarded project
//   is a no-op; a failed initialization leaves the project retryable on its next
//   event.
// - Root resolution: the base comes from the Paseo API's project record
//   (projectRootPath), never from the event payload's cwd, which for crewmate
//   worktrees is the worktree, not the base.
// - Initialization: `bd ready` (exit 0 = initialized) with the base as working
//   directory; uninitialized projects get `bd init --quiet` there. Full init,
//   never --skip-agents: the agent-facing files it writes are what make memory
//   conventions discoverable in worktrees and clones. Init commits the scaffolding
//   itself; this plugin performs no git operations and writes no files.
// - Failure posture: absent bd, a failed initialized-check, or a failed init each
//   log a warning and return without throwing. The standing orders are the
//   behavioral safety net ("no database found" → report blocked, never
//   self-initialize).
import { execFile } from "node:child_process";
import type { PluginHookContext, PluginHookWorkspace, PluginServerContext } from "@getpaseo/plugin/server";
type PaseoApi = PluginHookContext["paseo"];

export type WorkspaceCreatedEvent = { workspace: PluginHookWorkspace };
export type WorkspaceCreatedContext = PluginHookContext;

export function createOnboardingHandler(log: Pick<Console, "log" | "warn"> = console) {
	// Project ids that onboarded successfully this process — never initialized twice.
	const completed = new Set<string>();
	// Project ids whose onboarding is running right now — concurrent events join it.
	const inFlight = new Map<string, Promise<void>>();

	return async function onWorkspaceCreated(event: WorkspaceCreatedEvent, context: WorkspaceCreatedContext): Promise<void> {
		const projectId = event.workspace.projectId;
		if (completed.has(projectId)) return;
		const running = inFlight.get(projectId);
		if (running) return running;

		const task = onboard(event.workspace, context.paseo, context.signal, log)
			.then(
				(onboarded) => {
					if (!onboarded) return; // degraded: leave retryable for the project's next event
					completed.add(projectId);
				},
				(error) => log.warn(`[firstmate-beads-onboarding] onboarding of project ${projectId} failed; will retry on its next workspace event: ${describe(error)}`),
			)
			.finally(() => inFlight.delete(projectId));
		inFlight.set(projectId, task);
		return task;
	};
}

/**
 * Onboard one project. Returns true when the project is onboarded for good
 * (initialized now, or already initialized) and false when onboarding degraded
 * — a degraded project stays retryable for its next workspace event.
 */
async function onboard(workspace: PluginHookWorkspace, paseo: PaseoApi, signal: AbortSignal, log: Pick<Console, "log" | "warn">): Promise<boolean> {
	const base = await resolveProjectRoot(workspace.projectId, paseo);

	const ready = await run("bd", ["ready"], base, signal);
	if (ready.kind === "absent") {
		log.warn(`[firstmate-beads-onboarding] bd not found on PATH — cannot onboard ${base}; the mate's standing orders cover the gap (report blocked, never self-initialize)`);
		return false;
	}
	// bd ready is the initialized-check: exit 0 means initialized, exit 1 means
	// uninitialized (its documented answer, stderr under --json included). Any
	// other exit is a check we cannot read an answer out of — degrade, don't init.
	const uninitialized = ready.kind === "failed" && ready.exit === 1;
	if (!uninitialized) {
		if (ready.kind === "ok") {
			log.log(`[firstmate-beads-onboarding] beads already initialized at ${base} — nothing to do`);
			return true;
		}
		log.warn(`[firstmate-beads-onboarding] bd ready failed in ${base} (exit ${ready.exit}): ${ready.stderr.trim()} — skipping init; will retry on the next workspace event`);
		return false;
	}

	const init = await run("bd", ["init", "--quiet"], base, signal);
	if (init.kind === "absent") {
		log.warn(`[firstmate-beads-onboarding] bd not found on PATH — cannot onboard ${base}; the mate's standing orders cover the gap (report blocked, never self-initialize)`);
		return false;
	}
	if (init.kind === "failed") {
		log.warn(`[firstmate-beads-onboarding] bd init failed in ${base} (exit ${init.exit}): ${init.stderr.trim()} — will retry on the next workspace event`);
		return false;
	}
	log.log(`[firstmate-beads-onboarding] onboarded ${base}: project memory database initialized (scaffolding committed by bd itself)`);
	return true;
}

/** The project's base checkout, resolved through the Paseo API — never the event's cwd. */
async function resolveProjectRoot(projectId: string, paseo: PaseoApi): Promise<string> {
	const { projects } = await paseo.projects.list();
	const project = projects.find((candidate) => candidate.projectId === projectId);
	if (!project) throw new Error(`project ${projectId} not found in the Paseo project list`);
	return project.projectRootPath;
}

type RunResult =
	| { kind: "absent" }
	| { kind: "failed"; exit: number; stderr: string }
	| { kind: "ok" };

/** Run a command in a directory; never throws — every outcome is a typed result. */
function run(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(command, args, { cwd, signal, encoding: "utf8" }, (error, _stdout, stderr) => {
			if (error === null) {
				resolve({ kind: "ok" });
				return;
			}
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				resolve({ kind: "absent" });
				return;
			}
			// A number is the process's exit status; anything else (abort signal,
			// spawn failure) is a failure we cannot read an answer out of.
			resolve(
				typeof code === "number"
					? { kind: "failed", exit: code, stderr: String(stderr) }
					: { kind: "failed", exit: -1, stderr: String(stderr || error) },
			);
		});
	});
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function contribute(server: PluginServerContext) {
	const onWorkspaceCreated = createOnboardingHandler();
	server.on("workspace.created", onWorkspaceCreated);
	return () => {};
}
