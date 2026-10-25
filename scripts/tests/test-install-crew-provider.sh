#!/usr/bin/env bash
#
# Tests for the crew provider in install.mjs and uninstall.mjs (#40, spec #11
# D16): install adds one provider entry to Paseo's config.json, built on the
# claude provider with Paseo's tools off and Claude Code's Workflow tool
# disallowed, recorded before it is written, and has the daemon reload the
# file; uninstall takes back only that entry, leaving the rest of the file
# byte for byte, and has the daemon reload it again. On the shared harness of
# lib/install-harness.sh; fully offline.
#
# Usage: tests/test-install-crew-provider.sh

set -uo pipefail
. "$(dirname "$0")/lib/install-harness.sh"

crew=claude-crew

config_of() { # config_of <sb>
	printf '%s\n' "$1/home/.paseo/config.json"
}

# A JS expression over the parsed config.json (`c`), true → exit 0.
config_true() { # config_true <sb> <js-expression>
	node -e '
		const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		process.exit(('"$2"') ? 0 : 1);
	' "$(config_of "$1")"
}

# The entry D16 asks for: on the claude provider, Paseo's tools off (no
# create_agent), Claude Code's Workflow tool disallowed, and a label of its own.
crew_entry_ok() { # crew_entry_ok <sb>
	config_true "$1" "(({ extends: e, label, paseoTools, disallowedTools }) =>
		e === 'claude' && typeof label === 'string' && label !== '' &&
		paseoTools?.enabled === false && disallowedTools?.includes('Workflow'))(c.agents.providers['$crew'])"
}

# The providers the stub daemon loaded at its last `paseo reload`.
daemon_has_crew() { # daemon_has_crew <sb>
	node -e '
		const f = process.argv[1];
		const p = require("fs").existsSync(f) ? JSON.parse(require("fs").readFileSync(f, "utf8")) : {};
		process.exit(process.argv[2] in p ? 0 : 1);
	' "$1/state/paseo-providers.json" "$crew"
}

reloads() { # reloads <sb>  — how many times the daemon was asked to reload
	grep -c '^paseo|reload|' "$1/stub.log"
}

recorded() { # recorded <sb>  — the manifest records our entry
	manifest_true "$1" "m.items.some((i) => i.kind === 'provider-entry' && i.id === '$crew')"
}

pending() { # pending <sb>  — the manifest says the daemon has not reloaded our last write
	manifest_true "$1" "m.items.some((i) => i.kind === 'provider-entry' && i.pendingReload)"
}

not() { ! "$@"; }

# --- a fresh install adds the entry and reloads the daemon; uninstall takes both back ----------

sb=$(new_sandbox crew-fresh)
before=$(snapshot "$sb/home")
install_in "$sb" --dry-run
check "the dry run names the crew provider" out_has "$sb" "crew provider $crew"
check "the dry run names the reload" out_has "$sb" "paseo reload"
check "the dry run writes no config.json" test ! -e "$(config_of "$sb")"
check "the dry run makes no reload" test "$(reloads "$sb")" -eq 0
install_in "$sb"
check "install exits 0" test $? -eq 0
check "install adds the crew provider entry D16 describes" crew_entry_ok "$sb"
check "install records the entry in the manifest" recorded "$sb"
check "install has the daemon reload config.json once" test "$(reloads "$sb")" -eq 1
check "the daemon knows the crew provider after install" daemon_has_crew "$sb"
check "the record says the daemon has reloaded it" not pending "$sb"
config=$(cat "$(config_of "$sb")")
manifest=$(cat "$(manifest_of "$sb")")
install_in "$sb"
check "a second install exits 0" test $? -eq 0
check "a second install leaves config.json byte-identical" test "$(cat "$(config_of "$sb")")" = "$config"
check "a second install leaves the manifest byte-identical" test "$(cat "$(manifest_of "$sb")")" = "$manifest"
check "a second install makes no reload" test "$(reloads "$sb")" -eq 1
uninstall_in "$sb" --dry-run
check "the uninstall dry run names the entry's file and the reload" bash -c 'grep -qF "strip our parts from $2" "$1" && grep -qF "paseo reload, so the daemon drops the crew provider $3" "$1"' _ "$sb/out.txt" "$(config_of "$sb")" "$crew"
check "the uninstall dry run names config.json once" test "$(grep -cF "$(config_of "$sb")" "$sb/out.txt")" -eq 1
uninstall_in "$sb" --purge --yes
check "uninstall exits 0" test $? -eq 0
check "uninstall has the daemon reload config.json" test "$(reloads "$sb")" -eq 2
check "the daemon no longer knows the crew provider" not daemon_has_crew "$sb"
check "uninstall deletes the config.json the install created" test ! -e "$(config_of "$sb")"
check "install → uninstall restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# --- the operator's providers and settings survive, byte for byte ------------------------------

