#!/usr/bin/env bash
#
# Tests for an install interrupted at an external call that creates state
# (#35): the skills CLI's add, and the beads orders installer's bd calls, which
# run after the standing-orders installer has appended its block. Each call is
# SIGKILLed once done (STUB_INTERRUPT), on a first install. Uninstall then
# restores the pre-install snapshot, and a re-run converges on the manifest of
# an install that was never interrupted, after which uninstall restores the
# snapshot too. On the shared harness of lib/install-harness.sh; fully offline.
#
# Usage: tests/test-install-interrupt.sh

set -uo pipefail
. "$(dirname "$0")/lib/install-harness.sh"

# The manifest's items with each sandbox's HOME as ~, sorted, without the
# hashes of shared files (they hold HOME): two sandboxes' records compare equal.
records() { # records <sb>
	node -e '
		const [file, home] = process.argv.slice(1);
		const m = JSON.parse(require("fs").readFileSync(file, "utf8"));
		const lines = m.items.map((i) => JSON.stringify({ ...i, ...(i.shared ? { sha256: null } : {}) }).replaceAll(home, "~"));
		console.log(lines.sort().join("\n"));
	' "$(manifest_of "$1")" "$1/home"
}

interrupt() { # interrupt <sb> <call>  — a first install, SIGKILLed once <call> is done
	(run_in "$1" full STUB_INTERRUPT="$2" -- "$installer") 2>/dev/null # the shell's "Killed" notice
}

last_call_is() { # last_call_is <sb> <name> <args prefix>
	tail -n 1 "$1/stub.log" | grep -qF -- "$2|$3"
}

# interrupted <call> <stub name> <args prefix> [rich]
interrupted() {
	local call=$1 name=$2 args=$3 kind=${4:-plain} sb ref before status
	local label="$call ($kind)"

	ref=$(new_sandbox "ref-$call-$kind" "${4:-}")
	install_in "$ref"

	sb=$(new_sandbox "uninstall-$call-$kind" "${4:-}")
	before=$(snapshot "$sb/home")
	interrupt "$sb" "$call"
	check "$label: the install was killed" test $? -ne 0
	check "$label: at that call" last_call_is "$sb" "$name" "$args"
	uninstall_in "$sb" --purge --yes
	status=$?
	check "$label: uninstall right after exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
	check "$label: uninstall right after restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

	sb=$(new_sandbox "rerun-$call-$kind" "${4:-}")
	before=$(snapshot "$sb/home")
	interrupt "$sb" "$call"
	install_in "$sb"
	status=$?
	check "$label: the re-run exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
	check "$label: the re-run finds nothing of ours installed from elsewhere" bash -c '! grep -qF "from elsewhere" "$1"' _ "$sb/out.txt"
	check "$label: the re-run records what an uninterrupted install does" test "$(records "$sb")" = "$(records "$ref")"
	uninstall_in "$sb" --purge --yes
	check "$label: uninstall after the re-run restores the snapshot" test "$(snapshot "$sb/home")" = "$before"
}

# The skills CLI has copied every skill and written its lock.
interrupted skills-add npx "--yes $skills_pin add "
interrupted skills-add npx "--yes $skills_pin add " rich
# The standing-orders block is appended; the beads installer has just begun.
interrupted bd-ready bd "ready"
interrupted bd-ready bd "ready" rich
# bd init has created the mate's home database; its orders block is not appended yet.
interrupted bd-init bd "init"

summary
