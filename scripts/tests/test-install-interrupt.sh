#!/usr/bin/env bash
#
# Tests for an interrupted install. At an external call that creates state
# (#35): the skills CLI's add (partway through its copies, and once done), and
# the beads orders installer's bd calls, which run after the standing-orders
# installer has appended its block. Each call is SIGKILLed (STUB_INTERRUPT).
# Between the installer's own file writes (#50): after each group of them, and
# once a write is recorded but not made, at the installer's test kill points
# (AIDEV_TEST_KILL). Each kill is on a first install. Uninstall then
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

interrupt() { # interrupt <sb> <VAR=value>  — a first install, SIGKILLed where VAR=value says
	(run_in "$1" full "$2" -- "$installer") 2>/dev/null # the shell's "Killed" notice
}

last_call_is() { # last_call_is <sb> <name> <args prefix>
	tail -n 1 "$1/stub.log" | grep -qF -- "$2|$3"
}

# An uninterrupted install's records, one per sandbox kind.
reference_records() { # reference_records <plain|rich>
	local ref=$tmp/sb/ref-$1
	if [ ! -d "$ref" ]; then
		new_sandbox "ref-$1" "$(rich_arg "$1")" >/dev/null
		install_in "$ref"
	fi
	records "$ref"
}

rich_arg() { # rich_arg <plain|rich>  — new_sandbox's second argument
	case $1 in
	rich) printf rich ;;
	*) ;;
	esac
}

