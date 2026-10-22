#!/usr/bin/env bash
#
# Tests for the Paseo plugins step of install.mjs and uninstall.mjs (#33):
# the daemon call install makes for the plugin's registration, and that
# uninstall takes back exactly ours, against the stub daemon of
# lib/cli-stub.mjs, which, like Paseo, registers a plugin before building it
# and keeps it, as failed, when the build fails. A copy of this checkout that
# lists a second, fixture plugin shows the step over more than one plugin
# (#39). On the shared harness of lib/install-harness.sh; fully offline.
#
# Usage: tests/test-install-plugin.sh

set -uo pipefail
. "$(dirname "$0")/lib/install-harness.sh"

# The states the step converges from.

forget_plugin() { # forget_plugin <sb>  — the manifest records no plugin item
	json_edit "$(manifest_of "$1")" '(m) => { m.items = m.items.filter((i) => i.kind !== "plugin"); }'
}

# Record a copy file's current content as what the installer wrote, as if an
# older install had placed it.
record_as_ours() { # record_as_ours <sb> <file>
	json_edit "$(manifest_of "$1")" "(m) => {
		m.items.find((i) => i.path === '$2').sha256 = require('crypto').createHash('sha256').update(require('fs').readFileSync('$2')).digest('hex');
	}"
}

set_plugin_status() { # set_plugin_status <sb> <status>  — what the stub daemon reports
	json_edit "$1/state/paseo-plugins.json" "(list) => { for (const p of list) p.status = '$2'; }"
}

# The daemon last built an older version of the plugin, as before a repo
# update: a build input of the copy holds older content, recorded as ours,
# and the stored build state is that older build's.
age_build() { # age_build <sb>
	local f
	f=$(plugin_copy "$1")/index.server.ts
	printf '// an older build\n' >>"$f"
	record_as_ours "$1" "$f"
	json_edit "$(manifest_of "$1")" "(m) => { m.items.find((i) => i.kind === 'plugin').buildSha256 = 'the-older-build'; }"
}

# What the #21 installer left on the operator machine (after an install here):
# the copy of the pre-#33 source, which imports @getpaseo/client and so does
# not build where it lies, recorded as ours, with the README.md the copy then
# held; the registration failed; no plugin item, in a manifest of schema
# version 1.
pre33_state() { # pre33_state <sb>
	local f
	f=$(plugin_copy "$1")/index.server.ts
	sed 's|^type PaseoApi = PluginHookContext\["paseo"\];$|import type { PaseoApi } from "@getpaseo/client";|' "$plugin_src/index.server.ts" >"$f"
	grep -q '"@getpaseo/client"' "$f" || { echo "pre33_state: the PaseoApi line moved; update this helper" >&2; return 1; }
	record_as_ours "$1" "$f"
	printf 'the README the old copy held\n' >"$(plugin_copy "$1")/README.md"
	json_edit "$(manifest_of "$1")" "(m) => {
		m.items.push({ kind: 'file', path: '$(plugin_copy "$1")/README.md', sha256: require('crypto').createHash('sha256').update('the README the old copy held\\n').digest('hex'), existedBefore: false });
	}"
	set_plugin_status "$1" failed
	forget_plugin "$1"
	json_edit "$(manifest_of "$1")" '(m) => { m.schemaVersion = 1; }'
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
check "the plugin stays recorded until its registration is gone" plugin_recorded "$sb"
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

# --- an install interrupted at the daemon leaves nothing uninstall cannot find --------------

sb=$(new_sandbox plugin-interrupted)
before=$(snapshot "$sb/home")
(run_in "$sb" full STUB_INTERRUPT=paseo-install -- "$installer") 2>/dev/null # the shell's "Killed" notice
check "the interrupted install did not finish" test $? -ne 0
uninstall_in "$sb" --purge --yes
check "uninstall after an interrupted install exits 0" test $? -eq 0
check "uninstall after an interrupted install leaves no registration" plugin_status_is "$sb" ""
check "an interrupted install → uninstall restores the snapshot, no empty directories left" \
	test "$(snapshot "$sb/home")" = "$before"

