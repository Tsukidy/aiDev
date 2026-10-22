#!/usr/bin/env bash
#
# Tests for an install interrupted at an external call that creates state
# (#35): the skills CLI's add (partway through its copies, and once done), and
# the beads orders installer's bd calls, which run after the standing-orders
# installer has appended its block. Each call is SIGKILLed (STUB_INTERRUPT),
# on a first install. Uninstall then
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

# The skills CLI has copied half the skills, and written its lock for those.
interrupted skills-add-partway npx "--yes $skills_pin add "
# The skills CLI has copied every skill and written its lock.
interrupted skills-add npx "--yes $skills_pin add "
interrupted skills-add npx "--yes $skills_pin add " rich
# The standing-orders block is appended; the beads installer has just begun.
interrupted bd-ready bd "ready"
interrupted bd-ready bd "ready" rich
# bd init has created the mate's home database; its orders block is not appended yet.
interrupted bd-init bd "init"

# --- what captain.md gains between a kill at bd-ready and the re-run is not ours ---

captain_of() { # captain_of <sb>
	printf '%s\n' "$1/home/$mate_rel/data/captain.md"
}

# The snapshot less captain.md, its backup and the state directory that holds
# the backup: what the operator's line leaves of the file, and whether the
# backup is kept, are checked on their own.
snapshot_less_captain() { # snapshot_less_captain <sb>
	snapshot "$1/home" | grep -vE 'captain\.md|/backups|/state/aidev -> $'
}

# After the kill, the operator appends a line. The re-run must not take it for
# the beads script's heading, or uninstall deletes it.
operator_line_survives() { # operator_line_survives [rich]
	local kind=${1:-plain} sb before pre status
	local label="operator line after a bd-ready kill ($kind)"
	local line='OPERATOR: never deploy on Fridays.'
	sb=$(new_sandbox "operator-$kind" "${1:-}")
	before=$(snapshot_less_captain "$sb")
	pre=$(cat "$(captain_of "$sb")" 2>/dev/null || true)
	interrupt "$sb" bd-ready
	printf '%s\n' "$line" >>"$(captain_of "$sb")"
	install_in "$sb"
	status=$?
	check "$label: the re-run exits 0" test "$status" -eq 0
	uninstall_in "$sb" --purge --yes
	status=$?
	check "$label: uninstall exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
	check "$label: captain.md is the pre-install text plus the line" test "$(cat "$(captain_of "$sb")")" = "$(printf '%s%s\n' "${pre:+$pre
}" "$line")"
	# A file that existed before and changed since keeps its pre-install backup.
	if [ "$kind" = rich ]; then check "$label: uninstall keeps the backup, since the file changed" out_has "$sb" "only our parts were removed"; fi
	check "$label: everything else is restored" test "$(snapshot_less_captain "$sb")" = "$before"
}
operator_line_survives
operator_line_survives rich

# The state between an orders script appending its block and install.mjs
# settling the record, synthesized: after a kill at bd-ready, the settled
# standing-orders record is turned back into the intent its run began with,
# anchored at the pre-install text (the recorded backup's; '' when there was
# no file).
unsettle_standing_orders() { # unsettle_standing_orders <sb>
	json_edit "$(manifest_of "$1")" '(m) => {
		const fs = require("fs");
		const crypto = require("crypto");
		const b = m.items.find((i) => i.kind === "backup" && i.of.endsWith("/captain.md"));
		const text = b ? fs.readFileSync(b.path, "utf8") : "";
		const i = m.items.find((i) => i.kind === "marked-block" && i.id === "aidev-standing-orders");
		delete i.before;
		i.at = { length: text.length, sha256: crypto.createHash("sha256").update(text).digest("hex") };
	}'
}

