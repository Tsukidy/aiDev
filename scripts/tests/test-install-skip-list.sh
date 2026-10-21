#!/usr/bin/env bash
#
# Tests for the beads onboarding skip list in install.mjs and uninstall.mjs
# (#34): install adds this checkout's root to the operator-owned skip list,
# once, recorded in the manifest, before the plugin is registered; uninstall
# takes back only that entry. On the shared harness of lib/install-harness.sh;
# fully offline.
#
# Usage: tests/test-install-skip-list.sh

set -uo pipefail
. "$(dirname "$0")/lib/install-harness.sh"

skip_list_of() { # skip_list_of <sb>
	printf '%s\n' "$1/home/.config/aidev/beads-onboarding-skip"
}

# The list's entries, one per line, as the plugin reads them: comments and
# blank lines dropped.
entries() { # entries <sb>
	sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$(skip_list_of "$1")" | grep -v '^$'
}

recorded() { # recorded <sb>  — the manifest records our entry
	manifest_true "$1" "m.items.some((i) => i.kind === 'skip-entry' && i.entry === '$repo')"
}

not() { ! "$@"; }

# --- a fresh install adds the repo root, once, and uninstall takes the list back out ---------

sb=$(new_sandbox skip-fresh)
before=$(snapshot "$sb/home")
install_in "$sb" --dry-run
check "the dry run names the skip-list entry" out_has "$sb" "$repo to the beads onboarding skip list"
check "the dry run writes no skip list" test ! -e "$(skip_list_of "$sb")"
install_in "$sb"
check "install exits 0" test $? -eq 0
check "install creates the skip list with this checkout's root as its one entry" test "$(entries "$sb")" = "$repo"
check "install records the entry in the manifest" recorded "$sb"
list=$(cat "$(skip_list_of "$sb")")
manifest=$(cat "$(manifest_of "$sb")")
install_in "$sb"
check "a second install exits 0" test $? -eq 0
check "a second install leaves the skip list byte-identical" test "$(cat "$(skip_list_of "$sb")")" = "$list"
check "a second install leaves the manifest byte-identical" test "$(cat "$(manifest_of "$sb")")" = "$manifest"
uninstall_in "$sb" --dry-run
check "the uninstall dry run names the entry it removes" out_has "$sb" "remove $repo from the beads onboarding skip list"
uninstall_in "$sb" --purge --yes
check "uninstall exits 0" test $? -eq 0
check "uninstall deletes the skip list the install created" test ! -e "$(skip_list_of "$sb")"
check "install → uninstall restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# --- the operator's entries survive install and uninstall --------------------------------------

sb=$(new_sandbox skip-operator)
mkdir -p "$(dirname "$(skip_list_of "$sb")")"
printf '# my projects\n/opt/scratch\n~/sandbox' >"$(skip_list_of "$sb")" # no final newline
chmod 600 "$(skip_list_of "$sb")"
before=$(snapshot "$sb/home")
install_in "$sb"
check "install over an operator's skip list exits 0" test $? -eq 0
check "install keeps the operator's entries and appends ours" \
	test "$(entries "$sb")" = "$(printf '/opt/scratch\n~/sandbox\n%s' "$repo")"
check "install keeps the operator's text byte for byte in front of ours" has_prefix "$(skip_list_of "$sb")" '# my projects\n/opt/scratch\n~/sandbox\n'
check "install keeps the list's mode" test "$(stat -c %a "$(skip_list_of "$sb")")" = 600
uninstall_in "$sb" --purge --yes
check "uninstall exits 0" test $? -eq 0
check "uninstall puts the operator's skip list back as it was" test "$(snapshot "$sb/home")" = "$before"

# ...and an entry the operator adds after install stays; only ours goes.
sb=$(new_sandbox skip-added-later)
install_in "$sb"
printf '/opt/added-later\n' >>"$(skip_list_of "$sb")"
uninstall_in "$sb" --purge --yes
check "uninstall with an entry added after install exits 0" test $? -eq 0
check "uninstall removes only our entry" test "$(entries "$sb")" = /opt/added-later

# --- the operator already lists this checkout: nothing added, nothing taken -------------------

sb=$(new_sandbox skip-already)
mkdir -p "$(dirname "$(skip_list_of "$sb")")" "$tmp/links"
ln -sfn "$repo" "$tmp/links/aidev"
printf '%s/\n' "$tmp/links/aidev" >"$(skip_list_of "$sb")" # the same directory, by another path
list=$(cat "$(skip_list_of "$sb")")
install_in "$sb"
check "install over a list that already names this checkout exits 0" test $? -eq 0
check "install adds no second entry for it" test "$(cat "$(skip_list_of "$sb")")" = "$list"
check "install records no entry it did not add" not recorded "$sb"
uninstall_in "$sb" --purge --yes
check "uninstall leaves the operator's entry for this checkout" test "$(cat "$(skip_list_of "$sb")")" = "$list"

# --- converging ------------------------------------------------------------------------------

# Our entry, deleted by the operator, comes back on the next run (as our hook entry does).
sb=$(new_sandbox skip-deleted)
install_in "$sb"
: >"$(skip_list_of "$sb")"
install_in "$sb"
check "a re-run after our entry was deleted exits 0" test $? -eq 0
check "a re-run puts our deleted entry back, once" test "$(entries "$sb")" = "$repo"
uninstall_in "$sb" --purge --yes
check "uninstall then deletes the list the install created" test ! -e "$(skip_list_of "$sb")"

# An install from before #34 (a version-2 manifest, no skip list) gains the entry.
sb=$(new_sandbox skip-from-v2)
before=$(snapshot "$sb/home")
install_in "$sb"
rm "$(skip_list_of "$sb")"
json_edit "$(manifest_of "$sb")" '(m) => { m.schemaVersion = 2; m.items = m.items.filter((i) => i.kind !== "skip-entry"); }'
install_in "$sb"
check "a re-run over a version-2 manifest exits 0" test $? -eq 0
check "it adds this checkout to the skip list" test "$(entries "$sb")" = "$repo"
check "it records the entry" recorded "$sb"
check "it saves the manifest as version 3" manifest_true "$sb" 'm.schemaVersion === 3'
uninstall_in "$sb" --purge --yes
check "uninstall after that restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# The entry is recorded and written before the daemon is asked: an install
# interrupted at the plugin's registration has already skipped this checkout.
sb=$(new_sandbox skip-interrupted)
before=$(snapshot "$sb/home")
(run_in "$sb" full STUB_FAIL=paseo-interrupt -- "$installer") 2>/dev/null # the shell's "Killed" notice
check "the interrupted install did not finish" test $? -ne 0
check "the interrupted install had written our entry" test "$(entries "$sb")" = "$repo"
check "the interrupted install had recorded it" recorded "$sb"
uninstall_in "$sb" --purge --yes
check "uninstall after the interrupted install restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# A skip list that is not a file is refused before anything is written.
sb=$(new_sandbox skip-not-a-file)
mkdir -p "$(skip_list_of "$sb")"
before=$(snapshot "$sb/home")
install_in "$sb"
check "install refuses a skip list that is a directory" test $? -ne 0
check "the refusal names the skip list" out_has "$sb" "$(skip_list_of "$sb")"
check "the refusal writes nothing" test "$(snapshot "$sb/home")" = "$before"

summary
