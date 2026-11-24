#!/usr/bin/env bash
# test/fixtures/capture-transcripts.sh - capture the Claude Code transcripts and hook payloads that
# test/transcript.test.mjs and test/subagent-stop-hook.test.mjs parse. Run by hand, never by
# `node --test` (repo AGENTS.md, item 4: a parser of another tool's output is tested against
# output saved from a real run).
#
#   bash plugins/output-types/test/fixtures/capture-transcripts.sh
#   CAPTURE_SETTING_SOURCES=user bash plugins/output-types/test/fixtures/capture-transcripts.sh
#
# The second form loads the user's own settings; on the machine these fixtures were captured on,
# that is what gives subagents the SubagentHandback tool. Check the scrubbed files for anything
# private before committing them.
#
# What it does: in a throwaway directory, runs one `claude -p` turn with this plugin loaded
# (--plugin-dir) and a fixed, synthetic prompt that makes three Bash calls, one WebFetch, one Skill
# call and one Agent dispatch to a subagent that runs a Bash call and reports. Two extra hooks,
# passed with --settings, copy the Stop and SubagentStop payloads to files. Then it copies the main
# and subagent transcripts and both payloads here, with the home directory and the throwaway
# directory rewritten to /home/user and /work and harness bookkeeping entries dropped, so nothing
# machine-specific lands in the repo:
#   cc-main-turns.jsonl, cc-subagent-handback.jsonl, cc-stop-payload.json, cc-subagentstop-payload.json
# It also prints whether the subagent transcript held a SubagentHandback call when SubagentStop
# fired (the payload file records the transcript's line count at that moment).
#
# How it fails: `claude` not on PATH → exit 75 with the reason. The run fails or writes no
# transcript → exit 1 naming what is missing; the existing fixtures are left as they were.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/../.." && pwd)"
command -v claude >/dev/null 2>&1 || { echo "unavailable: claude not found on PATH"; exit 75; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ot-capture-XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
CAP="$WORK/.capture"
mkdir -p "$CAP"
cd "$WORK"
git init -q .

# Each capture hook writes the payload, then the agent transcript's line count at that moment.
cat > "$CAP/tee.sh" <<'TEE'
#!/usr/bin/env bash
out="$1"
cat > "$out"
p="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.agent_transcript_path||"")' "$out")"
if [ -n "$p" ] && [ -f "$p" ]; then wc -l < "$p" > "$out.lines"; grep -c '"name":"SubagentHandback"' "$p" > "$out.handback" || true; fi
TEE
chmod +x "$CAP/tee.sh"
SETTINGS=$(cat <<JSON
{"hooks":{
  "Stop":[{"hooks":[{"type":"command","command":"bash '$CAP/tee.sh' '$CAP/stop.json'"}]}],
  "SubagentStop":[{"hooks":[{"type":"command","command":"bash '$CAP/tee.sh' '$CAP/subagentstop.json'"}]}]
}}
JSON
)

PROMPT='This is a test of tool-call logging; follow the steps exactly and in order.
1. Use the Bash tool three separate times: `echo one`, then `echo two`, then `ls -a`.
2. Use the WebFetch tool on https://example.com with the prompt "Return the page title".
3. Use the Skill tool to load the output-types skill.
4. Use the Agent tool to dispatch a general-purpose subagent with this task: "Run `echo from-subagent` with the Bash tool, then report what it printed, labelling the fact as the output-types skill says."
5. Finish with a short reply that says which steps ran.'

# --setting-sources "" keeps the user's own settings, plugins and memory out of the run (and so out
# of the fixtures); the login still comes from the real HOME, as plugin-kit's live-run.mjs does.
claude -p "$PROMPT" --setting-sources "${CAPTURE_SETTING_SOURCES-}" --plugin-dir "$PLUGIN_DIR" --settings "$SETTINGS" \
  --allowedTools "Bash(echo:*)" "Bash(ls:*)" "WebFetch(domain:example.com)" "Agent" "Task" "Skill" \
  --output-format json > "$CAP/result.json" 2> "$CAP/stderr.txt" || { echo "claude -p failed: $(tail -3 "$CAP/stderr.txt")"; exit 1; }

[ -f "$CAP/stop.json" ] || { echo "no Stop payload captured in $CAP"; exit 1; }
MAIN="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).transcript_path||"")' "$CAP/stop.json")"
[ -f "$MAIN" ] || { echo "main transcript $MAIN not found"; exit 1; }
SUB=""
if [ -f "$CAP/subagentstop.json" ]; then
  SUB="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).agent_transcript_path||"")' "$CAP/subagentstop.json")"
fi

# Paths rewritten; harness bookkeeping entries (attachment, system, api-request-*: any entry that
# is not a user or assistant entry) are dropped: they carry the session's whole prompt, hook notes and
# tool listing, which the parser never reads and the repo should not hold.
scrub() {
  sed -e "s#$WORK#/work#g" -e "s#$HOME#/home/user#g" "$1" | node -e '
    const lines = require("fs").readFileSync(0, "utf8").split("\n");
    const keep = (l) => { if (!l.trim()) return false; try { const e = JSON.parse(l); return !e.type || ["user", "assistant"].includes(e.type); } catch { return true; } };
    process.stdout.write(lines.filter(keep).join("\n") + "\n");'
}
scrub "$MAIN" > "$HERE/cc-main-turns.jsonl"
scrub "$CAP/stop.json" > "$HERE/cc-stop-payload.json"
if [ -n "$SUB" ] && [ -f "$SUB" ]; then
  scrub "$SUB" > "$HERE/cc-subagent-handback.jsonl"
  scrub "$CAP/subagentstop.json" > "$HERE/cc-subagentstop-payload.json"
  echo "subagent transcript lines at SubagentStop: $(cat "$CAP/subagentstop.json.lines" 2>/dev/null || echo unknown); SubagentHandback calls then: $(cat "$CAP/subagentstop.json.handback" 2>/dev/null || echo unknown); lines now: $(wc -l < "$SUB")"
else
  echo "no SubagentStop payload or agent transcript captured"
fi
echo "captured into $HERE from $WORK"
echo "check the scrubbed files for private text (other sessions' held questions, names) before committing them"
