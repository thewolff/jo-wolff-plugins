// zero-label-hook.test.mjs - the 0.3.3 additions to hooks/output-types-stop.mjs, as a spawned
// process and through handle(): the zero-label warning and its turn boundary, its switches and
// thresholds, the bounded read on a huge transcript, and the session record the judge receives.
// Every case: exit 0, never a decision, never `continue`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { extractText, withRecords } from "../hooks/output-types-stop.mjs";
import { BUDGET_MS, PLUGIN_ROOT, parseJson, sandbox } from "./helpers.mjs";

const STOP_HOOK = join(PLUGIN_ROOT, "hooks", "output-types-stop.mjs");
const LONG = "This reply describes the work in plain prose and labels nothing. ".repeat(11).trim(); // 714 chars

const user = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content) => ({ type: "assistant", message: { role: "assistant", content } });
const text = (t) => ({ type: "text", text: t });

/** A turn of `n` Bash calls with results, opened by a human prompt. */
function bashTurn(n, prefix = "c", commands = []) {
  const out = [user(`run ${n} commands`)];
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    out.push(assistant([{ type: "tool_use", id, name: "Bash", input: { command: commands[i] ?? `echo step ${i}` } }]));
    out.push(user([{ type: "tool_result", tool_use_id: id, content: `step ${i}` }], { toolUseResult: { stdout: `step ${i}`, stderr: "", interrupted: false } }));
  }
  return out;
}

function writeTranscript(box, entries, name = "s.jsonl") {
  const dir = join(box.home, ".claude", "projects", "x");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

const payload = (box, transcriptPath, extra = {}) => JSON.stringify({ session_id: "s", transcript_path: transcriptPath, cwd: box.work, hook_event_name: "Stop", stop_hook_active: false, ...extra });

function runStop(box, input, env = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [STOP_HOOK], { cwd: box.work, env: { ...box.env, ...env }, input, encoding: "utf8", timeout: BUDGET_MS * 2, killSignal: "SIGKILL" });
  return { ...r, ms: Date.now() - started, json: parseJson(r.stdout) };
}

function assertAllows(r, budget = BUDGET_MS) {
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.ms < budget, `took ${r.ms} ms`);
  if (r.json) {
    assert.equal(r.json.decision, undefined);
    assert.equal(r.json.continue, undefined);
    assert.equal(r.json.hookSpecificOutput, undefined);
  }
}

function configEnv(box, config) {
  const dir = join(box.root, "config");
  mkdirSync(join(dir, "output-types"), { recursive: true });
  writeFileSync(join(dir, "output-types", "config.json"), JSON.stringify(config));
  return { XDG_CONFIG_HOME: dir };
}

// ─── the zero-label rule ────────────────────────────────────────────────────────────────

test("zero labels, a 600-character reply and 3 tool calls this turn → one systemMessage naming the count; nothing else in the output", () => {
  const box = sandbox();
  const path = writeTranscript(box, [...bashTurn(3), assistant([text(LONG)])]);
  const r = runStop(box, payload(box, path));
  assertAllows(r);
  assert.deepEqual(r.json, { systemMessage: "output-types: 3 tool calls this turn, 0 labelled statements. Label what you checked, or say nothing was checked." });
  assert.equal(box.readErrors(), "");
});

test("zero labels after a 12-tool-call turn, but the latest turn ran none → no output (the turn boundary); an isMeta entry does not open a turn", () => {
  const box = sandbox();
  const path = writeTranscript(box, [...bashTurn(12), assistant([text("done")]), user("and one more question"), assistant([text(LONG)])]);
  const r = runStop(box, payload(box, path));
  assertAllows(r);
  assert.equal(r.stdout, "");
  const meta = writeTranscript(box, [...bashTurn(2), user("injected skill body", { isMeta: true }), ...bashTurn(2, "d").slice(1), assistant([text(LONG)])], "meta.jsonl");
  const m = runStop(box, payload(box, meta));
  assert.match(m.json.systemMessage, /^output-types: 4 tool calls this turn/);
});

