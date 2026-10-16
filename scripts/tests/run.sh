#!/usr/bin/env bash
#
# Tests for verify-curation.mjs — the curation gate from spec #11, ticket #12.
# The checker is driven against synthetic fixture trees built in a temporary
# directory (one per rule: duplicates, each unresolvable reference syntax,
# unparseable frontmatter, the pstack: ban) plus a positive control showing a
# carried agent definition satisfies the agent-reference rule, and finally
# against the repo's real skills/ tree — the ticket's acceptance criterion
# "passes on the current pre-curation tree".
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

printf '\n%d checks, %d failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ]
