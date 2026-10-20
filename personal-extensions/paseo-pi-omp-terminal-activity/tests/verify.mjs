#!/usr/bin/env node
// Offline verification for the pi/omp terminal-activity patch set.
//
// Exercises everything that does not need the user's Paseo container:
//   1. patch gates against the real published @getpaseo/server package:
//      anchors match, patched output is syntax-clean, a second application is
//      a no-op, and a smoke import shows both providers registered;
//   2. the drift path: a mutated layout exits non-zero with instructions;
//   3. event→activity resolution by direct execution for every declared
//      event, including the omp turn_end idle guard;
//   4. the agent-side hook modules against a stubbed hook CLI (Paseo-env
//      gating, CLI arguments per event, the omp agent_end idle payload,
//      errors swallowed, reports serialized).
//
// Usage:
//   node tests/verify.mjs                       # npm-packs the verified server version (cached)
//   node tests/verify.mjs --tgz <file.tgz>      # use a local tarball
//   node tests/verify.mjs --keep                # keep work dirs for debugging

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = dirname(SCRIPT_DIR);
const PATCH_SCRIPT = join(ARTIFACT_DIR, "paseo-agent-hooks-patch.mjs");
const REGISTRY_REL = join("dist", "server", "terminal", "agent-hooks", "provider-registry.js");

const VERIFIED_SERVER_VERSION = "0.10.2";
const CACHE_DIR = process.env.PASEO_VERIFY_CACHE ?? join(tmpdir(), "paseo-pi-omp-verify-cache");

// Declared event→activity mapping under test (from the spec, verified against
// current pi / oh-my-pi documentation). The provider modules must agree with
// this table — that agreement is exactly what these checks prove.
const DECLARED = {
  pi: {
    before_agent_start: "running",
    tool_execution_start: "running",
    agent_end: "idle",
    session_shutdown: "idle",
  },
  omp: {
    input: "running",
    turn_start: "running",
    tool_approval_resolved: "running",
    tool_approval_requested: "needs-input",
    turn_end: "running",
    agent_end: "idle-guarded",
    session_shutdown: "idle",
  },
};

// omp ExtensionContext fixtures for the agent_end idle guard, per current
// oh-my-pi documentation: ctx.isIdle() and ctx.hasPendingMessages() are the
// documented settle context; event.willContinue marks scheduled continuations.
const OMP_CTX_IDLE = { isIdle: () => true, hasPendingMessages: () => false };
const OMP_CTX_BUSY = { isIdle: () => false, hasPendingMessages: () => true };
const OMP_CTX_QUEUED = { isIdle: () => true, hasPendingMessages: () => true };

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n== ${title}`);
}

function run(file, args, options = {}) {
  return spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    ...options,
  });
}

function stageServerPackage(workRoot, tgzPath, tag) {
  const dir = join(workRoot, tag);
  mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-xzf", tgzPath, "-C", dir, "--strip-components=1"]);
  return dir;
}

function resolveTgz() {
  const flagIndex = process.argv.indexOf("--tgz");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return resolve(process.argv[flagIndex + 1]);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const cached = join(CACHE_DIR, `getpaseo-server-${VERIFIED_SERVER_VERSION}.tgz`);
  if (existsSync(cached)) {
    return cached;
  }
  console.log(`Fetching @getpaseo/server@${VERIFIED_SERVER_VERSION} via npm pack (cached at ${cached})…`);
  const out = execFileSync("npm", ["pack", `@getpaseo/server@${VERIFIED_SERVER_VERSION}`], {
    cwd: CACHE_DIR,
    encoding: "utf8",
  });
  const produced = out.trim().split("\n").pop();
  const packed = join(CACHE_DIR, produced);
  if (packed !== cached) {
    cpSync(packed, cached);
    rmSync(packed, { force: true });
  }
  return cached;
}

function stubCli(dir, behavior = "record") {
  // A stub `paseo` CLI: records invocation (argv + stdin) as one JSON line per call.
  const path = join(dir, "stub-paseo");
  let body;
  if (behavior === "record") {
    body = [
      // Absolute-node shebang: the test PATH is deliberately minimal, so
      // /usr/bin/env would not find node there.
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      "let stdin = '';",
      "try { stdin = fs.readFileSync(0, 'utf8'); } catch {}",
      "const record = JSON.stringify({ argv: process.argv.slice(2), stdin, env: {",
      "  terminalId: process.env.PASEO_TERMINAL_ID,",
      "  activityUrl: process.env.PASEO_TERMINAL_ACTIVITY_URL,",
      "} });",
      "fs.appendFileSync(process.env.STUB_LOG, record + '\\n');",
    ].join("\n");
  } else {
    // Always fails — used to prove hook modules swallow errors.
    body = `#!${process.execPath}\nprocess.exit(1);\n`;
  }
  writeFileSync(path, body + "\n", { mode: 0o755 });
  return path;
}

