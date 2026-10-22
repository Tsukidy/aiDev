#!/usr/bin/env bash
#
# Tests for install.mjs and uninstall.mjs, the one-command installer and
# manifest-driven uninstaller from ticket #21 (spec #11 D5–D9), on the shared
# harness of lib/install-harness.sh: sandboxed homes, stub CLIs, fully
# offline. The onboarding plugin step has its own cases in
# test-install-plugin.sh.
#
# Usage: tests/test-install.sh

set -uo pipefail
. "$(dirname "$0")/lib/install-harness.sh"

# The skills the installer should hand to the skills CLI by default: every
# directory of the tree that carries a SKILL.md.
all_skills=$(cd "$skills_src" && for d in */; do [ -f "$d/SKILL.md" ] && printf '%s\n' "${d%/}"; done | LC_ALL=C sort)

carried_agents="comment-sicko poteto-agent thermo-nuclear-code-quality-review-subagent thermo-nuclear-review-subagent"
effort_agents=""
for level in low medium high xhigh max; do
	effort_agents="$effort_agents effort-$level poteto-agent-$level"
done
expected_agents=$(printf '%s\n' $carried_agents $effort_agents | LC_ALL=C sort)

# --- the vendored effort agents, hook text and the reverted paragraph (addendum) ---

for a in $effort_agents; do
	f=$skills_src/setup-pstack/agents/$a.md
	check "vendored effort agent exists: $a" test -f "$f"
done
check "vendored effort agents declare the effort their name says" bash -c '
	for level in low medium high xhigh max; do
		for a in effort-$level poteto-agent-$level; do
			grep -qx "effort: $level" "$1/$a.md" || exit 1
			grep -qx "name: $a" "$1/$a.md" || exit 1
		done
	done' _ "$skills_src/setup-pstack/agents"
check "the vendored session-start mandate text exists and names poteto-mode" \
	grep -qF 'Invoke the `poteto-mode` skill' "$skills_src/setup-pstack/hooks/session-start-context.md"
check "no skill text says effort agents ship only with the pstack plugin" \
	bash -c '! grep -rqF "ship with the pstack plugin" "$1"' _ "$skills_src"
upstream_effort='On Claude Code, a level picks the effort agent from the `subagent_type` you would otherwise use. `poteto-agent` becomes `subagent_type: "poteto-agent-<level>"`. `general-purpose`, or no `subagent_type`, becomes `subagent_type: "effort-<level>"`. The effort agents set only `effort`, so the model you pass still decides the model. On Codex,'
for s in how why interrogate poteto-mode arena architect swarm reflect; do
	check "the effort paragraph in $s matches upstream's wording (bare agent names)" \
		grep -qF -- "$upstream_effort" "$skills_src/$s/SKILL.md"
done

# --- a fresh install on an operator machine ----------------------------------------

rich=$(new_sandbox rich rich)
h=$rich/home
before_rich=$(snapshot "$h")
cp -p "$h/.claude/settings.json" "$tmp/rich-settings.json"
install_in "$rich"
status=$?
check "install exits 0" test "$status" -eq 0
[ "$status" -eq 0 ] || sed 's/^/    | /' "$rich/out.txt"

# Skills: one skills-CLI call, user level, Claude Code target, copy mode,
# pinned CLI, the curated subset minus what already exists and is not ours.
expected_skills=$(printf '%s\n' "$all_skills" | grep -vx 'my-own-skill' | tr '\n' ' ' | sed 's/ $//')
check "skills are installed with one pinned, user-level, claude-code skills-CLI call" \
	log_has "$rich" "npx|--yes $skills_pin add $skills_src -g -y --copy -a claude-code -s $expected_skills|"
check "every curated skill landed in the Claude Code skills directory" bash -c '
	for s in $2; do [ -f "$1/$s/SKILL.md" ] || exit 1; done' _ "$h/.claude/skills" "$all_skills"
check "the operator's own skill is untouched" grep -qx 'description: operator skill' "$h/.claude/skills/my-own-skill/SKILL.md"
check "question-guidelines and triage are installed" \
	bash -c 'test -f "$1/question-guidelines/SKILL.md" && test -f "$1/triage/SKILL.md"' _ "$h/.claude/skills"

# D14 (#45): every skill not listed below starts on its own. The stub skills CLI copies the source tree, so
# this pins the curated tree's frontmatter as the installed copies carry it.
user_only="improve-codebase-architecture loop-me setup-ts-deep-modules teach to-questionnaire wait-what writing-beats writing-fragments writing-shape"
flagged=$(for s in $all_skills; do
	awk 'NR == 1 { next } /^---$/ { exit } /^disable-model-invocation:/ { found = 1 } END { exit !found }' \
		"$h/.claude/skills/$s/SKILL.md" && printf '%s\n' "$s"
done)
check "exactly the user-only skills carry disable-model-invocation once installed" \
	test "$flagged" = "$(printf '%s\n' $user_only | LC_ALL=C sort)"

