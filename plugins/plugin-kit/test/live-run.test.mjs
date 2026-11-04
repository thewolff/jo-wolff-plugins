// live-run.test.mjs — lib/live-run.mjs, the scenario runner every scaffold's e2e/live-run.sh
// hands off to (README "What it does", "Changes in 0.2.0"): a hook's stdout classified as one
// outcome; a scenario's hook phase in its own sandbox (pass on the expected outcome and reason,
// fail naming what differed, indeterminate when no hook matches); setup files and env reach the
// hook and are not counted as its writes, while what the hook leaves outside the work directory
// is printed as `wrote:`; an unfilled stub is a fail, and the manifest's uncovered outcomes are
// named; the judge is `claude plugin eval` over a case.yaml + scaffold.sh written inside the
// plugin and removed after, and a judge that cannot run or cannot log in is `unavailable` (exit
// 75), never a pass; the CLI's exit codes and the canary transcript.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyOutput, coverageProblems, hookCommands, judgeCase, judgeScenario, judgeVerdict, loadScenarios, outputText, run, runHookScenario, substitute, UNAVAILABLE_EXIT } from "../lib/live-run.mjs";

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(KIT_ROOT, "lib", "live-run.mjs");
const temp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// A fixture plugin whose one hook answers PreToolUse (Write|Edit) and Stop:
//   PreToolUse: content with "secret" → deny naming `fixture allow`; a config file under
//   $XDG_CONFIG_HOME/fixture/config.json with {"deny": "<why>"} → deny with that text; FIXTURE_MOOD=grumpy
//   → deny; otherwise silent. Every PreToolUse appends one line to $XDG_STATE_HOME/fixture/seen.log.
//   Stop: a transcript containing "needle" → systemMessage; otherwise silent. FIXTURE_CRASH=1 → exit 3.
const HOOK = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  if (process.env.FIXTURE_CRASH === "1") { process.stderr.write("fixture: crashed on purpose"); process.exit(3); }
  let input = {};
  try { input = JSON.parse(raw); } catch { process.stdout.write(JSON.stringify({ systemMessage: "fixture: stdin not JSON" })); return; }
  const deny = (why) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } }));
  if (input.hook_event_name === "PreToolUse") {
    const dir = join(process.env.XDG_STATE_HOME, "fixture");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "seen.log"), (input.tool_input?.file_path ?? "?") + "\\n");
    const cfg = join(process.env.XDG_CONFIG_HOME, "fixture", "config.json");
    if (existsSync(cfg)) { const c = JSON.parse(readFileSync(cfg, "utf8")); if (c.deny) return deny("fixture: " + c.deny + "; run \`fixture allow\` first"); }
    if (process.env.FIXTURE_MOOD === "grumpy") return deny("fixture: grumpy; run \`fixture cheer\` first");
    if (String(input.tool_input?.content ?? "").includes("secret")) return deny("fixture: no secrets in " + input.tool_input.file_path + "; run \`fixture allow\` first");
    return;
  }
  if (input.hook_event_name === "Stop") {
    let t = "";
    try { t = readFileSync(input.transcript_path, "utf8"); } catch {}
    if (t.includes("needle")) process.stdout.write(JSON.stringify({ systemMessage: "fixture: the needle was in the transcript" }));
  }
});
`;
const HOOKS_JSON = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/h.mjs"', timeout: 5 }] }], Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/h.mjs"', timeout: 5 }] }] } });
const MANIFEST = { events: { PreToolUse: ["deny", "silent"], Stop: ["systemMessage", "silent"] }, manual: [] };
const write = (dir, rel, text) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
};
const preInput = (content = "hello", file = "${CWD}/notes.txt") => ({ session_id: "${SESSION_ID}", cwd: "${CWD}", hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file, content } });
const stopInput = () => ({ session_id: "${SESSION_ID}", cwd: "${CWD}", transcript_path: "${TRANSCRIPT}", hook_event_name: "Stop", stop_hook_active: false });
/** The fixture plugin in a temp directory, with `scenarios` (name → json) under evals/. */
function fixture(scenarios = {}, { manifest = MANIFEST } = {}) {
  const dir = join(temp("kit-live-"), "fixture");
  write(dir, "hooks/hooks.json", HOOKS_JSON);
  write(dir, "hooks/h.mjs", HOOK);
  write(dir, ".claude-plugin/plugin.json", { name: "fixture", version: "0.0.1" });
  if (manifest) write(dir, "evals/manifest.json", manifest);
  for (const [name, json] of Object.entries(scenarios)) write(dir, `evals/${name}.scenario.json`, json);
  return dir;
}
const scenariosOf = (dir) => loadScenarios(dir).scenarios;
const hookRun = (dir, name) => runHookScenario(scenariosOf(dir).find((s) => s.name === name), { pluginDir: dir, pluginName: "fixture", env: { PATH: process.env.PATH, HOME: process.env.HOME, LEDGER_DB: "/never/read", FIXTURE_MOOD: "grumpy" } });

test("classifyOutput and outputText: deny, block and continue:false are deny; ask; allow; a systemMessage or additionalContext; anything else, not JSON included, is silent", () => {
  assert.equal(classifyOutput(""), "silent");
  assert.equal(classifyOutput("   \n"), "silent");
  assert.equal(classifyOutput("not json"), "silent");
  assert.equal(classifyOutput("[1]"), "silent");
  assert.equal(classifyOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" } })), "deny");
  assert.equal(classifyOutput(JSON.stringify({ decision: "block", reason: "no" })), "deny");
  assert.equal(classifyOutput(JSON.stringify({ continue: false, stopReason: "halt" })), "deny");
  assert.equal(classifyOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } })), "ask");
  assert.equal(classifyOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })), "allow");
  assert.equal(classifyOutput(JSON.stringify({ systemMessage: "hi" })), "systemMessage");
  assert.equal(classifyOutput(JSON.stringify({ systemMessage: "  " })), "silent");
  assert.equal(classifyOutput(JSON.stringify({ hookSpecificOutput: { additionalContext: "ctx" } })), "systemMessage");
  assert.equal(classifyOutput(JSON.stringify({ suppressOutput: true })), "silent");
  assert.equal(outputText(JSON.stringify({ hookSpecificOutput: { permissionDecisionReason: "a", additionalContext: "e" }, reason: "b", stopReason: "c", systemMessage: "d" })), "a\nb\nc\nd\ne");
  assert.equal(outputText("plain"), "plain");
  assert.equal(outputText("42"), "");
});

test("hookCommands and substitute: ${CLAUDE_PLUGIN_ROOT} resolved in command and args, the matcher kept; ${VAR} placeholders through strings, arrays and objects", () => {
  const dir = fixture();
  assert.deepEqual(hookCommands(dir), [
    { event: "PreToolUse", matcher: "Write|Edit", command: `node "${dir}/hooks/h.mjs"` },
    { event: "Stop", matcher: null, command: `node "${dir}/hooks/h.mjs"` },
  ]);
  write(dir, "hooks/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/h.mjs", "--x"] }, { type: "prompt", prompt: "ignored" }] }] } });
  assert.deepEqual(hookCommands(dir), [{ event: "Stop", matcher: null, command: `node "${dir}/hooks/h.mjs" "--x"` }]);
  assert.equal(hookCommands(join(dir, "nowhere")), null);
  assert.deepEqual(substitute({ a: "${CWD}/x", b: ["${HOME}", 1], c: "${UNKNOWN}" }, { CWD: "/w", HOME: "/h" }), { a: "/w/x", b: ["/h", 1], c: "${UNKNOWN}" });
});

test("hook phase: pass on the expected outcome carrying the reason; fail naming the outcome that differed, the missing reason text, or the hook's exit; indeterminate when no registered hook matches the input", () => {
  const dir = fixture({
    "deny-secret": { event: "PreToolUse", expect: "deny", reason: "run `fixture allow`", stdin: preInput("a secret") },
    "silent-hello": { event: "PreToolUse", expect: "silent", sibling: "deny-secret.scenario.json", stdin: preInput("hello") },
    "wrong-expect": { event: "PreToolUse", expect: "silent", sibling: "deny-secret.scenario.json", stdin: preInput("a secret") },
    "wrong-reason": { event: "PreToolUse", expect: "deny", reason: "run `fixture forgive`", stdin: preInput("a secret") },
    "no-match": { event: "PreToolUse", expect: "deny", stdin: { ...preInput("a secret"), tool_name: "Bash" } },
    "crash": { event: "Stop", expect: "silent", sibling: "stop-needle.scenario.json", setup: { env: { FIXTURE_CRASH: "1" } }, stdin: stopInput() },
    "stop-needle": { event: "Stop", expect: "systemMessage", reason: "the needle", transcript: [{ type: "user", message: "a needle here" }], stdin: stopInput() },
    "stop-quiet": { event: "Stop", expect: "silent", sibling: "stop-needle.scenario.json", transcript: ["{\"type\":\"user\"}"], stdin: stopInput() },
  });
  assert.deepEqual(loadScenarios(dir).errors, []);
  const r = (n) => hookRun(dir, n);
  const deny = r("deny-secret");
  assert.equal(deny.verdict, "pass", deny.why);
  assert.equal(deny.why, "PreToolUse → deny");
  assert.equal(deny.outcome, "deny");
  assert.deepEqual(deny.writes, ["$XDG_STATE_HOME/fixture/seen.log"], "the hook's own write outside the work directory is reported");
  assert.equal(r("silent-hello").verdict, "pass", "FIXTURE_MOOD from the caller's environment never reaches the hook: the sandbox env is the hook's");
  const wrong = r("wrong-expect");
  assert.equal(wrong.verdict, "fail");
  assert.match(wrong.why, /^expected silent, got deny \(fixture: no secrets in .*\/notes\.txt; run `fixture allow` first\)$/, wrong.why);
  const reason = r("wrong-reason");
  assert.equal(reason.verdict, "fail");
  assert.match(reason.why, /^the deny text does not carry "run `fixture forgive`": fixture: no secrets/, reason.why);
  const none = r("no-match");
  assert.equal(none.verdict, "indeterminate");
  assert.equal(none.why, 'no PreToolUse hook matches the input (tool_name "Bash")');
  const crash = r("crash");
  assert.equal(crash.verdict, "fail");
  assert.equal(crash.why, "Stop hook exited 3: fixture: crashed on purpose");
  assert.equal(r("stop-needle").verdict, "pass", "the transcript entries are written to ${TRANSCRIPT} and the hook reads them");
  assert.equal(r("stop-quiet").verdict, "pass");
});

test("setup: files under ~/ and $XDG_CONFIG_HOME reach the hook and are not its writes; env reaches it; before inputs run first; after.exists / absent / commands are checked; a failing setup command fails naming it", () => {
  const dir = fixture({
    "config-deny": { event: "PreToolUse", expect: "deny", reason: "fixture: by config; run `fixture allow`", setup: { files: { "$XDG_CONFIG_HOME/fixture/config.json": "{\"deny\":\"by config\"}", "notes.txt": "seeded" } }, stdin: preInput() },
    "env-deny": { event: "PreToolUse", expect: "deny", reason: "fixture: grumpy", setup: { env: { FIXTURE_MOOD: "grumpy" } }, stdin: preInput() },
    "before-and-after": { event: "PreToolUse", expect: "silent", sibling: "config-deny.scenario.json", before: [{ stdin: preInput("one", "${CWD}/a.txt") }, { stdin: preInput("two", "${CWD}/b.txt") }], stdin: preInput("three", "${CWD}/c.txt"), after: { exists: ["$XDG_STATE_HOME/fixture/seen.log"], absent: ["~/.config/fixture/config.json"], commands: ["test \"$(wc -l < \"${XDG_STATE_HOME}/fixture/seen.log\" | tr -d ' ')\" = 3", "grep -q c.txt \"${XDG_STATE_HOME}/fixture/seen.log\""] } },
    "after-fails": { event: "PreToolUse", expect: "silent", sibling: "config-deny.scenario.json", stdin: preInput(), after: { absent: ["$XDG_STATE_HOME/fixture/seen.log"] } },
    "setup-fails": { event: "PreToolUse", expect: "silent", sibling: "config-deny.scenario.json", setup: { commands: ["exit 7"] }, stdin: preInput() },
    "home-file": { event: "PreToolUse", expect: "silent", sibling: "config-deny.scenario.json", setup: { files: { "~/.fixture-rc": "x" } }, stdin: preInput() },
  });
  assert.deepEqual(loadScenarios(dir).errors, []);
  const r = (n) => hookRun(dir, n);
  const cfg = r("config-deny");
  assert.equal(cfg.verdict, "pass", cfg.why);
  assert.deepEqual(cfg.writes, ["$XDG_STATE_HOME/fixture/seen.log"], "the seeded config file is the scenario's, not a write");
  assert.equal(r("env-deny").verdict, "pass");
  const seq = r("before-and-after");
  assert.equal(seq.verdict, "pass", seq.why);
  const after = r("after-fails");
  assert.equal(after.verdict, "fail");
  assert.equal(after.why, "after: $XDG_STATE_HOME/fixture/seen.log still exists");
  const setup = r("setup-fails");
  assert.equal(setup.verdict, "fail");
  assert.match(setup.why, /^setup command `exit 7` exited 7/);
  const home = r("home-file");
  assert.equal(home.verdict, "pass");
  assert.deepEqual(home.writes, ["$XDG_STATE_HOME/fixture/seen.log"], "a file seeded under ~ is not a write either");
});

test("a stub is a fail naming the file, offline and in the run; the manifest's uncovered outcomes are named; a scenario naming an unregistered event, an undeclared outcome, or no stdin is a fail", () => {
  const dir = fixture({
    "pre-stub": { stub: true, event: "PreToolUse", expect: "silent", stdin: preInput() },
    "stop-needle": { event: "Stop", expect: "systemMessage", transcript: ["needle"], stdin: stopInput() },
    "stop-quiet": { event: "Stop", expect: "silent", sibling: "stop-needle.scenario.json", stdin: stopInput() },
    "bad-event": { event: "Notification", expect: "silent", stdin: {} },
    "bad-outcome": { event: "Stop", expect: "deny", stdin: stopInput() },
    "no-stdin": { event: "Stop", expect: "silent", sibling: "stop-needle.scenario.json" },
    "no-sibling": { event: "Stop", expect: "silent", stdin: stopInput() },
  });
  const { scenarios, errors } = loadScenarios(dir);
  assert.deepEqual(errors, [
    "evals/bad-event.scenario.json names Notification, which hooks/hooks.json does not register",
    "evals/bad-outcome.scenario.json expects deny, which the manifest does not declare for Stop",
    "evals/no-sibling.scenario.json stays silent but names no sibling scenario that fires",
    "evals/no-stdin.scenario.json has no stdin fixture (stdin or stdinFile)",
    "evals/pre-stub.scenario.json is an unfilled stub (remove \"stub\": true once its stdin and expect are real)",
    "evals/pre-stub.scenario.json stays silent but names no sibling scenario that fires",
  ]);
  assert.deepEqual(coverageProblems(dir, { manifest: MANIFEST, scenarios }), ["no scenario for PreToolUse × deny", "no scenario for PreToolUse × silent"], "a stub proves nothing");
  const stub = runHookScenario(scenarios.find((s) => s.name === "pre-stub"), { pluginDir: dir, pluginName: "fixture" });
  assert.equal(stub.verdict, "fail");
  assert.match(stub.why, /^is an unfilled stub .*; stays silent but names no sibling/);
  const r = run({ pluginDir: dir, live: false, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(r.code, 1);
  assert.equal(r.lines[0], `fixture live-run: plugin ${dir}`);
  assert.ok(r.lines.includes("fail: no scenario for PreToolUse × deny"), r.lines.join("\n"));
  assert.ok(r.lines.includes("scenario pre-stub: fail — is an unfilled stub (remove \"stub\": true once its stdin and expect are real); stays silent but names no sibling scenario that fires"), r.lines.join("\n"));
  assert.ok(r.lines.includes("scenario stop-needle: pass — Stop → systemMessage"), r.lines.join("\n"));
  assert.match(r.lines.at(-1), /^fail: \d+ problem\(s\); 2 hook scenario\(s\) passed, 0 live pass\(es\), 0 indeterminate$/, r.lines.at(-1));
  // No manifest at all: every registered event is named.
  const bare = fixture({}, { manifest: null });
  assert.deepEqual(coverageProblems(bare, { manifest: null, scenarios: [] }), ["evals/manifest.json missing; PreToolUse, Stop have no declared outcomes"]);
});

const COVERED = {
  "deny-secret": { event: "PreToolUse", expect: "deny", reason: "run `fixture allow`", stdin: preInput("a secret") },
  "silent-hello": { event: "PreToolUse", expect: "silent", sibling: "deny-secret.scenario.json", stdin: preInput("hello") },
  "stop-needle": { event: "Stop", expect: "systemMessage", transcript: ["needle"], stdin: stopInput() },
  "stop-quiet": { event: "Stop", expect: "silent", sibling: "stop-needle.scenario.json", stdin: stopInput() },
};
const JUDGED = { ...COVERED, "judged": { event: "session", session: { prompt: "Say hello.", allowedTools: ["Read", "Bash(ls:*)", "Write"], maxTurns: 3 }, judge: "The reply greets the person.", setup: { files: { "~/.fixture-rc": "greet", "$XDG_CONFIG_HOME/fixture/config.json": "{}" }, commands: ["touch marker"], env: { FIXTURE_MOOD: "kind" } } } };
const liveEnv = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra });

test("run: with no live phase or no claude the hook scenarios still run and the exit is 75 (unavailable) with the reason last; a live pass makes it 0; indeterminate alone is 75, never a pass; a live fail is 1", () => {
  const dir = fixture(COVERED);
  const offline = run({ pluginDir: dir, live: false, env: liveEnv() });
  assert.equal(offline.code, UNAVAILABLE_EXIT);
  assert.equal(offline.lines.at(-1), "unavailable: live phase skipped (--no-live); 4 hook scenario(s) passed offline");
  assert.ok(offline.lines.includes("wrote: $XDG_STATE_HOME/fixture/seen.log"), offline.lines.join("\n"));
  const noClaude = run({ pluginDir: dir, env: liveEnv(), claudePresent: false });
  assert.equal(noClaude.code, UNAVAILABLE_EXIT);
  assert.equal(noClaude.lines.at(-1), "unavailable: claude not found on PATH; 4 hook scenario(s) passed offline");
  const pass = run({ pluginDir: dir, env: liveEnv(), claudePresent: true, contract: () => ({ verdict: "pass", why: "ask became a denial" }) });
  assert.equal(pass.code, 0);
  assert.equal(pass.lines.at(-1), "pass: 4 hook scenario(s), 1 live pass(es), 0 indeterminate");
  assert.ok(pass.lines.includes("cli-contract: pass — ask became a denial"));
  const indeterminate = run({ pluginDir: dir, env: liveEnv(), claudePresent: true, contract: () => ({ verdict: "indeterminate", why: "terminal_reason api_error (credentials, network or rate limit)" }) });
  assert.equal(indeterminate.code, UNAVAILABLE_EXIT);
  assert.equal(indeterminate.lines.at(-1), "unavailable: every live session was indeterminate (1); 4 hook scenario(s) passed offline");
  const fail = run({ pluginDir: dir, env: liveEnv(), claudePresent: true, contract: () => ({ verdict: "fail", why: "Read was attempted and ask did not become a denial" }) });
  assert.equal(fail.code, 1);
  assert.equal(fail.lines.at(-1), "fail: 1 problem(s); 4 hook scenario(s) passed, 0 live pass(es), 0 indeterminate");
});

test("judgeCase: the eval case names the scenario, its prompt, turns, tools and env; the scaffold script writes the setup files (~ and XDG resolved in shell) and runs the commands; only the gated tools are granted with --allow-tools", () => {
  const { caseYaml, scaffold, allowTools } = judgeCase(loadScenarios(fixture(JUDGED)).scenarios.find((s) => s.name === "judged"), { timeoutS: 42 });
  assert.deepEqual(caseYaml, {
    schema_version: "1.0",
    name: "judged",
    context: { scaffold_script: "scaffold.sh" },
    execution: { prompt: "Say hello.", max_turns: 3, timeout_seconds: 42, allowed_tools: ["Read", "Bash(ls:*)", "Write"], env: { FIXTURE_MOOD: "kind" } },
    runs: 1,
    graders: [{ type: "llm", name: "rubric", criteria: "The reply greets the person." }],
  });
  assert.deepEqual(allowTools, ["Bash(ls:*)", "Write"]);
  assert.match(scaffold, /^#!\/bin\/sh\nset -e\n/);
  assert.ok(scaffold.includes('mkdir -p "$(dirname "$HOME/.fixture-rc")"'), scaffold);
  assert.ok(scaffold.includes(`printf '%s' '${Buffer.from("greet").toString("base64")}' | base64 -d > "$HOME/.fixture-rc"`), scaffold);
  assert.ok(scaffold.includes('> "${XDG_CONFIG_HOME:-$HOME/.config}/fixture/config.json"'), scaffold);
  assert.ok(scaffold.endsWith("touch marker\n"), scaffold);
  // The scaffold runs under sh and leaves the files it names.
  const home = temp("kit-judge-home-");
  const work = join(home, "work");
  mkdirSync(work);
  const r = spawnSync("/bin/sh", ["-c", scaffold], { cwd: work, env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(home, ".fixture-rc"), "utf8"), "greet");
  assert.equal(readFileSync(join(home, ".config", "fixture", "config.json"), "utf8"), "{}");
  assert.ok(existsSync(join(work, "marker")));
});

test("judgeVerdict: the rubric's pass with its votes; its fail with the evidence; a run error that is credentials, network or an API error is indeterminate, any other error a fail; no case loaded is a fail naming the stderr's last line", () => {
  const json = (run) => ({ cases: [{ name: "judged", arms: { with: [run] } }] });
  assert.deepEqual(judgeVerdict(json({ passed: true, graders: [{ explanation: "judge votes: PASS PASS PASS" }] }), "judged"), { verdict: "pass", why: "claude plugin eval: the rubric passed (judge votes: PASS PASS PASS)" });
  assert.deepEqual(judgeVerdict(json({ passed: false, graders: [{ explanation: "FAIL", evidence: "it said   goodbye" }] }), "judged"), { verdict: "fail", why: "claude plugin eval: the rubric failed (FAIL): it said goodbye" });
  assert.equal(judgeVerdict(json({ error: "API Error: 401 unauthorized" }), "judged").verdict, "indeterminate");
  assert.equal(judgeVerdict(json({ error: "rate limit reached" }), "judged").verdict, "indeterminate");
  assert.deepEqual(judgeVerdict(json({ error: "scaffold.sh exited 1" }), "judged"), { verdict: "fail", why: "claude plugin eval: scaffold.sh exited 1" });
  assert.deepEqual(judgeVerdict(json({}), "judged"), { verdict: "fail", why: "claude plugin eval: the rubric failed: " }, "a run with no passed flag is no pass");
  assert.deepEqual(judgeVerdict({ cases: [{ name: "judged", arms: {} }] }, "judged"), { verdict: "indeterminate", why: "claude plugin eval recorded no run for the case" });
  assert.deepEqual(judgeVerdict({ cases: [] }, "judged", { stderr: "warn\nError: invalid case: missing execution.prompt\n" }), { verdict: "fail", why: "claude plugin eval loaded no case named judged: Error: invalid case: missing execution.prompt" });
  assert.deepEqual(judgeVerdict(null, "judged"), { verdict: "fail", why: "claude plugin eval loaded no case named judged: no JSON result" });
});

/**
 * A `claude` on PATH that answers only `plugin eval`: records the case directory it was given
 * (proof that case.yaml and scaffold.sh were written inside the plugin) into FAKE_CLAUDE_CAPTURE,
 * then by FAKE_CLAUDE_MODE: `pass` writes a passing --json result, `api-error` a run error,
 * `not-logged-in` prints the login error and writes nothing, `absent` is not installed at all.
 */
function fakeClaude(mode) {
  const bin = temp("kit-fake-bin-");
  symlinkSync(process.execPath, join(bin, "node"));
  const capture = join(bin, "capture");
  mkdirSync(capture);
  if (mode !== "absent") {
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh
plugin="$3"; out=""; evaldir=""
while [ $# -gt 0 ]; do
  case "$1" in --json) out="$2"; shift;; --eval-dir) evaldir="$2"; shift;; --allow-tools) printf '%s\\n' "$2" > "$FAKE_CLAUDE_CAPTURE/allow-tools";; esac
  shift
done
cp -R "$plugin/$evaldir" "$FAKE_CLAUDE_CAPTURE/cases"
name="$(ls "$plugin/$evaldir" | head -n 1)"
case "$FAKE_CLAUDE_MODE" in
  pass) printf '{"cases":[{"name":"%s","arms":{"with":[{"passed":true,"graders":[{"explanation":"judge votes: PASS PASS PASS"}]}]}}]}' "$name" > "$out";;
  api-error) printf '{"cases":[{"name":"%s","arms":{"with":[{"error":"API Error: 529 overloaded"}]}}]}' "$name" > "$out";;
  not-logged-in) echo "Not logged in · Please run /login" >&2; exit 1;;
esac
exit 0
`,
      { mode: 0o755 },
    );
  }
  return { bin, capture, env: liveEnv({ PATH: `${bin}:/usr/bin:/bin`, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_CAPTURE: capture }) };
}
const sessionPass = () => ({ verdict: "pass", why: "the session completed with the expected outcome", writes: ["~/.fixture-rc"] });