unsettled_block() { # unsettled_block [rich]
	local kind=${1:-plain} sb ref before status
	local label="an appended, unsettled block ($kind)"
	ref=$(new_sandbox "ref-unsettled-$kind" "${1:-}")
	install_in "$ref"

	sb=$(new_sandbox "uninstall-unsettled-$kind" "${1:-}")
	before=$(snapshot "$sb/home")
	interrupt "$sb" bd-ready
	unsettle_standing_orders "$sb"
	check "$label: the record is an intent" manifest_true "$sb" 'm.items.some((i) => i.id === "aidev-standing-orders" && i.at && !("before" in i))'
	uninstall_in "$sb" --purge --yes
	status=$?
	check "$label: uninstall right after exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
	check "$label: uninstall right after restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

	sb=$(new_sandbox "rerun-unsettled-$kind" "${1:-}")
	before=$(snapshot "$sb/home")
	interrupt "$sb" bd-ready
	unsettle_standing_orders "$sb"
	install_in "$sb"
	status=$?
	check "$label: the re-run exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
	check "$label: the re-run records what an uninterrupted install does" test "$(records "$sb")" = "$(records "$ref")"
	uninstall_in "$sb" --purge --yes
	check "$label: uninstall after the re-run restores the snapshot" test "$(snapshot "$sb/home")" = "$before"
}
unsettled_block
unsettled_block rich

# A repo update between the kill and the re-run: the standing-orders script
# upgrades its block in place, so the text in front of the beads block is no
# longer what the killed run recorded. From a git copy of this checkout, whose
# orders text the case edits.
repo_update_between() {
	local label="a repo update between a bd-ready kill and the re-run (rich)" copy sb before status
	copy=$tmp/update-copy
	check "$label: the checkout copies" git_copy_with_worktree "$copy" || return
	sb=$(new_sandbox update-rich rich)
	before=$(snapshot "$sb/home")
	(run_in "$sb" full STUB_INTERRUPT=bd-ready -- "$copy/main/scripts/install.mjs") 2>/dev/null
	check "$label: the install was killed" test $? -ne 0
	sed -i 's/7\. \*\*Retro after landings\.\*\*/7. **Retro after every landing.**/' "$copy/main/scripts/install-standing-orders.sh"
	check "$label: the orders text changed" grep -q 'Retro after every landing' "$copy/main/scripts/install-standing-orders.sh"
	run_in "$sb" full -- "$copy/main/scripts/install.mjs"
	status=$?
	check "$label: the re-run exits 0" test "$status" -eq 0
	check "$label: the re-run upgraded the standing-orders block" out_has "$sb" "upgraded the standing orders block"
	run_in "$sb" full -- "$copy/main/scripts/uninstall.mjs" --purge --yes
	status=$?
	check "$label: uninstall exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
	check "$label: uninstall restores the snapshot" test "$(snapshot "$sb/home")" = "$before"
}
repo_update_between

# --- a kill leaves captain.md's record and backup, which only our parts justify ---

# Both blocks are already in captain.md and not ours (an earlier install's
# file, kept by hand). The kill at bd-ready leaves the shared record and the
# backup written before the first script; the re-run must drop both, as an
# uninterrupted install records neither.
foreign_blocks() {
	local label="both blocks already there, not ours: a bd-ready kill" ref sb before status
	ref=$(new_sandbox ref-foreign)
	install_in "$ref"
	sb=$(new_sandbox foreign)
	cp "$(captain_of "$ref")" "$(captain_of "$sb")"
	before=$(snapshot "$sb/home")
	interrupt "$sb" bd-ready
	check "$label: the install was killed" test $? -ne 0
	check "$label: at that call" last_call_is "$sb" bd "ready"
	check "$label: the kill left captain.md's record and backup" manifest_true "$sb" 'm.items.some((i) => i.kind === "backup" && i.of.endsWith("/captain.md")) && m.items.some((i) => i.shared && i.path.endsWith("/captain.md"))'
	install_in "$sb"
	status=$?
	check "$label: the re-run exits 0" test "$status" -eq 0
	check "$label: the re-run records nothing for captain.md" manifest_true "$sb" '!m.items.some((i) => (i.path ?? i.of).endsWith("/captain.md"))'
	check "$label: the re-run removed the backup" test -z "$(ls "$sb/home/.local/state/aidev/backups" 2>/dev/null)"
	uninstall_in "$sb" --purge --yes
	status=$?
	check "$label: uninstall exits 0" test "$status" -eq 0
	check "$label: uninstall restores the snapshot" test "$(snapshot "$sb/home")" = "$before"
}
foreign_blocks

