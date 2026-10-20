#!/usr/bin/env bash
#
# The suite for spec #11's two repo-owned seams: verify-curation.mjs (the
# curation gate from ticket #12 — driven against synthetic fixture trees built
# in a temporary directory, one per rule: duplicates, each unresolvable
# reference syntax, unparseable frontmatter, the pstack: ban, plus a positive
# control showing a carried agent definition satisfies the agent-reference
# rule, the pstack provenance manifest from #24, a node_modules dependency
# tree that must be skipped, and finally against the repo's real skills/
# tree), the .gitignore rule that keeps
# node_modules out of git (in a throwaway repository), and the
# standing-orders installer from ticket #08 (its own harness in
# test-standing-orders.sh, invoked at the end).
#
# Usage: tests/run.sh

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
checker="$repo/scripts/verify-curation.mjs"
real_skills="$repo/skills"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

failures=0
checks=0

check() { # check <description> <command...>
	local description=$1
	shift
	checks=$((checks + 1))
	if "$@"; then
		printf 'ok   %s\n' "$description"
	else
		printf 'FAIL %s\n' "$description"
		failures=$((failures + 1))
	fi
}

# The provenance manifest every tree must carry (#24). Fixtures that vendor
# nothing get an empty one: no upstream skills, nothing adopted.
manifest_name=pstack-provenance.json
write_empty_manifest() { # write_empty_manifest <tree>
	cat >"$1/$manifest_name" <<'EOF'
{
  "upstream": "https://github.com/example/vendor",
  "sha": "1111111111111111111111111111111111111111",
  "upstreamSkillsDir": "skills",
  "upstreamSkills": [],
  "adopted": [],
  "excluded": [],
  "modified": [],
  "copies": []
}
EOF
}