test("judgeScenario: the session first (its fail or indeterminate is the verdict, the judge never runs); then `claude plugin eval` over case.yaml + scaffold.sh written under the plugin and removed after, with --allow-tools for the gated tools; its pass is the pass", () => {
  const dir = fixture(JUDGED);
  const judged = loadScenarios(dir).scenarios.find((s) => s.name === "judged");
  const { capture, env } = fakeClaude("pass");
  const sessionFail = judgeScenario(judged, { pluginDir: dir, pluginName: "fixture", env, model: "haiku", timeoutS: 30, session: () => ({ verdict: "fail", why: "the reply does not match", writes: [] }) });
  assert.deepEqual(sessionFail, { verdict: "fail", why: "session: the reply does not match", writes: [] });
  assert.ok(!existsSync(join(capture, "cases")), "the judge never ran");
  const r = judgeScenario(judged, { pluginDir: dir, pluginName: "fixture", env, model: "haiku", timeoutS: 30, session: sessionPass });
  assert.deepEqual(r, { verdict: "pass", why: "claude plugin eval: the rubric passed (judge votes: PASS PASS PASS)", writes: ["~/.fixture-rc"] });
  assert.deepEqual(readdirSync(join(capture, "cases", "judged")).sort(), ["case.yaml", "scaffold.sh"]);
  assert.equal(JSON.parse(readFileSync(join(capture, "cases", "judged", "case.yaml"), "utf8")).execution.prompt, "Say hello.");
  assert.equal(readFileSync(join(capture, "allow-tools"), "utf8"), "Bash(ls:*)\n");
  assert.ok(!readdirSync(dir).some((n) => n.startsWith("live-run-cases-")), `the case directory is removed from the plugin: ${readdirSync(dir).join(", ")}`);
});

