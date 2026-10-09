// Tests for the plugin's workspace.created handler — the primary seam from the
// spec ("Testing Decisions"): the handler is invoked directly with a stub Paseo
// API client, a stub `bd` executable on PATH, and a real temporary filesystem
// with real git repositories. Only externally observable behavior is asserted:
// the exact bd invocations (arguments, working directory, count), the filesystem
// outcome, and the degrade posture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let stubsDir;
let callLog;
let sandbox;

before(() => {
	sandbox = mkdtempSync(join(tmpdir(), "beads-onboarding-"));
	stubsDir = join(sandbox, "stubs");
	callLog = join(sandbox, "bd-calls.log");
	mkdirSync(stubsDir);
	writeFileSync(callLog, "");
	// The stub records every invocation (subcommand + cwd) and stands in for the
	// store: `.beads-initialized` at the cwd is the initialized marker, exactly
	// the way the real `.beads/` is what the initialized-check sniffs out.
	// STUB_READY_EXIT / STUB_INIT_EXIT inject failures ("" = default behavior).
	writeFileSync(
		join(stubsDir, "bd"),
		`#!/usr/bin/env bash
echo "\$1|\$*|\$PWD" >> "\$STUB_CALL_LOG"
case "\$1" in
ready)
	[ -n "\$STUB_READY_EXIT" ] && exit "\$STUB_READY_EXIT"
	[ -f ".beads-initialized" ]
	exit \$?
	;;
init)
	[ -n "\$STUB_INIT_EXIT" ] && exit "\$STUB_INIT_EXIT"
	touch ".beads-initialized"
	exit \$?
	;;
*)
	exit 0
	;;
esac
`,
	);
	execFileSync("chmod", ["+x", join(stubsDir, "bd")]);
	mkdirSync(join(sandbox, "empty-path-bin"));
});

after(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

const { createOnboardingHandler } = await import(join(here, "..", "index.server.ts"));

function git(cwd, ...args) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function freshRepo(name) {
	const repo = join(sandbox, name);
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "README.md"), "# test\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "seed");
	return repo;
}

function calls() {
	return readFileSync(callLog, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => line.split("|"));
}

function resetCalls() {
	writeFileSync(callLog, "");
}

function stubPaseo(projects) {
	return { projects: { list: async () => ({ projects }) } };
}

function fakeLog() {
	const lines = { warn: [], log: [] };
	return {
		log: (...args) => lines.log.push(args.join(" ")),
		warn: (...args) => lines.warn.push(args.join(" ")),
		lines,
	};
}

function event(projectId, cwd) {
	return { id: `ws-${projectId}`, projectId, cwd, name: null, archivedAt: null };
}

const project = (projectId, rootPath) => ({ projectId, projectRootPath: rootPath });

/** Run fn with the stub bd first on PATH; restores process.env afterwards. */
async function withStubBd(fn, { readyExit = "", initExit = "" } = {}) {
	const saved = { ...process.env };
	process.env.PATH = `${stubsDir}:${process.env.PATH}`;
	process.env.STUB_CALL_LOG = callLog;
	process.env.STUB_READY_EXIT = readyExit;
	process.env.STUB_INIT_EXIT = initExit;
	try {
		return await fn();
	} finally {
		process.env = saved;
	}
}

/** Run one handler invocation with the stub bd first on PATH. */
async function onboard({ projects, workspace, readyExit = "", initExit = "" }) {
	const log = fakeLog();
	await withStubBd(
		() =>
			createOnboardingHandler(log)(
				{ workspace },
				{ paseo: stubPaseo(projects), signal: new AbortController().signal },
			),
		{ readyExit, initExit },
	);
	return log;
}

test("fresh base: ready-check then init --quiet, both at the base, nothing written beyond what init produces", async () => {
	const base = freshRepo("fresh-base");
	resetCalls();
	const log = await onboard({ projects: [project("proj-a", base)], workspace: event("proj-a", base) });

	assert.deepEqual(
		calls(),
		[
			["ready", "ready", base],
			["init", "init --quiet", base],
		],
		"exactly one `bd ready` then one `bd init --quiet`, both with the base as working directory",
	);
	assert.ok(existsSync(join(base, ".beads-initialized")), "the store marker exists at the base");
	// No writes beyond what bd init itself produces: the only new untracked path is
	// the stub's marker, and the handler made no commit of its own.
	assert.deepEqual(
		git(base, "status", "--porcelain").trim().split("\n").filter(Boolean),
		["?? .beads-initialized"],
	);
	assert.equal(git(base, "rev-list", "--count", "HEAD").trim(), "1", "no plugin-owned commits");
	assert.equal(log.lines.warn.length, 0);
});

test("worktree-cwd event resolves the base, not the worktree", async () => {
	const base = freshRepo("worktree-base");
	const wt = join(sandbox, "wt-a");
	execFileSync("git", ["-C", base, "worktree", "add", "-q", wt, "-b", "crew-1"]);
	resetCalls();

	await onboard({ projects: [project("proj-wt", base)], workspace: event("proj-wt", wt) });

	assert.deepEqual(
		calls(),
		[
			["ready", "ready", base],
			["init", "init --quiet", base],
		],
		"bd runs at the base even though the event's cwd is the worktree",
	);
	assert.ok(existsSync(join(base, ".beads-initialized")));
	assert.equal(existsSync(join(wt, ".beads-initialized")), false, "nothing lands in the worktree");
});

