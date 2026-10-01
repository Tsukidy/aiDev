#!/usr/bin/env node
// Adds the `pi` and `omp` terminal-activity providers to Paseo's agent-hook
// provider registry, so the TUI's existing status dots and attention
// notifications work for them exactly as they do for the built-in agents
// (claude, codex, opencode).
//
// The registry is the sanctioned extension point: this patch adds one provider
// module per agent plus registration, and touches nothing else — no edits to
// the generic hook CLI or daemon bootstrap.
//
//   Usage:  node paseo-agent-hooks-patch.mjs [<path-to-@getpaseo/server>]
//   Env:    PASEO_SERVER_PKG_DIR — fallback for the positional argument
//
// The patch is idempotent (a second application is a no-op) and anchor-based:
// when the installed server package's layout does not match what was verified,
// it exits non-zero with instructions instead of half-applying.
//
// Verified against @getpaseo/server 0.10.2 (npm, published 2026-09-29).

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERIFIED_SERVER_VERSION = "0.10.2";
const REGISTRY_RELATIVE_PATH = join(
  "dist",
  "server",
  "terminal",
  "agent-hooks",
  "provider-registry.js",
);
const REGISTRY_DIR = dirname(REGISTRY_RELATIVE_PATH);

// One entry per provider added by this patch; every per-provider piece (the
// copied module, its registry import, its AGENT_HOOK_PROVIDERS entry) derives
// from this table so providers cannot drift apart.
const PROVIDERS = [
  { id: "pi", moduleRelativePath: join("pi", "pi.js") },
  { id: "omp", moduleRelativePath: join("omp", "omp.js") },
].map(({ id, moduleRelativePath }) => ({
  id,
  moduleRelativePath,
  importLine: `import { ${id}AgentHookProvider } from "./${id}/${id}.js";`,
  entryLine: `    [${id}AgentHookProvider.id]: ${id}AgentHookProvider,`,
}));

// Anchors in the unpatched registry. Both must occur exactly once; if they do
// not, the package layout has drifted past the verified shape and the build
// must stop rather than half-patch.
const IMPORT_ANCHOR =
  'import { opencodeAgentHookProvider } from "./opencode/opencode.js";';
const ENTRY_ANCHOR =
  "    [opencodeAgentHookProvider.id]: opencodeAgentHookProvider,";
// Presence of the first provider's import is the idempotence marker for an
// applied patch.
const APPLIED_MARKER = PROVIDERS[0].importLine;

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

function instructions(serverVersion) {
  return [
    "The @getpaseo/server package layout does not match what this patch was",
    `verified against (verified: ${VERIFIED_SERVER_VERSION}; found: ${serverVersion}).`,
    "",
    "Do not try to force the patch through. Either:",
    `  1. Pin the base image's @getpaseo/server to ${VERIFIED_SERVER_VERSION}, or`,
    "  2. Re-derive the anchors: open",
    `        <server pkg>/${REGISTRY_RELATIVE_PATH}`,
    "     locate the opencode import line and the AGENT_HOOK_PROVIDERS entry",
    "     for opencode, and update IMPORT_ANCHOR / ENTRY_ANCHOR in",
    "     paseo-agent-hooks-patch.mjs to match before re-running.",
  ].join("\n");
}

function resolveServerPackageDir() {
  const candidate = process.argv[2] ?? process.env.PASEO_SERVER_PKG_DIR;
  if (candidate) {
    return resolve(candidate);
  }
  // No explicit path: try the global npm root, where Paseo images install the
  // server package.
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const guess = join(globalRoot, "@getpaseo", "server");
    if (existsSync(guess)) {
      return guess;
    }
  } catch {
    // Fall through to the error below.
  }
  fail(
    [
      "Could not locate the @getpaseo/server package.",
      "",
      "Pass its directory explicitly:",
      "  node paseo-agent-hooks-patch.mjs /path/to/node_modules/@getpaseo/server",
      "",
      "or set PASEO_SERVER_PKG_DIR.",
    ].join("\n"),
  );
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function syntaxCheck(execPath, file) {
  // `node --check` syntax-checks without executing; it honors the package's
  // `type: "module"`, so ESM files check cleanly.
  execFileSync(execPath, ["--check", file], { stdio: "pipe" });
}