test("judge unavailable: `claude` that cannot log in, that reports an API error, or that is not installed is indeterminate, and the run is `unavailable` (exit 75), never a pass", () => {
  const dir = fixture(JUDGED);
  const judged = loadScenarios(dir).scenarios.find((s) => s.name === "judged");
  for (const [mode, why] of [
    ["not-logged-in", /^claude plugin eval exit 1 without a JSON result: Not logged in/],
    ["api-error", /^claude plugin eval: API Error: 529 overloaded$/],
    ["absent", /^claude plugin eval could not run \(spawnSync claude ENOENT\)$/],
  ]) {
    const { env } = fakeClaude(mode);
    const r = judgeScenario(judged, { pluginDir: dir, pluginName: "fixture", env, model: "haiku", timeoutS: 30, session: sessionPass });
    assert.equal(r.verdict, "indeterminate", `${mode}: ${r.why}`);
    assert.match(r.why, why, mode);
    assert.ok(!readdirSync(dir).some((n) => n.startsWith("live-run-cases-")), `${mode}: the case directory is removed whatever happened`);
    const whole = run({ pluginDir: dir, env, claudePresent: true, contract: () => ({ verdict: "pass", why: "contract" }), session: sessionPass });
    assert.equal(whole.code, UNAVAILABLE_EXIT, `${mode}: ${whole.lines.join("\n")}`);
    assert.ok(whole.lines.some((l) => l.startsWith("session judged: indeterminate — ")), whole.lines.join("\n"));
    assert.ok(!whole.lines.some((l) => l.startsWith("session judged: pass")), "never a pass");
    assert.match(whole.lines.at(-1), /^unavailable: 1 judge scenario\(s\) not graded: judged \(claude plugin eval.*\); 4 hook scenario\(s\) passed offline, 1 live pass\(es\)$/, `${mode}: the contract's pass does not carry an ungraded judge: ${whole.lines.at(-1)}`);
  }
  // The judge's session indeterminate (the model never tried the behaviour): the same, the judge never runs.
  const { env: never, capture } = fakeClaude("pass");
  const untried = run({ pluginDir: dir, env: never, claudePresent: true, contract: () => ({ verdict: "pass", why: "contract" }), session: () => ({ verdict: "indeterminate", why: "the model never attempted Write", writes: [] }) });
  assert.equal(untried.code, UNAVAILABLE_EXIT, untried.lines.join("\n"));
  assert.equal(untried.lines.at(-1), "unavailable: 1 judge scenario(s) not graded: judged (session: the model never attempted Write); 4 hook scenario(s) passed offline, 1 live pass(es)");
  assert.ok(!existsSync(join(capture, "cases")), "the judge never ran");
  // The judge graded: the run passes and keeps the session's writes.
  const { env } = fakeClaude("pass");
  const judgedPass = run({ pluginDir: dir, env, claudePresent: true, contract: () => ({ verdict: "pass", why: "contract" }), session: sessionPass });
  assert.equal(judgedPass.code, 0, judgedPass.lines.join("\n"));
  assert.ok(judgedPass.lines.includes("session judged: pass — claude plugin eval: the rubric passed (judge votes: PASS PASS PASS)"), judgedPass.lines.join("\n"));
  assert.ok(judgedPass.lines.includes("wrote: ~/.fixture-rc"), "the session's writes are kept on the run");
  assert.equal(judgedPass.lines.at(-1), "pass: 4 hook scenario(s), 2 live pass(es), 0 indeterminate", "the session scenario's skipped hook phase is not a live indeterminate");
});