# ...and an edit between the kill and the re-run is the operator's: the re-run
# still drops the record and the backup, which uninstall would only report.
foreign_blocks_edited() {
	local label="both blocks already there, not ours: an edit after a bd-ready kill" ref sb status
	ref=$(new_sandbox ref-foreign-edited)
	install_in "$ref"
	sb=$(new_sandbox foreign-edited)
	cp "$(captain_of "$ref")" "$(captain_of "$sb")"
	interrupt "$sb" bd-ready
	printf 'OPERATOR: never deploy on Fridays.\n' >>"$(captain_of "$sb")"
	install_in "$sb"
	status=$?
	check "$label: the re-run exits 0" test "$status" -eq 0
	check "$label: the re-run records nothing for captain.md" manifest_true "$sb" '!m.items.some((i) => (i.path ?? i.of).endsWith("/captain.md"))'
	check "$label: the re-run removed the backup" test -z "$(ls "$sb/home/.local/state/aidev/backups" 2>/dev/null)"
}
foreign_blocks_edited

# --- a kill inside the standing-orders script, on a captain.md it creates ----------
#
# From a git copy of this checkout whose standing-orders script kills the
# install (and itself) either right after writing the header to the
# captain.md it creates, or before writing anything. The re-run runs the
# script unchanged.

kill_copy=$tmp/kill-copy
git_copy_with_worktree "$kill_copy" || printf 'FAIL the checkout copies for the kill cases\n'
kill_script=$kill_copy/main/scripts/install-standing-orders.sh
cp "$kill_script" "$tmp/standing-orders.orig"

# killed_in_standing_orders <case> <after-header|before-header> <captain.md text written after the kill, or "">
# Prints nothing; leaves the sandbox at <sb>, re-run and uninstalled.
killed_in_standing_orders() {
	local name=$1 when=$2 text=$3 sb
	sb=$(new_sandbox "$name")
	cp "$tmp/standing-orders.orig" "$kill_script"
	if [ "$when" = after-header ]; then
		sed -i "s|^\tprintf 'created %s\\\\n' \"\$target\"|&\n\tkill -9 \$PPID \$\$|" "$kill_script"
	else
		sed -i 's|^target="\$home/data/captain.md"|kill -9 $PPID $$\n&|' "$kill_script"
	fi
	snapshot "$sb/home" >"$sb/before.txt"
	(run_in "$sb" full -- "$kill_copy/main/scripts/install.mjs") 2>/dev/null
	printf '%s' "$?" >"$sb/killed.txt"
	cp "$tmp/standing-orders.orig" "$kill_script"
	[ -n "$text" ] && printf '%s' "$text" >>"$(captain_of "$sb")"
	run_in "$sb" full -- "$kill_copy/main/scripts/install.mjs"
	printf '%s' "$?" >"$sb/rerun.txt"
	run_in "$sb" full -- "$kill_copy/main/scripts/uninstall.mjs" --purge --yes
	printf '%s' "$?" >"$sb/uninstall.txt"
	printf '%s\n' "$sb"
}

sb=$(killed_in_standing_orders kill-header after-header "")
label="a kill after the standing-orders header"
check "$label: the install was killed, the header written" test "$(cat "$sb/killed.txt")" -ne 0
check "$label: the re-run and uninstall exit 0" test "$(cat "$sb/rerun.txt")$(cat "$sb/uninstall.txt")" = 00
check "$label: uninstall takes the header with the block, restoring the snapshot" test "$(snapshot "$sb/home")" = "$(cat "$sb/before.txt")"

sb=$(killed_in_standing_orders kill-header-edited after-header $'OPERATOR: never deploy on Fridays.\n')
label="an operator line after a kill after the standing-orders header"
check "$label: the re-run and uninstall exit 0" test "$(cat "$sb/rerun.txt")$(cat "$sb/uninstall.txt")" = 00
check "$label: uninstall keeps the header and the line" test "$(cat "$(captain_of "$sb")")" = "$(printf '# Standing orders\n\nOPERATOR: never deploy on Fridays.')"

# firstmate seeds captain.md from its template whenever the mate launches.
seeded=$'# Captain\'s standing orders\n\nOPERATOR: never deploy on Fridays.\n'
sb=$(killed_in_standing_orders kill-before-header before-header "$seeded")
label="a captain.md seeded after a kill before the standing-orders header"
check "$label: the install was killed, no captain.md written" test "$(cat "$sb/killed.txt")" -ne 0
check "$label: the re-run and uninstall exit 0" test "$(cat "$sb/rerun.txt")$(cat "$sb/uninstall.txt")" = 00
check "$label: uninstall leaves the seeded file as it was" test "$(cat "$(captain_of "$sb")")" = "$(printf '%s' "$seeded")"

summary