# A minimal, fully valid skill in the current $tree fixture: parseable
# frontmatter with name + description. The first skill in a fixture also
# writes the empty manifest.
make_skill() { # make_skill <name>  ($tree is set by the caller)
	mkdir -p "$tree/$1"
	[ -e "$tree/$manifest_name" ] || write_empty_manifest "$tree"
	cat >"$tree/$1/SKILL.md" <<EOF
---
name: $1
description: A valid fixture skill named $1.
---

# $1

Uses [\`/$1\`](./SKILL.md).
EOF
}

# Run the checker on a fixture tree; stdout and the exit code are captured for
# the assertions below.
run_checker() { # run_checker <tree>
	output=$(node "$checker" "$1" 2>&1)
	status=$?
}

# --- acceptance criterion: the current pre-curation tree ------------------------

tree="$real_skills"
run_checker "$tree"
check "the real skills/ tree passes (exit 0)" test "$status" -eq 0
check "the real-tree report starts with ok:" grep -q '^ok:' <<<"$output"

# --- fixture baseline: a valid two-skill tree passes -----------------------------

tree="$tmp/baseline"
make_skill alpha
make_skill beta
run_checker "$tree"
check "a valid fixture tree passes" test "$status" -eq 0

# --- duplicate skill names -------------------------------------------------------

tree="$tmp/dup-dir"
make_skill alpha
make_skill Alpha
run_checker "$tree"
check "a case-colliding duplicate skill directory fails" test "$status" -eq 1
check "the duplicate-directory report names the collision" grep -q 'duplicate skill directory name' <<<"$output"

tree="$tmp/dup-frontmatter"
make_skill alpha
make_skill beta
sed 's/^name: beta$/name: alpha/' "$tree/beta/SKILL.md" >"$tree/beta/SKILL.md.new"
mv "$tree/beta/SKILL.md.new" "$tree/beta/SKILL.md"
run_checker "$tree"
check "two directories declaring the same frontmatter name fail" test "$status" -eq 1
check "the duplicate-name report names the collision" grep -q 'duplicate skill name in frontmatter' <<<"$output"

tree="$tmp/dup-quoted-frontmatter"
make_skill alpha
make_skill beta
sed 's/^name: beta$/name: "alpha"/' "$tree/beta/SKILL.md" >"$tree/beta/SKILL.md.new"
mv "$tree/beta/SKILL.md.new" "$tree/beta/SKILL.md"
run_checker "$tree"
check "a quoted frontmatter name still collides with a bare duplicate" test "$status" -eq 1
check "the quoted-duplicate report names the collision" grep -q 'duplicate skill name in frontmatter' <<<"$output"

# --- unresolvable cross-skill references -----------------------------------------

tree="$tmp/cross-slash"
make_skill alpha
cat >>"$tree/alpha/SKILL.md" <<'EOF'

Run `/no-such-skill` next.
EOF
run_checker "$tree"
check "an unresolvable slash-mention fails" test "$status" -eq 1
check "the slash-mention report names the missing skill" grep -q 'no-such-skill' <<<"$output"

tree="$tmp/cross-path"
make_skill alpha
make_skill beta
cat >>"$tree/alpha/SKILL.md" <<'EOF'

See `skills/beta/gone.md` and `skills/ghost/SKILL.md`.
EOF
run_checker "$tree"
check "an unresolvable skills/<name>/<file> path reference fails" test "$status" -eq 1
check "the path reference report names the missing file" grep -q 'skills/beta/gone.md' <<<"$output"
check "an unknown skill in a path reference fails" grep -q 'skills/ghost' <<<"$output"

# --- unresolvable relative paths ---------------------------------------------------

tree="$tmp/rel-backtick"
make_skill alpha
cat >>"$tree/alpha/SKILL.md" <<'EOF'

Read `references/missing.md` first.
EOF
run_checker "$tree"
check "an unresolvable backticked relative path fails" test "$status" -eq 1
check "the relative-path report names the missing file" grep -q 'references/missing.md' <<<"$output"

tree="$tmp/rel-link"
make_skill alpha
cat >>"$tree/alpha/SKILL.md" <<'EOF'

See [the guide](guide.md) and [up](../nope.md).
EOF
run_checker "$tree"
check "an unresolvable markdown link target fails" test "$status" -eq 1
check "the link report names the missing target" grep -q 'guide.md' <<<"$output"

# Illustrative content must not false-positive: links inside fenced code blocks
# or inline code spans are examples, not references.
tree="$tmp/rel-examples"
make_skill alpha
cat >>"$tree/alpha/SKILL.md" <<'EOF'

```md
- [Ordering](./src/ordering/CONTEXT.md): receives orders
```

Write a pointer like `see [src/README.md](./src/README.md)` in one line.
EOF
run_checker "$tree"
check "example links inside fences and code spans do not fail the tree" test "$status" -eq 0

# --- agent references ----------------------------------------------------------------

tree="$tmp/agent-ref"
make_skill alpha
mkdir -p "$tree/alpha/agents"
cat >"$tree/alpha/agents/reviewer.md" <<'EOF'
---
name: reviewer
description: A carried agent definition for the fixture.
---
EOF
cat >>"$tree/alpha/SKILL.md" <<'EOF'

Dispatch with `subagent_type: "reviewer"`.
EOF
run_checker "$tree"
check "a subagent_type naming a carried agents/*.md definition passes" test "$status" -eq 0

cat >>"$tree/alpha/SKILL.md" <<'EOF'

Also dispatch with `subagent_type: "ghost-agent"`.
EOF
run_checker "$tree"
check "an unresolvable subagent_type agent reference fails" test "$status" -eq 1
check "the agent report names the missing agent" grep -q 'ghost-agent' <<<"$output"

# --- the pstack: ban -------------------------------------------------------------------

tree="$tmp/pstack-ref"
make_skill alpha
cat >>"$tree/alpha/SKILL.md" <<'EOF'

Spawn `pstack:poteto-agent` for reviews.
EOF
printf 'ref: pstack:some-agent\n' >"$tree/alpha/notes.txt"
run_checker "$tree"
check "a pstack:-prefixed reference in markdown fails" test "$status" -eq 1
check "the pstack: report names the reference" grep -q 'pstack:poteto-agent' <<<"$output"
check "a pstack:-prefixed reference in a non-markdown file fails too" test "$(grep -c 'pstack:' <<<"$output")" -ge 2

# --- plugin-rooted paths (#26) -----------------------------------------------------
#
# A skills-CLI install has no plugin root, so a path rooted at one never
# resolves. Paths relative to the skill directory are the installable form.

tree="$tmp/plugin-root"
make_skill alpha
cat >>"$tree/alpha/SKILL.md" <<'EOF'

Run `node <plugin>/skills/alpha/scripts/run.mjs` first.
EOF
printf 'node "${CLAUDE_PLUGIN_ROOT}/skills/alpha/run.mjs"\n' >"$tree/alpha/run.sh"
run_checker "$tree"
check "a <plugin>-rooted path fails" test "$status" -eq 1
check "the plugin-root report names the path" grep -q '<plugin>/skills/alpha' <<<"$output"
check "a \${CLAUDE_PLUGIN_ROOT} path in a non-markdown file fails too" grep -q 'alpha/run.sh:1:.*CLAUDE_PLUGIN_ROOT' <<<"$output"

tree="$tmp/plugin-root-fenced"
make_skill alpha
cat >>"$tree/alpha/SKILL.md" <<'EOF'

```bash
node <plugin>/skills/alpha/scripts/run.mjs
```
EOF
run_checker "$tree"
check "a <plugin>-rooted path inside a fenced command fails too" test "$status" -eq 1

# --- namespaced skill references (#26) ------------------------------------------
#
# A plugin-namespaced skill (`namespace:skill`) that is not in the tree never
# resolves after a skills-CLI install. Checked in the forms that name a skill
# unambiguously; labels such as `wayfinder:map` or `file:line` are not.

tree="$tmp/namespace-ref"
make_skill alpha
cat >>"$tree/alpha/SKILL.md" <<'EOF'

Use the **plugin-dev:skill-development** skill to write it.
Then the `tools:formatter` skill, and `/tools:linter` after.
Dispatch with `subagent_type: "tools:helper-agent"`.
Labels like `wayfinder:map`, `lint:boundaries` and `file:line` are not skills.
EOF
run_checker "$tree"
check "unresolvable namespace:skill references fail" test "$status" -eq 1
check "the namespace report names a bold reference" grep -q 'plugin-dev:skill-development' <<<"$output"
check "the namespace report names a backticked reference followed by 'skill'" grep -q 'tools:formatter' <<<"$output"
check "the namespace report names a namespaced slash mention" grep -q 'tools:linter' <<<"$output"
check "the namespace report names a namespaced subagent_type" grep -q 'tools:helper-agent' <<<"$output"
check "labels that are not skill references are not reported" test "$(grep -c 'wayfinder:map\|lint:boundaries\|file:line' <<<"$output")" -eq 0

tree="$tmp/namespace-resolved"
make_skill alpha
make_skill beta
cat >>"$tree/alpha/SKILL.md" <<'EOF'

Use the **local:beta** skill, then `/local:beta`.
EOF
run_checker "$tree"
check "a namespace:skill reference whose skill is in the tree passes" test "$status" -eq 0

# --- frontmatter -------------------------------------------------------------------------

tree="$tmp/frontmatter-broken"
make_skill alpha
mkdir -p "$tree/broken"
cat >"$tree/broken/SKILL.md" <<'EOF'
---
name broken
description: this frontmatter line has no colon
---
EOF
run_checker "$tree"
check "unparseable frontmatter (a line without a key) fails" test "$status" -eq 1
check "the frontmatter report says unparseable" grep -q 'unparseable YAML frontmatter' <<<"$output"

tree="$tmp/frontmatter-unclosed"
make_skill alpha
mkdir -p "$tree/unclosed"
cat >"$tree/unclosed/SKILL.md" <<'EOF'
---
name: unclosed
description: the fence is never closed
EOF
run_checker "$tree"
check "an unclosed frontmatter fence fails" test "$status" -eq 1

tree="$tmp/frontmatter-missing-desc"
make_skill alpha
mkdir -p "$tree/nodesc"
cat >"$tree/nodesc/SKILL.md" <<'EOF'
---
name: nodesc
---
EOF
run_checker "$tree"
check "frontmatter without a description fails" test "$status" -eq 1
check "the missing-field report names description" grep -q 'description' <<<"$output"

# --- a directory without SKILL.md is not a skill -------------------------------------------

tree="$tmp/orphan-dir"
make_skill alpha
mkdir -p "$tree/not-a-skill"
run_checker "$tree"
check "a top-level directory without SKILL.md fails" test "$status" -eq 1
check "the orphan report names the directory" grep -q 'not-a-skill' <<<"$output"

# --- unreadable files -------------------------------------------------------------

tree="$tmp/unreadable-file"
make_skill alpha
ln -s "$tmp/does-not-exist-anywhere" "$tree/alpha/notes.md"
run_checker "$tree"
check "an unreadable file (dangling symlink) is reported, not crashed on" test "$status" -eq 1
check "the unreadable-file report names the file" grep -q 'unreadable file' <<<"$output"

# --- the pstack provenance manifest (#24) -----------------------------------------
#
# A vendored snapshot: upstream skills gamma (adopted), teach (adopted renamed
# to understand, because a local skill owns the name teach), and dropped
# (excluded). The local alpha and teach are not vendored. Each variant below
# copies this valid tree and breaks one thing.

make_provenance_tree() { # make_provenance_tree <tree>
	tree=$1
	make_skill alpha
	make_skill gamma
	make_skill teach
	make_skill understand
	printf 'Pinned [notice](https://github.com/example/vendor/blob/1111111111111111111111111111111111111111/NOTICE.md).\n' >"$tree/NOTICE-skills.md"
	cat >"$tree/$manifest_name" <<'EOF'
{
  "upstream": "https://github.com/example/vendor",
  "sha": "1111111111111111111111111111111111111111",
  "upstreamSkillsDir": "skills",
  "upstreamSkills": ["dropped", "gamma", "teach"],
  "adopted": [
    { "path": "gamma", "upstream": "skills/gamma" },
    { "path": "understand", "upstream": "skills/teach" },
    { "path": "NOTICE-skills.md", "upstream": "NOTICE-skills.md" }
  ],
  "excluded": [
    { "upstream": "skills/dropped", "reason": "not wanted here" }
  ],
  "modified": [
    { "path": "gamma/SKILL.md", "reason": "local wording" },
    { "path": "NOTICE-skills.md", "reason": "links pinned to the sha" },
    { "path": "gamma/licenses/NOTICE.md", "reason": "same text as NOTICE-skills.md" }
  ],
  "copies": [
    { "path": "gamma/licenses/NOTICE.md", "of": "NOTICE-skills.md" }
  ]
}
EOF
	mkdir -p "$tree/gamma/licenses"
	cp "$tree/NOTICE-skills.md" "$tree/gamma/licenses/NOTICE.md"
}

# Edit the current $tree's manifest with a JavaScript statement over `m`.
edit_manifest() { # edit_manifest <js>
	node -e '
		const fs = require("fs");
		const file = process.argv[1];
		const m = JSON.parse(fs.readFileSync(file, "utf8"));
		new Function("m", process.argv[2])(m);
		fs.writeFileSync(file, JSON.stringify(m, null, 2));
	' "$tree/$manifest_name" "$1"
}

make_provenance_tree "$tmp/provenance"
run_checker "$tree"
check "a manifest covering every vendored path passes, beside a local skill holding a renamed upstream's name" test "$status" -eq 0

make_provenance_tree "$tmp/provenance-missing-adopted"
edit_manifest 'm.upstreamSkills.push("ghost"); m.adopted.push({ path: "ghost", upstream: "skills/ghost" });'
run_checker "$tree"
check "an adopted path the tree does not have fails" test "$status" -eq 1
check "the missing-adopted report names the path" grep -q '"ghost"' <<<"$output"

make_provenance_tree "$tmp/provenance-missing-modified"
edit_manifest 'm.modified.push({ path: "gamma/gone.md", reason: "edited" });'
run_checker "$tree"
check "a modified path the tree does not have fails" test "$status" -eq 1
check "the missing-modified report names the path" grep -q 'gamma/gone.md' <<<"$output"

make_provenance_tree "$tmp/provenance-modified-outside"
edit_manifest 'm.modified.push({ path: "alpha/SKILL.md", reason: "edited" });'
run_checker "$tree"
check "a modified path outside every adopted path fails" test "$status" -eq 1
check "the outside-modified report names the path" grep -q 'alpha/SKILL.md' <<<"$output"

make_provenance_tree "$tmp/provenance-modified-escape"
edit_manifest 'm.modified.push({ path: "gamma/../alpha/SKILL.md", reason: "edited" });'
run_checker "$tree"
check "a modified path that climbs out of its adopted path fails" test "$status" -eq 1
check "the climbing-path report names the path" grep -q 'gamma/../alpha/SKILL.md' <<<"$output"

make_provenance_tree "$tmp/provenance-spelling"
edit_manifest 'm.adopted[0].path = "./gamma/";'
run_checker "$tree"
check "an adopted path spelled ./gamma/ is the same path as gamma" test "$status" -eq 0

make_provenance_tree "$tmp/provenance-adopted-twice"
edit_manifest 'm.adopted.push({ path: "alpha", upstream: "skills/gamma" });'
run_checker "$tree"
check "one upstream path adopted under two local paths fails" test "$status" -eq 1
check "the adopted-twice report names the upstream path" grep -q 'skills/gamma' <<<"$output"

make_provenance_tree "$tmp/provenance-bad-field"
edit_manifest 'm.sha = "1111111";'
run_checker "$tree"
check "a malformed manifest field fails" test "$status" -eq 1
check "the malformed-field report names the field" grep -q 'field "sha"' <<<"$output"

make_provenance_tree "$tmp/provenance-unlisted"
edit_manifest 'm.adopted = m.adopted.filter((a) => a.path !== "gamma"); m.modified = m.modified.filter((x) => !x.path.startsWith("gamma/"));'
run_checker "$tree"
check "an adopted upstream directory missing from the manifest fails" test "$status" -eq 1
check "the unlisted-directory report names the directory" grep -q 'gamma' <<<"$output"
check "the unlisted-directory report says it is not listed" grep -q 'not listed as adopted' <<<"$output"

make_provenance_tree "$tmp/provenance-excluded-present"
make_skill dropped
run_checker "$tree"
check "an excluded upstream skill present in the tree fails" test "$status" -eq 1
check "the excluded-present report names the directory" grep -q 'dropped' <<<"$output"

make_provenance_tree "$tmp/provenance-excluded-case"
make_skill Dropped
run_checker "$tree"
check "an excluded upstream skill present under another letter case fails" test "$status" -eq 1

# Upstream ships some files twice (a skill carries its own copy of the
# licenses); the manifest declares each copy, and the copies stay identical.
make_provenance_tree "$tmp/provenance-copy-drift"
printf 'One more line.\n' >>"$tree/gamma/licenses/NOTICE.md"
run_checker "$tree"
check "a declared copy that differs from its original fails" test "$status" -eq 1
check "the copy-drift report names the copy and its original" grep -q 'gamma/licenses/NOTICE.md.*NOTICE-skills.md' <<<"$output"

make_provenance_tree "$tmp/provenance-copy-missing"
rm "$tree/gamma/licenses/NOTICE.md"
edit_manifest 'm.modified = m.modified.filter((x) => x.path !== "gamma/licenses/NOTICE.md");'
run_checker "$tree"
check "a declared copy the tree does not have fails" test "$status" -eq 1
check "the missing-copy report names the copy" grep -q 'gamma/licenses/NOTICE.md' <<<"$output"

make_provenance_tree "$tmp/provenance-no-manifest"
rm "$tree/$manifest_name"
run_checker "$tree"
check "a tree without the provenance manifest fails" test "$status" -eq 1
check "the missing-manifest report names the file" grep -q "$manifest_name" <<<"$output"

make_provenance_tree "$tmp/provenance-unpinned-notice"
printf 'See the [log](https://github.com/example/vendor/blob/main/CHANGES.md).\n' >>"$tree/NOTICE-skills.md"
run_checker "$tree"
check "a NOTICE link to the upstream at a ref other than the pinned sha fails" test "$status" -eq 1
check "the unpinned-link report names the ref" grep -q 'blob/main' <<<"$output"

for link in \
	'http://www.github.com/Example/Vendor/blob/main/NOTICE.md' \
	'https://github.com/example/vendor.git/tree/main' \
	'https://github.com/example/vendor/commits/main' \
	'https://raw.githubusercontent.com/example/vendor/main/NOTICE.md'; do
	make_provenance_tree "$tmp/provenance-unpinned-$(printf '%s' "$link" | tr -c 'a-z0-9' '-')"
	printf 'See %s.\n' "$link" >>"$tree/NOTICE-skills.md"
	run_checker "$tree"
	check "an unpinned NOTICE link fails in any GitHub URL shape: $link" test "$status" -eq 1
done

# --- dependency trees (#25) ---------------------------------------------------------
#
# poteto-mode's script bootstrap runs `bun install` into its own scripts
# directory, leaving a node_modules full of third-party markdown. The
# fixture package below violates several rules (dangling link, unknown slash
# mention, pstack: reference, a dangling .bin symlink); the control proves it
# does, so the node_modules case passing is not vacuous.

make_dependency() { # make_dependency <dir>
	mkdir -p "$1/commander" "$1/.bin"
	cat >"$1/commander/Readme.md" <<'EOF'
# commander

See [the docs](./docs/options.md) and run `/not-a-skill`.
EOF
	printf '{ "note": "pstack:not-ours" }\n' >"$1/commander/package.json"
	ln -s ../commander/missing.js "$1/.bin/commander"
}

tree="$tmp/dependency-control"
make_skill alpha
make_dependency "$tree/alpha/scripts/lib"
run_checker "$tree"
check "the dependency fixture violates the rules outside node_modules (control)" test "$status" -eq 1

tree="$tmp/node-modules"
make_skill alpha
make_dependency "$tree/alpha/scripts/node_modules"
make_dependency "$tree/node_modules"
run_checker "$tree"
check "node_modules inside a skill and at the root is skipped (exit 0)" test "$status" -eq 0
check "the node_modules report starts with ok:" grep -q '^ok:' <<<"$output"

# Package managers can leave node_modules as a symlink to a shared store; it
# is skipped by name, not read as a file.
tree="$tmp/node-modules-symlink"
make_skill alpha
make_dependency "$tmp/shared-store"
mkdir -p "$tree/alpha/scripts"
ln -s "$tmp/shared-store" "$tree/alpha/scripts/node_modules"
run_checker "$tree"
check "a symlinked node_modules is skipped (exit 0)" test "$status" -eq 0

# --- .gitignore: node_modules never becomes pushable (#25) -------------------------
#
# A throwaway repository carrying the real .gitignore: dependency trees under
# every whitelisted directory stay out of `git status`, and the whitelist
# still hides everything else.

gitrepo="$tmp/gitignore"
# Ignore the operator's global and system git config (e.g. a core.excludesFile)
# so only the repo's .gitignore decides what shows up.
fixture_git() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$gitrepo" "$@"; }
mkdir -p "$gitrepo"
fixture_git init -q
cp "$repo/.gitignore" "$gitrepo/.gitignore"
for dir in skills/alpha/scripts scripts personal-extensions/ext; do
	mkdir -p "$gitrepo/$dir/node_modules/commander"
	printf 'kept\n' >"$gitrepo/$dir/kept.txt"
	printf 'dependency\n' >"$gitrepo/$dir/node_modules/commander/index.js"
done
mkdir -p "$gitrepo/skills/beta/scripts"
ln -s "$tmp/shared-store" "$gitrepo/skills/beta/scripts/node_modules"
mkdir -p "$gitrepo/docs"
printf 'local\n' >"$gitrepo/docs/local.md"
printf 'local\n' >"$gitrepo/CONTEXT.md"
untracked=$(fixture_git status --porcelain --untracked-files=all | sed 's/^?? //' | LC_ALL=C sort)
expected=$(printf '%s\n' .gitignore personal-extensions/ext/kept.txt scripts/kept.txt skills/alpha/scripts/kept.txt | LC_ALL=C sort)
check "git status lists whitelisted files only, never node_modules" test "$untracked" = "$expected"

# --- the standing-orders installer seam (ticket #08) -----------------------------

if installer_out=$(bash "$here/test-standing-orders.sh" 2>&1); then
	printf '%s\n' "$installer_out"
	checks=$((checks + 1))
	printf 'ok   the standing-orders installer tests pass\n'
else
	installer_status=$?
	printf '%s\n' "$installer_out"
	checks=$((checks + 1))
	printf 'FAIL the standing-orders installer tests pass (exit %s)\n' "$installer_status"
	failures=$((failures + 1))
fi

printf '\n%d checks, %d failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ]
