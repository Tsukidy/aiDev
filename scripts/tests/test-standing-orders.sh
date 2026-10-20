#!/usr/bin/env bash
#
# Tests for install-standing-orders.sh — the installer seam from spec #11,
# ticket #08, following the beads onboarding installer's test pattern: the
# installer is driven against a real temporary filesystem with synthetic mate
# homes covering every home-resolution branch (configured path, `~` expansion,
# empty config value, missing config, corrupt config, legacy location, no home
# → refusal with no side effects), plus append-once idempotency, preservation
# of pre-existing orders, the seven elements, the execution doctrine (features
# test-first at the agreed seams, `tdd` for bug fixes only; spec #11 D10, worded
# the same as in `implement`), the PR precedence rule (`pr` over poteto-mode's
# Opening a PR playbook; #24), and the rule that every skill the orders name
# exists in the repo's final skills/ tree. Fully offline: `paseo` and `bd` are
# failing stubs on PATH, so any attempt to shell out to the daemon or the
# tracker lands in the stub log and fails the run.
#
# Usage: tests/test-standing-orders.sh

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
installer="$repo/scripts/install-standing-orders.sh"
real_skills="$repo/skills"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

stubs=$tmp/stubs
mkdir -p "$stubs"
stublog=$tmp/stub-calls.log
: >"$stublog"

cat >"$stubs/failing-stub" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$(basename "$0")|$*|$PWD" >>"$STUB_LOG"
exit 1
STUB
chmod +x "$stubs/failing-stub"
ln -s failing-stub "$stubs/paseo"
ln -s failing-stub "$stubs/bd"
export STUB_LOG=$stublog

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

# Content checks match prose that wraps across lines, so they run against one
# whitespace-collapsed copy of the file.
flatten() { # flatten <file>
	tr -s '[:space:]' ' ' <"$1"
}

has() { # has <flattened-text> <phrase>  (literal, case-insensitive)
	grep -qiF -- "$2" <<<"$1"
}

captain_has_one_block() { # captain_has_one_block <file>
	[ -f "$1" ] && [ "$(grep -c 'aidev-standing-orders:start' "$1" 2>/dev/null || true)" -eq 1 ]
}

# Build a synthetic environment: <sandbox>/paseo-home is PASEO_HOME, and
# <sandbox>/crew-home is HOME. <config-json> is written to firstmate's
# config.json ("none" = no config file). <home-dir> ("no" = skip) is created as
# a launched mate home (a directory with data/).
make_sandbox() { # make_sandbox <name> <config-json|none> <home-dir|no>
	local sandbox="$tmp/$1"
	mkdir -p "$sandbox/paseo-home/plugin-data/firstmate"
	if [ "$2" != "none" ]; then
		printf '%s\n' "$2" >"$sandbox/paseo-home/plugin-data/firstmate/config.json"
	fi
	if [ "$3" != "no" ]; then
		mkdir -p "$3/data"
	fi
	printf '%s\n' "$sandbox"
}

# Run the installer inside a sandbox: PASEO_HOME and HOME point into it, the
# failing paseo/bd stubs are first on PATH. Installer stdout is discarded;
# stderr lands in $tmp/stderr.txt for the refusal assertions.
run_installer() { # run_installer <sandbox>
	(
		cd "$1" || exit 1
		export PASEO_HOME="$1/paseo-home"
		export HOME="$1/crew-home"
		export PATH="$stubs:$PATH"
		bash "$installer" >/dev/null 2>"$tmp/stderr.txt"
	)
}

# --- home resolution ---------------------------------------------------------

s=$(make_sandbox absolute "{\"home\": \"$tmp/abs-home\"}" "$tmp/abs-home")
run_installer "$s"
check "absolute configured home is used" captain_has_one_block "$tmp/abs-home/data/captain.md"

s=$(make_sandbox tilde '{"home": "~/mate-home"}' no)
mkdir -p "$s/crew-home/mate-home/data"
run_installer "$s"
check "tilde home expands against HOME" captain_has_one_block "$s/crew-home/mate-home/data/captain.md"

s=$(make_sandbox tilde-alone '{"home": "~"}' no)
mkdir -p "$s/crew-home/data"
run_installer "$s"
check "bare ~ home resolves to HOME itself" captain_has_one_block "$s/crew-home/data/captain.md"

s=$(make_sandbox empty '{"home": ""}' "$tmp/empty/paseo-home/plugin-data/firstmate/home")
run_installer "$s"
check "empty config value falls back to the default home" \
	captain_has_one_block "$tmp/empty/paseo-home/plugin-data/firstmate/home/data/captain.md"

s=$(make_sandbox noconfig none "$tmp/noconfig/paseo-home/plugin-data/firstmate/home")
run_installer "$s"
check "missing config falls back to the default home" \
	captain_has_one_block "$tmp/noconfig/paseo-home/plugin-data/firstmate/home/data/captain.md"

s=$(make_sandbox corrupt '{not json' "$tmp/corrupt/paseo-home/plugin-data/firstmate/home")
run_installer "$s"
check "corrupt config falls back to the default home" \
	captain_has_one_block "$tmp/corrupt/paseo-home/plugin-data/firstmate/home/data/captain.md"

