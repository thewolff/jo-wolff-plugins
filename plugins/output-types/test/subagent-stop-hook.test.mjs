// subagent-stop-hook.test.mjs - hooks/output-types-subagent-stop.mjs as a spawned process under
// the hook runner, fed the SubagentStop payload shape captured from a real run
// (test/fixtures/cc-subagentstop-payload.json). Every case: exit 0, never a decision, never
// `continue`, never hookSpecificOutput (nothing is fed back to the subagent).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractReport, handle, sourceFor } from "../hooks/output-types-stop.mjs";
import { readSession } from "../lib/transcript.mjs";
import { BUDGET_MS, PLUGIN_ROOT, parseJson, sandbox } from "./helpers.mjs";

const HOOK = join(PLUGIN_ROOT, "hooks", "output-types-subagent-stop.mjs");
const FIXTURES = join(PLUGIN_ROOT, "test", "fixtures");
const CAPTURED = JSON.parse(readFileSync(join(FIXTURES, "cc-subagentstop-payload.json"), "utf8"));

const sc = (e) => ({ ...e, isSidechain: true });
const user = (content, extra = {}) => sc({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content) => sc({ type: "assistant", message: { role: "assistant", content } });

/** A subagent transcript: the brief, `n` Bash calls, then a SubagentHandback carrying `report`. */
function agentTranscript(box, { n = 0, report = null, closing = null, name = "agent-a1.jsonl" } = {}) {
  const entries = [user("the brief")];
  for (let i = 0; i < n; i++) {
    entries.push(assistant([{ type: "tool_use", id: `b${i}`, name: "Bash", input: { command: `echo ${i} x` } }]));
    entries.push(user([{ type: "tool_result", tool_use_id: `b${i}`, content: String(i) }]));
  }
  if (report !== null) {
    entries.push(assistant([{ type: "tool_use", id: "h", name: "SubagentHandback", input: { message: report } }]));
    entries.push(user([{ type: "tool_result", tool_use_id: "h", content: "delivered" }]));
  }
  if (closing) entries.push(assistant([{ type: "text", text: closing }]));
  const dir = join(box.home, ".claude", "projects", "x", "s", "subagents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

/** The captured payload's shape, pointed at this sandbox. */
function payload(box, agentPath, extra = {}) {
  const { last_assistant_message: _drop, ...base } = CAPTURED;
  return JSON.stringify({ ...base, cwd: box.work, transcript_path: join(box.root, "no-main.jsonl"), agent_transcript_path: agentPath, agent_type: "builder", ...extra });
}

function run(box, input, env = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { cwd: box.work, env: { ...box.env, ...env }, input, encoding: "utf8", timeout: BUDGET_MS * 2, killSignal: "SIGKILL" });
  return { ...r, ms: Date.now() - started, json: parseJson(r.stdout) };
}

function assertAllows(r, budget = BUDGET_MS) {
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.ms < budget, `took ${r.ms} ms`);
  if (r.json) {
    assert.equal(r.json.decision, undefined);
    assert.equal(r.json.continue, undefined);
    assert.equal(r.json.hookSpecificOutput, undefined, "nothing is fed back to the subagent");
  }
}

const skipped = (box) => {
  const p = join(box.root, "state", "output-types", "skipped.log");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
};

test("the captured payload is a SubagentStop payload with agent_transcript_path and agent_type, and sourceFor reads it", () => {
  assert.equal(CAPTURED.hook_event_name, "SubagentStop");
  assert.equal(typeof CAPTURED.agent_transcript_path, "string");
  assert.equal(typeof CAPTURED.agent_type, "string");
  const src = sourceFor(CAPTURED);
  assert.deepEqual(src, { event: "SubagentStop", transcript: CAPTURED.agent_transcript_path, skipSidechain: false, who: { agentType: CAPTURED.agent_type }, hook: "hooks/output-types-subagent-stop.mjs" });
  assert.equal(sourceFor({ hook_event_name: "Stop", transcript_path: "/t" }).event, "Stop");
});

test("extractReport on the captured subagent transcript: the SubagentHandback message, not the closing text", () => {
  const session = readSession(join(FIXTURES, "cc-subagent-handback.jsonl"), { skipSidechain: false });
  const report = extractReport({ last_assistant_message: "closing words" }, session);
  assert.match(report, /from-subagent/);
  assert.notEqual(report, "closing words");
  assert.equal(extractReport({ last_assistant_message: "the text" }, null), "the text");
  assert.equal(extractReport({}, null), "");
});

test("SubagentStop with the report in SubagentHandback and only closing text in last_assistant_message → the report's unreceipted CLAIM is named", () => {
  const box = sandbox();
  const path = agentTranscript(box, { report: "**CLAIM**\nThe handler returns early.", closing: "Done." });
  const r = run(box, payload(box, path, { last_assistant_message: "Done." }));
  assertAllows(r);
  assert.deepEqual(Object.keys(r.json), ["systemMessage"]);
  assert.match(r.json.systemMessage, /^output-types: 1 labelled statement without a receipt that holds\.[\s\S]*line 1 \*\*CLAIM\*\* "The handler returns early\."/);
  assert.equal(box.readErrors(), "");
});

test("SubagentStop with no agent_transcript_path → last_assistant_message is checked; no zero-label warning (no tool count)", () => {
  const box = sandbox();
  const r = run(box, payload(box, undefined, { last_assistant_message: "**CLAIM**\nNo receipt here." }));
  assertAllows(r);
  assert.match(r.json.systemMessage, /line 1 \*\*CLAIM\*\* "No receipt here\."/);
  const plain = run(box, payload(box, undefined, { last_assistant_message: "Done, everything looks good." }));
  assertAllows(plain);
  assert.equal(plain.stdout, "");
});

test("SubagentStop zero-label: the agent transcript's tool calls are counted with sidechain entries kept; SubagentHandback is not counted; no character floor; the message names agent_type", () => {
  const box = sandbox();
  const path = agentTranscript(box, { n: 3, report: "Done, everything looks good." });
  const r = run(box, payload(box, path));
  assertAllows(r);
  assert.deepEqual(r.json, { systemMessage: "output-types: the builder subagent ran 3 tool calls, 0 labelled statements in its report. Treat its findings as unverified until checked." });
  const two = run(box, payload(box, agentTranscript(box, { n: 2, report: "Done.", name: "two.jsonl" })));
  assert.equal(two.stdout, "", "below the tool-call floor");
  assert.equal(run(box, payload(box, path), { OUTPUT_TYPES_ZERO_LABEL: "off" }).stdout, "");
});

test("SubagentStop with an empty agent_type → receipts check runs, zero-label rule does not", () => {
  const box = sandbox();
  const silent = run(box, payload(box, agentTranscript(box, { n: 5, report: "Done." }), { agent_type: "" }));
  assertAllows(silent);
  assert.equal(silent.stdout, "");
  const warned = run(box, payload(box, agentTranscript(box, { n: 5, report: "**CLAIM** it works.", name: "b.jsonl" }), { agent_type: "" }));
  assert.match(warned.json.systemMessage, /^output-types: 1 labelled statement/);
});

test("SubagentStop: skipped.log lines name hooks/output-types-subagent-stop.mjs", () => {
  const box = sandbox();
  const dir = join(box.root, "config");
  mkdirSync(join(dir, "output-types"), { recursive: true });
  writeFileSync(join(dir, "output-types", "config.json"), JSON.stringify({ judge: true }));
  const path = agentTranscript(box, { report: "**CLAIM** the file says so: /srv/a.ts:3" });
  const r = run(box, payload(box, path), { XDG_CONFIG_HOME: dir });
  assertAllows(r);
  const lines = skipped(box);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\S+Z hooks\/output-types-subagent-stop\.mjs judge not run: judge is on but no command is configured/);
});