test("zero labels below either threshold → no output; thresholds from config.json change the outcome; dispatch tools are not counted", () => {
  const box = sandbox();
  const short = writeTranscript(box, [...bashTurn(5), assistant([text("Short unlabeled reply.")])], "short.jsonl");
  assert.equal(runStop(box, payload(box, short)).stdout, "");
  const few = writeTranscript(box, [...bashTurn(2), assistant([text(LONG)])], "few.jsonl");
  assert.equal(runStop(box, payload(box, few)).stdout, "");
  const env = configEnv(box, { zeroLabelMinChars: 10, zeroLabelMinToolCalls: 2 });
  assert.match(runStop(box, payload(box, few), env).json.systemMessage, /^output-types: 2 tool calls this turn/);
  assert.match(runStop(box, payload(box, short), env).json.systemMessage, /^output-types: 5 tool calls this turn/);
  const dispatch = [user("go"), assistant(["Agent", "Agent", "Agent", "ToolSearch", "TodoWrite"].map((name, i) => ({ type: "tool_use", id: `x${i}`, name, input: {} }))), assistant([text(LONG)])];
  assert.equal(runStop(box, payload(box, writeTranscript(box, dispatch, "dispatch.jsonl"))).stdout, "");
});

test("OUTPUT_TYPES_ZERO_LABEL=off → no zero-label warning, the receipts warning still works; OUTPUT_TYPES_CHECK=off → nothing", () => {
  const box = sandbox();
  const path = writeTranscript(box, [...bashTurn(4), assistant([text(LONG)])]);
  assert.equal(runStop(box, payload(box, path), { OUTPUT_TYPES_ZERO_LABEL: "off" }).stdout, "");
  const labelled = writeTranscript(box, [...bashTurn(4), assistant([text(`${LONG}\n\n**CLAIM** the handler returns early.`)])], "l.jsonl");
  assert.match(runStop(box, payload(box, labelled), { OUTPUT_TYPES_ZERO_LABEL: "off" }).json.systemMessage, /^output-types: 1 labelled statement without a receipt/);
  assert.equal(runStop(box, payload(box, path), { OUTPUT_TYPES_CHECK: "off" }).stdout, "");
});

test("last_assistant_message with no transcript, or with an OMP-format transcript → no zero-label warning", () => {
  const box = sandbox();
  assert.equal(runStop(box, payload(box, join(box.root, "missing.jsonl"), { last_assistant_message: LONG })).stdout, "");
  assert.equal(runStop(box, JSON.stringify({ hook_event_name: "Stop", last_assistant_message: LONG })).stdout, "");
  const omp = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    ...Array.from({ length: 4 }, (_, i) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `o${i}`, name: "bash", arguments: { command: "ls" } }] } })),
    ...Array.from({ length: 4 }, (_, i) => ({ type: "message", message: { role: "toolResult", toolCallId: `o${i}`, content: [{ type: "text", text: "ok" }] } })),
  ];
  assert.equal(runStop(box, payload(box, writeTranscript(box, omp, "omp.jsonl"), { last_assistant_message: LONG })).stdout, "");
});

test("a 200 MiB sparse transcript → the same answer as a small one, inside the 4 s mechanical deadline", () => {
  const box = sandbox();
  const path = join(box.root, "huge.jsonl");
  const tail = [...bashTurn(3), assistant([text(LONG)])].map((e) => JSON.stringify(e)).join("\n") + "\n";
  const fd = openSync(path, "w");
  ftruncateSync(fd, 200 * 1024 * 1024);
  writeSync(fd, "\n" + tail, 200 * 1024 * 1024);
  closeSync(fd);
  const r = runStop(box, payload(box, path));
  assertAllows(r, 4_000);
  assert.deepEqual(r.json, { systemMessage: "output-types: 3 tool calls this turn, 0 labelled statements. Label what you checked, or say nothing was checked." });
});

// ─── the session record ─────────────────────────────────────────────────────────────────