s=$(make_sandbox legacy '{"home": "~/gone"}' no)
mkdir -p "$s/paseo-home/plugins/firstmate/home/data"
run_installer "$s"
check "legacy plugins/firstmate/home is used when the configured home is missing" \
	captain_has_one_block "$s/paseo-home/plugins/firstmate/home/data/captain.md"

s=$(make_sandbox nowhere '{"home": "~/gone"}' no)
if run_installer "$s"; then
	check "no mate home anywhere is refused" false
else
	check "no mate home anywhere is refused" test -s "$tmp/stderr.txt"
fi
check "refusal creates no default home as a side effect" test ! -e "$s/paseo-home/plugin-data/firstmate/home"

# --- idempotency and preservation --------------------------------------------

s=$(make_sandbox idempotent "{\"home\": \"$tmp/idem-home\"}" "$tmp/idem-home")
run_installer "$s"
cp "$tmp/idem-home/data/captain.md" "$tmp/idem-first-run.md"
run_installer "$s"
check "running twice installs the block exactly once" \
	test "$(grep -c 'aidev-standing-orders:start' "$tmp/idem-home/data/captain.md")" -eq 1
check "a re-run leaves captain.md byte-identical" cmp -s "$tmp/idem-first-run.md" "$tmp/idem-home/data/captain.md"

s=$(make_sandbox truncated "{\"home\": \"$tmp/trunc-home\"}" "$tmp/trunc-home")
run_installer "$s"
# Simulate a prior append cut off mid-block: keep everything up to the start marker.
line=$(grep -n 'aidev-standing-orders:start' "$tmp/trunc-home/data/captain.md" | cut -d: -f1)
head -n "$line" "$tmp/trunc-home/data/captain.md" >"$tmp/truncated.md" && mv "$tmp/truncated.md" "$tmp/trunc-home/data/captain.md"
if run_installer "$s"; then
	check "a truncated prior block (start without end) is refused" false
else
	check "a truncated prior block (start without end) is refused" test -s "$tmp/stderr.txt"
fi
check "the truncated file was not appended to" \
	test "$(grep -c 'aidev-standing-orders' "$tmp/trunc-home/data/captain.md")" -eq 1

s=$(make_sandbox orphan-end "{"home": "$tmp/orphan-home"}" "$tmp/orphan-home")
printf '# Standing orders\n\n<!-- aidev-standing-orders:end -->\n' >"$tmp/orphan-home/data/captain.md"
if run_installer "$s"; then
	check "an orphaned end marker (end without start) is refused" false
else
	check "an orphaned end marker (end without start) is refused" test -s "$tmp/stderr.txt"
fi
check "the orphaned-marker file was not appended to" \
	test "$(grep -c 'aidev-standing-orders' "$tmp/orphan-home/data/captain.md")" -eq 1

s=$(make_sandbox preserve "{\"home\": \"$tmp/pres-home\"}" "$tmp/pres-home")
printf '# Standing orders\n\nNever push to main.\n' >"$tmp/pres-home/data/captain.md"
run_installer "$s"
check "pre-existing orders are preserved ahead of the block" \
	bash -c "grep -q 'Never push to main' '$tmp/pres-home/data/captain.md' && [ \"\$(head -1 '$tmp/pres-home/data/captain.md')\" = '# Standing orders' ]"

s=$(make_sandbox after "{\"home\": \"$tmp/after-home\"}" "$tmp/after-home")
run_installer "$s"
printf '\nCustom captain footnote.\n' >>"$tmp/after-home/data/captain.md"
run_installer "$s"
check "custom orders after the block survive a re-run" \
	test "$(grep -c 'aidev-standing-orders:start' "$tmp/after-home/data/captain.md")" -eq 1
check "the post-block custom text is still present" grep -qF 'Custom captain footnote.' "$tmp/after-home/data/captain.md"

# --- upgrade: an older block of ours is replaced in place (#27, #21) ----------
#
# A machine that installed an earlier version of the block gets the current
# one on the next run; only the text between our markers changes.

s=$(make_sandbox upgrade "{\"home\": \"$tmp/up-home\"}" "$tmp/up-home")
printf '# Standing orders\n\nNever push to main.\n' >"$tmp/up-home/data/captain.md"
run_installer "$s"
cp "$tmp/up-home/data/captain.md" "$tmp/up-current.md"
printf '\nCaptain footnote after the block.\n' >>"$tmp/up-home/data/captain.md"
# Age the block: an old element line inside the markers.
sed -i 's/^7\. \*\*Retro after landings\.\*\*.*/7. **An outdated element from an older install.**/' "$tmp/up-home/data/captain.md"
run_installer "$s"
check "an older block is upgraded in place on re-run" \
	cmp -s "$tmp/up-home/data/captain.md" <(cat "$tmp/up-current.md"; printf '\nCaptain footnote after the block.\n')
cp "$tmp/up-home/data/captain.md" "$tmp/up-after.md"
run_installer "$s"
check "a re-run after the upgrade is byte-identical" cmp -s "$tmp/up-after.md" "$tmp/up-home/data/captain.md"