async function smokeImport(serverPkgDir) {
  const registryPath = join(serverPkgDir, REGISTRY_RELATIVE_PATH);
  let registry;
  try {
    registry = await import(pathToFileURL(registryPath).href);
  } catch (error) {
    fail(
      `Patched registry failed to import: ${error?.message ?? error}\n` +
        "The patch did not apply cleanly; restore the original file and re-run.",
    );
  }
  const providers = registry.AGENT_HOOK_PROVIDERS ?? {};
  for (const { id } of PROVIDERS) {
    const provider = providers[id];
    if (
      !provider ||
      provider.id !== id ||
      !Array.isArray(provider.events) ||
      provider.events.length === 0 ||
      typeof provider.resolveActivity !== "function" ||
      provider.install?.kind !== "plugin-file" ||
      typeof provider.install.source !== "string" ||
      provider.install.source.length === 0
    ) {
      fail(
        `Provider "${id}" is not registered correctly after patching ` +
          "(missing from AGENT_HOOK_PROVIDERS or malformed). " +
          "Restore the original file and re-run.",
      );
    }
  }
  return Object.keys(providers);
}

async function main() {
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const serverPkgDir = resolveServerPackageDir();

  const packageJsonPath = join(serverPkgDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    fail(
      `No package.json at ${packageJsonPath} — pass the directory of the ` +
        "@getpaseo/server package (the one containing package.json).",
    );
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== "@getpaseo/server") {
    fail(
      `Expected @getpaseo/server at ${serverPkgDir}, found "${packageJson.name}".`,
    );
  }
  const serverVersion = packageJson.version ?? "unknown";
  if (serverVersion !== VERIFIED_SERVER_VERSION) {
    process.stderr.write(
      `WARNING: @getpaseo/server ${serverVersion} is not the verified ` +
        `${VERIFIED_SERVER_VERSION}. Anchors will still be checked exactly;\n` +
        "if they no longer match, the patch fails below.\n\n",
    );
  }

  const registryPath = join(serverPkgDir, REGISTRY_RELATIVE_PATH);
  if (!existsSync(registryPath)) {
    process.stderr.write(instructions(serverVersion) + "\n");
    fail(`Missing expected registry file: ${registryPath}`);
  }
  const registrySource = readFileSync(registryPath, "utf8");

  const providerSources = PROVIDERS.map(
    ({ id }) => join(scriptDir, "providers", `${id}.js`),
  );
  for (const file of providerSources) {
    if (!existsSync(file)) {
      fail(`Required provider module missing next to this script: ${file}`);
    }
  }

  const registryAlreadyPatched = registrySource.includes(APPLIED_MARKER);
  if (!registryAlreadyPatched) {
    for (const [name, anchor] of [
      ["import", IMPORT_ANCHOR],
      ["entry", ENTRY_ANCHOR],
    ]) {
      const occurrences = countOccurrences(registrySource, anchor);
      if (occurrences !== 1) {
        process.stderr.write(instructions(serverVersion) + "\n");
        fail(
          `Anchor check failed: the opencode ${name} anchor occurs ` +
            `${occurrences} times (expected exactly once) in ` +
            `${REGISTRY_RELATIVE_PATH}.`,
        );
      }
    }
  }

  // Write the provider modules. Same bytes on every run, so re-running is
  // harmless even when the registry itself is already patched.
  const providerDests = PROVIDERS.map(
    ({ moduleRelativePath }) => join(serverPkgDir, REGISTRY_DIR, moduleRelativePath),
  );
  for (const [dest, source] of providerDests.map((dest, i) => [dest, providerSources[i]])) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
  }

  if (registryAlreadyPatched) {
    console.log(
      "Registry already patched — provider modules refreshed, registry untouched.",
    );
  } else {
    const patched = registrySource
      .replace(
        IMPORT_ANCHOR,
        [IMPORT_ANCHOR, ...PROVIDERS.map(({ importLine }) => importLine)].join("\n"),
      )
      .replace(
        ENTRY_ANCHOR,
        [ENTRY_ANCHOR, ...PROVIDERS.map(({ entryLine }) => entryLine)].join("\n"),
      );
    writeFileSync(registryPath, patched);
    console.log(`Patched ${registryPath}`);
  }

  // Hard gates before declaring success: output must be syntax-clean and the
  // patched registry must import and expose both providers.
  for (const file of [registryPath, ...providerDests]) {
    syntaxCheck(process.execPath, file);
  }
  const registeredIds = await smokeImport(serverPkgDir);
  console.log(`Smoke import OK — providers registered: ${registeredIds.join(", ")}`);
  console.log(
    "\nDone. Enable the hooks live via the daemon's Terminals setting " +
      "(terminal agent hooks); toggling it on installs the hook files into " +
      "the pi and omp config directories.",
  );
}

main().catch((error) => {
  fail(error?.stack ?? String(error));
});
