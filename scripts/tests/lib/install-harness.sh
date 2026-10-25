# The shared harness of the installer tests (test-install.sh and
# test-install-plugin.sh). Each case drives install.mjs and uninstall.mjs end
# to end against a sandboxed HOME (`mktemp -d`), with CLAUDE_CONFIG_DIR,
# PASEO_HOME and the XDG variables pointed inside it and the rest of the
# environment cleared (`env -i`), so nothing can reach the real ~/.claude or
# ~/.paseo. The external CLIs are the stubs of lib/cli-stub.mjs, which record
# every invocation. Fully offline. Sourced, not run: the sourcing script sets
# `set -uo pipefail` and ends with `summary`.

tests=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo=$(cd "$tests/../.." && pwd)
installer="$repo/scripts/install.mjs"
uninstaller="$repo/scripts/uninstall.mjs"
skills_src="$repo/skills"
skills_pin="skills@1.7.4"
plugin_src="$repo/personal-extensions/paseo-firstmate-beads-onboarding"
plugin_id=$(node -p 'require(process.argv[1]).id' "$plugin_src/paseo-plugin.json")

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

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

summary() { # summary  — the closing line; nonzero when a check failed
	printf '\n%d checks, %d failures\n' "$checks" "$failures"
	[ "$failures" -eq 0 ]
}

# --- stubs -----------------------------------------------------------------------
#
# One node script plays every external CLI; a thin bash wrapper per name puts
# it on PATH. PATH is <stub dir>:<sysbin>:/usr/bin:/bin, where sysbin holds
# only the real node: the real npx, paseo and bd live beside node in
# /usr/local/bin and must never be reachable.

sysbin=$tmp/sysbin
mkdir -p "$sysbin"
ln -s "$(command -v node)" "$sysbin/node"

make_stub_dir() { # make_stub_dir <dir> <names...>
	local dir=$1
	shift
	mkdir -p "$dir"
	for n in "$@"; do
		printf '#!/usr/bin/env bash\nexec node %q %s "$@"\n' "$tests/lib/cli-stub.mjs" "$n" >"$dir/$n"
		chmod +x "$dir/$n"
	done
}
make_stub_dir "$tmp/stubs/full" npx paseo bd bun
make_stub_dir "$tmp/stubs/nobun" npx paseo bd
make_stub_dir "$tmp/stubs/nonpx" paseo bd bun
make_stub_dir "$tmp/stubs/nobd" npx paseo bun
make_stub_dir "$tmp/stubs/nopaseo" npx bd bun

# --- sandboxes ---------------------------------------------------------------------
#
# <sb>/home is HOME. Every sandbox has a launched first mate (its home exists
# at firstmate's default location). `rich` sandboxes also carry what an
# operator machine already has: settings.json with other hooks and keys, a
# global CLAUDE.md, captain orders, an unrelated skill and agent, a skills-CLI
# lock with someone else's entry, an existing home memory database, and
# Paseo's config.json with providers and settings of its own.

mate_rel=.paseo/plugin-data/firstmate/home

new_sandbox() { # new_sandbox <name> [rich]
	local sb=$tmp/sb/$1 h
	h=$sb/home
	mkdir -p "$h/$mate_rel/data" "$sb/state"
	: >"$sb/stub.log"
	if [ "${2:-}" = rich ]; then
		mkdir -p "$h/.claude/skills/my-own-skill" "$h/.claude/agents" "$h/.local/state/skills" "$h/$mate_rel/.beads"
		cat >"$h/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "echo operator-hook"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "paseo hooks claude Stop",
            "timeout": 10
          }
        ]
      }
    ]
  },
  "model": "opus"
}
JSON
		chmod 600 "$h/.claude/settings.json" # Claude Code keeps it private: it can hold env secrets
		printf '# My global rules\n\nAlways answer in English.\n' >"$h/.claude/CLAUDE.md"
		printf -- '---\nname: my-own-skill\ndescription: operator skill\n---\n' >"$h/.claude/skills/my-own-skill/SKILL.md"
		printf -- '---\nname: comment-sicko\ndescription: the operator wrote this one\n---\n' >"$h/.claude/agents/comment-sicko.md"
		chmod 600 "$h/.claude/agents/comment-sicko.md"
		printf '{\n  "version": 3,\n  "skills": {\n    "someone-else": {\n      "source": "x/y",\n      "sourceType": "github"\n    }\n  }\n}' >"$h/.local/state/skills/.skill-lock.json"
		printf '# Standing orders\n\nNever push to main.\n' >"$h/$mate_rel/data/captain.md"
		printf 'existing\n' >"$h/$mate_rel/.beads/config.yaml"
		cat >"$h/.paseo/config.json" <<'JSON'
{
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:6767",
    "mcp": {
      "injectIntoAgents": true
    }
  },
  "agents": {
    "providers": {
      "claude": {
        "enabled": true
      },
      "glm": {
        "extends": "acp",
        "label": "GLM Agent",
        "command": [
          "npx",
          "-y",
          "glm-acp-agent@1.14.0"
        ],
        "enabled": false
      }
    },
    "metadataGeneration": {
      "providers": []
    }
  }
}
JSON
		chmod 600 "$h/.paseo/config.json" # Paseo writes it private
	fi
	printf '%s\n' "$sb"
}