/** A judge that appends each prompt to a file and prints `reply`. */
function fakeJudge(box, reply = "echo '{\"verdict\":\"pass\",\"reason\":\"ok\"}'") {
  const calls = join(box.root, "judge-calls");
  const script = join(box.root, "judge.sh");
  writeFileSync(script, `#!/bin/sh\ncat >> "${calls}"\nprintf '\\n---\\n' >> "${calls}"\n${reply}\n`);
  chmodSync(script, 0o755);
  return { command: script, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n---\n").filter(Boolean) : []) };
}

const skippedLines = (box) => {
  const p = join(box.root, "state", "output-types", "skipped.log");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
};

test("judge on, a statement with a command receipt and a matching Bash call → the judge receives a prompt with the record block, and only that statement's call is in it", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const reply = "**CLAIM**\n`npm test` → 3 pass";
  const path = writeTranscript(box, [...bashTurn(3, "c", ["npm run lint", "npm test", "npm run build"]), assistant([text(reply)])]);
  const r = runStop(box, payload(box, path), env);
  assertAllows(r, 10_000);
  assert.equal(r.stdout, "");
  const [prompt] = judge.calls();
  assert.ok(prompt.includes("\n<<<RECORD\n[shell command — success]\n$ npm test\nstatus: success\nexit code: unknown\nstep 1\nRECORD "), prompt);
  assert.ok(!prompt.includes("npm run lint") && !prompt.includes("npm run build"));
  assert.equal(judge.calls().length, 1);
});

test("judge on, a statement with a URL receipt and a matching WebFetch call → the record carries the fetched text, bounded", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const entries = [
    user("look it up"),
    assistant([{ type: "tool_use", id: "w1", name: "WebFetch", input: { url: "https://example.com/Docs", prompt: "p" } }]),
    user([{ type: "tool_result", tool_use_id: "w1", content: "<persisted-output>" }], { toolUseResult: { result: `the cap is 100. ${"x".repeat(9000)}`, url: "https://example.com/Docs", code: 200 } }),
    assistant([text("**CITE** per https://example.com/Docs the cap is 100.")]),
  ];
  const r = runStop(box, payload(box, writeTranscript(box, entries)), env);
  assertAllows(r, 10_000);
  const [prompt] = judge.calls();
  assert.ok(prompt.includes("[fetched https://example.com/Docs — the tool's result as the agent saw it, bounded by output-types]\nrequested: https://example.com/Docs\nfinal: https://example.com/Docs\nstatus: success\nthe cap is 100."), prompt.slice(0, 2000));
  assert.ok(!prompt.includes("x".repeat(6001)));
});

test("judge on, a command receipt with no matching call and no file line → no judge call, one skipped.log line saying no tool call matched, no extra warning", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const path = writeTranscript(box, [...bashTurn(1), assistant([text("**CLAIM**\n`make all` → built")])]);
  const r = runStop(box, payload(box, path), env);
  assertAllows(r, 10_000);
  assert.equal(r.stdout, "");
  assert.deepEqual(judge.calls(), []);
  const lines = skippedLines(box);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\S+Z hooks\/output-types-stop\.mjs line 1 \*\*CLAIM\*\* ".*" judge not run: no Bash or WebFetch call in the last 16 MiB of the transcript matches its command or URL/);
});

test("judge on, a URL receipt with no matching WebFetch call and no file line, transcript readable → no judge call, one skipped.log line saying no tool call matched, no extra warning", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const entries = [
    user("look it up"),
    assistant([{ type: "tool_use", id: "w1", name: "WebFetch", input: { url: "https://example.com/other", prompt: "p" } }]),
    user([{ type: "tool_result", tool_use_id: "w1", content: "other page" }], { toolUseResult: { result: "other page", url: "https://example.com/other", code: 200 } }),
    assistant([text("**CITE** per https://example.com/docs the cap is 100.")]),
  ];
  const r = runStop(box, payload(box, writeTranscript(box, entries)), env);
  assertAllows(r, 10_000);
  assert.equal(r.stdout, "");
  assert.deepEqual(judge.calls(), []);
  const lines = skippedLines(box);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\S+Z hooks\/output-types-stop\.mjs line 1 \*\*CITE\*\* ".*" judge not run: no Bash or WebFetch call in the last 16 MiB of the transcript matches its command or URL/);
});