test("SubagentStop, judge on, no command configured, state dir unwritable → exit 0, and the failed-open systemMessage names SubagentStop and carries the reason", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const box = sandbox();
  const dir = join(box.root, "config");
  mkdirSync(join(dir, "output-types"), { recursive: true });
  writeFileSync(join(dir, "output-types", "config.json"), JSON.stringify({ judge: true }));
  const path = agentTranscript(box, { report: "**CLAIM** the file says so: /srv/a.ts:3" });
  mkdirSync(box.env.XDG_STATE_HOME, { recursive: true });
  chmodSync(box.env.XDG_STATE_HOME, 0o500);
  let r;
  try {
    r = run(box, payload(box, path), { XDG_CONFIG_HOME: dir });
  } finally {
    chmodSync(box.env.XDG_STATE_HOME, 0o700);
  }
  assertAllows(r);
  assert.ok(r.json, `expected JSON output, got ${JSON.stringify(r.stdout)}`);
  assert.match(r.json.systemMessage, /^output-types SubagentStop failed open: skipped\.log could not be written/);
  assert.match(r.json.systemMessage, /judge not run: judge is on but no command is configured/);
  assert.deepEqual(skipped(box), []);
});

test("SubagentStop fault inputs: empty stdin, malformed JSON, missing agent transcript, unwritable state dir, a 5-second budget → exit 0, never a block", async () => {
  const box = sandbox();
  const empty = run(box, "");
  assertAllows(empty);
  assert.equal(empty.stdout, "");
  const bad = run(box, "{not json");
  assertAllows(bad);
  assert.match(bad.json.systemMessage, /^output-types SubagentStop failed open: stdin not JSON/);
  assert.match(box.readErrors(), /SubagentStop stdin not JSON/);
  const missing = run(box, payload(box, join(box.root, "gone.jsonl"), { last_assistant_message: "Done." }));
  assertAllows(missing);
  assert.equal(missing.stdout, "");
  const blocked = join(box.root, "file-not-dir");
  writeFileSync(blocked, "");
  const u = run(box, payload(box, agentTranscript(box, { report: "**CLAIM** x." })), { XDG_STATE_HOME: blocked });
  assertAllows(u);
  assert.match(u.json.systemMessage, /^output-types: 1 labelled/);
  const held = await new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK], { cwd: box.work, env: { ...box.env, OUTPUT_TYPES_STOP_DEADLINE_MS: "800" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stdin.on("error", () => {});
    child.stdin.write("{");
    const timer = setTimeout(() => child.kill("SIGKILL"), BUDGET_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, ms: Date.now() - started, json: parseJson(stdout) });
    });
  });
  assert.equal(held.status, 0);
  assert.ok(held.ms < BUDGET_MS, `took ${held.ms} ms`);
  assert.match(held.json.systemMessage, /failed open: no answer within 800 ms/);
});

test("handle() directly on a SubagentStop payload: OUTPUT_TYPES_CHECK=off → null", async () => {
  const box = sandbox();
  const path = agentTranscript(box, { n: 4, report: "**CLAIM** x." });
  assert.equal(await handle(JSON.parse(payload(box, path)), { env: { ...box.env, OUTPUT_TYPES_CHECK: "off" } }), null);
  const out = await handle(JSON.parse(payload(box, path)), { env: box.env });
  assert.match(out.systemMessage, /^output-types: 1 labelled/);
});