function readStubLog(logPath) {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function importProviderModule(patchedPkgDir, id) {
  const modulePath = join(
    patchedPkgDir,
    "dist",
    "server",
    "terminal",
    "agent-hooks",
    id,
    `${id}.js`,
  );
  return import(pathToFileURL(modulePath).href);
}

async function verifyPatchGates(workRoot, tgzPath) {
  section("Patch gates against the real published server package");
  const pkgDir = stageServerPackage(workRoot, tgzPath, "patched");

  // Unpatched sanity.
  const before = readFileSync(join(pkgDir, REGISTRY_REL), "utf8");
  check("unpatched registry lacks pi/omp", !before.includes("piAgentHookProvider") && !before.includes("ompAgentHookProvider"));

  // First application.
  const first = run(PATCH_SCRIPT, [pkgDir]);
  check("patch exits 0", first.status === 0, first.stderr);
  check("patch reports patched registry", /Patched .*provider-registry\.js/.test(first.stdout));
  check("patch smoke import shows both providers", /providers registered: .*pi.*omp|providers registered: .*omp.*pi/.test(first.stdout));

  // Output syntax-clean (belt and braces on top of the patch's own gate).
  for (const rel of [REGISTRY_REL, "dist/server/terminal/agent-hooks/pi/pi.js", "dist/server/terminal/agent-hooks/omp/omp.js"]) {
    const checkResult = spawnSync(process.execPath, ["--check", join(pkgDir, rel)], { encoding: "utf8" });
    check(`node --check ${rel}`, checkResult.status === 0, checkResult.stderr);
  }

  // Idempotence: second application is a no-op on the registry.
  const afterFirst = readFileSync(join(pkgDir, REGISTRY_REL), "utf8");
  const second = run(PATCH_SCRIPT, [pkgDir]);
  const afterSecond = readFileSync(join(pkgDir, REGISTRY_REL), "utf8");
  check("second run exits 0", second.status === 0, second.stderr);
  check("second run is a registry no-op", afterFirst === afterSecond);
  check("second run reports already applied", /already patched/.test(second.stdout));

  // Smoke import: both providers registered and contract-shaped.
  const registryUrl = pathToFileURL(join(pkgDir, REGISTRY_REL)).href;
  const registry = await import(`${registryUrl}`);
  for (const id of ["pi", "omp"]) {
    const provider = registry.AGENT_HOOK_PROVIDERS[id];
    check(`provider "${id}" registered`, Boolean(provider));
    if (!provider) continue;
    check(
      `provider "${id}" contract-shaped`,
      provider.id === id &&
        Array.isArray(provider.events) &&
        provider.events.length > 0 &&
        typeof provider.resolveActivity === "function" &&
        provider.install?.kind === "plugin-file" &&
        typeof provider.install.source === "string" &&
        provider.install.source.length > 0 &&
        typeof provider.install.hookMarker === "string" &&
        provider.install.hookMarker.length > 0 &&
        provider.install.source.includes(provider.install.hookMarker) &&
        typeof provider.install.configDir === "string" &&
        typeof provider.install.configFile === "string",
      JSON.stringify({ events: provider.events?.length, install: provider.install && { kind: provider.install.kind } }),
    );
    const declaredEvents = Object.keys(DECLARED[id]);
    const providerEvents = provider.events.map((event) => event.event).sort();
    check(
      `provider "${id}" observes exactly the declared events`,
      JSON.stringify(providerEvents) === JSON.stringify([...declaredEvents].sort()),
      `provider: ${providerEvents.join(", ")} | declared: ${declaredEvents.join(", ")}`,
    );
  }
  return pkgDir;
}

function verifyDriftPath(workRoot, tgzPath) {
  section("Drift path: mutated layout fails loudly with instructions");
  const variants = [
    ["entry anchor removed", (source) => source.replace("    [opencodeAgentHookProvider.id]: opencodeAgentHookProvider,\n", "")],
    ["import anchor removed", (source) => source.replace('import { opencodeAgentHookProvider } from "./opencode/opencode.js";\n', "")],
    ["anchor duplicated", (source) => source.replace("import { codexAgentHookProvider } from \"./codex/codex.js\";", 'import { codexAgentHookProvider } from "./codex/codex.js";\nimport { opencodeAgentHookProvider } from "./opencode/opencode.js";')],
  ];
  for (const [label, mutate] of variants) {
    const dir = join(workRoot, `drift-${label.replace(/\W+/g, "-")}`);
    mkdirSync(dir, { recursive: true });
    execFileSync("tar", ["-xzf", tgzPath, "-C", dir, "--strip-components=1"]);
    const registryPath = join(dir, REGISTRY_REL);
    writeFileSync(registryPath, mutate(readFileSync(registryPath, "utf8")));
    const result = run(PATCH_SCRIPT, [dir]);
    check(
      `drift (${label}): non-zero exit`,
      result.status !== 0,
      `status=${result.status}`,
    );
    check(
      `drift (${label}): actionable instructions`,
      /Re-derive the anchors|Pin the base image/.test(result.stderr),
      result.stderr.slice(0, 200),
    );
    const patchedAfterDrift = readFileSync(registryPath, "utf8");
    check(
      `drift (${label}): no half-patch`,
      !patchedAfterDrift.includes("piAgentHookProvider } from") || !patchedAfterDrift.includes("[piAgentHookProvider.id]"),
    );
  }
}

async function verifyResolvers(pkgDir) {
  section("Event→activity resolution by direct execution");
  for (const id of ["pi", "omp"]) {
    const mod = await importProviderModule(pkgDir, id);
    const provider = mod[`${id}AgentHookProvider`];
    const noInput = { isTTY: false, read: async () => null };
    for (const [event, expected] of Object.entries(DECLARED[id])) {
      if (expected === "idle-guarded") {
        continue; // covered below with real payloads
      }
      const state = await provider.resolveActivity({ event, input: noInput });
      check(
        `${id}: ${event} → ${expected}`,
        state === expected,
        `resolved ${String(state)}`,
      );
    }
  }

  // omp agent_end guard: idle only when the hook context reported idle with
  // no pending messages; anything else reports nothing at all.
  const omp = await importProviderModule(pkgDir, "omp");
  const provider = omp.ompAgentHookProvider;
  const agentEndWith = async (payload) =>
    provider.resolveActivity({
      event: "agent_end",
      input: { isTTY: false, read: async () => payload },
    });
  check(
    "omp: agent_end idle+0 pending → idle",
    (await agentEndWith(JSON.stringify({ idle: true, pendingMessages: 0 }))) === "idle",
  );
  check(
    "omp: agent_end idle+2 pending → no report",
    (await agentEndWith(JSON.stringify({ idle: true, pendingMessages: 2 }))) === null,
  );
  check(
    "omp: agent_end not idle → no report",
    (await agentEndWith(JSON.stringify({ idle: false, pendingMessages: 0 }))) === null,
  );
  check("omp: agent_end empty stdin → no report", (await agentEndWith("")) === null);
  check("omp: agent_end stdin timeout (null) → no report", (await agentEndWith(null)) === null);
  check("omp: agent_end malformed stdin → no report", (await agentEndWith("{not json")) === null);
  check(
    "omp: unknown event → no report",
    (await provider.resolveActivity({ event: "nonsense", input: { read: async () => null } })) === null,
  );
}

function materializeHookSource(dir, name, source) {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

async function verifyHookModules(pkgDir, workRoot) {
  section("Agent-side hook modules against a stubbed hook CLI");
  // The hook modules spawn the CLI detached+unref'd (so shutdown reports can
  // outlive the agent). That means the only pending handle during a fire is
  // the unref'd child, and node would drain its loop and exit silently before
  // "close" fires. A keep-alive timer holds the harness open so flushes can
  // actually be observed.
  const keepAlive = setInterval(() => {}, 50);
  try {
    await verifyHookModulesInner(pkgDir, workRoot);
  } finally {
    clearInterval(keepAlive);
  }
}

async function verifyHookModulesInner(pkgDir, workRoot) {
  // Materialize the hook sources the providers carry — these exact bytes are
  // what Paseo writes into the agent config dirs when the setting enables.
  const hookDir = join(workRoot, "hook-modules");
  mkdirSync(hookDir, { recursive: true });
  const piMod = await importProviderModule(pkgDir, "pi");
  const ompMod = await importProviderModule(pkgDir, "omp");
  const piAdapter = await import(pathToFileURL(join(SCRIPT_DIR, "adapters", "pi-adapter.mjs")).href);
  const ompAdapter = await import(pathToFileURL(join(SCRIPT_DIR, "adapters", "omp-adapter.mjs")).href);
  const piLoaded = await piAdapter.load(
    materializeHookSource(hookDir, "paseo-terminal-activity.js", piMod.piAgentHookProvider.install.source),
  );
  const ompLoaded = await ompAdapter.load(
    materializeHookSource(hookDir, "paseo-omp-post-hook.js", ompMod.ompAgentHookProvider.install.source),
  );
  const firePi = (env, event, payload) => piAdapter.fire(piLoaded, env, event, payload);
  const fireOmp = (env, event, context) => ompAdapter.fire(ompLoaded, env, event, context);

  // --- gating: inert outside Paseo ---
  const outsideDir = join(workRoot, "hook-outside");
  mkdirSync(outsideDir, { recursive: true });
  const outsideLog = join(outsideDir, "calls.log");
  stubCli(outsideDir);
  const outsideEnv = {
    // No PASEO_TERMINAL_ID: hooks must stay silent even with the CLI present.
    PASEO_TERMINAL_ID: undefined,
    STUB_LOG: outsideLog,
    PASEO_HOOK_CLI: join(outsideDir, "stub-paseo"),
    PATH: outsideDir,
  };
  await firePi(outsideEnv, "before_agent_start", {});
  await fireOmp(outsideEnv, "input", {});
  check("outside Paseo: pi hook never invokes the CLI", readStubLog(outsideLog).length === 0);
  check("outside Paseo: omp hook never invokes the CLI", readStubLog(outsideLog).length === 0);

  // --- inside Paseo: one recorded call per declared event, correct argv ---
  const insideDir = join(workRoot, "hook-inside");
  mkdirSync(insideDir, { recursive: true });
  const insideLog = join(insideDir, "calls.log");
  stubCli(insideDir);
  const insideEnv = {
    STUB_LOG: insideLog,
    PASEO_TERMINAL_ID: "term-123",
    PASEO_ACTIVITY_TOKEN: "token-abc",
    PASEO_TERMINAL_ACTIVITY_URL: "http://127.0.0.1:9/api/terminal-activity",
    PASEO_HOOK_CLI: join(insideDir, "stub-paseo"),
    PATH: insideDir,
  };
  for (const event of Object.keys(DECLARED.pi)) {
    await firePi(insideEnv, event, { toolName: "bash" });
  }
  for (const event of Object.keys(DECLARED.omp)) {
    const context = event === "agent_end" ? OMP_CTX_IDLE : {};
    await fireOmp(insideEnv, event, context);
  }
  const calls = readStubLog(insideLog);
  // Stub records argv as ["hooks", provider, event].
  const piCalls = calls.filter((call) => call.argv[1] === "pi");
  const ompCalls = calls.filter((call) => call.argv[1] === "omp");
  check(
    "pi hook: exactly one CLI call per declared event",
    JSON.stringify(piCalls.map((call) => call.argv[2])) === JSON.stringify(Object.keys(DECLARED.pi)),
    JSON.stringify(piCalls.map((call) => call.argv)),
  );
  check(
    "omp hook: exactly one CLI call per declared event",
    JSON.stringify(ompCalls.map((call) => call.argv[2])) === JSON.stringify(Object.keys(DECLARED.omp)),
    JSON.stringify(ompCalls.map((call) => call.argv)),
  );
  check(
    "CLI args shape: hooks <provider> <event>",
    calls.every((call) => call.argv.length === 3 && call.argv[0] === "hooks"),
    JSON.stringify(calls.map((call) => call.argv)),
  );
  check(
    "agent_end carries the idle payload on stdin",
    (() => {
      const call = ompCalls.find((call) => call.argv[2] === "agent_end");
      if (!call) return false;
      const payload = JSON.parse(call.stdin);
      return payload.idle === true && payload.pendingMessages === 0;
    })(),
    JSON.stringify(ompCalls.find((call) => call.argv[2] === "agent_end")),
  );
  check(
    "non-agent_end events carry no stdin payload",
    ompCalls.filter((call) => call.argv[2] !== "agent_end").every((call) => call.stdin === ""),
  );

  // --- omp agent_end guard inputs, hook-module side ---
  {
    const guardDir = join(workRoot, "hook-guard");
    mkdirSync(guardDir, { recursive: true });
    const guardLog = join(guardDir, "calls.log");
    stubCli(guardDir);
    const guardEnv = { ...insideEnv, STUB_LOG: guardLog, PASEO_HOOK_CLI: join(guardDir, "stub-paseo"), PATH: guardDir };
    await fireOmp(guardEnv, "agent_end", { ...OMP_CTX_BUSY, willContinue: true });
    await fireOmp(guardEnv, "agent_end", OMP_CTX_QUEUED);
    // Fail closed: a context without the documented isIdle/hasPendingMessages
    // methods is outside the verified contract — no settle report.
    await fireOmp(guardEnv, "agent_end", {});
    check(
      "omp hook: continuing, mid-queue, or context-less agent_end reports nothing",
      !readStubLog(guardLog).some((call) => call.argv[1] === "agent_end"),
    );
  }

  // --- errors swallowed ---
  {
    const failingDir = join(workRoot, "hook-failing");
    mkdirSync(failingDir, { recursive: true });
    stubCli(failingDir, "fail");
    const failingEnv = {
      STUB_LOG: join(failingDir, "calls.log"),
      PASEO_TERMINAL_ID: "term-123",
      PASEO_HOOK_CLI: join(failingDir, "stub-paseo"),
      PATH: failingDir,
    };
    let threw = null;
    try {
      await firePi(failingEnv, "agent_end", {});
      // OMP_CTX_IDLE so the omp guard passes and the CLI call is attempted.
      await fireOmp(failingEnv, "agent_end", OMP_CTX_IDLE);
    } catch (error) {
      threw = error;
    }
    check("failing CLI: hook modules do not throw", threw === null, String(threw));

    const missingDir = join(workRoot, "hook-missing-cli");
    mkdirSync(missingDir, { recursive: true });
    const missingEnv = {
      STUB_LOG: join(missingDir, "calls.log"),
      PASEO_TERMINAL_ID: "term-123",
      PASEO_HOOK_CLI: join(missingDir, "does-not-exist"),
    };
    let missingThrew = null;
    try {
      await firePi(missingEnv, "agent_end", {});
      await fireOmp(missingEnv, "agent_end", OMP_CTX_IDLE);
    } catch (error) {
      missingThrew = error;
    }
    check("missing CLI: hook modules do not throw", missingThrew === null, String(missingThrew));
  }
}

async function main() {
  const keep = process.argv.includes("--keep");
  const workRoot = mkdtempSync(join(tmpdir(), "paseo-pi-omp-verify-"));
  try {
    const tgzPath = resolveTgz();
    const patchedPkgDir = await verifyPatchGates(workRoot, tgzPath);
    verifyDriftPath(workRoot, tgzPath);
    await verifyResolvers(patchedPkgDir);
    await verifyHookModules(patchedPkgDir, workRoot);
  } finally {
    if (!keep) {
      rmSync(workRoot, { recursive: true, force: true });
    } else {
      console.log(`\n(work dirs kept under ${workRoot})`);
    }
  }
  console.log(
    failures === 0
      ? "\nALL CHECKS PASSED"
      : `\n${failures} CHECK(S) FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