test("judge on, a URL receipt and no readable transcript (the plan's no-transcript rule: skipped, never judged on its text) → no judge call, one 'no transcript was readable' line", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const r = runStop(box, payload(box, join(box.root, "missing.jsonl"), { last_assistant_message: "**CITE** per https://example.com/docs the cap is 100." }), env);
  assertAllows(r, 10_000);
  assert.equal(r.stdout, "");
  assert.deepEqual(judge.calls(), []);
  const lines = skippedLines(box);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /line 1 \*\*CITE\*\* ".*" judge not run: no transcript was readable to match its command or URL against$/);
});

test("Stop with no last_assistant_message: the parent's final text is checked, not a later sidechain assistant entry", () => {
  const box = sandbox();
  const entries = [
    user("go"),
    assistant([text("**CLAIM**\nThe parent says this with no receipt.")]),
    { ...assistant([text("**CLAIM**\nThe subagent says something else.")]), isSidechain: true },
  ];
  const r = runStop(box, payload(box, writeTranscript(box, entries)));
  assertAllows(r);
  assert.match(r.json.systemMessage, /line 1 \*\*CLAIM\*\* "The parent says this with no receipt\."/);
  assert.ok(!r.json.systemMessage.includes("subagent says"));
  assert.equal(extractText({ transcript_path: writeTranscript(box, entries, "t2.jsonl") }), "**CLAIM**\nThe parent says this with no receipt.");
});

test("judge on, a command receipt whose newest matching call has no result → not judged, an older failing run is not used, one evidence-unavailable line", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const entries = [
    user("go"),
    assistant([{ type: "tool_use", id: "a", name: "Bash", input: { command: "npm test" } }]),
    user([{ type: "tool_result", tool_use_id: "a", content: "Exit code 1\nfail", is_error: true }]),
    assistant([{ type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } }]),
    assistant([text("**CLAIM**\n`npm test` → pass")]),
  ];
  const r = runStop(box, payload(box, writeTranscript(box, entries)), env);
  assertAllows(r, 10_000);
  assert.deepEqual(judge.calls(), []);
  assert.match(skippedLines(box)[0], /judge not run: evidence unavailable: newest matching Bash call has no captured result$/);
});

test("judge on, a command receipt with no matching call but an absolute file:line → judged without a record", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const path = writeTranscript(box, [...bashTurn(1), assistant([text("**CLAIM**\n`make all` → built, see /srv/app/Makefile:12")])]);
  assertAllows(runStop(box, payload(box, path), env), 10_000);
  const [prompt] = judge.calls();
  assert.ok(prompt && !prompt.includes("<<<RECORD"));
  assert.deepEqual(skippedLines(box), []);
});

test("judge on, two command receipts and only one ran, no file line → not judged on the partial record, one skipped.log line naming the command that was not found", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const path = writeTranscript(box, [...bashTurn(1, "c", ["npm test"]), assistant([text("**CLAIM**\n`npm test` → 3 pass and `npm run build` → built")])]);
  const r = runStop(box, payload(box, path), env);
  assertAllows(r, 10_000);
  assert.equal(r.stdout, "");
  assert.deepEqual(judge.calls(), []);
  const lines = skippedLines(box);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\S+Z hooks\/output-types-stop\.mjs line 1 \*\*CLAIM\*\* ".*" judge not run: the session record is incomplete: no Bash or WebFetch call in the last 16 MiB of the transcript matches `npm run build` \(it may have run in a subagent or an earlier session\)$/);
});

/** A turn of Bash calls, each [command, output]. */
const runTurn = (pairs) => {
  const out = [user("run them")];
  pairs.forEach(([command, stdout], i) => {
    out.push(assistant([{ type: "tool_use", id: `r${i}`, name: "Bash", input: { command } }]));
    out.push(user([{ type: "tool_result", tool_use_id: `r${i}`, content: stdout }], { toolUseResult: { stdout, stderr: "", interrupted: false } }));
  });
  return out;
};

