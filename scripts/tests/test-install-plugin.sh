#!/usr/bin/env bash
#
# Tests for the onboarding plugin step of install.mjs and uninstall.mjs (#33):
# the daemon call install makes for the plugin's registration, and that
# uninstall takes back exactly ours, against the stub daemon of
# lib/cli-stub.mjs, which, like Paseo, registers a plugin before building it
# and keeps it, as failed, when the build fails. On the shared harness of
# lib/install-harness.sh; fully offline.
#
# Usage: tests/test-install-plugin.sh

set -uo pipefail
. "$(dirname "$0")/lib/install-harness.sh"

# The states the step converges from.

# What an install that failed at the daemon before #33 left: the copy recorded,
# the registration failed, no plugin item.
forget_plugin() { # forget_plugin <sb>
	json_edit "$(manifest_of "$1")" '(m) => { m.items = m.items.filter((i) => i.kind !== "plugin"); }'
}

# The copy holds an older version of one of its files, as after a repo update.
age_copy() { # age_copy <sb>
	local f
	f=$(plugin_copy "$1")/README.md
	printf 'an older README\n' >"$f"
	json_edit "$(manifest_of "$1")" "(m) => {
		m.items.find((i) => i.path === '$f').sha256 = require('crypto').createHash('sha256').update(require('fs').readFileSync('$f')).digest('hex');
	}"
}

set_plugin_status() { # set_plugin_status <sb> <status>  — what the stub daemon reports
	json_edit "$1/state/paseo-plugins.json" "(list) => { for (const p of list) p.status = '$2'; }"
}

plugin_recorded() { # plugin_recorded <sb>  — the manifest holds our plugin item
	manifest_true "$1" "m.items.some((i) => i.kind === 'plugin' && i.id === '$plugin_id')"
}

# --- the plugin copy outlives a failed plugin removal --------------------------------------

sb=$(new_sandbox plugin-remove-fails)
install_in "$sb"
run_in "$sb" full STUB_FAIL=paseo-remove -- "$uninstaller"
check "a failed plugin removal makes uninstall exit nonzero" test $? -ne 0
check "the plugin's source copy is still there for the daemon" test -f "$(plugin_copy "$sb")/index.server.ts"
uninstall_in "$sb" --purge --yes
check "a later uninstall finishes the job" test ! -e "$(manifest_of "$sb")"

# --- a failed build still registers the plugin; it is recorded, and uninstall takes it back -

sb=$(new_sandbox plugin-build-fails)
before=$(snapshot "$sb/home")
run_in "$sb" full STUB_FAIL=paseo-build -- "$installer"
check "a failing plugin build makes the install exit nonzero" test $? -ne 0
check "the daemon kept the failed registration (as Paseo does)" plugin_status_is "$sb" failed
check "the failed registration is recorded in the manifest" plugin_recorded "$sb"
uninstall_in "$sb" --purge --yes
check "uninstall after a failed plugin build exits 0" test $? -eq 0
check "uninstall after a failed plugin build leaves no registration" plugin_status_is "$sb" ""
check "install with a failed plugin build → uninstall restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# --- the state the #21 installer left on the operator machine converges on re-run ----------

sb=$(new_sandbox plugin-failed-unrecorded)
before=$(snapshot "$sb/home")
run_in "$sb" full STUB_FAIL=paseo-build -- "$installer"
forget_plugin "$sb"
: >"$sb/stub.log"
install_in "$sb"
status=$?
check "re-running over an unrecorded failed registration from our copy exits 0" test "$status" -eq 0
[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
check "the re-run rebuilds it with reload, not a second install" test "$(plugin_calls "$sb")" = "plugin reload $plugin_id"
check "the re-run leaves the plugin running" plugin_status_is "$sb" running
check "the re-run records the plugin in the manifest" plugin_recorded "$sb"
uninstall_in "$sb" --purge --yes
check "uninstall after the converged re-run leaves no registration" plugin_status_is "$sb" ""
check "uninstall after the converged re-run restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# ...and uninstall alone takes that registration back too.
sb=$(new_sandbox plugin-failed-uninstall)
before=$(snapshot "$sb/home")
run_in "$sb" full STUB_FAIL=paseo-build -- "$installer"
forget_plugin "$sb"
uninstall_in "$sb" --purge --yes
check "uninstall over an unrecorded failed registration exits 0" test $? -eq 0
check "uninstall removes the unrecorded registration from our copy" plugin_status_is "$sb" ""
check "uninstall over an unrecorded failed registration restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# --- a running plugin whose copy is out of date is reloaded; the dry run names it ----------

sb=$(new_sandbox plugin-changed)
install_in "$sb"
age_copy "$sb"
: >"$sb/stub.log"
install_in "$sb" --dry-run
check "the dry run names the reload the run makes" out_has "$sb" "then paseo plugin reload $plugin_id"
install_in "$sb"
check "re-running over an out-of-date copy exits 0" test $? -eq 0
check "a running plugin whose copy changed is reloaded" test "$(plugin_calls "$sb")" = "plugin reload $plugin_id"
check "the out-of-date copy is current again" cmp -s "$plugin_src/README.md" "$(plugin_copy "$sb")/README.md"
check "the reloaded plugin is running" plugin_status_is "$sb" running

# --- a plugin disabled in Paseo stays disabled; its copy is still refreshed -----------------
#
# The stub, like Paseo, refuses to reload a disabled plugin.

sb=$(new_sandbox plugin-disabled)
install_in "$sb"
age_copy "$sb"
set_plugin_status "$sb" disabled
: >"$sb/stub.log"
install_in "$sb"
check "re-running with the plugin disabled in Paseo exits 0" test $? -eq 0
check "a disabled plugin is neither reloaded nor reinstalled" test -z "$(plugin_calls "$sb")"
check "a disabled plugin's copy is refreshed" cmp -s "$plugin_src/README.md" "$(plugin_copy "$sb")/README.md"
check "a disabled plugin stays disabled" plugin_status_is "$sb" disabled

# --- a plugin of that id registered from anywhere else is not ours ---------------------------

sb=$(new_sandbox plugin-foreign)
printf '[{"id":"%s","path":"/opt/elsewhere","status":"running"}]' "$plugin_id" >"$sb/state/paseo-plugins.json"
install_in "$sb"
check "install with the plugin registered from elsewhere exits 0" test $? -eq 0
uninstall_in "$sb" --purge --yes
check "install and uninstall leave a plugin registered from elsewhere alone" test -z "$(plugin_calls "$sb")"
check "the plugin registered from elsewhere is still there" plugin_status_is "$sb" running

summary
