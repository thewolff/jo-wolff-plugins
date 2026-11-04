// stop-hook.test.mjs — hooks/output-types-stop.mjs as a spawned process under the hook runner,
// fed what Claude Code sends on Stop. Every case: exit 0 inside the budget, never a decision,
// never `continue: false`; a warning only when a labelled statement has no receipt, and the
// judge only when the config turns it on and a command resolves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JUDGE_DEADLINE_MS, extractText, handle } from "../hooks/output-types-stop.mjs";
import { DEADLINE_MS } from "../lib/hook-runner.mjs";
import { NEEDS } from "../lib/receipts.mjs";
import { BUDGET_MS, PLUGIN_ROOT, parseJson, sandbox } from "./helpers.mjs";

const STOP_HOOK = join(PLUGIN_ROOT, "hooks", "output-types-stop.mjs");

/** A Claude Code JSONL transcript whose last assistant turn says `text`, after a tool-only assistant entry and a user entry. */
function transcript(box, text, name = "s.jsonl") {
  const dir = join(box.home, ".claude", "projects", "x");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const lines = [
    { type: "user", message: { role: "user", content: "do the thing" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "an earlier reply with **CLAIM** nothing" }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n{torn");
  return path;
}

function stopPayload(box, transcriptPath, extra = {}) {
  return JSON.stringify({ session_id: "11111111-2222-3333-4444-555555555555", transcript_path: transcriptPath, cwd: box.work, hook_event_name: "Stop", stop_hook_active: false, ...extra });
}

function runStop(box, { input, env = {} } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [STOP_HOOK], { cwd: box.work, env: { ...box.env, ...env }, input, encoding: "utf8", timeout: BUDGET_MS * 2, killSignal: "SIGKILL" });
  return { ...r, ms: Date.now() - started, json: parseJson(r.stdout) };
}

/** Exit 0, inside the budget, nothing that blocks or ends the session. */
function assertAllows(r, budget = BUDGET_MS) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.error, undefined, String(r.error));
  assert.ok(r.ms < budget, `took ${r.ms} ms`);
  if (r.json) {
    assert.equal(r.json.decision, undefined, "never blocks");
    assert.equal(r.json.continue, undefined, "never stops the session");
  }
}

/** A config dir under the sandbox with output-types/config.json (and optionally the shared judge file). */
function configDir(box, outputTypes, shared) {
  const dir = join(box.root, "config");
  if (outputTypes) {
    mkdirSync(join(dir, "output-types"), { recursive: true });
    writeFileSync(join(dir, "output-types", "config.json"), JSON.stringify(outputTypes));
  }
  if (shared) {
    mkdirSync(join(dir, "judge"), { recursive: true });
    writeFileSync(join(dir, "judge", "config.json"), JSON.stringify(shared));
  }
  return dir;
}

const UNRECEIPTED = "## Report\n\n**CLAIM** the handler returns early.\n\n**CITE** the vendor caps it at 100.\n\nPlain prose with CLAIM in it.\n";
const RECEIPTED = "**CLAIM** the handler returns early: /srv/app/src/a.ts:41\n\n**CITE** per https://example.com/docs the cap is 100.\n";

// ─── the mechanical stage ───────────────────────────────────────────────────────────────

test("two labelled statements without receipts → one systemMessage naming both lines; no decision; no errors.log; no skipped.log", () => {
  const box = sandbox();
  const r = runStop(box, { input: stopPayload(box, transcript(box, UNRECEIPTED)) });
  assertAllows(r);
  assert.equal(r.stderr, "");
  assert.deepEqual(Object.keys(r.json), ["systemMessage"]);
  assert.equal(
    r.json.systemMessage,
    "output-types: 2 labelled statements without a receipt that holds. Add the receipt or remove the label (unlabeled means unreceipted).\n" +
      `  line 3 **CLAIM** "the handler returns early.": ${NEEDS.CLAIM}\n` +
      `  line 5 **CITE** "the vendor caps it at 100.": ${NEEDS.CITE}`,
  );
  assert.equal(box.readErrors(), "");
  assert.ok(!existsSync(join(box.root, "state", "output-types", "skipped.log")));
});