# Agents: the four carried definitions and ten effort agents, by bare name.
installed_agents=$(cd "$h/.claude/agents" && ls | sed 's/\.md$//' | LC_ALL=C sort)
check "the agents directory holds exactly the 4 carried and 10 effort agents" test "$installed_agents" = "$expected_agents"
check "each installed agent's name is its file name and carries no plugin namespace" bash -c '
	for f in "$1"/*.md; do
		n=$(basename "$f" .md)
		grep -qx "name: $n" "$f" || exit 1
		! grep -q "pstack:" "$f" || exit 1
	done' _ "$h/.claude/agents"
check "installed carried agents are byte-identical to the repo's" bash -c '
	cmp -s "$1/thermos/agents/thermo-nuclear-review-subagent.md" "$2/thermo-nuclear-review-subagent.md" &&
	cmp -s "$1/no-comments/agents/comment-sicko.md" "$2/comment-sicko.md" &&
	cmp -s "$1/poteto-mode/agents/poteto-agent.md" "$2/poteto-agent.md" &&
	cmp -s "$1/setup-pstack/agents/effort-xhigh.md" "$2/effort-xhigh.md"' _ "$skills_src" "$h/.claude/agents"

# Settings: one identifiable SessionStart entry, everything else preserved.
hook_script=$h/.local/share/aidev/claude-code/hooks/session-start.sh
check "the hook script is installed under the aidev data directory and executable" test -x "$hook_script"
check "settings.json gains exactly one SessionStart entry for our hook, with the four matchers" node -e '
	const [settingsFile, script] = process.argv.slice(1);
	const s = JSON.parse(require("fs").readFileSync(settingsFile, "utf8"));
	const ours = s.hooks.SessionStart.filter((g) => g.hooks.some((x) => x.command.includes(script)));
	process.exit(ours.length === 1 && ours[0].matcher === "startup|resume|clear|compact" ? 0 : 1);
' "$h/.claude/settings.json" "$hook_script"
check "settings.json keeps every other hook and key" node -e '
	const fs = require("fs");
	const [file, orig, script] = process.argv.slice(1);
	const s = JSON.parse(fs.readFileSync(file, "utf8"));
	s.hooks.SessionStart = s.hooks.SessionStart.filter((g) => !g.hooks.some((x) => x.command.includes(script)));
	const o = JSON.parse(fs.readFileSync(orig, "utf8"));
	process.exit(JSON.stringify(s) === JSON.stringify(o) ? 0 : 1);
' "$h/.claude/settings.json" "$tmp/rich-settings.json" "$hook_script"
check "settings.json keeps its 0600 mode" test "$(stat -c %a "$h/.claude/settings.json")" = 600

# The routing hook: injects the mandate unless the sheet says off.
run_hook() { # run_hook <home>  — runs the registered command as Claude Code would
	local cmd
	cmd=$(node -e '
		const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		const g = s.hooks.SessionStart.find((g) => g.hooks.some((x) => x.command.includes(process.argv[2])));
		process.stdout.write(g.hooks.find((x) => x.command.includes(process.argv[2])).command);
	' "$1/.claude/settings.json" "$1/.local/share/aidev/claude-code/hooks/session-start.sh")
	env -i HOME="$1" CLAUDE_CONFIG_DIR="$1/.claude" PATH="$sysbin:/usr/bin:/bin" sh -c "$cmd"
}
hook_out=$(run_hook "$h")
check "the SessionStart hook injects the poteto-mode mandate" \
	test "$hook_out" = "$(cat "$skills_src/setup-pstack/hooks/session-start-context.md")"

# The model sheet: setup-pstack's default shape, written because it was absent.
sheet=$h/.claude/pstack-models.md
default_sheet=$(sed -n '/^```markdown$/,/^```$/p' "$skills_src/setup-pstack/SKILL.md" | sed '1d;$d')
check "pstack-models.md is setup-pstack's default sheet" test "$(cat "$sheet")" = "$default_sheet"
check "the default sheet keeps the session hook on" grep -qx 'session hook: on' "$sheet"

# Global CLAUDE.md: one marked block with the sheet include, appended after the
# operator's content.
check "CLAUDE.md keeps the operator's content as its exact prefix" \
	has_prefix "$h/.claude/CLAUDE.md" '# My global rules\n\nAlways answer in English.\n'
check "CLAUDE.md carries one aidev marked block" \
	test "$(grep -c 'aidev-pstack-sheet:start' "$h/.claude/CLAUDE.md")" -eq 1
check "the marked block includes the sheet by its resolved path" grep -qxF "@$sheet" "$h/.claude/CLAUDE.md"

# captain.md: both orders blocks, operator orders first and unchanged.
captain=$h/$mate_rel/data/captain.md
check "captain.md keeps the operator's orders as its exact prefix" \
	has_prefix "$captain" '# Standing orders\n\nNever push to main.\n'
check "captain.md carries the standing-orders block once" test "$(grep -c 'aidev-standing-orders:start' "$captain")" -eq 1
check "captain.md carries the beads captain-orders block once" test "$(grep -c 'paseo-beads-onboarding:start' "$captain")" -eq 1
check "an existing home memory database is not initialized again" bash -c '! grep -q "^bd|init" "$1"' _ "$rich/stub.log"

# The onboarding plugin: copied under the data directory, installed from there.
plugin_dir=$(plugin_copy "$rich")
check "the onboarding plugin source is copied under the data directory" \
	cmp -s "$plugin_src/index.server.ts" "$plugin_dir/index.server.ts"
check "the onboarding plugin is installed with paseo plugin install" log_has "$rich" "paseo|plugin install $plugin_dir|"
check "the onboarding plugin is running" plugin_status_is "$rich" running

# Attribution travels with the install.
check "NOTICE, the provenance manifest and every license file are placed under the data directory" bash -c '
	cd "$1" || exit 1
	for f in NOTICE.md NOTICE-skills.md pstack-provenance.json LICENSE*; do
		cmp -s "$1/$f" "$2/$f" || exit 1
	done
	cmp -s "$3/LICENSE" "$2/LICENSE-repository"' _ "$skills_src" "$h/.local/share/aidev/licenses" "$repo"

# bun is reported.
check "the precondition report says bun is present" out_has "$rich" "bun: found"

# The manifest.
check "the manifest exists under the XDG state directory" test -f "$(manifest_of "$rich")"
check "the manifest has a schema version, an install time and the repo commit" \
	manifest_true "$rich" 'm.schemaVersion === 3 && /^\d{4}-\d\d-\d\dT/.test(m.installedAt) && /^[0-9a-f]{40}$/.test(m.repoCommit)'
check "every manifest item has a known kind and a path" manifest_true "$rich" \
	'm.items.every((i) => ["skill","agent","hook-entry","marked-block","file","plugin","skip-entry","backup","dir","beads-db","skills-lock"].includes(i.kind) && typeof i.path === "string")'
for kind in skill agent hook-entry marked-block file plugin skip-entry backup; do
	check "the manifest records at least one $kind item" manifest_true "$rich" "m.items.some((i) => i.kind === \"$kind\")"
done
check "the manifest backs up every pre-existing file it modified" manifest_true "$rich" '
	["/.claude/settings.json", "/.claude/CLAUDE.md", "/.claude/agents/comment-sicko.md", "/data/captain.md"]
		.every((suffix) => m.items.some((i) => i.kind === "backup" && i.of.endsWith(suffix)))'
check "the manifest records sha256 for the files it placed" manifest_true "$rich" \
	'm.items.filter((i) => i.kind === "agent").every((i) => /^[0-9a-f]{64}$/.test(i.sha256))'

# Every path the install created is accounted for by a manifest item: the item
# names it, or names a directory it lives in.
after_rich=$(snapshot "$h")
created=$(comm -13 <(printf '%s\n' "$before_rich" | sed -n 's/^[a-z] [0-9]* \(\.[^ ]*\) -> .*/\1/p' | LC_ALL=C sort) \
	<(printf '%s\n' "$after_rich" | sed -n 's/^[a-z] [0-9]* \(\.[^ ]*\) -> .*/\1/p' | LC_ALL=C sort))
