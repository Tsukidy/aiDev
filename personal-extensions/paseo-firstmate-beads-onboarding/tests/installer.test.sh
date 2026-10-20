#!/usr/bin/env bash
#
# Tests for install-captain-orders.sh — the secondary seam from the spec: the
# installer is driven against a real temporary filesystem with synthetic mate
# homes covering every home-resolution branch (configured path, `~` expansion,
# empty config value, legacy location, no home → refusal), plus append-once
# idempotency and preservation of pre-existing orders. No Paseo involvement;
# `bd` is a stub on PATH so the home-database step is observable too.
#
# Usage: tests/installer.test.sh

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
installer="$here/../install-captain-orders.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

stubs=$tmp/stubs
mkdir -p "$stubs"
bdlog=$tmp/bd-calls.log
: >"$bdlog"

cat >"$stubs/bd" <<'STUB'
#!/usr/bin/env bash
echo "$1|$*|$PWD" >>"$STUB_BD_LOG"
case "$1" in
ready)
	[ -f ".beads-initialized" ]
	exit $?
	;;
init)
	mkdir -p .beads
	touch .beads-initialized
	exit $?
	;;
esac
exit 0
STUB
chmod +x "$stubs/bd"
export STUB_BD_LOG=$bdlog

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
	[ -f "$1" ] && [ "$(grep -c 'paseo-beads-onboarding:start' "$1" 2>/dev/null || true)" -eq 1 ]
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
# stub bd is first on PATH. Installer stdout is discarded; stderr lands in
# $tmp/stderr.txt for the refusal assertions.
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
	test "$(grep -c 'paseo-beads-onboarding:start' "$tmp/idem-home/data/captain.md")" -eq 1

s=$(make_sandbox truncated "{\"home\": \"$tmp/trunc-home\"}" "$tmp/trunc-home")
run_installer "$s"
# Simulate a prior append cut off mid-block: keep everything up to the start marker.
line=$(grep -n 'paseo-beads-onboarding:start' "$tmp/trunc-home/data/captain.md" | cut -d: -f1)
head -n "$line" "$tmp/trunc-home/data/captain.md" >"$tmp/truncated.md" && mv "$tmp/truncated.md" "$tmp/trunc-home/data/captain.md"
if run_installer "$s"; then
	check "a truncated prior block (start without end) is refused" false
else
	check "a truncated prior block (start without end) is refused" test -s "$tmp/stderr.txt"
fi
check "the truncated file was not appended to" \
	test "$(grep -c 'paseo-beads-onboarding' "$tmp/trunc-home/data/captain.md")" -eq 1

s=$(make_sandbox preserve "{\"home\": \"$tmp/pres-home\"}" "$tmp/pres-home")
printf '# Standing orders\n\nNever push to main.\n' >"$tmp/pres-home/data/captain.md"
run_installer "$s"
check "pre-existing orders are preserved and the block is appended" \
	bash -c "grep -q 'Never push to main' '$tmp/pres-home/data/captain.md' && [ \"\$(head -1 '$tmp/pres-home/data/captain.md')\" = '# Standing orders' ]"

# --- content: the seven rules -------------------------------------------------

s=$(make_sandbox content "{\"home\": \"$tmp/content-home\"}" "$tmp/content-home")
run_installer "$s"
orders="$tmp/content-home/data/captain.md"
for rule in \
	"NEVER goes in your home database" \
	"Never create a database" \
	"bd supersede" \
	"findings and decisions in the project DB before reporting done" \
	"BEGIN BEADS INTEGRATION" \
	"bd remember" \
	"exclude-label memory:decision,memory:gotcha,memory:handoff"; do
	check "orders carry rule: $rule" grep -qF "$rule" "$orders"
done

# --- the home database step ----------------------------------------------------

s=$(make_sandbox homedb "{\"home\": \"$tmp/homedb-home\"}" "$tmp/homedb-home")
: >"$bdlog"
run_installer "$s"
check "first install creates the home database with bd init --quiet --stealth" \
	grep -qF "init|init --quiet --stealth|$tmp/homedb-home" "$bdlog"
check "the home store marker exists after install" test -f "$tmp/homedb-home/.beads-initialized"
: >"$bdlog"
run_installer "$s"
check "second install does not re-init the home database" test "$(grep -c '^init|' "$bdlog")" -eq 0

# A failed home init must not forfeit the standing orders (the behavioral half).
mkdir -p "$tmp/stubs-broken"
cat >"$tmp/stubs-broken/bd" <<'STUB'
#!/usr/bin/env bash
case "$1" in
ready) exit 1 ;;
init) exit 4 ;;
esac
exit 0
STUB
chmod +x "$tmp/stubs-broken/bd"
s=$(make_sandbox failedinit "{\"home\": \"$tmp/failedinit-home\"}" "$tmp/failedinit-home")
(
	cd "$s" || exit 1
	export PASEO_HOME="$s/paseo-home"
	export HOME="$s/crew-home"
	export PATH="$tmp/stubs-broken:$PATH"
	bash "$installer" >/dev/null 2>"$tmp/stderr.txt"
)
check "a failed home init still installs the standing orders" \
	captain_has_one_block "$tmp/failedinit-home/data/captain.md"
check "the failed init is reported on stderr" test -s "$tmp/stderr.txt"

printf '\n%d checks, %d failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ]
