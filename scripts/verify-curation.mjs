#!/usr/bin/env node
//
// verify-curation.mjs — offline, deterministic coherence gate for the skill
// source tree (default `skills/`, override as argv[1]). Zero npm dependencies.
// Exit 0 = the tree is a coherent, installable skill set; exit 1 = one report
// line per violation (`<file>:<line>: what (expected ...; actual ...)`).
//
// The reference grammar below was derived by surveying the syntaxes that
// actually occur in this repo's fork tree (skills/) and in the upstream tree
// later curation tickets import from (pstack's plugins/pstack/skills/), not
// invented. Only unambiguous forms are checked, to keep false positives at
// zero on the pre-curation tree:
//
// 1. Skill identity. Every top-level directory under the skills root must
//    contain a SKILL.md (it is a skill or it does not ship). Directory names
//    must be unique case-insensitively, as must the `name:` declared in each
//    SKILL.md's frontmatter.
//
// 2. Frontmatter. Every SKILL.md and every agents/*.md must open with a `---`
//    fenced YAML frontmatter block that parses under the minimal YAML subset
//    these files use in practice (flat `key: value`, `key:` nesting headers,
//    `- ` list items, `#` comments, blank lines) and must declare non-empty
//    `name` and `description`.
//
// 3. Reference syntaxes, scanned in every *.md file. Fenced code blocks are
//    blanked first; markdown links are then scanned outside inline code
//    spans, and inline code spans themselves are the source for path and
//    slash-command references. (Illustrative links in format/template docs
//    live inside fences or code spans — e.g. domain-modeling/CONTEXT-FORMAT.md
//    and setup-ts-deep-modules/SKILL.md — so this blanking is what makes the
//    check exact rather than noisy.)
//
//    a. Slash mentions: a code span whose whole content is `/name` with a
//       skill-shaped name (e.g. `` `/tdd` `` in ask-matt/SKILL.md) must name
//       an existing skill, or a known non-skill built-in (`clear`, `compact`,
//       `settings`, `tmp` — Claude Code CLI commands and plain paths).
//    b. Path-style cross-skill refs: `skills/<name>[/<rest>]` occurring at a
//       token boundary (not preceded by `/`, word char, dot, or hyphen — this
//       excludes URLs like github.com/…/skills/blob/…) in prose or backticks.
//       `<name>` must be a skill; a placeholder-free `<rest>` must resolve
//       from that skill's directory.
//    c. Backticked relative paths. A span starting with `../` (pstack's
//       `../poteto-mode/SKILL.md`, `../references/bugbot-triage.md`) resolves
//       against the containing file's directory and must stay inside the
//       skills root. Otherwise a span naming a skill-internal directory —
//       `(../)*(references|playbooks|scripts|agents)/…` (diagnosing-bugs'
//       `scripts/hitl-loop.template.sh`, poteto-mode's `references/pi-tools.md`,
//       future `agents/<name>.md`) — resolves against the containing skill's
//       root directory. Either way the span must look like a path: it must
//       end in a file extension or a trailing slash, so module import
//       specifiers like `../index` in prose examples stay out of the grammar.
//       Spans containing glob/placeholder chars (`* < ~ {`) are skipped.
//    d. Markdown link targets `](target)`: absolute URLs (scheme:) and
//       in-page anchors (`#…`) are skipped; the `#fragment` is stripped from
//       the rest; the target resolves against the containing file's directory
//       and must exist (file or directory) inside the skills root (targets
//       that escape the root are project files, out of scope). Seen as
//       `tests.md`, `./triage-labels.md`, `../poteto-mode/references/pi-tools.md`.
//    e. Agent references: `subagent_type: "name"` (single-quoted and bare
//       forms too — the syntax pstack's skills use for subagent dispatch) must
//       resolve to a carried agent definition (`name:` frontmatter of some
//       agents/*.md in the tree) or a known harness built-in
//       (`general-purpose`). Values containing `<` are placeholders and
//       skipped. Separately, ZERO `pstack:`-prefixed references are allowed
//       anywhere in the tree, in any file type — later tickets rewrite them,
//       and this verifier enforces that invariant from day one.
//
// 4. Vendored provenance (#24). The tree must carry `pstack-provenance.json`
//    at its top level (a file, so rule 1 does not apply to it): the upstream
//    repository, the pinned commit sha, the full upstream skill list at that
//    sha, every adopted path with its upstream path (a different last segment
//    records a rename), the excluded upstream skills with reasons, and every
//    locally modified vendored file with a reason. Checked: every adopted and
//    modified path exists, and each modified file lies inside an adopted path;
//    every upstream skill is either adopted or excluded; a top-level directory
//    named like an upstream skill is listed as adopted, unless that upstream
//    skill was adopted under a new name (the local skill owns the name); and
//    every NOTICE* link into the upstream repository pins the manifest's sha.
//    Whether the modified list is complete needs the upstream tree, so it is
//    rebuilt by diffing on each re-sync, not checked here.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, basename, isAbsolute } from 'node:path';