check "every path the install created is covered by a manifest item" node -e '
	const fs = require("fs");
	const [manifest, home, list] = process.argv.slice(1);
	const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
	const roots = m.items.map((i) => i.path);
	const stateDir = home + "/.local/state/aidev";
	const missing = list.split("\n").filter(Boolean).map((p) => home + p.slice(1))
		.filter((p) => p !== stateDir && !p.startsWith(stateDir + "/"))
		.filter((p) => !roots.some((r) => p === r || p.startsWith(r + "/")));
	if (missing.length) console.error(missing.join("\n"));
	process.exit(missing.length ? 1 : 0);
' "$(manifest_of "$rich")" "$h" "$created"

# --- install twice equals install once ------------------------------------------------

after_once=$(snapshot "$h")
: >"$rich/stub.log"
install_in "$rich"
check "a second install exits 0" test $? -eq 0
check "install twice leaves the same tree, manifest included, as install once" test "$(snapshot "$h")" = "$after_once"
check "a second install leaves the running, current plugin alone" test -z "$(plugin_calls "$rich")"

# --- the round trip on the operator machine ----------------------------------------

: >"$rich/stub.log"
uninstall_in "$rich"
status=$?
check "uninstall exits 0" test "$status" -eq 0
[ "$status" -eq 0 ] || sed 's/^/    | /' "$rich/out.txt"
check "uninstall removes the skills it installed through the skills CLI" \
	log_has "$rich" "npx|--yes $skills_pin remove -g -y -a claude-code -s $expected_skills|"