# Run a command inside a sandbox with a cleared environment. Output (stdout and
# stderr) lands in <sb>/out.txt; the exit status is returned.
#   run_in <sb> <stub-set> [VAR=value ...] -- <script> [args...]
run_in() {
	local sb=$1 stubset=$2 h
	shift 2
	h=$sb/home
	local extra=()
	while [ "$1" != "--" ]; do
		extra+=("$1")
		shift
	done
	shift
	env -i \
		HOME="$h" \
		CLAUDE_CONFIG_DIR="$h/.claude" \
		PASEO_HOME="$h/.paseo" \
		XDG_DATA_HOME="$h/.local/share" \
		XDG_STATE_HOME="$h/.local/state" \
		XDG_CONFIG_HOME="$h/.config" \
		PATH="$tmp/stubs/$stubset:$sysbin:/usr/bin:/bin" \
		STUB_LOG="$sb/stub.log" \
		STUB_STATE="$sb/state" \
		"${extra[@]}" \
		node "$@" </dev/null >"$sb/out.txt" 2>&1
}

# A copy of this checkout's files, made its own git repository at <dir>/main
# with a linked worktree of it at <dir>/wt, so a case can run the installer
# from either, wherever the suite itself runs from. A tracked file deleted in
# the working tree is left out. Nonzero when the copy fails.
git_copy_with_worktree() { # git_copy_with_worktree <dir>
	local dir=$1
	local git=(env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$dir/main" -c user.name=test -c user.email=test@example.com)
	mkdir -p "$dir/main" &&
		(cd "$repo" && git ls-files -z -co --exclude-standard | while IFS= read -r -d '' f; do if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi; done | tar --null -T - -cf -) | tar -C "$dir/main" -xf - &&
		"${git[@]}" init -q && "${git[@]}" add -A && "${git[@]}" commit -qm copy && "${git[@]}" worktree add -q --detach "$dir/wt"
}

install_in() { # install_in <sb> [args...]
	local sb=$1
	shift
	run_in "$sb" full -- "$installer" "$@"
}

uninstall_in() { # uninstall_in <sb> [args...]
	local sb=$1
	shift
	run_in "$sb" full -- "$uninstaller" "$@"
}

# Every path under a directory with its type, mode, link target and content
# hash: two equal snapshots mean an identical tree.
snapshot() { # snapshot <dir>
	(
		cd "$1" || exit 1
		find . -printf '%y %m %p -> %l\n' | LC_ALL=C sort
		find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
	)
}

out_has() { # out_has <sb> <literal>
	grep -qiF -- "$2" "$1/out.txt"
}

log_has() { # log_has <sb> <literal>
	grep -qF -- "$2" "$1/stub.log"
}

# A plugin's status in the stub daemon's list ("" when not registered); the
# onboarding plugin's unless an id is given.
plugin_status_is() { # plugin_status_is <sb> <status> [id]
	node -e '
		const fs = require("fs");
		const f = process.argv[1];
		const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
		const p = list.find((x) => x.id === process.argv[3]);
		process.exit((p?.status ?? "") === process.argv[2] ? 0 : 1);
	' "$1/state/paseo-plugins.json" "$2" "${3:-$plugin_id}"
}

# Where install keeps a plugin's copy; the onboarding plugin's unless an id is given.
plugin_copy() { # plugin_copy <sb> [id]
	printf '%s\n' "$1/home/.local/share/aidev/paseo-plugins/${2:-$plugin_id}"
}

# The daemon calls that change registrations, as `plugin <verb> <arg>` lines.
plugin_calls() { # plugin_calls <sb>
	grep -E '^paseo\|plugin (install|reload|remove) ' "$1/stub.log" | cut -d'|' -f2
}

no_mutating_calls() { # no_mutating_calls <sb>  — only `paseo plugin ls --json` allowed
	! grep -vE '^paseo\|plugin ls --json\|' "$1/stub.log" | grep -q .
}

has_prefix() { # has_prefix <file> <printf-format>
	printf "$2" >"$tmp/prefix"
	head -c "$(wc -c <"$tmp/prefix")" "$1" | cmp -s - "$tmp/prefix"
}

manifest_of() { # manifest_of <sb>
	printf '%s\n' "$1/home/.local/state/aidev/install-manifest.json"
}

# Evaluate a node expression against the parsed manifest (`m`) and exit 0 when
# it is truthy.
manifest_true() { # manifest_true <sb> <js-expression>
	node -e '
		const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		process.exit(('"$2"') ? 0 : 1);
	' "$(manifest_of "$1")"
}

# Rewrite a JSON file through a JS function of its parsed value, which edits it
# in place or returns the new value.
json_edit() { # json_edit <file> <js-function>
	node -e '
		const fs = require("fs");
		const [file, fn] = process.argv.slice(1);
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.writeFileSync(file, JSON.stringify(eval(fn)(value) ?? value, null, 2) + "\n");
	' "$1" "$2"
}
