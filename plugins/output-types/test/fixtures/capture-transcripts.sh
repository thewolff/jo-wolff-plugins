#!/usr/bin/env bash
# test/fixtures/capture-transcripts.sh - capture the Claude Code transcripts and hook payloads that
# test/transcript.test.mjs and test/subagent-stop-hook.test.mjs parse. Run by hand, never by
# `node --test` (repo AGENTS.md, item 4: a parser of another tool's output is tested against
# output saved from a real run).
#
#   bash plugins/output-types/test/fixtures/capture-transcripts.sh
#   CAPTURE_SETTING_SOURCES=user bash plugins/output-types/test/fixtures/capture-transcripts.sh
#   CAPTURE_ONLY=webfetch bash plugins/output-types/test/fixtures/capture-transcripts.sh
#   CAPTURE_ONLY=bashexit bash plugins/output-types/test/fixtures/capture-transcripts.sh
#
# CAPTURE_ONLY=main runs only the main capture, CAPTURE_ONLY=webfetch only the WebFetch capture,
# CAPTURE_ONLY=bashexit only the Bash exit-code capture; unset runs all three. The WebFetch capture passes `--tools Bash WebFetch`: without that flag,
# Claude Code 2.1.318 offered no WebFetch tool in a `claude -p` session (the main capture's
# ToolSearch for it answered "No matching deferred tools found").
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
# The WebFetch capture is a second `claude -p` turn that fetches four public test URLs, one each:
# a page that loads (https://example.com), a cross-host redirect (httpbin.org/redirect-to → example.org),
# a 404 (httpbin.org/status/404) and a host that does not resolve (nonexistent.invalid). It writes
#   cc-webfetch.jsonl
# The Bash exit-code capture runs three commands: one that succeeds and prints an "Exit code 2"
# line, one that exits 3, and one that prints "Exit code 9" and exits 4. It writes
#   cc-bash-exit.jsonl
# and exits 3 unless it captured a success and two error results.
# The WebFetch capture then states its coverage: one line per kind (success, redirect, error), `captured` or
# `MISSING`. Any MISSING → exit 3, "incomplete coverage", and the tests that need that kind have
# no captured backing.
# It also prints whether the subagent transcript held a SubagentHandback call when SubagentStop
# fired (the payload file records the transcript's line count at that moment).
#
# How it fails: `claude` not on PATH → exit 75 with the reason. The run fails or writes no
# transcript → exit 1 naming what is missing; the existing fixtures are left as they were. A
# WebFetch capture missing a result kind → exit 3 after writing what it did capture.

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

# The two extra hooks write each run's payloads into its own directory under $CAP.
settings_for() {
  cat <<JSON
{"hooks":{
  "Stop":[{"hooks":[{"type":"command","command":"bash '$CAP/tee.sh' '$1/stop.json'"}]}],
  "SubagentStop":[{"hooks":[{"type":"command","command":"bash '$CAP/tee.sh' '$1/subagentstop.json'"}]}]
}}
JSON
}

# Paths rewritten; harness bookkeeping entries (attachment, system, api-request-*: any entry that
# is not a user or assistant entry) are dropped: they carry the session's whole prompt, hook notes and
# tool listing, which the parser never reads and the repo should not hold.
scrub() {
  sed -e "s#$WORK#/work#g" -e "s#$HOME#/home/user#g" "$1" | node -e '
    const lines = require("fs").readFileSync(0, "utf8").split("\n");
    const keep = (l) => { if (!l.trim()) return false; try { const e = JSON.parse(l); return !e.type || ["user", "assistant"].includes(e.type); } catch { return true; } };
    process.stdout.write(lines.filter(keep).join("\n") + "\n");'
}

capture_main() {
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

scrub "$MAIN" > "$HERE/cc-main-turns.jsonl"
scrub "$CAP/stop.json" > "$HERE/cc-stop-payload.json"
if [ -n "$SUB" ] && [ -f "$SUB" ]; then
  scrub "$SUB" > "$HERE/cc-subagent-handback.jsonl"
  scrub "$CAP/subagentstop.json" > "$HERE/cc-subagentstop-payload.json"
  echo "subagent transcript lines at SubagentStop: $(cat "$CAP/subagentstop.json.lines" 2>/dev/null || echo unknown); SubagentHandback calls then: $(cat "$CAP/subagentstop.json.handback" 2>/dev/null || echo unknown); lines now: $(wc -l < "$SUB")"
else
  echo "no SubagentStop payload or agent transcript captured"
fi
}