for (const claim of ["`npm test` printed `tests 134`, `pass 134`", "`npm test` → `3 tests passed`", "`npm test` → ok, its output has `tests 134` and `pass 134`"]) {
  test(`judge on, a command-plus-output receipt with a matching call → judged with the record, no skipped.log line: ${claim}`, () => {
    const box = sandbox();
    const judge = fakeJudge(box);
    const env = configEnv(box, { judge: true, judgeCommand: judge.command });
    const path = writeTranscript(box, [...runTurn([["npm test", "3 tests passed\ntests 134\npass 134"]]), assistant([text(`**CLAIM**\n${claim}`)])]);
    const r = runStop(box, payload(box, path), env);
    assertAllows(r, 10_000);
    assert.equal(r.stdout, "");
    const [prompt] = judge.calls();
    assert.ok(prompt && prompt.includes("\n<<<RECORD\n[shell command — success]\n$ npm test\nstatus: success\nexit code: unknown\n3 tests passed\ntests 134\npass 134\nRECORD "), prompt);
    assert.deepEqual(skippedLines(box), []);
  });
}

test("judge on, an output span the captured output contradicts → still judged with the real output, and the judge's fail reaches the person", () => {
  const box = sandbox();
  const judge = fakeJudge(box, "echo '{\"verdict\":\"fail\",\"reason\":\"npm test printed 1 failing\"}'");
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const path = writeTranscript(box, [...runTurn([["npm test", "tests 3\npass 2\nfail 1"]]), assistant([text("**CLAIM**\n`npm test` printed `pass 3`, `fail 0`")])]);
  const r = runStop(box, payload(box, path), env);
  assertAllows(r, 10_000);
  const [prompt] = judge.calls();
  assert.ok(prompt && prompt.includes("\n$ npm test\nstatus: success\nexit code: unknown\ntests 3\npass 2\nfail 1\nRECORD "), prompt);
  assert.deepEqual(skippedLines(box), []);
  assert.match(r.json.systemMessage, /the judge says the receipt does not license it: npm test printed 1 failing/);
});

test("judge on, two commands with output spans and only one ran, no file line → still not judged on the partial record; the log names the one that never ran", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const path = writeTranscript(box, [...runTurn([["npm test", "pass 3"]]), assistant([text("**CLAIM**\n`npm test` printed `pass 3`, `npm run build` printed `built ok`")])]);
  const r = runStop(box, payload(box, path), env);
  assertAllows(r, 10_000);
  assert.deepEqual(judge.calls(), []);
  const lines = skippedLines(box);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /judge not run: the session record is incomplete: no Bash or WebFetch call in the last 16 MiB of the transcript matches `npm run build` \(it may have run in a subagent or an earlier session\)$/);
});