const root = resolve(process.argv[2] ?? 'skills');

if (!existsSync(root) || !statSync(root).isDirectory()) {
	console.error(`verify-curation: skills directory not found: ${root}`);
	process.exit(1);
}

const violations = [];

function report(file, line, message) {
	violations.push(`${relative(process.cwd(), file)}:${line}: ${message}`);
}

// --- tree walk ------------------------------------------------------------------

// Dependency directories are local install output, not curated content (e.g.
// poteto-mode's script bootstrap runs `bun install` into its scripts
// directory). Their files are never walked or checked, at any depth. Matched
// by name whatever the entry type, so a symlinked node_modules is skipped
// too; .gitignore keeps them out of git the same way.
const SKIPPED_DIRS = new Set(['node_modules']);

function isSkipped(entry) {
	return SKIPPED_DIRS.has(entry.name);
}

function walk(dir) {
	const entries = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (isSkipped(entry)) continue;
		if (entry.isDirectory()) entries.push(...walk(p));
		else entries.push(p);
	}
	return entries;
}

let files;
try {
	files = walk(root).sort();
} catch (err) {
	console.error(`verify-curation: cannot read tree: ${err.message}`);
	process.exit(1);
}

const textCache = new Map();
function fileText(file) {
	if (!textCache.has(file)) {
		try {
			textCache.set(file, readFileSync(file, 'utf8'));
		} catch (err) {
			// Report per the contract (one line per violation) instead of crashing
			// mid-scan — e.g. a dangling symlink or a permission-denied file.
			textCache.set(file, '');
			report(file, 1, `unreadable file (${err.message})`);
		}
	}
	return textCache.get(file);
}

// Line offsets per file, so every scanner can report a 1-based line number.
const lineStarts = new Map();
function lineOf(file, index) {
	if (!lineStarts.has(file)) {
		const starts = [0];
		const text = fileText(file);
		for (let i = 0; i < text.length; i++) {
			if (text[i] === '\n') starts.push(i + 1);
		}
		lineStarts.set(file, starts);
	}
	const starts = lineStarts.get(file);
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= index) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

// --- frontmatter: minimal YAML subset ----------------------------------------------

