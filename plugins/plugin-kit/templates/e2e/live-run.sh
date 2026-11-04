#!/usr/bin/env bash
# e2e/live-run.sh — this plugin's live run for the nightly canary (`ledger canary run` finds every
# plugins/*/e2e/live-run.sh and runs it under the canary contract: exit 0 pass, 75 unavailable
# with the reason on the last stdout line, anything else fail; every stdout line is kept).
#
# The work is plugin-kit's lib/live-run.mjs (the scaffold copies it into lib/; a plugin in the
# same repository as the kit may use the kit's own). It runs every evals/*.scenario.json against
# this checkout's hooks in a sandbox (temp HOME, XDG dirs and TMPDIR; every LEDGER_* and
# {{name}}'s own env keys dropped; pass or fail from the hook's outcome), then, when `claude` is on
# PATH, the pinned CLI-contract session and every scenario with a `session`, isolated with
# --setting-sources "" and a temp HOME seeded with the login files only. The verdict of a session
# reads result.terminal_reason, never the exit code; a model that never tried the behaviour is
# indeterminate, never a fail; Stop-hook feedback is read from the on-disk transcript.
#
# How it fails: `claude` missing → the hook scenarios still run and print, then exit 75 with
# `unavailable: claude not found on PATH` last. No helper found → exit 75 naming both paths looked
# at. A scenario that does not parse or is still a stub → exit 1 naming the file.

set -u
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export CANARY_PLUGIN="${CANARY_PLUGIN:-{{name}}}"

HELPER=""
for candidate in "$PLUGIN_DIR/lib/live-run.mjs" "$PLUGIN_DIR/../plugin-kit/lib/live-run.mjs"; do
  if [ -f "$candidate" ]; then
    HELPER="$candidate"
    break
  fi
done
if [ -z "$HELPER" ]; then
  echo "unavailable: no live-run helper at $PLUGIN_DIR/lib/live-run.mjs or $PLUGIN_DIR/../plugin-kit/lib/live-run.mjs"
  exit 75
fi
if ! command -v node >/dev/null 2>&1; then
  echo "unavailable: node not found on PATH"
  exit 75
fi

exec node "$HELPER" --plugin-dir "$PLUGIN_DIR" "$@"