test("every statement receipted → no output at all; a message with no labels → no output", () => {
  const box = sandbox();
  const r = runStop(box, { input: stopPayload(box, transcript(box, RECEIPTED)) });
  assertAllows(r);
  assert.equal(r.stdout, "");
  const plain = runStop(box, { input: stopPayload(box, transcript(box, "Nothing labelled; CLAIM in prose only.", "p.jsonl")) });
  assertAllows(plain);
  assert.equal(plain.stdout, "");
});

test("the message is the LAST assistant text entry: a later tool-only entry and a torn trailing line are skipped; last_assistant_message in the payload wins over the transcript", () => {
  const box = sandbox();
  const path = transcript(box, RECEIPTED);
  assert.equal(extractText({ transcript_path: path }), RECEIPTED);
  assert.equal(extractText({ transcript_path: path, last_assistant_message: "**CITE** direct" }), "**CITE** direct");
  assert.equal(extractText({ transcript_path: join(box.root, "missing.jsonl") }), "");
  assert.equal(extractText({}), "");
  assert.equal(extractText(null), "");
  const r = runStop(box, { input: stopPayload(box, path, { last_assistant_message: "**CLAIM** from the payload, unreceipted" }) });
  assertAllows(r);
  assert.match(r.json.systemMessage, /line 1 \*\*CLAIM\*\* "from the payload, unreceipted"/);
});

test("more than five → the first five named and +N more", () => {
  const box = sandbox();
  const text = Array.from({ length: 7 }, (_, i) => `- **CLAIM** statement ${i + 1}`).join("\n");
  const r = runStop(box, { input: stopPayload(box, transcript(box, text)) });
  assertAllows(r);
  assert.ok(r.json.systemMessage.startsWith("output-types: 7 labelled statements"));
  assert.ok(r.json.systemMessage.endsWith("\n  +2 more"));
  assert.ok(!r.json.systemMessage.includes("statement 6"));
});

// ─── fault inputs: each exits 0 and allows ─────────────────────────────────────────────

test("empty stdin → exit 0, nothing to check, no output", () => {
  const r = runStop(sandbox(), { input: "" });
  assertAllows(r);
  assert.equal(r.stdout, "");
});

test("malformed JSON on stdin → exit 0, one errors.log line and a failed-open systemMessage, never a block", () => {
  const box = sandbox();
  const r = runStop(box, { input: "{not json" });
  assertAllows(r);
  assert.match(r.json.systemMessage, /^output-types Stop failed open: stdin not JSON/);
  const lines = box.readErrors().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\S+Z Stop stdin not JSON/);
});

test("a missing transcript, a transcript that is not JSONL, an unknown event, and an unwritable state dir → exit 0, no block", () => {
  const box = sandbox();
  assertAllows(runStop(box, { input: stopPayload(box, join(box.root, "no-such.jsonl")) }));
  const junk = join(box.root, "junk.jsonl");
  writeFileSync(junk, "not json\n{\"type\":\"user\"}\n");
  const r = runStop(box, { input: stopPayload(box, junk) });
  assertAllows(r);
  assert.equal(r.stdout, "");
  assertAllows(runStop(box, { input: JSON.stringify({ hook_event_name: "Whatever" }) }));
  const blocked = join(box.root, "file-not-dir");
  writeFileSync(blocked, "");
  const u = runStop(box, { input: stopPayload(box, transcript(box, UNRECEIPTED)), env: { XDG_STATE_HOME: blocked } });
  assertAllows(u);
  assert.match(u.json.systemMessage, /^output-types: 2 labelled/);
});