sb=$(new_sandbox crew-operator rich)
before=$(snapshot "$sb/home")
original=$(cat "$(config_of "$sb")")
install_in "$sb"
check "install over the operator's config.json exits 0" test $? -eq 0
check "install adds the crew provider entry" crew_entry_ok "$sb"
check "install leaves every other provider and setting as it was" \
	config_true "$sb" "(delete c.agents.providers['$crew'], JSON.stringify(c) === JSON.stringify($original))"
check "install keeps config.json's mode" test "$(stat -c %a "$(config_of "$sb")")" = 600
check "install keeps config.json's two-space indent" grep -q '^    "providers": {$' "$(config_of "$sb")"
uninstall_in "$sb" --purge --yes
check "uninstall exits 0" test $? -eq 0
check "uninstall restores config.json byte for byte" test "$(cat "$(config_of "$sb")")" = "$original"
check "uninstall restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# ...and a setting the operator changes after install stays; only our entry goes.
sb=$(new_sandbox crew-changed-later rich)
install_in "$sb"
json_edit "$(config_of "$sb")" '(c) => { c.daemon.listen = "127.0.0.1:7777"; }'
uninstall_in "$sb" --purge --yes
check "uninstall with a setting changed after install exits 0" test $? -eq 0
check "uninstall removes our entry" config_true "$sb" "!('$crew' in c.agents.providers)"
check "uninstall keeps the operator's change" config_true "$sb" "c.daemon.listen === '127.0.0.1:7777'"
check "uninstall keeps the operator's providers" config_true "$sb" "c.agents.providers.glm.label === 'GLM Agent'"

# ...and with Paseo keeping plugin registrations in config.json, which
# `paseo plugin remove` rewrites, as on an operator machine with plugins of
# its own: uninstall takes the crew provider back first, so the backup's
# bytes still come back, and no backup is left.
sb=$(new_sandbox crew-plugins-in-config rich)
json_edit "$(config_of "$sb")" '(c) => { c.plugins = { theirs: { source: "directory", path: "/opt/theirs", enabled: true } }; }'
before=$(snapshot "$sb/home")
original=$(cat "$(config_of "$sb")")
run_in "$sb" full STUB_PLUGINS_IN_CONFIG=1 -- "$installer"
check "install with plugins kept in config.json exits 0" test $? -eq 0
check "the daemon recorded our plugin in config.json" config_true "$sb" "'$plugin_id' in c.plugins"
run_in "$sb" full STUB_PLUGINS_IN_CONFIG=1 -- "$uninstaller" --purge --yes
check "uninstall exits 0" test $? -eq 0
check "uninstall keeps no copy of config.json" not out_has "$sb" "config.json, which changed since install"
check "uninstall restores config.json byte for byte" test "$(cat "$(config_of "$sb")")" = "$original"
check "uninstall restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# ...and a key the repo does not set, as Paseo's settings write it, is the
# operator's: a re-run keeps it.
sb=$(new_sandbox crew-operator-key rich)
install_in "$sb"
json_edit "$(config_of "$sb")" "(c) => { c.agents.providers['$crew'].enabled = false; }"
config=$(cat "$(config_of "$sb")")
install_in "$sb"
check "a re-run after the operator disabled the crew provider exits 0" test $? -eq 0
check "the re-run keeps it disabled, and changes nothing" test "$(cat "$(config_of "$sb")")" = "$config"
check "the re-run makes no reload" test "$(reloads "$sb")" -eq 1

# ...and a key we set that the repo no longer sets goes (as after a repo
# update that drops it); the operator's keys stay.
sb=$(new_sandbox crew-dropped-key rich)
install_in "$sb"
config=$(cat "$(config_of "$sb")")
json_edit "$(manifest_of "$sb")" '(m) => { m.items.find((i) => i.kind === "provider-entry").keys.push("dropped"); }'
json_edit "$(config_of "$sb")" "(c) => { c.agents.providers['$crew'].dropped = true; }"
install_in "$sb"
check "a re-run after the repo dropped a key exits 0" test $? -eq 0
check "the re-run removes the dropped key" test "$(cat "$(config_of "$sb")")" = "$config"

# --- the operator already has a provider of that id: left alone, not recorded -------------------

