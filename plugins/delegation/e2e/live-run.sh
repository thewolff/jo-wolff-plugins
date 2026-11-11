#!/usr/bin/env bash
# e2e/live-run.sh — this plugin's live run for the nightly canary (`ledger canary run` finds every
# plugins/*/e2e/live-run.sh and runs it; a plugin without one is reported `unavailable: no
# e2e/live-run.sh`).
#
# THE CANARY CONTRACT (the same for every plugin):
#   run from the plugin directory; env CANARY_PLUGIN (this plugin's name), CANARY_TRANSCRIPT (a
#   path this script may write its stream-json transcript to), CANARY_TIMEOUT_S (the deadline the
#   canary kills at). Exit 0 = pass. Exit 75 = unavailable, with the reason on the LAST line of
#   stdout (no `claude`, no credentials, no network). Any other exit = fail. Every line of stdout
#   is kept as the run's summary, so print the evidence for each step.
#
# What this run proves. First, offline: every evals/*.scenario.json passes against this
# checkout's hooks, run by plugin-kit's lib/live-run.mjs hook phase (a sandbox per scenario; no
# model). Then headless (`claude -p`), with the plugin loaded from THIS checkout and the
# installed copy disabled:
#   1. The host ran SessionStart hooks: the step-1 grep is for a stream-json line carrying both
#      `"subtype":"hook_response"` and `"hook_event":"SessionStart"` (copied from
#      plugins/ctx-watch/e2e/live-run.sh). Claude Code 2.1.318's hook events carry the event name
#      and output, not the script path, so which plugin answered is proved by step 2, not here.
#   2. This plugin's SessionStart hook answered: the stream-json carries the
#      "Delegation: how to brief a subagent" heading (the additionalContext the hook returns).
#
# How it fails: a hook scenario fails → exit 1 with the helper's lines. No helper found → the
# hook phase is skipped with a line saying so. `claude` missing → 75. `claude` present but the
# run exits non-zero and names a login, credential or network problem → 75; any other non-zero
# → that exit code. An assertion fails with its step number and the evidence line. Everything
# is under a mktemp directory removed at exit; the transcript is copied to CANARY_TRANSCRIPT
# when set. `--no-live` on this script's command line stops after the hook phase: exit 75 with
# the helper's `unavailable: live phase skipped (--no-live); N hook scenario(s) passed offline`
# last, and `claude` is never looked up or run.

set -u
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="${CANARY_PLUGIN:-delegation}"
TIMEOUT="${CANARY_TIMEOUT_S:-300}"
NO_LIVE=0
for arg in "$@"; do
  [ "$arg" = "--no-live" ] && NO_LIVE=1
done

HELPER=""
for candidate in "$PLUGIN_DIR/lib/live-run.mjs" "$PLUGIN_DIR/../plugin-kit/lib/live-run.mjs"; do
  if [ -f "$candidate" ]; then
    HELPER="$candidate"
    break
  fi
done
if [ -n "$HELPER" ]; then
  CANARY_PLUGIN="$PLUGIN" node "$HELPER" --plugin-dir "$PLUGIN_DIR" --no-live
  HOOKS=$?
  # 75 is the helper's "live phase skipped" with every hook scenario passed; this script runs the live part.
  if [ "$HOOKS" -ne 75 ] && [ "$HOOKS" -ne 0 ]; then
    echo "fail: a hook scenario failed (live-run.mjs exit $HOOKS)"
    exit 1
  fi
else
  echo "hook scenarios skipped: no live-run helper at $PLUGIN_DIR/lib/live-run.mjs or $PLUGIN_DIR/../plugin-kit/lib/live-run.mjs"
fi

if [ "$NO_LIVE" = 1 ]; then
  # With the helper, its last line is already `unavailable: live phase skipped (--no-live); N hook scenario(s) passed offline`.
  [ -z "$HELPER" ] && echo "unavailable: live phase skipped (--no-live); hook phase skipped too (no live-run helper)"
  exit 75
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "unavailable: claude not found on PATH"
  exit 75
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/$PLUGIN-canary.XXXXXX")"
trap 'rm -r -f "$T"' EXIT
mkdir -p "$T/trial" "$T/state"
# A throwaway state dir, never the caller's: drop the env that would point this plugin (or
# ledger, when its canary runs this script) at a real store before setting our own.
unset LEDGER_DB LEDGER_CONFIG LEDGER_ENABLED
export XDG_STATE_HOME="$T/state"

echo "$PLUGIN canary: plugin $PLUGIN_DIR"
echo "claude: $(claude --version 2>/dev/null | head -1)"

OUT="$T/run.jsonl"
cd "$T/trial" || exit 1
timeout "$((TIMEOUT - 10 > 30 ? TIMEOUT - 10 : 30))" claude -p \
  --plugin-dir "$PLUGIN_DIR" \
  --settings "{\"enabledPlugins\":{\"$PLUGIN@jo-wolff-plugins\":false}}" \
  --output-format stream-json --verbose --include-hook-events \
  --allowedTools Read \
  -- "Say hello in one line." >"$OUT" 2>"$T/run.err"
CODE=$?
[ -n "${CANARY_TRANSCRIPT:-}" ] && { mkdir -p "$(dirname "$CANARY_TRANSCRIPT")" && cp "$OUT" "$CANARY_TRANSCRIPT" 2>/dev/null; }

if [ "$CODE" -ne 0 ]; then
  echo "claude exited $CODE; stderr tail:"
  tail -5 "$T/run.err"
  if grep -qiE "not logged in|log in|login|credential|unauthori[sz]ed|api key|authentication|network|ENOTFOUND|ECONNREFUSED" "$T/run.err" "$OUT"; then
    echo "unavailable: claude could not run (credentials or network)"
    exit 75
  fi
  exit "$CODE"
fi

# 1. The host ran SessionStart hooks: a hook_response event for SessionStart is in the stream.
if ! grep -q '"subtype":"hook_response".*"hook_event":"SessionStart"' "$OUT"; then
  echo "fail 1: no hook_response event for SessionStart in the stream-json (hooks did not run, or --include-hook-events changed shape)"
  exit 1
fi
echo "step 1: the host ran SessionStart hooks"
# 2. This plugin's SessionStart hook answered: its teaching block heading is in the stream.
if ! grep -q "Delegation: how to brief a subagent" "$OUT"; then
  echo "fail 2: the SessionStart teaching block is not in the transcript"
  exit 1
fi
echo "step 2: the SessionStart teaching block was delivered"
# 3. A plain run leaves no errors.log line.
if [ -s "$T/state/$PLUGIN/errors.log" ]; then
  echo "fail 3: errors.log is not empty after a plain run:"
  cat "$T/state/$PLUGIN/errors.log"
  exit 1
fi
echo "pass: hooks ran, teaching block delivered, no errors.log line"
exit 0