test("stdin held open → the runner's deadline answers inside the budget, exit 0, no block", async () => {
  const box = sandbox();
  const started = Date.now();
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [STOP_HOOK], { cwd: box.work, env: { ...box.env, OUTPUT_TYPES_STOP_DEADLINE_MS: "800" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stdin.on("error", () => {});
    child.stdin.write("{");
    const timer = setTimeout(() => child.kill("SIGKILL"), BUDGET_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, ms: Date.now() - started, json: parseJson(stdout) });
    });
  });
  assert.equal(r.status, 0);
  assert.ok(r.ms < BUDGET_MS, `took ${r.ms} ms`);
  assert.match(r.json.systemMessage, /failed open: no answer within 800 ms/);
  assert.equal(r.json.decision, undefined);
});

test("OUTPUT_TYPES_CHECK=off → nothing, even with unreceipted labels", () => {
  const box = sandbox();
  const r = runStop(box, { input: stopPayload(box, transcript(box, UNRECEIPTED)), env: { OUTPUT_TYPES_CHECK: "off" } });
  assertAllows(r);
  assert.equal(r.stdout, "");
});

// ─── the judge stage ────────────────────────────────────────────────────────────────────

/** A judge that records every call to `calls` and prints `reply` (a shell snippet). */
function fakeJudge(box, reply) {
  const calls = join(box.root, "judge-calls");
  const script = join(box.root, "judge.sh");
  writeFileSync(script, `#!/bin/sh\ncat >> "${calls}"\nprintf '\\n---\\n' >> "${calls}"\n${reply}\n`);
  chmodSync(script, 0o755);
  return { command: script, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "") };
}

test("judge off by default: with no config, and with judge:false, the command is never run even when it would resolve", () => {
  const box = sandbox();
  const judge = fakeJudge(box, "echo '{\"verdict\":\"fail\",\"reason\":\"x\"}'");
  const r = runStop(box, { input: stopPayload(box, transcript(box, RECEIPTED)), env: { OUTPUT_TYPES_JUDGE_BIN: judge.command } });
  assertAllows(r);
  assert.equal(r.stdout, "");
  assert.equal(judge.calls(), "");
  const dir = configDir(box, { judge: false }, { command: judge.command });
  const off = runStop(box, { input: stopPayload(box, transcript(box, RECEIPTED)), env: { XDG_CONFIG_HOME: dir, OUTPUT_TYPES_JUDGE_BIN: judge.command } });
  assertAllows(off);
  assert.equal(off.stdout, "");
  assert.equal(judge.calls(), "");
});

test("judge on, no command anywhere → the mechanical result only, nothing logged", () => {
  const box = sandbox();
  const dir = configDir(box, { judge: true });
  const r = runStop(box, { input: stopPayload(box, transcript(box, UNRECEIPTED)), env: { XDG_CONFIG_HOME: dir } });
  assertAllows(r);
  assert.match(r.json.systemMessage, /^output-types: 2 labelled/);
  assert.ok(!existsSync(join(box.root, "state", "output-types", "skipped.log")));
});

test("judge on with the shared command: one call per receipted statement, a fail joins the warning after the mechanical lines in message order; unreceipted statements are not sent", () => {
  const box = sandbox();
  const judge = fakeJudge(box, "echo '{\"verdict\":\"fail\",\"reason\":\"the line does not say that\"}'");
  const dir = configDir(box, { judge: true }, { command: judge.command, timeoutMs: 5000 });
  const text = "**CLAIM** unreceipted one.\n\n**CLAIM** receipted: /srv/a.ts:1\n\n**CITE** also receipted https://x.y/z\n";
  const r = runStop(box, { input: stopPayload(box, transcript(box, text)), env: { XDG_CONFIG_HOME: dir } });
  assertAllows(r, JUDGE_DEADLINE_MS);
  assert.equal(
    r.json.systemMessage,
    "output-types: 3 labelled statements without a receipt that holds. Add the receipt or remove the label (unlabeled means unreceipted).\n" +
      `  line 1 **CLAIM** "unreceipted one.": ${NEEDS.CLAIM}\n` +
      '  line 3 **CLAIM** "receipted: /srv/a.ts:1": the judge says the receipt does not license it: the line does not say that\n' +
      '  line 5 **CITE** "also receipted https://x.y/z": the judge says the receipt does not license it: the line does not say that',
  );
  const calls = judge.calls().split("\n---\n").filter(Boolean);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("Label: CLAIM\n") && calls[0].includes("<<<\nreceipted: /srv/a.ts:1\n>>>"));
  assert.ok(calls[1].includes("Label: CITE\n") && calls[1].includes("also receipted https://x.y/z"));
  assert.ok(!judge.calls().includes("unreceipted one"));
  assert.ok(!existsSync(join(box.root, "state", "output-types", "skipped.log")));
});