check "uninstall removes the onboarding plugin" log_has "$rich" "paseo|plugin remove $plugin_id|"
check "install → uninstall leaves the operator machine identical to its snapshot" test "$(snapshot "$h")" = "$before_rich"
check "the plugin list is back to empty" test "$(cat "$rich/state/paseo-plugins.json")" = "[]"

# --- the round trip on a bare machine, purging the database it created --------------

bare=$(new_sandbox bare)
before_bare=$(snapshot "$bare/home")
install_in "$bare"
check "install on a bare machine exits 0" test $? -eq 0
check "the bare install created the home memory database through bd init" \
	log_has "$bare" "bd|init --quiet --stealth|$bare/home/$mate_rel"
check "the manifest records the databases the setup created" manifest_true "$bare" \
	'm.items.some((i) => i.kind === "beads-db" && i.path.endsWith("/.beads"))'
check "captain.md was created and carries both blocks" \
	bash -c 'grep -q aidev-standing-orders:end "$1" && grep -q paseo-beads-onboarding:end "$1"' _ "$bare/home/$mate_rel/data/captain.md"

# --purge without --yes and without a terminal: refused, nothing touched.
snap=$(snapshot "$bare/home")
: >"$bare/stub.log"
uninstall_in "$bare" --purge
check "--purge without --yes and no terminal to confirm on is refused" test $? -ne 0
check "the refused purge touched nothing" test "$(snapshot "$bare/home")" = "$snap"
check "the refused purge called no mutating CLI" no_mutating_calls "$bare"

uninstall_in "$bare" --purge --yes
check "uninstall --purge --yes exits 0" test $? -eq 0
check "install → uninstall --purge leaves a bare machine identical to its snapshot" test "$(snapshot "$bare/home")" = "$before_bare"

# --- without --purge the databases survive ----------------------------------------------

keepdb=$(new_sandbox keepdb)
install_in "$keepdb"
uninstall_in "$keepdb"
check "uninstall without --purge exits 0" test $? -eq 0
check "without --purge the home memory database survives uninstall" test -f "$keepdb/home/$mate_rel/.beads/config.yaml"
check "the kept database is reported" out_has "$keepdb" "$keepdb/home/$mate_rel/.beads"
check "nothing else of the install remains" test ! -e "$keepdb/home/.local/state/aidev/install-manifest.json"

# --- operator edits after install survive uninstall -----------------------------------

edits=$(new_sandbox edits rich)
h=$edits/home
install_in "$edits"
printf 'session hook: off\n' >>"$h/.claude/pstack-models.md"
cp "$h/.claude/pstack-models.md" "$tmp/edited-sheet.md"
check "the hook stays silent when the sheet says session hook: off" test -z "$(run_hook "$h")"
printf '\nOperator note added later.\n' >>"$h/.claude/CLAUDE.md"
printf '\nCaptain footnote added later.\n' >>"$h/$mate_rel/data/captain.md"
json_edit "$h/.claude/settings.json" '(s) => { s.theme = "dark"; }'
uninstall_in "$edits"
check "uninstall after operator edits exits 0" test $? -eq 0
check "a sheet edited after install survives uninstall" cmp -s "$tmp/edited-sheet.md" "$h/.claude/pstack-models.md"
check "the edited sheet is reported as kept" bash -c 'grep -iF "kept" "$1" | grep -qF "pstack-models.md"' _ "$edits/out.txt"
check "CLAUDE.md is the original plus the operator's later note, our block gone" \
	cmp -s "$h/.claude/CLAUDE.md" <(printf '# My global rules\n\nAlways answer in English.\n\nOperator note added later.\n')
