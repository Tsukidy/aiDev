#!/usr/bin/env bash
#
# Full offline verification for paseo-firstmate-beads-onboarding: the plugin's
# workspace.created handler (stub Paseo API, stub bd on PATH, real git and real
# filesystem), that the daemon can build the plugin from a copy without
# node_modules (with Paseo's own compiler wherever paseo is on PATH), and the
# standing-orders installer (synthetic mate homes). The repository's
# scripts/tests/run.sh runs this too.
#
# Usage: tests/run.sh

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)

status=0
node --test "$here/plugin.test.mjs" || status=1
node --test "$here/build.test.mjs" || status=1
bash "$here/installer.test.sh" || status=1
exit "$status"