test("judge on, five commands and the record's cap of four calls, no file line → not judged on four of five; the log names the call left out and says the cap was the reason", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const cmds = ["npm run a1", "npm run a2", "npm run a3", "npm run a4", "npm run a5"];
  const path = writeTranscript(box, [...runTurn(cmds.map((c) => [c, "ok"])), assistant([text(`**CLAIM**\n${cmds.map((c) => `\`${c}\` → ok`).join(", ")}`)])]);
  const r = runStop(box, payload(box, path), env);
  assertAllows(r, 10_000);
  assert.deepEqual(judge.calls(), []);
  const lines = skippedLines(box);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /judge not run: the session record is incomplete: the record holds at most 4 tool calls and left out `npm run a5`$/);
});

test("judge on, five commands past the cap with a file line → judged on the file line, and the record says a call was left out", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const cmds = ["npm run a1", "npm run a2", "npm run a3", "npm run a4", "npm run a5"];
  const path = writeTranscript(box, [...runTurn(cmds.map((c) => [c, "ok"])), assistant([text(`**CLAIM**\n${cmds.map((c) => `\`${c}\` → ok`).join(", ")}, per /srv/app/package.json:3`)])]);
  assertAllows(runStop(box, payload(box, path), env), 10_000);
  const [prompt] = judge.calls();
  assert.ok(prompt && prompt.includes("[omitted: 1 more tool call past the record's 4 calls]\nRECORD "), prompt);
  assert.deepEqual(skippedLines(box), []);
});

/** A one-call turn: `pwd` printed `out`. */
const pwdTurn = (out) => [
  user("where are we"),
  assistant([{ type: "tool_use", id: "p1", name: "Bash", input: { command: "pwd" } }]),
  user([{ type: "tool_result", tool_use_id: "p1", content: out }], { toolUseResult: { stdout: out, stderr: "", interrupted: false } }),
];

test("judge on, an explicit `$ pwd` receipt → matched to the pwd call; the judge receives its captured result", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const path = writeTranscript(box, [...pwdTurn("/srv/work"), assistant([text("**CLAIM**\n`$ pwd` → /srv/work")])]);
  const r = runStop(box, payload(box, path), env);
  assertAllows(r, 10_000);
  assert.equal(r.stdout, "");
  const [prompt] = judge.calls();
  assert.ok(prompt.includes("\n<<<RECORD\n[shell command — success]\n$ pwd\nstatus: success\nexit code: unknown\n/srv/work\nRECORD "), prompt);
  assert.deepEqual(skippedLines(box), []);
});

test("judge on, an explicit `$ pwd` receipt the captured result contradicts → the judge sees the real output and its fail reaches the person", () => {
  const box = sandbox();
  const judge = fakeJudge(box, "echo '{\"verdict\":\"fail\",\"reason\":\"pwd printed /srv/work\"}'");
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const path = writeTranscript(box, [...pwdTurn("/srv/work"), assistant([text("**CLAIM**\n`$ pwd` → /home/other")])]);
  const r = runStop(box, payload(box, path), env);
  assertAllows(r, 10_000);
  const [prompt] = judge.calls();
  assert.ok(prompt.includes("<<<\n`$ pwd` → /home/other\n>>>"), prompt);
  assert.ok(prompt.includes("\n$ pwd\nstatus: success\nexit code: unknown\n/srv/work\nRECORD "), prompt);
  assert.match(r.json.systemMessage, /the judge says the receipt does not license it: pwd printed \/srv\/work/);
});

test("judge on, bare inline `pwd` (no '$ ', no shell fence) → not treated as a command: no record, no skipped.log line", () => {
  const box = sandbox();
  const judge = fakeJudge(box);
  const env = configEnv(box, { judge: true, judgeCommand: judge.command });
  const path = writeTranscript(box, [...pwdTurn("/srv/work"), assistant([text("**CLAIM**\n`pwd` is /srv/work, see /srv/app/a.ts:3")])]);
  assertAllows(runStop(box, payload(box, path), env), 10_000);
  const [prompt] = judge.calls();
  assert.ok(prompt && !prompt.includes("<<<RECORD"), prompt);
  assert.deepEqual(skippedLines(box), []);
});

test("judge on, the record lookup fails: a throwing read propagates out of withRecords to the runner (which logs it and allows, as every throw); an unreadable transcript path is 'no transcript' and still allows", () => {
  const box = sandbox();
  const env = { ...box.env, ...configEnv(box, { judge: true, judgeCommand: "unused" }) };
  const boom = () => {
    throw new Error("transcript exploded");
  };
  assert.throws(() => withRecords([{ label: "CLAIM", line: 1, text: "`npm test` → ok" }], boom, { env }), /transcript exploded/);
  // Through the spawned hook: a transcript path that is a directory reads as no transcript, never a throw past the runner.
  const r = runStop(box, payload(box, box.root, { last_assistant_message: "**CLAIM**\n`npm test` → ok" }), configEnv(box, { judge: true, judgeCommand: fakeJudge(box).command }));
  assertAllows(r, 10_000);
  assert.equal(r.json?.decision, undefined);
  assert.match(skippedLines(box)[0], /judge not run: no transcript was readable/);
  assert.equal(box.readErrors(), "");
});