# interrupted <label> <VAR=value> <plain|rich> <rerun-check> [<stub name> <args prefix>]
# <rerun-check> <label> <sb> runs once the re-run is done, its output in
# <sb>/out.txt (`:` for none). With a stub call named, the kill must come at it.
interrupted() {
	local label="$1 ($3)" kill=$2 kind=$3 rerun_check=$4 sb before status
	local slug=${label//[^A-Za-z0-9.-]/-}
	shift 4

	sb=$(new_sandbox "uninstall-$slug" "$(rich_arg "$kind")")
	before=$(snapshot "$sb/home")
	interrupt "$sb" "$kill"
	check "$label: the install was killed" test $? -ne 0
	if [ $# -gt 0 ]; then check "$label: at that call" last_call_is "$sb" "$@"; fi
	uninstall_in "$sb" --purge --yes
	status=$?
	check "$label: uninstall right after exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
	check "$label: uninstall right after restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

	sb=$(new_sandbox "rerun-$slug" "$(rich_arg "$kind")")
	before=$(snapshot "$sb/home")
	interrupt "$sb" "$kill"
	install_in "$sb"
	status=$?
	check "$label: the re-run exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
	check "$label: the re-run finds nothing of ours installed from elsewhere" bash -c '! grep -qF "from elsewhere" "$1"' _ "$sb/out.txt"
	check "$label: the re-run records what an uninterrupted install does" test "$(records "$sb")" = "$(reference_records "$kind")"
	"$rerun_check" "$label" "$sb"
	uninstall_in "$sb" --purge --yes
	check "$label: uninstall after the re-run restores the snapshot" test "$(snapshot "$sb/home")" = "$before"
}

# The skills CLI has copied half the skills, and written its lock for those.
interrupted skills-add-partway STUB_INTERRUPT=skills-add-partway plain : npx "--yes $skills_pin add "
# The skills CLI has copied every skill and written its lock.
interrupted skills-add STUB_INTERRUPT=skills-add plain : npx "--yes $skills_pin add "
interrupted skills-add STUB_INTERRUPT=skills-add rich : npx "--yes $skills_pin add "
# The standing-orders block is appended; the beads installer has just begun.
interrupted bd-ready STUB_INTERRUPT=bd-ready plain : bd "ready"
interrupted bd-ready STUB_INTERRUPT=bd-ready rich : bd "ready"
# bd init has created the mate's home database; its orders block is not appended yet.
interrupted bd-init STUB_INTERRUPT=bd-init plain : bd "init"

# --- killed between the installer's own writes (#50) -----------------------------
#
# At the installer's kill points (AIDEV_TEST_KILL), each named for one file:
# `record` once what its write may create is recorded and saved, `copied` once
# its backup is copied, `written` once it is written.

# The re-run takes none of the installer's own files, blocks or entries for the
# operator's.
reran_as_ours() { # reran_as_ours <label> <sb>
	check "$1: the re-run backs up none of its own files" bash -c '! grep -qF "already existed" "$1"' _ "$2/out.txt"
	check "$1: the re-run finds none of its own blocks or entries unrecorded" bash -c '! grep -qF "not added by this install" "$1"' _ "$2/out.txt"
}

# After each group of writes, at its last write: the agents; the routing hook's
# files and its settings.json entry; the model sheet; the CLAUDE.md block; the
# license copies.
last_agent=$(node -e 'import(process.argv[1]).then((l) => console.log(l.repoAgents().at(-1).name))' "$repo/scripts/lib/aidev-install.mjs")
for file in ".claude/agents/$last_agent.md" .claude/settings.json .claude/pstack-models.md .claude/CLAUDE.md .local/share/aidev/licenses/LICENSE-repository; do
	for kind in plain rich; do
		interrupted "written ~/$file" "AIDEV_TEST_KILL=written ~/$file" "$kind" reran_as_ours
	done
done

# A write recorded and saved, but not made: a shared file's new part, and a
# file whose whole content is ours, new or (rich) replacing the operator's.
for file in settings.json CLAUDE.md agents/comment-sicko.md; do
	interrupted "record ~/.claude/$file" "AIDEV_TEST_KILL=record ~/.claude/$file" plain reran_as_ours
done
for file in settings.json CLAUDE.md; do
	interrupted "record ~/.claude/$file" "AIDEV_TEST_KILL=record ~/.claude/$file" rich reran_as_ours
done

# The operator's agent, recorded for a backup not yet copied, or copied and not
# yet replaced: the re-run replaces it once and keeps the backup.
replaced_once() { # replaced_once <label> <sb>
	local agent=$2/home/.claude/agents/comment-sicko.md
	check "$1: the re-run replaces the operator's agent once" test "$(grep -F "already existed" "$2/out.txt")" = "install: $agent already existed — backed up and replaced; uninstall restores it"
	check "$1: the re-run keeps its backup" manifest_true "$2" 'm.items.some((i) => i.kind === "backup" && i.of === "'"$agent"'" && require("fs").readFileSync(i.path, "utf8").includes("the operator wrote this one"))'
}
for point in record copied; do
	interrupted "$point ~/.claude/agents/comment-sicko.md" "AIDEV_TEST_KILL=$point ~/.claude/agents/comment-sicko.md" rich replaced_once
done

# captain.md, which the orders scripts write: its record and backup are saved
# before the first script runs.
for point in record copied; do
	interrupted "$point ~/$mate_rel/data/captain.md" "AIDEV_TEST_KILL=$point ~/$mate_rel/data/captain.md" rich :
done

# A backup recorded but never copied, and the operator's agent edited before
# the re-run: the re-run backs up the edited agent, which uninstall restores.
edited_before_copy() {
	local label="the operator's agent edited after a kill before its backup" sb before agent edited
	sb=$(new_sandbox edited-before-copy rich)
	agent=$sb/home/.claude/agents/comment-sicko.md
	before=$(snapshot "$sb/home" | grep -vF agents/comment-sicko.md)
	interrupt "$sb" "AIDEV_TEST_KILL=record ~/.claude/agents/comment-sicko.md"
	check "$label: the install was killed" test $? -ne 0
	printf 'OPERATOR: edited.\n' >>"$agent"
	edited=$(cat "$agent")
	install_in "$sb"
	check "$label: the re-run exits 0" test $? -eq 0
	uninstall_in "$sb" --purge --yes
	check "$label: uninstall exits 0" test $? -eq 0
	check "$label: uninstall restores the edited agent" test "$(cat "$agent")" = "$edited"
	check "$label: everything else is restored" test "$(snapshot "$sb/home" | grep -vF agents/comment-sicko.md)" = "$before"
}
edited_before_copy

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
	interrupt "$sb" STUB_INTERRUPT=bd-ready
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
	interrupt "$sb" STUB_INTERRUPT=bd-ready
	unsettle_standing_orders "$sb"
	check "$label: the record is an intent" manifest_true "$sb" 'm.items.some((i) => i.id === "aidev-standing-orders" && i.at && !("before" in i))'
	uninstall_in "$sb" --purge --yes
	status=$?
	check "$label: uninstall right after exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
	check "$label: uninstall right after restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

	sb=$(new_sandbox "rerun-unsettled-$kind" "${1:-}")
	before=$(snapshot "$sb/home")
	interrupt "$sb" STUB_INTERRUPT=bd-ready
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
	interrupt "$sb" STUB_INTERRUPT=bd-ready
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
	interrupt "$sb" STUB_INTERRUPT=bd-ready
	check "$label: the install was killed" test $? -ne 0
	printf 'OPERATOR: never deploy on Fridays.\n' >>"$(captain_of "$sb")"
	install_in "$sb"
	status=$?
	check "$label: the re-run exits 0" test "$status" -eq 0
	check "$label: the re-run records nothing for captain.md" manifest_true "$sb" '!m.items.some((i) => (i.path ?? i.of).endsWith("/captain.md"))'
	check "$label: the re-run removed the backup" test -z "$(ls "$sb/home/.local/state/aidev/backups" 2>/dev/null)"
}
foreign_blocks_edited

# ...but once a script has upgraded a block that is not ours, the backup holds
# the text before the upgrade, and every later run keeps it, killed or not.
captain_backed_up() { # captain_backed_up <sb>
	manifest_true "$1" 'm.items.some((i) => i.kind === "backup" && i.of.endsWith("/captain.md") && require("fs").existsSync(i.path))'
}
foreign_block_upgraded() {
	local label="an older standing-orders block, not ours" ref sb
	ref=$(new_sandbox ref-foreign-older)
	install_in "$ref"
	for run in clean killed; do
		sb=$(new_sandbox "foreign-older-$run")
		sed 's/^7\. \*\*Retro after landings\.\*\*/7. **Retro after each landing.**/' "$(captain_of "$ref")" >"$(captain_of "$sb")"
		check "$label ($run): the block is older" grep -q 'Retro after each landing' "$(captain_of "$sb")"
		if [ "$run" = clean ]; then
			install_in "$sb"
			check "$label ($run): the first run upgrades it" out_has "$sb" "upgraded the standing orders block"
		else
			interrupt "$sb" STUB_INTERRUPT=bd-ready
			check "$label ($run): the install was killed once it had upgraded it" test $? -ne 0
		fi
		check "$label ($run): the run keeps the backup" captain_backed_up "$sb"
		install_in "$sb"
		check "$label ($run): the next run exits 0" test $? -eq 0
		check "$label ($run): the next run keeps the backup" captain_backed_up "$sb"
	done
}
foreign_block_upgraded

# --- the standing-orders script stopped on a captain.md it creates ----------------
#
# From a git copy of this checkout whose standing-orders script runs a command
# either right after writing the header to the captain.md it creates, or before
# writing anything. The re-run runs the script unchanged.

kill_copy=$tmp/kill-copy
check "the checkout copies for the standing-orders cases" git_copy_with_worktree "$kill_copy"
kill_script=$kill_copy/main/scripts/install-standing-orders.sh
cp "$kill_script" "$tmp/standing-orders.orig"

break_standing_orders() { # break_standing_orders <after-header|before-header> <command>
	cp "$tmp/standing-orders.orig" "$kill_script"
	if [ "$1" = after-header ]; then
		sed -i "s|^\tprintf 'created %s\\\\n' \"\$target\"|&\n\t$2|" "$kill_script"
	else
		sed -i "s|^target=\"\\\$home/data/captain.md\"|$2\n&|" "$kill_script"
	fi
	grep -qxF "	$2" "$kill_script" || grep -qxF "$2" "$kill_script"
}

# killed_in_standing_orders <name> <after-header|before-header> <captain.md the kill leaves, or <absent>> [text added after the kill]
# A first install killed there, then the text added, a re-run and uninstall,
# each step checked; sets sb and before for the case's own checks.
killed_in_standing_orders() {
	local name=$1 where=$2 left=$3 text=${4:-} label="$1: killed $2" status
	sb=$(new_sandbox "$name")
	before=$(snapshot "$sb/home")
	check "$label: the script is broken there" break_standing_orders "$where" 'kill -9 $PPID $$'
	(run_in "$sb" full -- "$kill_copy/main/scripts/install.mjs") 2>/dev/null # the shell's "Killed" notice
	check "$label: the install was killed" test $? -ne 0
	check "$label: the kill leaves captain.md as expected" test "$(cat "$(captain_of "$sb")" 2>/dev/null || printf '<absent>')" = "$left"
	cp "$tmp/standing-orders.orig" "$kill_script"
	if [ -n "$text" ]; then printf '%s' "$text" >>"$(captain_of "$sb")"; fi
	run_in "$sb" full -- "$kill_copy/main/scripts/install.mjs"
	status=$?
	check "$label: the re-run exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
	run_in "$sb" full -- "$kill_copy/main/scripts/uninstall.mjs" --purge --yes
	status=$?
	check "$label: uninstall exits 0" test "$status" -eq 0
	[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
}

killed_in_standing_orders kill-header after-header '# Standing orders'
check "kill-header: uninstall takes the header with the block, restoring the snapshot" test "$(snapshot "$sb/home")" = "$before"

killed_in_standing_orders kill-header-edited after-header '# Standing orders' $'OPERATOR: never deploy on Fridays.\n'
check "kill-header-edited: uninstall keeps the header and the operator's line" \
	test "$(cat "$(captain_of "$sb")")" = "$(printf '# Standing orders\n\nOPERATOR: never deploy on Fridays.')"

# firstmate seeds captain.md from its template whenever the mate launches.
seeded=$'# Captain\'s standing orders\n\nOPERATOR: never deploy on Fridays.\n'
killed_in_standing_orders kill-before-header before-header '<absent>' "$seeded"
check "kill-before-header: uninstall leaves the captain.md seeded since as it was" test "$(cat "$(captain_of "$sb")")" = "$(printf '%s' "$seeded")"

# A script that fails after the header, no kill: the re-run takes the header
# with its block.
sb=$(new_sandbox fail-header)
before=$(snapshot "$sb/home")
check "fail-header: the script is broken there" break_standing_orders after-header 'exit 1'
run_in "$sb" full -- "$kill_copy/main/scripts/install.mjs"
check "fail-header: the install fails" test $? -ne 0
check "fail-header: it leaves the header" test "$(cat "$(captain_of "$sb")")" = '# Standing orders'
cp "$tmp/standing-orders.orig" "$kill_script"
run_in "$sb" full -- "$kill_copy/main/scripts/install.mjs"
check "fail-header: the re-run exits 0" test $? -eq 0
run_in "$sb" full -- "$kill_copy/main/scripts/uninstall.mjs" --purge --yes
check "fail-header: uninstall after the re-run restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

summary