check "captain.md is the original orders plus the later footnote, our blocks gone" \
	cmp -s "$h/$mate_rel/data/captain.md" <(printf '# Standing orders\n\nNever push to main.\n\nCaptain footnote added later.\n')
check "settings.json keeps the later key and every original hook, ours gone" node -e '
	const fs = require("fs");
	const [file, orig] = process.argv.slice(1);
	const s = JSON.parse(fs.readFileSync(file, "utf8"));
	const o = JSON.parse(fs.readFileSync(orig, "utf8"));
	o.theme = "dark";
	process.exit(JSON.stringify(s) === JSON.stringify(o) ? 0 : 1);
' "$h/.claude/settings.json" "$tmp/rich-settings.json"
check "the replaced operator agent is restored" grep -qx 'description: the operator wrote this one' "$h/.claude/agents/comment-sicko.md"

# --- preconditions: refuse with nothing written -----------------------------------------

refuse_case() { # refuse_case <description> <sb> <stubset> [VAR=value ...]
	local description=$1 sb=$2 stubset=$3 snap
	shift 3
	snap=$(snapshot "$sb/home")
	run_in "$sb" "$stubset" "$@" -- "$installer"
	local status=$?
	check "$description exits nonzero" test "$status" -ne 0
	check "$description writes nothing" test "$(snapshot "$sb/home")" = "$snap"
	check "$description calls no mutating CLI" no_mutating_calls "$sb"
}

refuse_case "missing npx" "$(new_sandbox no-npx)" nonpx
refuse_case "missing bd" "$(new_sandbox no-bd)" nobd
refuse_case "missing paseo" "$(new_sandbox no-paseo)" nopaseo
refuse_case "an unreachable Paseo daemon" "$(new_sandbox no-daemon)" full STUB_FAIL=paseo-ls
sb=$(new_sandbox outside)
mkdir -p "$tmp/outside-claude"
refuse_case "CLAUDE_CONFIG_DIR outside HOME" "$sb" full CLAUDE_CONFIG_DIR="$tmp/outside-claude"
check "the outside-HOME refusal names the offending path" out_has "$sb" "$tmp/outside-claude"
sb=$(new_sandbox symlink-escape)
ln -s "$tmp/outside-claude" "$sb/home/.claude"
refuse_case "a ~/.claude symlink that resolves outside HOME" "$sb" full
sb=$(new_sandbox mate-outside)
mkdir -p "$tmp/outside-mate/data" "$sb/home/.paseo/plugin-data/firstmate"
printf '{"home": "%s"}\n' "$tmp/outside-mate" >"$sb/home/.paseo/plugin-data/firstmate/config.json"
refuse_case "a first mate home outside HOME" "$sb" full
sb=$(new_sandbox no-mate)
rm -rf "$sb/home/.paseo"
refuse_case "no first mate home" "$sb" full

# --- bun: reported, never required unless strict ------------------------------------------

sb=$(new_sandbox no-bun)
run_in "$sb" nobun -- "$installer"
check "a missing bun is only a warning" test $? -eq 0
check "the bun warning names the playbooks that need it" \
	bash -c 'grep -iF "bun" "$1" | grep -F "watch-pr" | grep -qF "ship-pr"' _ "$sb/out.txt"
sb=$(new_sandbox no-bun-strict)
snap=$(snapshot "$sb/home")
run_in "$sb" nobun -- "$installer" --strict
check "a missing bun under --strict exits nonzero" test $? -ne 0
check "a missing bun under --strict writes nothing" test "$(snapshot "$sb/home")" = "$snap"
check "a missing bun under --strict calls no mutating CLI" no_mutating_calls "$sb"

# --- the exclude list -------------------------------------------------------------------

sb=$(new_sandbox exclude)
mkdir -p "$sb/home/.config/aidev"
printf '# operator excludes\nfrontend-design\nno-such-skill\n' >"$sb/home/.config/aidev/install-exclude"
install_in "$sb"
check "install honours the exclude list" test $? -eq 0
check "the exclude-list install handed the other skills to the skills CLI" \
	bash -c 'grep -E "^npx\|.* add .* -s " "$1" | grep -qw thermos' _ "$sb/stub.log"
check "an excluded skill is not handed to the skills CLI" bash -c '! grep -E "add .* -s .*\bfrontend-design\b" "$1"' _ "$sb/stub.log"
check "an unknown exclude entry is reported" out_has "$sb" "no-such-skill"
printf 'frontend-design\nwizard\n' >"$sb/home/.config/aidev/install-exclude"
: >"$sb/stub.log"
install_in "$sb"
check "a re-run after the exclude list grows removes the newly excluded skill" \
	log_has "$sb" "npx|--yes $skills_pin remove -g -y -a claude-code -s wizard|"
