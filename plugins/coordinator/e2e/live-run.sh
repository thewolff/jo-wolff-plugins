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
# checkout's hooks, run by lib/live-run.mjs's hook phase (a sandbox per scenario; no model).
# Then headless (`claude -p`), with the plugin loaded from THIS checkout, no user, project or local
# settings (`--setting-sources ""`, so no other plugin or hook runs), the installed copy
# disabled, and a temp config that lists the trial folder and names an expectedModel no model
# matches (so a model notice, had one fired, would not pass on silence):
#   1. The host ran UserPromptSubmit hooks: a hook_response event for UserPromptSubmit.
#   2. This plugin's clock hook answered: a UserPromptSubmit hook_response event carries the full
#      clock line (`The system clock reads <date time zone> (...), which is <UTC>, as of this prompt.`).
#   3. A plain run leaves no errors.log line.
# The model notice fires only on PostModelSwitch, which a one-prompt `claude -p` run never
# triggers; its proof is the offline scenarios plus the manual entry in evals/manifest.json.
#
# The session must also end with a result event that reports completion (e2e/session-check.mjs,
# sessionProblem from the helper): a clock line followed by an API error is not a pass; a
# credential, network or rate-limit ending is exit 75.
#
# How it fails: a hook scenario fails, or the live-run helper is missing → exit 1 with the helper's lines. `claude` missing → 75.
# `claude` present but the run exits non-zero naming a login, credential, network, rate-limit or overload problem → 75;
# any other non-zero → that exit code. An assertion fails with its step number. Everything is
# under a mktemp directory removed at exit; the transcript is copied to CANARY_TRANSCRIPT when
# set. `--no-live` stops after the hook phase: exit 75 with the helper's
# `unavailable: live phase skipped (--no-live); N hook scenario(s) passed offline` last.

set -u
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="${CANARY_PLUGIN:-coordinator}"
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
  echo "fail: no live-run helper at $PLUGIN_DIR/lib/live-run.mjs or $PLUGIN_DIR/../plugin-kit/lib/live-run.mjs, so no hook scenario ran"
  exit 1
fi

if [ "$NO_LIVE" = 1 ]; then
  exit 75
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "unavailable: claude not found on PATH"
  exit 75
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/$PLUGIN-canary.XXXXXX")"
trap 'rm -r -f "$T"' EXIT
mkdir -p "$T/trial" "$T/state" "$T/config/coordinator"
unset LEDGER_DB LEDGER_CONFIG LEDGER_ENABLED
export XDG_STATE_HOME="$T/state"
export XDG_CONFIG_HOME="$T/config"
TRIAL="$(cd "$T/trial" && pwd -P)"
printf '{"folders": ["%s"], "expectedModel": "claude-no-such-model", "clock": true}\n' "$TRIAL" >"$T/config/coordinator/config.json"

echo "$PLUGIN canary: plugin $PLUGIN_DIR"
echo "claude: $(claude --version 2>/dev/null)"

OUT="$T/run.jsonl"
cd "$TRIAL" || exit 1
timeout "$((TIMEOUT - 10 > 30 ? TIMEOUT - 10 : 30))" claude -p \
  --setting-sources "" \
  --plugin-dir "$PLUGIN_DIR" \
  --settings "{\"enabledPlugins\":{\"$PLUGIN@jo-wolff-plugins\":false}}" \
  --output-format stream-json --verbose --include-hook-events \
  --allowedTools Read \
  -- "Say hello in one line, and quote the system clock line you were given." >"$OUT" 2>"$T/run.err"
CODE=$?
[ -n "${CANARY_TRANSCRIPT:-}" ] && { mkdir -p "$(dirname "$CANARY_TRANSCRIPT")" && cp "$OUT" "$CANARY_TRANSCRIPT" 2>/dev/null; }

if [ "$CODE" -ne 0 ]; then
  echo "claude exited $CODE; stderr:"
  cat "$T/run.err"
  # The same classification as a zero exit first: a result event naming credentials, network or a rate limit.
  if [ "$(node "$PLUGIN_DIR/e2e/session-check.mjs" "$HELPER" "$OUT" "$CODE" >/dev/null 2>&1; echo $?)" -eq 2 ]; then
    echo "unavailable: the session ended on a credential, network or rate-limit problem"
    exit 75
  fi
  # rate_limit_error (429) and overloaded_error (529) are the Claude API's error types.
  UNAVAILABLE_RE='not logged in|log in|login|credential|unauthori[sz]ed|api key|authentication|network|ENOTFOUND|ECONNREFUSED|rate[ _]limit|overloaded'
  if grep -qiE "$UNAVAILABLE_RE" "$T/run.err" "$OUT"; then
    echo "unavailable: claude could not run (credentials, network, rate limit or overload)"
    exit 75
  fi
  exit "$CODE"
fi

SESSION="$(node "$PLUGIN_DIR/e2e/session-check.mjs" "$HELPER" "$OUT" "$CODE" 2>&1)"
SCODE=$?
if [ "$SCODE" -eq 2 ]; then
  echo "$SESSION"
  echo "unavailable: the session ended on a credential, network or rate-limit problem"
  exit 75
elif [ "$SCODE" -ne 0 ]; then
  echo "fail 0: the session did not complete: $SESSION"
  exit 1
fi
echo "step 0: the session's result event reports completion"
if ! grep -q '"subtype":"hook_response".*"hook_event":"UserPromptSubmit"' "$OUT"; then
  echo "fail 1: no hook_response event for UserPromptSubmit in the stream-json"
  exit 1
fi
echo "step 1: the host ran UserPromptSubmit hooks"
# The hook's own answer: a UserPromptSubmit hook_response event carrying the whole clock line, not the
# model's reply or the prompt echoing the phrase.
CLOCK_RE='The system clock reads [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} .*, which is [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z, as of this prompt\.'
if ! grep '"subtype":"hook_response"' "$OUT" | grep '"hook_event":"UserPromptSubmit"' | grep -qE "$CLOCK_RE"; then
  echo "fail 2: no UserPromptSubmit hook_response carries the clock line"
  exit 1
fi
echo "step 2: the clock line was delivered"
if [ -s "$T/state/$PLUGIN/errors.log" ]; then
  echo "fail 3: errors.log is not empty after a plain run:"
  cat "$T/state/$PLUGIN/errors.log"
  exit 1
fi
echo "pass: clock line delivered, no errors.log line"
exit 0