// Parses the frontmatter shape these skill files actually use. Returns
// { ok, data, line, error }; `line` points at the offending body line.
// Strip one pair of surrounding quotes so quoted scalars (`name: "foo"`)
// key the same as bare ones — duplicate detection and lookups compare the
// clean value, matching how the YAML-convention frontmatter is meant to read.
function unquote(value) {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function parseFrontmatter(file) {
	const text = fileText(file);
	const lines = text.split('\n');
	if (lines[0].trim() !== '---') {
		return { ok: false, line: 1, error: 'file does not start with a --- frontmatter fence' };
	}
	const data = {};
	let closed = false;
	for (let i = 1; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.replace(/\t/g, '  ');
		if (line.trim() === '---' || line.trim() === '...') {
			closed = true;
			break;
		}
		if (line.trim() === '' || line.trim().startsWith('#')) continue;
		const kv = line.trim().match(/^([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
		if (kv) {
			if (indentOf(line) === 0) data[kv[1]] = unquote(kv[2].trim());
			// Indented lines are nested values; only top-level keys are recorded.
			continue;
		}
		if (line.trim().startsWith('- ')) continue; // list item under the previous key
		return { ok: false, line: i + 1, error: `unparseable frontmatter line: ${raw.trim()}` };
	}
	if (!closed) {
		return { ok: false, line: 1, error: 'frontmatter fence is never closed' };
	}
	return { ok: true, data };
}

function indentOf(line) {
	return line.length - line.trimStart().length;
}

// --- reference grammar helpers -------------------------------------------------------

const SKILL_INTERNAL_DIR = /^(references|playbooks|scripts|agents)\/[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const DOTDOT_RELATIVE = /^(?:\.\.\/)+[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const PLACEHOLDER = /[*<~{}]/;
// A span is treated as a path only when it names a file (extension) or a
// directory (trailing slash); this keeps module import specifiers like
// `../index` in prose examples out of the path grammar.
const LOOKS_LIKE_PATH = /(\.[A-Za-z0-9]+|\/)$/;
const BUILTIN_SLASH = new Set(['clear', 'compact', 'settings', 'tmp']);
const BUILTIN_SUBAGENT = new Set(['general-purpose']);

// Blanks fenced code blocks with same-length space padding so string indices
// (and therefore line numbers) stay valid.
function blankFences(text) {
	return text.replace(/```[\s\S]*?(?:```|$)/g, (block) =>
		block.replace(/[^\n]/g, ' '),
	);
}

// Inline code spans, extracted from fence-blanked text. Scan targets pair each
// text region with its offset into the original string, so match indices map
// back to real line numbers: the fence-blanked text at offset 0, plus every
// code span's content at the span's own offset.
function scanTargets(blanked, spans) {
	return [
		{ text: blanked, baseIndex: 0 },
		...spans.map((span) => ({ text: span.content, baseIndex: span.index })),
	];
}

function extractCodeSpans(blanked) {
	const spans = [];
	const re = /`[^`\n]+`/g;
	let m;
	while ((m = re.exec(blanked)) !== null) {
		spans.push({
			content: m[0].slice(1, -1),
			index: m.index + 1,
		});
	}
	const noSpans = blanked.replace(re, (s) => s.replace(/[^\n]/g, ' '));
	return { spans, noSpans };
}

function stripFragment(target) {
	const hash = target.indexOf('#');
	return hash === -1 ? target : target.slice(0, hash);
}

function isInsideRoot(abs) {
	const rel = relative(root, abs);
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function skillRootOf(file) {
	// The skill's root directory is the first path segment under the skills root.
	const rel = relative(root, dirname(file));
	return rel.split(/[/\\]/)[0];
}

function resolveWithin(base, target) {
	const abs = resolve(base, target);
	if (!isInsideRoot(abs)) return null;
	return existsSync(abs) ? abs : null;
}

// --- pass 1: skill identity + frontmatter ---------------------------------------------

const topDirs = readdirSync(root, { withFileTypes: true })
	.filter((e) => e.isDirectory() && !isSkipped(e))
	.map((e) => e.name)
	.sort();

const dirNamesLower = new Map();
for (const dir of topDirs) {
	const key = dir.toLowerCase();
	if (dirNamesLower.has(key)) {
		report(join(root, dir), 1, `duplicate skill directory name (expected unique; "${dirNamesLower.get(key)}" and "${dir}" collide case-insensitively)`);
	} else {
		dirNamesLower.set(key, dir);
	}
	if (!existsSync(join(root, dir, 'SKILL.md'))) {
		report(join(root, dir), 1, `directory has no SKILL.md (expected ${dir}/SKILL.md to exist; directory is not an installable skill)`);
	}
}

const skillNamesLower = new Map();
const mdFiles = files.filter((f) => f.endsWith('.md'));
const agentFiles = [];

for (const file of mdFiles) {
	const rel = relative(root, file);
	const segs = rel.split(/[/\\]/);
	const isSkillMd = segs.length === 2 && segs[1] === 'SKILL.md';
	const isAgentMd = segs.length === 3 && segs[1] === 'agents' && segs[2].endsWith('.md');
	if (!isSkillMd && !isAgentMd) continue;
	if (isAgentMd) agentFiles.push(file);

	const fm = parseFrontmatter(file);
	if (!fm.ok) {
		report(file, fm.line, `unparseable YAML frontmatter (expected a --- fenced block of key: value lines; ${fm.error})`);
		continue;
	}
	for (const field of ['name', 'description']) {
		if (!fm.data[field] || !fm.data[field].trim()) {
			report(file, 1, `frontmatter is missing a non-empty "${field}" (expected "${field}: ..." in the frontmatter)`);
		}
	}
	if (isSkillMd && fm.data.name) {
		const key = fm.data.name.trim().toLowerCase();
		if (skillNamesLower.has(key)) {
			report(file, 1, `duplicate skill name in frontmatter (expected unique; "${skillNamesLower.get(key)}" and "${fm.data.name}" collide case-insensitively)`);
		} else {
			skillNamesLower.set(key, file);
		}
	}
}

const knownAgentNames = new Set();
for (const file of agentFiles) {
	const fm = parseFrontmatter(file);
	if (fm.ok && fm.data.name) knownAgentNames.add(fm.data.name.trim());
}

function isKnownSkill(name) {
	return dirNamesLower.has(name.toLowerCase()) || skillNamesLower.has(name.toLowerCase());
}

// --- pass 2: reference scanning ---------------------------------------------------------

for (const file of mdFiles) {
	const raw = fileText(file);
	const blanked = blankFences(raw);
	const { spans, noSpans } = extractCodeSpans(blanked);
	const fileDir = dirname(file);
	const skillRoot = join(root, skillRootOf(file));

	// (a) slash-command mentions inside code spans
	for (const span of spans) {
		const m = span.content.match(/^\/([a-z0-9][a-z0-9-]*)$/);
		if (!m) continue;
		if (!BUILTIN_SLASH.has(m[1]) && !isKnownSkill(m[1])) {
			report(file, lineOf(file, span.index), `slash mention "/${m[1]}" does not resolve (expected an existing skill or built-in command; no skill named "${m[1]}" exists)`);
		}
	}

	// (b) path-style cross-skill references, in prose and in code spans
	for (const { text, baseIndex } of scanTargets(noSpans, spans)) {
		const re = /(?<![\w/.\-])skills\/([A-Za-z0-9_-]+)((?:\/[A-Za-z0-9_.-]+)*)/g;
		let m;
		while ((m = re.exec(text)) !== null) {
			const index = baseIndex + m.index;
			const name = m[1];
			if (!isKnownSkill(name)) {
				report(file, lineOf(file, index), `path reference "skills/${name}" does not resolve (expected an existing skill; no skill named "${name}" exists)`);
				continue;
			}
			const rest = m[2];
			if (rest && !PLACEHOLDER.test(rest)) {
				// rest always starts with "/" from the regex; strip it so
				// path.resolve keeps the base instead of discarding it.
				const restPath = rest.replace(/^\/+/, '');
				if (!resolveWithin(join(root, name), restPath)) {
					report(file, lineOf(file, index), `path reference "skills/${name}${rest}" does not resolve (expected ${join(name, restPath)} to exist inside the skills tree)`);
				}
			}
		}
	}

	// (c) backticked relative paths: ../ against the file's directory,
	// skill-internal directories against the skill's root
	for (const span of spans) {
		const target = span.content;
		if (PLACEHOLDER.test(target) || target.includes(' ')) continue;
		if (!LOOKS_LIKE_PATH.test(target)) continue;
		let base;
		if (DOTDOT_RELATIVE.test(target)) base = fileDir;
		else if (SKILL_INTERNAL_DIR.test(target)) base = skillRoot;
		else continue;
		if (!resolveWithin(base, target)) {
			report(file, lineOf(file, span.index), `relative path "${target}" does not resolve (expected ${resolve(base, target)} to exist inside the skills tree)`);
		}
	}

	// (d) markdown link targets, outside code spans
	{
		const re = /\]\(([^)\s]+)\)/g;
		let m;
		while ((m = re.exec(noSpans)) !== null) {
			const original = m[1];
			if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(original)) continue; // scheme: URL
			if (original.startsWith('#')) continue; // in-page anchor
			const target = stripFragment(original);
			if (!target || PLACEHOLDER.test(target)) continue;
			const abs = resolve(fileDir, target);
			if (!isInsideRoot(abs)) continue; // points at project files outside the tree
			if (!existsSync(abs)) {
				report(file, lineOf(file, m.index), `markdown link target "${original}" does not resolve (expected ${abs} to exist inside the skills tree)`);
			}
		}
	}

	// (e) subagent_type references, in prose and in code spans
	for (const { text, baseIndex } of scanTargets(noSpans, spans)) {
		const re = /subagent_type:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/g;
		let m;
		while ((m = re.exec(text)) !== null) {
			const name = m[1] ?? m[2] ?? m[3];
			const index = baseIndex + m.index + m[0].indexOf(name);
			if (name.includes(':')) continue; // namespaced values are covered by the pstack: ban below
			if (PLACEHOLDER.test(name)) continue;
			if (BUILTIN_SUBAGENT.has(name)) continue;
			if (!knownAgentNames.has(name)) {
				report(file, lineOf(file, index), `agent reference "subagent_type: ${name}" does not resolve (expected an agents/*.md definition declaring name: ${name}; known agents: ${knownAgentNames.size ? [...knownAgentNames].join(', ') : 'none'})`);
			}
		}
	}
}

// (e, cont.) zero pstack:-prefixed references anywhere, any file type.
for (const file of files) {
	const text = fileText(file);
	const re = /pstack:[A-Za-z0-9_-]*/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		report(file, lineOf(file, m.index), `forbidden "pstack:"-prefixed reference "${m[0]}" (expected none anywhere in the tree; rewrite as a bare resolvable name)`);
	}
}

// --- pass 3: the pstack provenance manifest (rule 4) ---------------------------------------

const MANIFEST = 'pstack-provenance.json';
const manifestFile = join(root, MANIFEST);
const provenance = checkProvenance();

function checkProvenance() {
	if (!existsSync(manifestFile)) {
		report(manifestFile, 1, `missing provenance manifest (expected ${MANIFEST} at the top of the skills tree; every vendored path must be declared)`);
		return null;
	}
	const text = fileText(manifestFile);
	let m;
	try {
		m = JSON.parse(text);
	} catch (err) {
		report(manifestFile, 1, `unparseable provenance manifest (expected JSON; ${err.message})`);
		return null;
	}
	// The line of a value's first JSON occurrence, for reports that name it.
	const at = (value) => {
		const index = text.indexOf(JSON.stringify(value));
		return index === -1 ? 1 : lineOf(manifestFile, index);
	};
	const fail = (value, message) => report(manifestFile, at(value), message);

	const isString = (v) => typeof v === 'string' && v.trim() !== '';
	const shapeOk =
		m !== null &&
		typeof m === 'object' &&
		isString(m.upstream) &&
		/^[0-9a-f]{40}$/.test(m.sha ?? '') &&
		isString(m.upstreamSkillsDir) &&
		Array.isArray(m.upstreamSkills) &&
		m.upstreamSkills.every(isString) &&
		Array.isArray(m.adopted) &&
		m.adopted.every((a) => a && isString(a.path) && isString(a.upstream)) &&
		Array.isArray(m.excluded) &&
		m.excluded.every((x) => x && isString(x.upstream) && isString(x.reason)) &&
		Array.isArray(m.modified) &&
		m.modified.every((x) => x && isString(x.path) && isString(x.reason));
	if (!shapeOk) {
		report(manifestFile, 1, 'malformed provenance manifest (expected upstream, a 40-hex sha, upstreamSkillsDir, upstreamSkills[name], adopted[{path, upstream}], excluded[{upstream, reason}], modified[{path, reason}])');
		return null;
	}

	// Manifest paths are relative to the skills root and must stay inside it.
	const inTree = (p) => {
		const abs = resolve(root, p);
		return isInsideRoot(abs) && existsSync(abs) ? abs : null;
	};
	const duplicates = (values) => values.filter((v, i) => values.indexOf(v) !== i);

	for (const dup of duplicates(m.adopted.map((a) => a.path))) {
		fail(dup, `adopted path "${dup}" is listed twice (expected each adopted path once)`);
	}
	for (const dup of duplicates(m.modified.map((x) => x.path))) {
		fail(dup, `modified path "${dup}" is listed twice (expected each modified file once)`);
	}

	for (const { path } of m.adopted) {
		if (!inTree(path)) {
			fail(path, `adopted path "${path}" does not exist (expected ${join(root, path)} inside the skills tree)`);
		}
	}

	const adoptedPaths = m.adopted.map((a) => a.path.replace(/\/+$/, ''));
	const underAdopted = (p) => adoptedPaths.some((a) => p === a || p.startsWith(`${a}/`));
	for (const { path } of m.modified) {
		const abs = inTree(path);
		if (!abs || !statSync(abs).isFile()) {
			fail(path, `modified path "${path}" does not exist as a file (expected ${join(root, path)} inside the skills tree)`);
		} else if (!underAdopted(path)) {
			fail(path, `modified path "${path}" is outside every adopted path (expected a file the snapshot vendored)`);
		}
	}

	// Every upstream skill at the pin is adopted (under its own name or a new
	// one) or excluded with a reason, never both and never neither.
	const skillsDir = m.upstreamSkillsDir.replace(/\/+$/, '');
	const upstreamSkillOf = (upstreamPath) =>
		upstreamPath.startsWith(`${skillsDir}/`) ? upstreamPath.slice(skillsDir.length + 1).replace(/\/+$/, '') : null;
	const adoptedAs = new Map(); // upstream skill name -> local path
	for (const a of m.adopted) {
		const name = upstreamSkillOf(a.upstream);
		if (name !== null) adoptedAs.set(name, a.path.replace(/\/+$/, ''));
	}
	const excluded = new Set(m.excluded.map((x) => upstreamSkillOf(x.upstream) ?? x.upstream));
	for (const name of m.upstreamSkills) {
		if (adoptedAs.has(name) && excluded.has(name)) {
			fail(name, `upstream skill "${name}" is both adopted and excluded (expected one)`);
		} else if (!adoptedAs.has(name) && !excluded.has(name)) {
			fail(name, `upstream skill "${name}" is neither adopted nor excluded (expected an adopted entry or an excluded entry with a reason)`);
		}
	}
	for (const name of [...adoptedAs.keys(), ...excluded]) {
		if (!m.upstreamSkills.includes(name)) {
			fail(name, `"${name}" is not in upstreamSkills (expected the full upstream skill list at the pinned sha)`);
		}
	}

	// A top-level directory named like an upstream skill is vendored, so it
	// must be adopted under that name. The exception is an upstream skill
	// adopted under a new name: the rename exists because a local skill owns
	// the original name.
	const localPaths = new Set(adoptedPaths);
	for (const dir of topDirs) {
		if (!m.upstreamSkills.includes(dir) || localPaths.has(dir)) continue;
		if (adoptedAs.has(dir) && adoptedAs.get(dir) !== dir) continue;
		report(join(root, dir), 1, `upstream skill directory "${dir}" is not listed as adopted in ${MANIFEST} (expected an adopted entry for it, or remove it if it is excluded)`);
	}

	// NOTICE links into the upstream repository pin the manifest's sha.
	const upstreamUrl = m.upstream.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	for (const file of files.filter((f) => /^NOTICE/i.test(basename(f)))) {
		const re = new RegExp(`${upstreamUrl}/(?:blob|tree|raw)/([^/\\s)]+)`, 'g');
		const body = fileText(file);
		let match;
		while ((match = re.exec(body)) !== null) {
			if (match[1] !== m.sha) {
				report(file, lineOf(file, match.index), `upstream link "${match[0]}" is not pinned (expected the ${MANIFEST} sha ${m.sha}; actual ${match[1]})`);
			}
		}
	}

	return m;
}

// --- report ------------------------------------------------------------------------------

if (violations.length > 0) {
	for (const v of violations.sort()) console.log(v);
	console.log(`\n${violations.length} violation${violations.length === 1 ? '' : 's'} in ${root}`);
	process.exit(1);
}
console.log(`ok: ${root} is a coherent, installable skill set (${topDirs.length} skills, ${mdFiles.length} markdown files; ${MANIFEST}: ${provenance.adopted.length} adopted paths and ${provenance.modified.length} modified files at ${provenance.sha})`);
process.exit(0);