test("judge on, every verdict pass → no output; the plugin's own judgeCommand beats the shared file and the env var beats both", () => {
  const box = sandbox();
  const pass = fakeJudge(box, "echo '{\"verdict\":\"pass\",\"reason\":\"ok\"}'");
  const dir = configDir(box, { judge: true, judgeCommand: pass.command }, { command: "/no/such/judge" });
  const r = runStop(box, { input: stopPayload(box, transcript(box, RECEIPTED)), env: { XDG_CONFIG_HOME: dir } });
  assertAllows(r, JUDGE_DEADLINE_MS);
  assert.equal(r.stdout, "");
  assert.equal(pass.calls().split("\n---\n").filter(Boolean).length, 2);
  const viaEnv = runStop(box, { input: stopPayload(box, transcript(box, RECEIPTED)), env: { XDG_CONFIG_HOME: dir, OUTPUT_TYPES_JUDGE_BIN: "echo '{\"verdict\":\"fail\",\"reason\":\"env\"}'" } });
  assertAllows(viaEnv, JUDGE_DEADLINE_MS);
  assert.match(viaEnv.json.systemMessage, /the judge says the receipt does not license it: env/);
  assert.equal(pass.calls().split("\n---\n").filter(Boolean).length, 2, "the env judge was used, not the plugin's own");
});

test("judge dispatch errors: non-zero exit, no JSON, and a timeout each write one skipped.log line naming the source and leave the warning to the mechanical stage; the hook exits inside its budget", () => {
  const box = sandbox();
  const dir = configDir(box, { judge: true }, { command: "echo nope >&2; exit 2", timeoutMs: 5000 });
  const env = { XDG_CONFIG_HOME: dir };
  const r = runStop(box, { input: stopPayload(box, transcript(box, UNRECEIPTED + RECEIPTED)), env });
  assertAllows(r, JUDGE_DEADLINE_MS);
  assert.ok(r.json.systemMessage.startsWith("output-types: 2 labelled statements"), r.json.systemMessage);
  const skipped = join(box.root, "state", "output-types", "skipped.log");
  let lines = readFileSync(skipped, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`^\\S+Z hooks/output-types-stop\\.mjs line 8 \\*\\*CLAIM\\*\\* ".*" judge nonzero: exit 2 stderr="nope" \\(source=${join(dir, "judge", "config.json").replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\)$`));
  assert.match(lines[1], /line 10 \*\*CITE\*\* .* judge nonzero: exit 2/);

  const unparseable = runStop(box, { input: stopPayload(box, transcript(box, RECEIPTED)), env: { ...env, OUTPUT_TYPES_JUDGE_BIN: "echo plain words" } });
  assertAllows(unparseable, JUDGE_DEADLINE_MS);
  assert.equal(unparseable.stdout, "");
  lines = readFileSync(skipped, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 4);
  assert.match(lines[2], /judge unparseable: exit 0 but no JSON object on stdout \(source=env OUTPUT_TYPES_JUDGE_BIN\)$/);

  // A judge that hangs is killed by its own clamped timer, inside the hook's deadline.
  const started = Date.now();
  const slow = runStop(box, { input: stopPayload(box, transcript(box, RECEIPTED)), env: { ...env, OUTPUT_TYPES_JUDGE_BIN: "sleep 30", OUTPUT_TYPES_STOP_DEADLINE_MS: "3000" } });
  assertAllows(slow, 4_000);
  assert.ok(Date.now() - started < 4_000);
  assert.equal(slow.stdout, "", "a hanging judge is a skipped line, not a failed-open message");
  lines = readFileSync(skipped, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 6);
  assert.match(lines[4], /judge timeout: no exit within \d+ ms \(source=env OUTPUT_TYPES_JUDGE_BIN\)$/);
  assert.match(lines[5], /judge skipped: no time left in the hook's budget|judge timeout/);
  assert.equal(box.readErrors(), "");
});

