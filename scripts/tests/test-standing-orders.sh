#!/usr/bin/env bash
#
# Tests for install-standing-orders.sh — the installer seam from spec #11,
# ticket #08, following the beads onboarding installer's test pattern: the
# installer is driven against a real temporary filesystem with synthetic mate
# homes covering every home-resolution branch (configured path, `~` expansion,
# empty config value, missing config, corrupt config, legacy location, no home
# → refusal with no side effects), plus append-once idempotency, preservation
# of pre-existing orders, the seven elements, the execution doctrine (features
# test-first at the agreed seams, `tdd` for bug fixes only; spec #11 D10), and
# the rule that every skill the orders name exists in the repo's final skills/
# tree. Fully offline: `paseo`
# and `bd` are failing stubs on PATH, so any attempt to shell out to the daemon
# or the tracker lands in the stub log and fails the run.
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
run_installer "$s"
check "running twice installs the block exactly once" \
	test "$(grep -c 'aidev-standing-orders:start' "$tmp/idem-home/data/captain.md")" -eq 1

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

# --- content: the seven elements ----------------------------------------------

s=$(make_sandbox content "{\"home\": \"$tmp/content-home\"}" "$tmp/content-home")
run_installer "$s"
orders="$tmp/content-home/data/captain.md"
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
	check "orders carry element: $element" grep -qF "$element" "$orders"
done

# --- content: the execution doctrine in element 4 (spec #11 D10) --------------
#
# Features are built test-first at the agreed seams; `tdd` is named for bug
# fixes only. The block wraps lines, so match against one whitespace-collapsed
# copy of it.

flat=$(tr -s '[:space:]' ' ' <"$orders")
has() { grep -qF -- "$1" <<<"$flat"; }
check "orders build features test-first: the failing test first" has "write the failing test first"
check "orders put the feature test at the agreed seams" has "at the seams agreed in the spec or brief"
check "orders allow only the code needed to pass the test" has "then only the code needed to pass it"
check "orders keep one seam and one test per cycle" has "one seam and one test per cycle"
check "orders route bug fixes to tdd" has 'Bug fixes use `tdd`'
check "orders name tdd for bug fixes only" \
	test "$(grep -oF '`tdd`' <<<"$flat" | wc -l)" -eq "$(grep -oF 'Bug fixes use `tdd`' <<<"$flat" | wc -l)"
check "orders no longer point at a merged tdd" bash -c '! grep -qiE "merged .?tdd" <<<"$1"' _ "$flat"

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