# --- content: the seven elements ----------------------------------------------

s=$(make_sandbox content "{\"home\": \"$tmp/content-home\"}" "$tmp/content-home")
run_installer "$s"
orders="$tmp/content-home/data/captain.md"
orders_flat=$(flatten "$orders")
for element in \
	"five-label state machine" \
	"never through the router's planning playbook" \
	"beads is why" \
	"report linked on the issue" \
	"agreed seams" \
	"make-pr-easy-to-review" \
	"smart zone" \
	"Retro after landings" \
	"dispatch prompt"; do
	check "orders carry element: $element" has "$orders_flat" "$element"
done

# The effort note matches what the installer (#21) now places: on Claude Code
# the effort agents exist, so the old "plugin-only, absent" claim must be gone.
check "the effort note says the installer registers the effort agents on Claude Code" \
	has "$orders_flat" "the aiDev installer registers the effort agents"
check "the effort note no longer calls effort agents plugin-only" \
	bash -c '! grep -qiE "plugin-registered|absent from a skills-only install" <<<"$1"' _ "$orders_flat"

block_elements=$(sed -n '/aidev-standing-orders:start/,/aidev-standing-orders:end/p' "$orders" | grep -cE '^[0-9]+\. \*\*')
check "the block is one list of exactly seven elements" test "$block_elements" -eq 7

# --- content: PR precedence in element 5 (#24) ---------------------------------
#
# poteto-mode's Opening a PR playbook prescribes its own PR sections and
# Conventional Commits titles; the orders settle the conflict without editing
# the vendored playbook: `pr` takes the description, the playbook keeps the
# title (captain decision).

pr_element=$(sed -n '/^5\. \*\*PR shape/,/^6\. \*\*/p' "$orders" | tr -s '[:space:]' ' ')
check "the PR-shape element gives pr precedence over the Opening a PR playbook's section list" \
	has "$pr_element" "\`pr\` governs PR descriptions, and overrides the section list of poteto-mode's Opening a PR playbook (\`poteto-mode/playbooks/opening-a-pr.md\`) and any other description template"
check "the PR-shape element keeps the playbook's Conventional Commits titles" \
	has "$pr_element" "PR titles follow that playbook's Conventional Commits rule, as does the rest of the playbook"
check "the PR-shape element does not hand PR titles to pr" \
	bash -c '! grep -qiF -- "governs PR titles" <<<"$1"' _ "$pr_element"
check "the PR-shape element makes briefs carry the precedence rule" \
	has "$pr_element" "A brief for work that ends in a PR carries this rule"
check "the playbook the precedence names exists in the tree" \
	test -f "$real_skills/poteto-mode/playbooks/opening-a-pr.md"

# --- content: the execution doctrine in element 4 (spec #11 D10) --------------
#
# Features are built test-first at the agreed seams, and `implement` must state
# the same directive the orders do, so the two cannot drift apart. `tdd` is
# named once, for bug fixes only.

implement_flat=$(flatten "$real_skills/implement/SKILL.md")
for phrase in \
	"write the failing test first at the seams agreed in the spec or brief, then only the code needed to pass it" \
	"one seam and one test per cycle"; do
	check "orders carry the feature directive: $phrase" has "$orders_flat" "$phrase"
	check "implement carries the same feature directive: $phrase" has "$implement_flat" "$phrase"
done
check "orders route bug fixes to tdd" has "$orders_flat" 'Bug fixes use `/tdd`'
check "orders name tdd once, for bug fixes only" \
	test "$(grep -oE '`/?tdd`' <<<"$orders_flat" | wc -l)" -eq 1

# --- every skill the orders name exists in the final tree ----------------------
#
# Two mention shapes: slash-commands (`` `/to-spec` `` — all backticked) and
# bare backticked names (`tdd`, `thermos`, `pr`, `correct`, …). The allowlists
# are the harness built-ins that are not skills, and the tracker labels, which
# are deliberately backticked in the block.

missing=0
for ref in $(grep -oE '`/[a-z0-9-]+`' "$orders" | tr -d '`/' | sort -u); do
	case "$ref" in
	clear | compact) continue ;; # harness built-ins, not skills
	esac
	if [ ! -d "$real_skills/$ref" ]; then
		printf 'FAIL the orders name a skill missing from skills/: /%s\n' "$ref"
		missing=1
	fi
done
check "every slash-mentioned skill exists in the final tree" test "$missing" -eq 0

missing=0
for ref in $(grep -oE '`[a-z0-9-]+`' "$orders" | tr -d '`' | sort -u); do
	case "$ref" in
	needs-triage | needs-info | ready-for-agent | ready-for-human | wontfix) continue ;; # tracker labels, not skills
	esac
	if [ ! -d "$real_skills/$ref" ]; then
		printf 'FAIL the orders name a skill missing from skills/: %s\n' "$ref"
		missing=1
	fi
done
check "every backticked skill name exists in the final tree" test "$missing" -eq 0

# --- the installer shells out to nothing ----------------------------------------

check "the installer never invoked paseo or bd" test ! -s "$stublog"

printf '\n%d checks, %d failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ]