test("judge on, stdin late and a judge that hangs: the judge budget counts from the runner's start, so the mechanical warning still arrives (not a failed-open line) and no judge process outlives the hook", async () => {
  const box = sandbox();
  const pidFile = join(box.root, "judge.pids");
  const dir = configDir(box, { judge: true }, { command: `echo $$ >> ${JSON.stringify(pidFile)}; exec sleep 30` });
  const payload = JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "**CLAIM**\nThe hook exits 0 at /a/b/hook.mjs:12.\n\n**CLAIM**\nNo receipt here." });
  const run = (delayMs) =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [STOP_HOOK], { cwd: box.work, env: { ...box.env, XDG_CONFIG_HOME: dir, OUTPUT_TYPES_STOP_DEADLINE_MS: "4000" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stdin.on("error", () => {});
      setTimeout(() => child.stdin.end(payload), delayMs);
      const timer = setTimeout(() => child.kill("SIGKILL"), BUDGET_MS * 2);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, ms: Date.now() - started, json: parseJson(stdout) });
      });
    });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // 2.5 s late: no time left for the judge at all; 1 s late: the judge runs and its clamped timer kills it.
  for (const delayMs of [2_500, 1_000]) {
    const r = await run(delayMs);
    assert.equal(r.status, 0);
    assert.ok(r.ms < 4_000, `took ${r.ms} ms`);
    assert.equal(r.json?.decision, undefined);
    assert.match(r.json?.systemMessage ?? "", /^output-types: 1 labelled statement without a receipt[\s\S]*line 4 \*\*CLAIM\*\* "No receipt here\."/);
  }
  const pids = existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : [];
  assert.equal(pids.length, 1, "the judge ran once, on the 1 s run");
  for (let i = 0; i < 20 && pids.some(alive); i++) await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(pids.filter(alive), [], "no judge process outlived the hook");
  assert.equal(box.readErrors(), "");
  const skipped = readFileSync(join(box.root, "state", "output-types", "skipped.log"), "utf8").split("\n").filter(Boolean);
  assert.match(skipped[0], /judge skipped: no time left in the hook's budget/);
  assert.match(skipped[1], /judge timeout: no exit within \d+ ms/);
});

test("handle() directly: the deadline constants, and a fake runner through the hook's own path", async () => {
  assert.equal(DEADLINE_MS, 4_000);
  assert.equal(JUDGE_DEADLINE_MS, 55_000);
  const box = sandbox();
  const dir = configDir(box, { judge: true, judgeCommand: "unused" });
  const env = { ...box.env, XDG_CONFIG_HOME: dir };
  const run = async () => ({ verdict: "fail", reason: "r" });
  const out = await handle({ last_assistant_message: RECEIPTED }, { env, run });
  assert.ok(out.systemMessage.includes("line 1 **CLAIM**") && out.systemMessage.includes("line 3 **CITE**"));
  assert.equal(await handle({ last_assistant_message: "no labels" }, { env, run }), null);
  assert.equal(await handle({ last_assistant_message: RECEIPTED }, { env: { ...env, OUTPUT_TYPES_CHECK: "OFF" }, run }), null);
});
