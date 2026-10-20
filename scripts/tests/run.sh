#!/usr/bin/env bash
#
# The suite for spec #11's two repo-owned seams: verify-curation.mjs (the
# curation gate from ticket #12 — driven against synthetic fixture trees built
# in a temporary directory, one per rule: duplicates, each unresolvable
# reference syntax, unparseable frontmatter, the pstack: ban, plus a positive
# control showing a carried agent definition satisfies the agent-reference
# rule, a node_modules dependency tree that must be skipped, and finally
# against the repo's real skills/ tree), the .gitignore rule that keeps
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

# A minimal, fully valid skill in the current $tree fixture: parseable
# frontmatter with name + description.
make_skill() { # make_skill <name>  ($tree is set by the caller)
	mkdir -p "$tree/$1"
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
untracked=$(fixture_git status --porcelain --untracked-files=all | sed 's/^?? //' | sort)
expected=$(printf '%s\n' .gitignore personal-extensions/ext/kept.txt scripts/kept.txt skills/alpha/scripts/kept.txt)
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