check "the newly excluded skill leaves the manifest" manifest_true "$sb" '!m.items.some((i) => i.kind === "skill" && i.name === "wizard")'

sb=$(new_sandbox exclude-dep)
mkdir -p "$sb/home/.config/aidev"
printf 'reflect\n' >"$sb/home/.config/aidev/install-exclude"
snap=$(snapshot "$sb/home")
install_in "$sb"
check "excluding reflect while poteto-mode installs is refused" test $? -ne 0
check "the dependency refusal names both skills" bash -c 'grep -F "reflect" "$1" | grep -qF "poteto-mode"' _ "$sb/out.txt"
check "the dependency refusal writes nothing" test "$(snapshot "$sb/home")" = "$snap"
printf 'reflect\npoteto-mode\n' >"$sb/home/.config/aidev/install-exclude"
install_in "$sb"
status=$?
check "excluding reflect is allowed once nothing installed needs it" test "$status" -eq 0
[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
check "an excluded skill's carried agent is not installed" test ! -e "$sb/home/.claude/agents/poteto-agent.md"
check "other skills' agents still are" test -f "$sb/home/.claude/agents/thermo-nuclear-review-subagent.md"
check "with poteto-mode excluded no routing hook entry is added" \
	bash -c 'test ! -e "$1" || ! grep -qF "session-start.sh" "$1"' _ "$sb/home/.claude/settings.json"
check "the skipped routing hook is reported" bash -c 'grep -iF "hook" "$1" | grep -qF "poteto-mode"' _ "$sb/out.txt"
check "the dependency-guarded install still handed the rest to the skills CLI" \
	bash -c 'grep -E "^npx\|.* add .* -s " "$1" | grep -qw thermos' _ "$sb/stub.log"

# Newly excluding a skill on a re-run takes its agent and hook back out.
sb=$(new_sandbox exclude-converge)
mkdir -p "$sb/home/.config/aidev"
install_in "$sb"
printf 'reflect\npoteto-mode\n' >"$sb/home/.config/aidev/install-exclude"
install_in "$sb"
check "a re-run that newly excludes poteto-mode removes its agent and the routing hook" \
	bash -c 'test ! -e "$1/agents/poteto-agent.md" && { test ! -e "$1/settings.json" || ! grep -qF "session-start.sh" "$1/settings.json"; } && test ! -e "$2"' \
	_ "$sb/home/.claude" "$sb/home/.local/share/aidev/claude-code/hooks/session-start.sh"
uninstall_in "$sb" --purge --yes
check "uninstall after that leaves only the operator's exclude list" \
	test -z "$(ls -A "$sb/home" | grep -vxE '\.(paseo|config)')"

# --- a skill name the operator already has from elsewhere -----------------------------

sb=$(new_sandbox collide)
h=$sb/home
mkdir -p "$h/.local/state/skills" "$h/.claude/skills/find-skills"
printf 'operator copy\n' >"$h/.claude/skills/find-skills/SKILL.md"
printf '{\n  "version": 3,\n  "skills": {\n    "setup-matt-pocock-skills": {\n      "source": "mattpocock/skills",\n      "sourceType": "github"\n    }\n  }\n}' >"$h/.local/state/skills/.skill-lock.json"
before=$(snapshot "$h")
install_in "$sb"
check "install with name collisions exits 0" test $? -eq 0
check "colliding skills are skipped and reported" \
	bash -c 'grep -qF "find-skills" "$1" && grep -qF "setup-matt-pocock-skills" "$1"' _ "$sb/out.txt"
check "the non-colliding skills were handed to the skills CLI" \
	bash -c 'grep -E "^npx\|.* add .* -s " "$1" | grep -qw thermos' _ "$sb/stub.log"
check "colliding skills are not handed to the skills CLI" \
	bash -c '! grep -E "add .* -s .*\b(find-skills|setup-matt-pocock-skills)\b" "$1"' _ "$sb/stub.log"
check "the operator's colliding skill is untouched" grep -qx 'operator copy' "$h/.claude/skills/find-skills/SKILL.md"
uninstall_in "$sb" --purge --yes
check "uninstall leaves the colliding skills and the lock as they were" test "$(snapshot "$h")" = "$before"

# --- orders blocks the operator installed before: not ours to remove -------------------

sb=$(new_sandbox prior-orders rich)
h=$sb/home
for orders in "$repo/scripts/install-standing-orders.sh" "$plugin_src/install-captain-orders.sh"; do
	env -i HOME="$h" PASEO_HOME="$h/.paseo" PATH="$tmp/stubs/full:$sysbin:/usr/bin:/bin" STUB_LOG="$sb/stub.log" STUB_STATE="$sb/state" \
		bash "$orders" >/dev/null 2>&1
done
check "fixture: both orders blocks were installed by hand first" \
	bash -c 'grep -q aidev-standing-orders:end "$1" && grep -q paseo-beads-onboarding:end "$1"' _ "$h/$mate_rel/data/captain.md"
before=$(snapshot "$h")
install_in "$sb"
check "install over hand-installed orders exits 0" test $? -eq 0
check "hand-installed orders blocks are not recorded as ours" \
	manifest_true "$sb" '!m.items.some((i) => i.kind === "marked-block" && i.path.endsWith("/captain.md"))'
uninstall_in "$sb"
status=$?
check "uninstall over hand-installed orders exits 0" test "$status" -eq 0
[ "$status" -eq 0 ] || sed 's/^/    | /' "$sb/out.txt"
check "hand-installed orders survive the round trip; the machine matches its snapshot" test "$(snapshot "$h")" = "$before"

# --- shared files that are symlinks (dotfiles) stay symlinks ------------------------------

sb=$(new_sandbox dotfiles rich)
h=$sb/home
mkdir -p "$h/dotfiles"
mv "$h/.claude/settings.json" "$h/dotfiles/settings.json"
mv "$h/.claude/CLAUDE.md" "$h/dotfiles/CLAUDE.md"
ln -s ../dotfiles/settings.json "$h/.claude/settings.json"
ln -s ../dotfiles/CLAUDE.md "$h/.claude/CLAUDE.md"
# An operator agent of the same name as ours, kept in dotfiles too.
printf -- '---\nname: poteto-agent\ndescription: dotfiles copy\n---\n' >"$h/dotfiles/poteto-agent.md"
ln -s ../../dotfiles/poteto-agent.md "$h/.claude/agents/poteto-agent.md"
before=$(snapshot "$h")
install_in "$sb"
check "install through symlinked settings.json and CLAUDE.md exits 0" test $? -eq 0
check "symlinked settings.json and CLAUDE.md are still symlinks after install" \
	bash -c 'test -L "$1/settings.json" && test -L "$1/CLAUDE.md"' _ "$h/.claude"
check "replacing a symlinked operator agent leaves its dotfiles target alone" \
	grep -qx 'description: dotfiles copy' "$h/dotfiles/poteto-agent.md"
check "the symlink targets received the hook entry and the block" \
	bash -c 'grep -qF session-start.sh "$1/settings.json" && grep -qF aidev-pstack-sheet "$1/CLAUDE.md"' _ "$h/dotfiles"
uninstall_in "$sb" --purge --yes
check "the dotfiles round trip leaves the machine identical to its snapshot" test "$(snapshot "$h")" = "$before"

# --- settings.json keeps its indentation -----------------------------------------------

sb=$(new_sandbox indent)
mkdir -p "$sb/home/.claude"
printf '{\n    "model": "opus"\n}\n' >"$sb/home/.claude/settings.json"
install_in "$sb"
check "settings.json keeps its four-space indentation" grep -qxE '    "model": "opus",?' "$sb/home/.claude/settings.json"

# --- a damaged orders block is caught before anything is written -----------------------

sb=$(new_sandbox damaged-captain)
printf '# Standing orders\n\n<!-- paseo-beads-onboarding:start -->\ncut off\n' >"$sb/home/$mate_rel/data/captain.md"
refuse_case "a truncated orders block in captain.md" "$sb" full
check "the damaged-block refusal names captain.md" out_has "$sb" "captain.md"
sb=$(new_sandbox prose-captain)
printf '# Standing orders\n\nNote: paseo-beads-onboarding:start is the marker.\n' >"$sb/home/$mate_rel/data/captain.md"
refuse_case "a marker name in captain.md prose" "$sb" full

# --- a hook entry the operator deleted comes back on re-run ------------------------------

sb=$(new_sandbox hook-readd)
install_in "$sb"
json_edit "$sb/home/.claude/settings.json" '(s) => { delete s.hooks; }'
install_in "$sb"
check "a re-run restores a deleted routing hook entry" grep -qF 'session-start.sh' "$sb/home/.claude/settings.json"
check "the restored entry is still one manifest item" manifest_true "$sb" 'm.items.filter((i) => i.kind === "hook-entry").length === 1'

# --- backups that uninstall keeps survive a reinstall ---------------------------------------

sb=$(new_sandbox kept-backup rich)
h=$sb/home
install_in "$sb"
rm "$h/$mate_rel/data/captain.md"
uninstall_in "$sb" --purge --yes
check "a shared file deleted after install keeps its backup, reported" \
	bash -c 'grep -iF "kept" "$1" | grep -qF "captain.md"' _ "$sb/out.txt"
kept_backups=$(cd "$h/.local/state/aidev/backups" 2>/dev/null && sha256sum ./* | LC_ALL=C sort)
check "uninstall kept the backup it could not consume" test -n "$kept_backups"
install_in "$sb"
check "a reinstall never overwrites a kept backup" bash -c '
	cd "$1" && sha256sum -c --quiet <<<"$2"' _ "$h/.local/state/aidev/backups" "$kept_backups"

# --- partial failure converges ----------------------------------------------------------

sb=$(new_sandbox partial)
h=$sb/home
before=$(snapshot "$h")
run_in "$sb" full STUB_FAIL=skills-add -- "$installer"
check "a failing skills install makes the install exit nonzero" test $? -ne 0
check "the partial install still left a manifest to uninstall from" test -f "$(manifest_of "$sb")"
install_in "$sb"
check "re-running after a partial failure exits 0" test $? -eq 0
check "the converged install has every curated skill" bash -c '
	for s in $2; do [ -f "$1/$s/SKILL.md" ] || exit 1; done' _ "$h/.claude/skills" "$all_skills"
uninstall_in "$sb" --purge --yes
check "uninstall after a converged partial install restores the snapshot" test "$(snapshot "$h")" = "$before"

# --- uninstall without a manifest -------------------------------------------------------

sb=$(new_sandbox no-manifest rich)
snap=$(snapshot "$sb/home")
uninstall_in "$sb"
check "uninstall without a manifest refuses" test $? -ne 0
check "uninstall without a manifest touches nothing" test "$(snapshot "$sb/home")" = "$snap"
check "uninstall without a manifest calls no CLI" test ! -s "$sb/stub.log"

# --- dry runs ------------------------------------------------------------------------------

sb=$(new_sandbox dry rich)
snap=$(snapshot "$sb/home")
install_in "$sb" --dry-run
check "install --dry-run exits 0" test $? -eq 0
check "install --dry-run writes nothing" test "$(snapshot "$sb/home")" = "$snap"
check "install --dry-run calls no mutating CLI" no_mutating_calls "$sb"
check "install --dry-run prints the plan with the paths it would write" \
	bash -c 'grep -qF "$2/.claude/agents/effort-max.md" "$1" && grep -qF "$2/.claude/settings.json" "$1" && grep -qF "skills add" "$1"' _ "$sb/out.txt" "$sb/home"
check "install --dry-run names the daemon call the run makes" out_has "$sb" "then paseo plugin install $(plugin_copy "$sb")"
install_in "$sb"
check "the run makes that call" test "$(plugin_calls "$sb")" = "plugin install $(plugin_copy "$sb")"
snap=$(snapshot "$sb/home")
: >"$sb/stub.log"
uninstall_in "$sb" --dry-run
check "uninstall --dry-run exits 0" test $? -eq 0
check "uninstall --dry-run writes nothing" test "$(snapshot "$sb/home")" = "$snap"
check "uninstall --dry-run calls no CLI" test ! -s "$sb/stub.log"
check "uninstall --dry-run prints what it would remove" out_has "$sb" "$sb/home/.claude/agents/effort-max.md"

# --- default locations when the XDG and Claude variables are unset ------------------------

sb=$(new_sandbox defaults)
h=$sb/home
env -i HOME="$h" PATH="$tmp/stubs/full:$sysbin:/usr/bin:/bin" STUB_LOG="$sb/stub.log" STUB_STATE="$sb/state" \
	node "$installer" </dev/null >"$sb/out.txt" 2>&1
check "install with no XDG or Claude variables exits 0" test $? -eq 0
check "the default manifest lives in ~/.local/state/aidev" test -f "$h/.local/state/aidev/install-manifest.json"
check "the default Claude Code directory is ~/.claude" test -f "$h/.claude/agents/poteto-agent.md"
check "the default skills-CLI lock is ~/.agents/.skill-lock.json" test -f "$h/.agents/.skill-lock.json"
env -i HOME="$h" PATH="$tmp/stubs/full:$sysbin:/usr/bin:/bin" STUB_LOG="$sb/stub.log" STUB_STATE="$sb/state" \
	node "$uninstaller" --purge --yes </dev/null >"$sb/out.txt" 2>&1
check "the default-location round trip leaves an empty home" test -z "$(ls -A "$h" | grep -v '^\.paseo$')"
summary