sb=$(new_sandbox crew-theirs rich)
json_edit "$(config_of "$sb")" "(c) => { c.agents.providers['$crew'] = { extends: 'codex', label: 'Mine' }; }"
original=$(cat "$(config_of "$sb")")
install_in "$sb"
check "install with the operator's $crew exits 0" test $? -eq 0
check "install warns that the entry is not its own" out_has "$sb" "warning: $(config_of "$sb") already has a provider $crew, not added by this install"
check "install leaves the operator's entry and file as they were" test "$(cat "$(config_of "$sb")")" = "$original"
check "install records no entry" not recorded "$sb"
check "install makes no reload" test "$(reloads "$sb")" -eq 0
uninstall_in "$sb" --purge --yes
check "uninstall leaves the operator's entry" test "$(cat "$(config_of "$sb")")" = "$original"

# --- the entry converges: deleted, or changed (a repo update, an edit), it comes back -----------

sb=$(new_sandbox crew-converge rich)
install_in "$sb"
config=$(cat "$(config_of "$sb")")
json_edit "$(config_of "$sb")" "(c) => { delete c.agents.providers['$crew']; }"
install_in "$sb"
check "a re-run after the entry was deleted exits 0" test $? -eq 0
check "the re-run puts the entry back" test "$(cat "$(config_of "$sb")")" = "$config"
check "the re-run reloads the daemon" test "$(reloads "$sb")" -eq 2
json_edit "$(config_of "$sb")" "(c) => { c.agents.providers['$crew'].disallowedTools = []; }"
install_in "$sb"
check "the re-run puts the changed entry back as the repo has it" test "$(cat "$(config_of "$sb")")" = "$config"
check "the re-run reloads the daemon again" test "$(reloads "$sb")" -eq 3
check "the daemon knows the crew provider" daemon_has_crew "$sb"

# --- a failed reload: recorded as owed, retried by the re-run ---------------------------------

sb=$(new_sandbox crew-reload-fails)
before=$(snapshot "$sb/home")
run_in "$sb" full STUB_FAIL=paseo-reload -- "$installer"
check "install exits nonzero when the reload fails" test $? -ne 0
check "install names the failed reload" out_has "$sb" "paseo reload failed"
check "the entry is written" crew_entry_ok "$sb"
check "the record says the reload is owed" pending "$sb"
install_in "$sb"
check "the re-run exits 0" test $? -eq 0
check "the re-run reloads the daemon" daemon_has_crew "$sb"
check "the re-run settles the record" not pending "$sb"
uninstall_in "$sb" --purge --yes
check "uninstall after a failed reload restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# ...and at uninstall, a failed reload is a warning: the file is already put back.
sb=$(new_sandbox crew-unreload-fails rich)
before=$(snapshot "$sb/home")
install_in "$sb"
run_in "$sb" full STUB_FAIL=paseo-reload -- "$uninstaller" --purge --yes
check "uninstall exits 0 when its reload fails" test $? -eq 0
check "uninstall warns that the daemon still has the provider" out_has "$sb" "warning: paseo reload failed"
check "uninstall still restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# --- uninstall that cannot write config.json keeps its records, and a re-run finishes ----------

sb=$(new_sandbox crew-unwritable)
before=$(snapshot "$sb/home")
install_in "$sb"
chmod a-w "$sb/home/.paseo"
uninstall_in "$sb" --purge --yes
status=$?
chmod u+w "$sb/home/.paseo"
check "uninstall that cannot write config.json exits nonzero" test "$status" -ne 0
check "the manifest still records the entry" recorded "$sb"
uninstall_in "$sb" --purge --yes
check "uninstall re-run once it can exits 0" test $? -eq 0
check "the re-run restores the snapshot" test "$(snapshot "$sb/home")" = "$before"

# --- a config.json that does not parse stops the install before any write ----------------------

sb=$(new_sandbox crew-broken)
printf '{ "version": 1,' >"$(config_of "$sb")"
before=$(snapshot "$sb/home")
install_in "$sb"
check "install with a broken config.json exits nonzero" test $? -ne 0
check "install names the file" out_has "$sb" ".paseo/config.json does not parse"
check "install writes nothing" test "$(snapshot "$sb/home")" = "$before"

# ...and so does an entry of that id that is not a JSON object.
sb=$(new_sandbox crew-not-object rich)
json_edit "$(config_of "$sb")" "(c) => { c.agents.providers['$crew'] = null; }"
before=$(snapshot "$sb/home")
install_in "$sb"
check "install with a $crew that is not an object exits nonzero" test $? -ne 0
check "install names it" out_has "$sb" "agents.providers.$crew is not a JSON object"
check "install writes nothing" test "$(snapshot "$sb/home")" = "$before"

summary