test("the CLI: --no-live exits 75 with every line on stdout and the canary transcript written as one JSON line per stdout line; an unknown argument is 1; reached through a symlink it still runs (real paths compared)", () => {
  const dir = fixture(COVERED);
  const transcript = join(temp("kit-live-cli-"), "deep", "canary.jsonl");
  const env = { ...liveEnv(), CANARY_PLUGIN: "renamed", CANARY_TRANSCRIPT: transcript };
  const r = spawnSync(process.execPath, [RUNNER, "--plugin-dir", dir, "--no-live"], { encoding: "utf8", env });
  assert.equal(r.status, UNAVAILABLE_EXIT, r.stdout + r.stderr);
  assert.equal(r.stdout.split("\n")[0], `renamed live-run: plugin ${dir}`);
  assert.match(r.stdout, /\nunavailable: live phase skipped \(--no-live\); 4 hook scenario\(s\) passed offline\n$/);
  const lines = readFileSync(transcript, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), lines.map(() => "live-run"));
  assert.deepEqual(lines.map((l) => l.line), r.stdout.trim().split("\n"));
  const bad = spawnSync(process.execPath, [RUNNER, "--bogus"], { encoding: "utf8", env: liveEnv() });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "live-run: unknown argument --bogus\n");
  const link = join(temp("kit-live-link-"), "runner.mjs");
  symlinkSync(RUNNER, link);
  const viaLink = spawnSync(process.execPath, [link, "--plugin-dir", dir, "--no-live", "--only", "stop-quiet"], { encoding: "utf8", env: liveEnv() });
  assert.equal(viaLink.status, UNAVAILABLE_EXIT, viaLink.stdout + viaLink.stderr);
  assert.match(viaLink.stdout, /^scenario stop-quiet: pass — Stop → silent$/m);
  assert.ok(!viaLink.stdout.includes("scenario deny-secret"), "--only narrows the scenarios run");
});
