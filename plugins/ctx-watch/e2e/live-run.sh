#!/usr/bin/env bash
# e2e/live-run.sh — this plugin's live run for the nightly canary (`ledger canary run` finds every
# plugins/*/e2e/live-run.sh and runs it under the canary contract: exit 0 pass, 75 unavailable
# with the reason on the last stdout line, anything else fail; every stdout line is kept).
#
# The work is plugin-kit's lib/live-run.mjs (a plugin in the same repository as the kit uses the
# kit's own). It runs every evals/*.scenario.json against this checkout's hooks in a sandbox (temp
# HOME, XDG dirs and TMPDIR; every LEDGER_* and CTX_WATCH_* key of the caller's environment
# dropped; pass or fail from the hook's outcome), then, when `claude` is on PATH, the pinned
# CLI-contract session and every scenario with a `session` (session-start-healthy: a headless
# `claude -p` with this checkout's plugin, proving the SessionStart handler ran to the end: it
# stamps firstSeenAt in <state>/ctx-watch/state.json and leaves no errors.log line). Every
# scenario that reaches the SessionStart hook sets CTX_WATCH_CTX to evals/fixtures/fake-ctx.sh,
# so no run probes or heals a real ctx daemon. Until 0.2.0 this script ran its own `claude -p`
# and grepped the stream for a SessionStart hook_response; the runner's session does the same
# and reads the outcome from the on-disk transcript.
#
# How it fails: `claude` missing → the hook scenarios still run and print, then exit 75 with
# `unavailable: claude not found on PATH` last. No helper found → exit 75 naming the path looked
# at. A scenario that does not parse or is still a stub → exit 1 naming the file. `--no-live`
# runs the hook phase only.

set -u
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export CANARY_PLUGIN="${CANARY_PLUGIN:-ctx-watch}"

HELPER="$PLUGIN_DIR/../plugin-kit/lib/live-run.mjs"
if [ ! -f "$HELPER" ]; then
  echo "unavailable: no live-run helper at $HELPER"
  exit 75
fi
if ! command -v node >/dev/null 2>&1; then
  echo "unavailable: node not found on PATH"
  exit 75
fi

exec node "$HELPER" --plugin-dir "$PLUGIN_DIR" "$@"