test("concurrent workspace.created events for one project initialize exactly once", async () => {
	const base = freshRepo("concurrent");
	resetCalls();
	const handler = createOnboardingHandler(fakeLog());
	const context = { paseo: stubPaseo([project("proj-c", base)]), signal: new AbortController().signal };
	await withStubBd(async () => {
		// Fire both without awaiting the first: the race the dedup exists for.
		await Promise.all([
			handler({ workspace: event("proj-c", base) }, context),
			handler({ workspace: event("proj-c", base) }, context),
		]);
	});

	assert.equal(calls().filter(([subcommand]) => subcommand === "init").length, 1, "exactly one init");
	assert.equal(calls().filter(([subcommand]) => subcommand === "ready").length, 1, "exactly one ready-check");
	assert.ok(existsSync(join(base, ".beads-initialized")));
});

test("already-initialized base is a no-op: ready-check only, no init", async () => {
	const base = freshRepo("initialized");
	writeFileSync(join(base, ".beads-initialized"), "");
	resetCalls();

	await onboard({ projects: [project("proj-d", base)], workspace: event("proj-d", base) });

	assert.deepEqual(calls(), [["ready", "ready", base]], "ready-check ran, init did not");
});

test("second workspace event for an onboarded project is a no-op (dedup by project id)", async () => {
	const base = freshRepo("dedup");
	resetCalls();
	const handler = createOnboardingHandler(fakeLog());
	const context = { paseo: stubPaseo([project("proj-e", base)]), signal: new AbortController().signal };
	await withStubBd(() => handler({ workspace: event("proj-e", base) }, context));
	resetCalls();
	await withStubBd(() => handler({ workspace: event("proj-e", join(sandbox, "wt-e")) }, context));

	assert.deepEqual(calls(), [], "an onboarded project is never touched again");
});

test("absent bd degrades to a logged warning: no throw, no init attempted", async () => {
	const base = freshRepo("no-bd");
	resetCalls();
	const log = fakeLog();
	const saved = { ...process.env };
	// PATH with neither the stub nor any real bd.
	process.env.PATH = join(sandbox, "empty-path-bin");
	delete process.env.STUB_CALL_LOG;
	try {
		await createOnboardingHandler(log)(
			{ workspace: event("proj-f", base) },
			{ paseo: stubPaseo([project("proj-f", base)]), signal: new AbortController().signal },
		);
	} finally {
		process.env = saved;
	}

	assert.deepEqual(calls(), [], "no bd invocation was possible");
	assert.equal(existsSync(join(base, ".beads-initialized")), false);
	assert.equal(log.lines.warn.length, 1, "exactly one warning");
	assert.match(log.lines.warn[0], /bd not found/);
});

test("failed init degrades to a warning and the project retries on its next event", async () => {
	const base = freshRepo("init-fails");
	const log = fakeLog();
	// One handler instance: the retry only means something within one process.
	const handler = createOnboardingHandler(log);
	const context = { paseo: stubPaseo([project("proj-g", base)]), signal: new AbortController().signal };

	resetCalls();
	await withStubBd(() => handler({ workspace: event("proj-g", base) }, context), { initExit: "3" });
	assert.deepEqual(calls(), [
		["ready", "ready", base],
		["init", "init --quiet", base],
	]);
	assert.equal(existsSync(join(base, ".beads-initialized")), false, "the failed init produced no store");
	assert.match(log.lines.warn.join("\n"), /bd init failed/);

	// The failed project must not be in the completed set: the next event retries.
	resetCalls();
	await withStubBd(() => handler({ workspace: event("proj-g", base) }, context));
	assert.deepEqual(calls(), [
		["ready", "ready", base],
		["init", "init --quiet", base],
	]);
	assert.ok(existsSync(join(base, ".beads-initialized")), "the retry succeeded");
});

test("failed initialized-check logs a warning and does NOT attempt init", async () => {
	const base = freshRepo("ready-fails");
	resetCalls();
	const log = await onboard({ projects: [project("proj-h", base)], workspace: event("proj-h", base), readyExit: "127" });

	assert.deepEqual(calls(), [["ready", "ready", base]], "no init after a broken ready-check");
	assert.equal(existsSync(join(base, ".beads-initialized")), false);
	assert.match(log.lines.warn.join("\n"), /bd ready failed/);
});

test("unknown project id (absent from the Paseo project list) warns and runs nothing", async () => {
	const base = freshRepo("unknown-project");
	resetCalls();
	const log = await onboard({ projects: [], workspace: event("proj-x", base) });

	assert.deepEqual(calls(), [], "no bd invocation without a resolvable base");
	assert.match(log.lines.warn.join("\n"), /proj-x.*not found/);
});
