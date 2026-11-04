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
# What this run proves, headless (`claude -p`), with the plugin loaded from THIS checkout and the
# installed copy disabled:
#   1. The plugin's hooks ran (a hook event naming one of them appears in the stream-json).
#   2. (Add the plugin's own claim here: the thing a unit test cannot prove because it needs the
#      model, e.g. "the first reply contains X injected at SessionStart".)
#
# How it fails: `claude` missing → 75. `claude` present but the run exits non-zero and names a
# login, credential or network problem → 75; any other non-zero → that exit code. An assertion
# fails with its step number and the evidence line. Everything is under a mktemp directory
# removed at exit; the transcript is copied to CANARY_TRANSCRIPT when set.

set -u
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="${CANARY_PLUGIN:-{{name}}}"
TIMEOUT="${CANARY_TIMEOUT_S:-300}"

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

# 1. A hook of this plugin ran: a hook event names one of its hook scripts.
if ! grep -q "$PLUGIN_DIR/hooks/" "$OUT"; then
  echo "fail 1: no hook event names a script under $PLUGIN_DIR/hooks/ (hooks did not run, or --include-hook-events changed shape)"
  exit 1
fi
echo "step 1: a hook of $PLUGIN ran"
# 2. (the plugin's own claim goes here) — until then: a plain run leaves no errors.log line.
if [ -s "$T/state/$PLUGIN/errors.log" ]; then
  echo "fail 2: errors.log is not empty after a plain run:"
  cat "$T/state/$PLUGIN/errors.log"
  exit 1
fi
echo "pass: hooks ran, no errors.log line"
exit 0