# --- the state the #21 installer left on the operator machine converges on re-run ----------
#
# The stub builds the copy where it lies, so the plugin runs only if the new
# source is placed before the daemon is asked to reload it.

sb=$(new_sandbox plugin-failed-unrecorded)
before=$(snapshot "$sb/home")
install_in "$sb"
pre33_state "$sb"
: >"$sb/stub.log"
install_in "$sb"
status=$?
check "re-running over an unrecorded failed registration from our copy exits 0" test "$status" -eq 0
[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
check "the re-run rebuilds it with reload, not a second install" test "$(plugin_calls "$sb")" = "plugin reload $plugin_id"
check "the re-run leaves the plugin running" plugin_status_is "$sb" running
check "the re-run records the plugin in the manifest" plugin_recorded "$sb"
check "the re-run leaves the README the copy no longer holds to uninstall" test -f "$(plugin_copy "$sb")/README.md"
uninstall_in "$sb" --purge --yes
check "uninstall after the converged re-run leaves no registration" plugin_status_is "$sb" ""
check "uninstall after the converged re-run restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# ...and uninstall alone takes that registration back too.
sb=$(new_sandbox plugin-failed-uninstall)
before=$(snapshot "$sb/home")
install_in "$sb"
pre33_state "$sb"
uninstall_in "$sb" --purge --yes
check "uninstall over an unrecorded failed registration exits 0" test $? -eq 0
check "uninstall removes the unrecorded registration from our copy" plugin_status_is "$sb" ""
check "uninstall over an unrecorded failed registration restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# ...also when the copy's paseo-plugin.json is gone, or names another id: the
# upgrade takes the id from the copy directory's name.
sb=$(new_sandbox plugin-failed-no-manifest-file)
install_in "$sb"
pre33_state "$sb"
rm "$(plugin_copy "$sb")/paseo-plugin.json"
uninstall_in "$sb" --purge --yes
check "uninstall over a pre-#33 copy without its paseo-plugin.json exits 0" test $? -eq 0
check "it removes the unrecorded registration" plugin_status_is "$sb" ""
sb=$(new_sandbox plugin-failed-edited-id)
install_in "$sb"
pre33_state "$sb"
printf '{"id": "someone-else"}\n' >"$(plugin_copy "$sb")/paseo-plugin.json"
uninstall_in "$sb" --purge --yes
check "uninstall over a pre-#33 copy whose paseo-plugin.json names another id exits 0" test $? -eq 0
check "it still removes our unrecorded registration" plugin_status_is "$sb" ""

# --- the pre-#33 upgrade runs once: an interrupted uninstall does not bring the plugin back --

sb=$(new_sandbox plugin-upgrade-once)
before=$(snapshot "$sb/home")
install_in "$sb"
run_in "$sb" full STUB_FAIL=skills-remove -- "$uninstaller"
check "an uninstall whose skills removal fails exits nonzero" test $? -ne 0
check "it removed the plugin's registration first" plugin_status_is "$sb" ""
run_in "$sb" full STUB_FAIL=paseo-ls -- "$uninstaller" --purge --yes
check "the next uninstall finishes without the daemon: no plugin record came back" test $? -eq 0
check "that uninstall restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# --- a running plugin whose build is out of date is reloaded; the dry run names it ---------

sb=$(new_sandbox plugin-changed)
install_in "$sb"
age_build "$sb"
: >"$sb/stub.log"
install_in "$sb" --dry-run
check "the dry run names the reload the run makes" out_has "$sb" "then paseo plugin reload $plugin_id"
install_in "$sb"
check "re-running over an out-of-date build exits 0" test $? -eq 0
check "a running plugin whose build is out of date is reloaded" test "$(plugin_calls "$sb")" = "plugin reload $plugin_id"
check "the out-of-date copy is current again" cmp -s "$plugin_src/index.server.ts" "$(plugin_copy "$sb")/index.server.ts"
check "the reloaded plugin is running" plugin_status_is "$sb" running

# --- a reload that fails is retried by the next run ------------------------------------------

sb=$(new_sandbox plugin-reload-fails)
install_in "$sb"
age_build "$sb"
run_in "$sb" full STUB_FAIL=paseo-reload -- "$installer"
check "a failing reload makes the install exit nonzero" test $? -ne 0
: >"$sb/stub.log"
install_in "$sb"
check "the run after a failed reload exits 0" test $? -eq 0
check "the run after a failed reload retries it" test "$(plugin_calls "$sb")" = "plugin reload $plugin_id"
check "the retried plugin is running" plugin_status_is "$sb" running

# --- a reload interrupted once the daemon is done converges on re-run -------------------------

sb=$(new_sandbox plugin-reload-interrupted)
before=$(snapshot "$sb/home")
install_in "$sb"
age_build "$sb"
: >"$sb/stub.log"
(run_in "$sb" full STUB_INTERRUPT=paseo-reload -- "$installer") 2>/dev/null # the shell's "Killed" notice
check "the install interrupted at the reload did not finish" test $? -ne 0
check "the interrupted call was the reload" test "$(plugin_calls "$sb")" = "plugin reload $plugin_id"
: >"$sb/stub.log"
install_in "$sb"
check "the run after an interrupted reload exits 0" test $? -eq 0
check "it reloads once more: the interrupted build was never recorded" test "$(plugin_calls "$sb")" = "plugin reload $plugin_id"
check "it finds the copy as recorded, not edited" bash -c '! grep -qF "modified since install" "$1"' _ "$sb/out.txt"
check "the plugin is running" plugin_status_is "$sb" running
: >"$sb/stub.log"
install_in "$sb"
check "the run after that makes no daemon call" test -z "$(plugin_calls "$sb")"
uninstall_in "$sb" --purge --yes
check "uninstall after the converged re-run exits 0" test $? -eq 0
check "an interrupted reload → re-run → uninstall restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# --- an operator's edit of the copy reloads the plugin once, not on every run ----------------

sb=$(new_sandbox plugin-edited)
install_in "$sb"
printf '// the operator was here\n' >>"$(plugin_copy "$sb")/index.server.ts"
: >"$sb/stub.log"
install_in "$sb"
first=$?
install_in "$sb"
check "two runs over an operator-edited copy exit 0" test "$first$?" = 00
check "an operator-edited copy is reloaded once over two runs" test "$(plugin_calls "$sb")" = "plugin reload $plugin_id"
check "the operator's edit is kept" grep -qF 'the operator was here' "$(plugin_copy "$sb")/index.server.ts"

# --- a plugin disabled in Paseo stays disabled; its copy is still refreshed -----------------
#
# The stub, like Paseo, refuses to reload a disabled plugin.

sb=$(new_sandbox plugin-disabled)
install_in "$sb"
age_build "$sb"
set_plugin_status "$sb" disabled
: >"$sb/stub.log"
install_in "$sb"
check "re-running with the plugin disabled in Paseo exits 0" test $? -eq 0
check "a disabled plugin is neither reloaded nor reinstalled" test -z "$(plugin_calls "$sb")"
check "a disabled plugin's copy is refreshed" cmp -s "$plugin_src/index.server.ts" "$(plugin_copy "$sb")/index.server.ts"
check "a disabled plugin stays disabled" plugin_status_is "$sb" disabled

# --- a plugin of that id registered from anywhere else is not ours ---------------------------

sb=$(new_sandbox plugin-foreign)
printf '[{"id":"%s","path":"/opt/elsewhere","status":"running"}]' "$plugin_id" >"$sb/state/paseo-plugins.json"
install_in "$sb"
check "install with the plugin registered from elsewhere exits 0" test $? -eq 0
uninstall_in "$sb" --purge --yes
check "install and uninstall leave a plugin registered from elsewhere alone" test -z "$(plugin_calls "$sb")"
check "the plugin registered from elsewhere is still there" plugin_status_is "$sb" running

# ...also when the manifest records our copy, as when the operator re-registered the id.
sb=$(new_sandbox plugin-foreign-recorded)
install_in "$sb"
json_edit "$sb/state/paseo-plugins.json" '(list) => { for (const p of list) p.path = "/opt/elsewhere"; }'
: >"$sb/stub.log"
install_in "$sb"
check "install with our recorded plugin re-registered from elsewhere exits 0" test $? -eq 0
uninstall_in "$sb" --purge --yes
check "uninstall with our recorded plugin re-registered from elsewhere exits 0" test $? -eq 0
check "install and uninstall leave that registration alone" test -z "$(plugin_calls "$sb")"
check "that registration is still there" plugin_status_is "$sb" running

# --- a registration recorded from a copy that has since moved is never orphaned --------------

sb=$(new_sandbox plugin-moved)
install_in "$sb"
snap=$(snapshot "$sb/home")
: >"$sb/stub.log"
run_in "$sb" full XDG_DATA_HOME="$sb/home/.local/share-moved" -- "$installer"
check "install refuses when the copy its recorded registration is from has moved" test $? -ne 0
check "the refusal says to run uninstall first" out_has "$sb" "run uninstall first"
check "the refusal writes nothing" test "$(snapshot "$sb/home")" = "$snap"
check "the refusal calls no mutating CLI" no_mutating_calls "$sb"
check "the registration from the moved copy is left in place" plugin_status_is "$sb" running

# --- uninstall under another XDG_DATA_HOME still takes back what the manifest records -------

sb=$(new_sandbox plugin-xdg-uninstall)
before=$(snapshot "$sb/home")
install_in "$sb"
run_in "$sb" full XDG_DATA_HOME="$sb/home/.local/share-moved" -- "$uninstaller" --purge --yes
check "uninstall under another XDG_DATA_HOME exits 0" test $? -eq 0
check "it removes the registration from the recorded copy" plugin_status_is "$sb" ""
check "it restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# --- a second listed plugin is installed, converges and uninstalls with the first (#39) ------
#
# From a git copy of this checkout with a fixture plugin added under its
# personal-extensions/ and listed after the beads onboarding plugin.

fixture_id=aidev-fixture-plugin
two=$tmp/two-plugins
check "the checkout copies for the two-plugin cases" git_copy_with_worktree "$two"
fixture=$two/main/personal-extensions/test-fixture-plugin
mkdir -p "$fixture"
printf '{"id": "%s"}\n' "$fixture_id" >"$fixture/paseo-plugin.json"
printf '{"name": "test-fixture-plugin", "private": true, "type": "module", "files": ["index.server.ts", "paseo-plugin.json", "package.json"]}\n' >"$fixture/package.json"
printf 'import { join } from "node:path";\nexport default { name: join("aidev", "fixture") };\n' >"$fixture/index.server.ts"
printf 'not in the files list\n' >"$fixture/README.md"

# The copy's PASEO_PLUGIN_DIRS: the beads onboarding plugin, then the given
# directories of its personal-extensions/.
list_plugins() { # list_plugins [dir ...]
	local lib=$two/main/scripts/lib/aidev-install.mjs dirs=ONBOARDING_PLUGIN_DIR d
	for d in "$@"; do dirs+=", join(REPO, 'personal-extensions', '$d')"; done
	sed -i "s|^export const PASEO_PLUGIN_DIRS = \[.*\];\$|export const PASEO_PLUGIN_DIRS = [$dirs];|" "$lib"
	grep -qxF "export const PASEO_PLUGIN_DIRS = [$dirs];" "$lib" || { echo "list_plugins: the PASEO_PLUGIN_DIRS line moved; update this helper" >&2; return 1; }
}
check "the checkout copy lists the fixture plugin" list_plugins test-fixture-plugin

two_install() { run_in "$1" full "${@:2}" -- "$two/main/scripts/install.mjs"; } # two_install <sb> [VAR=value ...]
two_uninstall() { run_in "$1" full -- "$two/main/scripts/uninstall.mjs" --purge --yes; }

first_installed() { printf 'plugin install %s\n' "$(plugin_copy "$1")"; }
second_installed() { printf 'plugin install %s\n' "$(plugin_copy "$1" "$fixture_id")"; }
second_reloaded() { printf 'plugin reload %s\n' "$fixture_id"; }
both_installed() { first_installed "$1" && second_installed "$1"; }

both_running() { plugin_status_is "$1" running && plugin_status_is "$1" running "$fixture_id"; }

plugin_records() { # plugin_records <sb>
	node -e '
		const [file, home] = process.argv.slice(1);
		const m = JSON.parse(require("fs").readFileSync(file, "utf8"));
		console.log(m.items.filter((i) => i.kind === "plugin").map((i) => JSON.stringify(i).replaceAll(home, "~")).join("\n"));
	' "$(manifest_of "$1")" "$1/home"
}

step_order() { # step_order <sb>
	grep -oE "to the beads onboarding skip list|plugin ($plugin_id|$fixture_id): copy to" "$1/out.txt"
}
expected_order=$(printf '%s\n' "to the beads onboarding skip list" "plugin $plugin_id: copy to" "plugin $fixture_id: copy to")

sb=$(new_sandbox two-plugins)
before=$(snapshot "$sb/home")
run_in "$sb" full -- "$two/main/scripts/install.mjs" --dry-run
check "the dry run names the skip-list entry, then each plugin's install, in order" test "$(step_order "$sb")" = "$expected_order"
check "the dry run names the second plugin's daemon call" out_has "$sb" "plugin $fixture_id: copy to $(plugin_copy "$sb" "$fixture_id"), then paseo plugin install $(plugin_copy "$sb" "$fixture_id")"
two_install "$sb"
status=$?
check "install with two plugins listed exits 0" test "$status" -eq 0
[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
check "install lists this checkout on the skip list before it installs either plugin" test "$(step_order "$sb")" = "$expected_order"
check "install makes one daemon call per plugin, in order" test "$(plugin_calls "$sb")" = "$(both_installed "$sb")"
check "the stub daemon runs both plugins" both_running "$sb"
check "the second plugin's copy holds the files its package.json lists, and only those" \
	test "$(ls "$(plugin_copy "$sb" "$fixture_id")")" = "$(printf '%s\n' index.server.ts package.json paseo-plugin.json)"
check "the manifest records both plugins, each from its copy, with its build" \
	manifest_true "$sb" "JSON.stringify(m.items.filter((i) => i.kind === 'plugin').map((i) => [i.id, i.path, typeof i.buildSha256])) === JSON.stringify([['$plugin_id', '$(plugin_copy "$sb")', 'string'], ['$fixture_id', '$(plugin_copy "$sb" "$fixture_id")', 'string']])"
two_records=$(plugin_records "$sb")
manifest=$(cat "$(manifest_of "$sb")")
: >"$sb/stub.log"
two_install "$sb"
check "a re-run with two plugins exits 0" test $? -eq 0
check "the re-run makes no daemon call" test -z "$(plugin_calls "$sb")"
check "the re-run leaves the manifest byte-identical" test "$(cat "$(manifest_of "$sb")")" = "$manifest"
run_in "$sb" full -- "$two/main/scripts/uninstall.mjs" --dry-run
check "the uninstall dry run names the second plugin's removal" out_has "$sb" "paseo plugin remove $fixture_id, if Paseo lists it from $(plugin_copy "$sb" "$fixture_id")"
: >"$sb/stub.log"
two_uninstall "$sb"
check "uninstall with two plugins exits 0" test $? -eq 0
check "uninstall removes both registrations" test "$(plugin_calls "$sb")" = "$(printf 'plugin remove %s\n' "$plugin_id" "$fixture_id")"
check "the stub daemon lists neither plugin" bash -c '[ "$(cat "$1")" = "[]" ]' _ "$sb/state/paseo-plugins.json"
check "install → re-run → uninstall with two plugins restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# --- an install with two plugins killed at the second converges --------------------------------

# killed_at_second <label> <VAR=value> <calls before the kill> <the re-run's calls>
# Each calls argument names one of the functions above, given the sandbox.
killed_at_second() {
	local label=$1 kill=$2 at_kill=$3 rerun_calls=$4 slug=${1//[^A-Za-z0-9-]/-} sb before status
	for run in uninstall rerun; do
		sb=$(new_sandbox "two-$slug-$run")
		before=$(snapshot "$sb/home")
		(two_install "$sb" "$kill") 2>/dev/null # the shell's "Killed" notice
		check "$label ($run): the install was killed" test $? -ne 0
		check "$label ($run): after the first plugin's call" test "$(plugin_calls "$sb")" = "$("$at_kill" "$sb")"
		check "$label ($run): the second plugin was recorded before its call" manifest_true "$sb" "m.items.some((i) => i.kind === 'plugin' && i.id === '$fixture_id' && !i.buildSha256)"
		if [ "$run" = rerun ]; then
			: >"$sb/stub.log"
			two_install "$sb"
			status=$?
			check "$label ($run): the re-run exits 0" test "$status" -eq 0
			[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
			check "$label ($run): the re-run makes the second plugin's call" test "$(plugin_calls "$sb")" = "$("$rerun_calls" "$sb")"
			check "$label ($run): the re-run finds the copy as recorded, not edited" bash -c '! grep -qF "modified since install" "$1"' _ "$sb/out.txt"
			check "$label ($run): both plugins run" both_running "$sb"
			check "$label ($run): the re-run records the plugins an uninterrupted install does" test "$(plugin_records "$sb")" = "$two_records"
			: >"$sb/stub.log"
			two_install "$sb"
			check "$label ($run): the run after that makes no daemon call" test -z "$(plugin_calls "$sb")"
		fi
		two_uninstall "$sb"
		status=$?
		check "$label ($run): uninstall exits 0" test "$status" -eq 0
		[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
		check "$label ($run): uninstall leaves neither plugin registered" bash -c '[ "$(cat "$1")" = "[]" ]' _ "$sb/state/paseo-plugins.json"
		check "$label ($run): uninstall restores the snapshot" test "$(snapshot "$sb/home")" = "$before"
	done
}

killed_at_second "killed at the second plugin's install" "STUB_INTERRUPT=paseo-install:$fixture_id" both_installed second_reloaded
killed_at_second "killed once the second plugin is recorded" "AIDEV_TEST_KILL=record ~/.local/share/aidev/paseo-plugins/$fixture_id/index.server.ts" \
	first_installed second_installed

# --- two plugin directories of one id are refused before anything is written (#39) ------------

twin=$two/main/personal-extensions/test-fixture-twin
cp -r "$fixture" "$twin"
list_plugins test-fixture-plugin test-fixture-twin
sb=$(new_sandbox two-plugins-one-id)
before=$(snapshot "$sb/home")
two_install "$sb"
check "install with two directories of one plugin id exits nonzero" test $? -ne 0
check "it names the id and both directories" out_has "$sb" "plugin id $fixture_id is declared by more than one paseo-plugin.json: $fixture, $twin"
check "it makes no daemon call" test -z "$(plugin_calls "$sb")"
check "it writes nothing" test "$(snapshot "$sb/home")" = "$before"
rm -r "$twin"
list_plugins test-fixture-plugin

# --- a listed plugin whose paseo-plugin.json is not JSON is refused before anything is written (#39)

broken=$two/main/personal-extensions/test-fixture-broken
cp -r "$fixture" "$broken"
printf '{"id": "%s"\n' "$fixture_id" >"$broken/paseo-plugin.json"
list_plugins test-fixture-plugin test-fixture-broken
sb=$(new_sandbox two-plugins-bad-metadata)
before=$(snapshot "$sb/home")
two_install "$sb"
check "install with a listed plugin whose paseo-plugin.json is not JSON exits nonzero" test $? -ne 0
check "it names the file" out_has "$sb" "error: $broken/paseo-plugin.json is not valid JSON"
check "it makes no daemon call" test -z "$(plugin_calls "$sb")"
check "it writes nothing" test "$(snapshot "$sb/home")" = "$before"
rm -r "$broken"
list_plugins test-fixture-plugin

summary
