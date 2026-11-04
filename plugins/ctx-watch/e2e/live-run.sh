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
#   2. The SessionStart handler itself ran, not just the runner: it stamps firstSeenAt in
#      <state>/ctx-watch/state.json on its first run, and a plain run leaves no errors.log line.
#      The probe's verdict is not asserted (the canary host may or may not have ctx up); the
#      line it printed, if any, is echoed as evidence.
#
# How it fails: `claude` missing → 75. `claude` present but the run exits non-zero and names a
# login, credential or network problem → 75; any other non-zero → that exit code. An assertion
# fails with its step number and the evidence line. Everything is under a mktemp directory
# removed at exit; the transcript is copied to CANARY_TRANSCRIPT when set.

set -u
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="${CANARY_PLUGIN:-ctx-watch}"
TIMEOUT="${CANARY_TIMEOUT_S:-300}"

if ! command -v claude >/dev/null 2>&1; then
  echo "unavailable: claude not found on PATH"
  exit 75
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/$PLUGIN-canary.XXXXXX")"
trap 'rm -r -f "$T"' EXIT
mkdir -p "$T/trial" "$T/state"
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
# 2. The handler ran: the first-seen stamp is in the state file, and no errors.log line.
if [ -s "$T/state/$PLUGIN/errors.log" ]; then
  echo "fail 2: errors.log is not empty after a plain run:"
  cat "$T/state/$PLUGIN/errors.log"
  exit 1
fi
if ! grep -q '"firstSeenAt": [0-9]' "$T/state/$PLUGIN/state.json" 2>/dev/null; then
  echo "fail 2: $T/state/$PLUGIN/state.json has no firstSeenAt stamp (the SessionStart handler did not run to the end)"
  exit 1
fi
echo "step 2: the SessionStart handler stamped firstSeenAt; no errors.log line"
LINE="$(grep -o '"systemMessage":"ctx-watch:[^"]*' "$OUT" | head -1 | cut -c18-)"
echo "ctx-watch said: ${LINE:-(nothing: ctx healthy on this host, timer not yet due)}"
echo "pass: hooks ran, handler stamped, no errors.log line"
exit 0
