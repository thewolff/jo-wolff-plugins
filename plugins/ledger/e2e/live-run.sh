#!/usr/bin/env bash
# e2e/live-run.sh — the ledger's live run for the nightly canary (`ledger canary run`).
#
# THE CANARY CONTRACT (the same for every plugin; new plugins copy it from plugin-kit):
#   run from the plugin directory; env CANARY_PLUGIN (this plugin's name), CANARY_TRANSCRIPT (a
#   path this script may write its stream-json transcript to; stdout is kept by the canary
#   regardless), CANARY_TIMEOUT_S (the deadline the canary kills at). Exit 0 = pass. Exit 75 =
#   unavailable, with the reason on the LAST line of stdout (no `claude`, no credentials, no
#   network). Any other exit = fail. Every line of stdout is kept as the run's summary.
#
# What this run proves, headless (`claude -p`), with the plugin loaded from THIS checkout and the
# installed ledger disabled, against a throwaway database and config:
#   1. SessionStart ran and injected the folder's state (the hook ran, the CLI path resolved).
#   2. A question asked in another folder is relayed: the model's first reply contains its body
#      (it can only know the question from the start context, so 2 proves 1).
#   3. The reply does not trip the Stop ask rule (no bounce row with rule stopAskRule).
#   4. The database has the session row and the bounce table is readable (`doctor` exits 0).
#
# How it fails: `claude` missing → 75. `claude` present but the run exits non-zero (no
# credentials, network, a crash) → 75 when its output names a login/credential problem, else
# the real exit code. The assertions below fail with the number of the step and the evidence
# line. Everything is under a mktemp directory removed at exit; the transcript is copied to
# CANARY_TRANSCRIPT when set.

set -u
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$PLUGIN_DIR/scripts/ledger.mjs"
TIMEOUT="${CANARY_TIMEOUT_S:-300}"

if ! command -v claude >/dev/null 2>&1; then
  echo "unavailable: claude not found on PATH"
  exit 75
fi
if ! command -v node >/dev/null 2>&1; then
  echo "unavailable: node not found on PATH"
  exit 75
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/ledger-canary.XXXXXX")"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/trial" "$T/other" "$T/cfg"
cat > "$T/cfg/config.json" <<EOF
{ "db": "$T/ledger.sqlite", "enabled": true, "review": { "mode": "off" }, "sweep": { "autoWithdrawDays": 0 }, "digest": { "enabled": false } }
EOF
export LEDGER_CONFIG="$T/cfg/config.json"

echo "ledger canary: plugin $PLUGIN_DIR"
echo "claude: $(claude --version 2>/dev/null | head -1)"

# Seed: one open question in the OTHER folder, so this folder's start lists it as elsewhere.
if ! node "$CLI" ask "Should the trial use a local or a remote database?" --name db-mode --options local,remote --cwd "$T/other" >"$T/seed.txt" 2>&1; then
  echo "fail: seeding the question: $(cat "$T/seed.txt")"
  exit 1
fi
echo "seeded: $(head -1 "$T/seed.txt")"

OUT="$T/run.jsonl"
cd "$T/trial" || exit 1
timeout "$((TIMEOUT - 10 > 30 ? TIMEOUT - 10 : 30))" claude -p \
  --plugin-dir "$PLUGIN_DIR" \
  --settings '{"enabledPlugins":{"ledger@jo-wolff-plugins":false}}' \
  --output-format stream-json --verbose --include-hook-events \
  --allowedTools "Bash(node:*)" Skill Read \
  -- "Hi. Just say hello and ask me what we are working on." >"$OUT" 2>"$T/run.err"
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

# The assistant's text, concatenated, from the stream-json events.
node - "$OUT" >"$T/reply.txt" <<'EOF'
const fs = require("fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
let text = "";
for (const l of lines) {
  let e;
  try { e = JSON.parse(l); } catch { continue; }
  if (e.type === "assistant" && Array.isArray(e.message?.content)) for (const c of e.message.content) if (c.type === "text") text += c.text + "\n";
}
process.stdout.write(text);
EOF
REPLY="$(cat "$T/reply.txt")"
echo "reply: $(echo "$REPLY" | tr '\n' ' ' | cut -c1-300)"

# 1 + 2. SessionStart injected and the elsewhere question's body was relayed: the model can
# only know the question from the start context, so the relay proves both.
if ! echo "$REPLY" | grep -qi "local or a remote database"; then
  echo "fail 2: the first reply does not relay the elsewhere question's body"
  exit 1
fi
# 3. No stopAskRule bounce.
BOUNCES="$(node "$CLI" bounces 2>&1)"
if echo "$BOUNCES" | grep -q "stopAskRule"; then
  echo "fail 3: the relay tripped the Stop ask rule:"
  echo "$BOUNCES"
  exit 1
fi
# 4. The session was recorded and doctor is clean enough to exit 0.
SESSIONS="$(node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare("SELECT count(*) AS n FROM cc_sessions WHERE cwd LIKE ?").get("%/trial").n)' "$T/ledger.sqlite" 2>/dev/null)"
if [ "$SESSIONS" != "1" ]; then
  echo "fail 4: expected one session row for the trial folder, got: $SESSIONS"
  exit 1
fi
if ! node "$CLI" doctor >"$T/doctor.txt" 2>&1; then
  echo "fail 4: doctor exited non-zero:"
  cat "$T/doctor.txt"
  exit 1
fi
echo "pass: start injected, elsewhere question relayed, no ask-rule bounce, session recorded, doctor exit 0"
exit 0
