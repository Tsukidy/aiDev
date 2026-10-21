#!/usr/bin/env bash
#
# Full offline verification for paseo-firstmate-beads-onboarding: the plugin's
# workspace.created handler (stub Paseo API, stub bd on PATH, real git and real
# filesystem), that the daemon can build the plugin from a copy without
# node_modules (Paseo's own compiler, when installed), and the standing-orders
# installer (synthetic mate homes).
#
# Usage: tests/run.sh

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)

status=0
node --test "$here/plugin.test.mjs" || status=1
node --test "$here/build.test.mjs" || status=1
bash "$here/installer.test.sh" || status=1
exit "$status"