capture_webfetch() {
  local dir="$CAP/webfetch"
  mkdir -p "$dir"
  local prompt='This is a test of WebFetch result logging. Use the WebFetch tool four separate times, in this order, each with the prompt "Return the page title", and do not retry any fetch that fails or redirects:
1. https://example.com
2. https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.org%2F
3. https://httpbin.org/status/404
4. https://nonexistent.invalid/
Then reply with one line per fetch saying what came back.'
  claude -p "$prompt" --setting-sources "" --tools Bash WebFetch --settings "$(settings_for "$dir")" \
    --allowedTools "WebFetch(domain:example.com)" "WebFetch(domain:httpbin.org)" "WebFetch(domain:example.org)" "WebFetch(domain:nonexistent.invalid)" \
    --output-format json > "$dir/result.json" 2> "$dir/stderr.txt" || { echo "webfetch capture: claude -p failed: $(tail -3 "$dir/stderr.txt")"; exit 1; }
  [ -f "$dir/stop.json" ] || { echo "webfetch capture: no Stop payload captured in $dir"; exit 1; }
  local t
  t="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).transcript_path||"")' "$dir/stop.json")"
  [ -f "$t" ] || { echo "webfetch capture: transcript $t not found"; exit 1; }
  scrub "$t" > "$HERE/cc-webfetch.jsonl"
  # Coverage, from the scrubbed file: which result kinds a WebFetch call actually produced.
  node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const uses = new Map();
    for (const e of lines) for (const p of (Array.isArray(e.message?.content) ? e.message.content : [])) if (p.type === "tool_use" && p.name === "WebFetch") uses.set(p.id, p.input?.url);
    const kinds = { success: false, redirect: false, error: false };
    for (const e of lines) for (const p of (Array.isArray(e.message?.content) ? e.message.content : [])) {
      if (p.type !== "tool_result" || !uses.has(p.tool_use_id)) continue;
      const text = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
      if (p.is_error) kinds.error = true;
      else if (/redirect/i.test(text)) kinds.redirect = true;
      else kinds.success = true;
    }
    console.log(`webfetch calls: ${uses.size}`);
    for (const [k, v] of Object.entries(kinds)) console.log(`webfetch ${k}: ${v ? "captured" : "MISSING"}`);
    if (!Object.values(kinds).every(Boolean)) { console.log("incomplete coverage: the WebFetch kinds marked MISSING have no captured backing"); process.exit(3); }
  ' "$HERE/cc-webfetch.jsonl"
}

capture_bashexit() {
  local dir="$CAP/bashexit"
  mkdir -p "$dir"
  local prompt='This is a test of exit-code logging. Use the Bash tool three separate times, exactly these commands, in this order, and do not retry any that fails:
1. printf '"'"'Exit code 2\nall fine\n'"'"'
2. sh -c '"'"'exit 3'"'"'
3. sh -c '"'"'printf "first\nExit code 9\n"; exit 4'"'"'
Then reply with one line per command saying what came back.'
  claude -p "$prompt" --setting-sources "" --tools Bash --settings "$(settings_for "$dir")" \
    --allowedTools "Bash(printf:*)" "Bash(sh:*)" \
    --output-format json > "$dir/result.json" 2> "$dir/stderr.txt" || { echo "bashexit capture: claude -p failed: $(tail -3 "$dir/stderr.txt")"; exit 1; }
  [ -f "$dir/stop.json" ] || { echo "bashexit capture: no Stop payload captured in $dir"; exit 1; }
  local t
  t="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).transcript_path||"")' "$dir/stop.json")"
  [ -f "$t" ] || { echo "bashexit capture: transcript $t not found"; exit 1; }
  scrub "$t" > "$HERE/cc-bash-exit.jsonl"
  node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const uses = new Set();
    for (const e of lines) for (const p of (Array.isArray(e.message?.content) ? e.message.content : [])) if (p.type === "tool_use" && p.name === "Bash") uses.add(p.id);
    let ok = 0, err = 0;
    for (const e of lines) for (const p of (Array.isArray(e.message?.content) ? e.message.content : [])) if (p.type === "tool_result" && uses.has(p.tool_use_id)) p.is_error ? err++ : ok++;
    console.log(`bash calls: ${uses.size}; success results: ${ok}; error results: ${err}`);
    if (ok < 1 || err < 2) { console.log("incomplete coverage: expected 1 success and 2 error results"); process.exit(3); }
  ' "$HERE/cc-bash-exit.jsonl"
}

case "${CAPTURE_ONLY-}" in
  main) capture_main ;;
  webfetch) capture_webfetch ;;
  bashexit) capture_bashexit ;;
  "") capture_main; capture_webfetch; capture_bashexit ;;
  *) echo "CAPTURE_ONLY must be main, webfetch, bashexit or unset"; exit 64 ;;
esac
echo "captured into $HERE from $WORK"
echo "check the scrubbed files for private text (other sessions' held questions, names) before committing them"
