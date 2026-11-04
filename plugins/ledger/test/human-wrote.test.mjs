// human-wrote.test.mjs — 0.3.8 (#340): only a prompt the person typed counts as "the human has
// written since you asked"; while brb holds the session the Stop hook neither nags for an answer
// nor tells the agent to ask the human; `hold <q-id>` never records an answer, even when the
// question lists `hold` as an option. Shapes from a Desktop session: ask → a task-notification
// `user` entry → an idle reply.

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, hook, cli, apply, askQuestion, openDb, row, count } from "./helpers.mjs";
import { isHumanPrompt, humanWroteSince } from "../lib/transcript.mjs";

const SID = "s-human";
const env = { LEDGER_SESSION_ID: SID };
const IDLE = "idle: waiting on the two Kitchen subagents; nothing for you right now.";
const LONG_Q = "I looked through the code and found two viable designs for the cache. Should I use A or B?";

const user = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, timestamp: new Date(Date.now() + 5).toISOString(), ...extra });
const notification = () =>
  user("<task-notification>\n<task-id>ae22</task-id>\n<status>completed</status>\n<summary>Agent \"Wire Kitchen\" is waiting</summary>\n</task-notification>", { origin: { kind: "task-notification" } });
const reminder = () => user("<system-reminder>\n<tools-used-before-summary>Monitor</tools-used-before-summary>\n</system-reminder>", { isMeta: true });

function setup() {
  const b = sandbox();
  const transcript = join(b.root, "transcript.jsonl");
  writeFileSync(transcript, `${JSON.stringify(user("set up the kitchen packages", { origin: { kind: "human" }, timestamp: "2026-01-01T00:00:00.000Z" }))}\n`);
  hook(b, "session-start", { session_id: SID, cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  const q = /q-[a-z0-9]+/.exec(cli(b, ["ask", "ship it or not?", "--name", "ship", "--options", "yes,no"], { env }).out)[0];
  const stop = (prompt_id, message = IDLE, extra = {}) =>
    hook(b, "stop", { session_id: SID, cwd: b.work, hook_event_name: "Stop", prompt_id, stop_hook_active: false, last_assistant_message: message, transcript_path: transcript }, extra);
  assert.equal(stop("p-1", LONG_Q).out, "", "the asking turn ends clean");
  const add = (...entries) => appendFileSync(transcript, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return { b, q, stop, add };
}

test("a task-notification and a system-reminder after the ask start a new turn but are not the human: no answer nag", () => {
  const { stop, add } = setup();
  add(reminder(), notification());
  assert.equal(stop("p-2").out, "");
});

test("a typed prompt after the ask is the human: the answer nag fires", () => {
  const { q, stop, add } = setup();
  add(notification(), user("yes ship it", { origin: { kind: "human" } }));
  const r = stop("p-2");
  assert.equal(r.json?.decision, "block", r.out);
  assert.match(r.json.reason, /the human has written since you asked this question/);
  assert.ok(r.json.reason.includes(q));
});

test("brb holds the session (away.json present): no answer nag even after a typed prompt, and nothing said", () => {
  const { b, stop, add } = setup();
  const dir = join(b.root, "state", "brb", SID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "away.json"), JSON.stringify({ since: "2026-11-04T18:42:47.234Z", note: "", held: 2 }));
  add(user("yes ship it", { origin: { kind: "human" } }));
  assert.equal(stop("p-2").out, "");
});

test("brb holds the session: a reply asking a question with no row is told to `ask` then `hold`, never to ask the human", () => {
  const b = sandbox();
  const dir = join(b.root, "state", "brb", "s-away");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "away.json"), "{}");
  const r = hook(b, "stop", { session_id: "s-away", cwd: b.work, hook_event_name: "Stop", prompt_id: "p-1", stop_hook_active: false, last_assistant_message: LONG_Q });
  assert.equal(r.json?.decision, "block", r.out);
  assert.match(r.json.reason, /the human is away \(brb\).*ask ".*then `.*hold <q-id>`/s);
  assert.doesNotMatch(r.json.reason, /plain words/);
  // An unparsable away.json is "home": the usual reason.
  writeFileSync(join(dir, "away.json"), "{not json");
  const home = hook(b, "stop", { session_id: "s-away", cwd: b.work, hook_event_name: "Stop", prompt_id: "p-2", stop_hook_active: false, last_assistant_message: LONG_Q });
  assert.match(home.json.reason, /ask in plain words/);
});

test("isHumanPrompt: a prompt led by a system-reminder block and then real text is the human; injected lines are not", () => {
  assert.equal(isHumanPrompt(user("<system-reminder>\nToday is Tuesday.\n</system-reminder>\nship it")), true);
  assert.equal(isHumanPrompt(user([{ type: "text", text: "<system-reminder>x</system-reminder>  ship it" }])), true);
  assert.equal(isHumanPrompt(user("<system-reminder>x</system-reminder>")), false, "a reminder alone");
  for (const t of [
    "<task-notification><task-id>a</task-id></task-notification>",
    '<agent-message from="peer">hi</agent-message>',
    "<local-command-stdout>ok</local-command-stdout>",
    "<local-command-caller>x</local-command-caller>",
    "Another Claude session sent a message:\nhello",
    "Stop hook feedback:\nledger: …",
    "[Subagent hand-back] The text below is the final report",
  ]) {
    assert.equal(isHumanPrompt(user(t)), false, t);
  }
  assert.equal(isHumanPrompt(user([{ type: "tool_result", tool_use_id: "t", content: "ok" }])), false, "tool results only");
  assert.equal(isHumanPrompt(user("ship it", { origin: { kind: "peer" } })), false, "origin.kind wins");
  assert.equal(isHumanPrompt(user("ship it", { isMeta: true })), false);
  assert.equal(isHumanPrompt(user("ship it")), true);
});

test("humanWroteSince: null when it cannot tell (no file, no timestamped user entries), so the prompt_id rule stands", () => {
  const b = sandbox();
  assert.equal(humanWroteSince(join(b.root, "nope.jsonl"), "2026-01-01T00:00:00.000Z"), null);
  const p = join(b.root, "other.jsonl");
  writeFileSync(p, `${JSON.stringify({ role: "user", content: "hi" })}\n`);
  assert.equal(humanWroteSince(p, "2026-01-01T00:00:00.000Z"), null);
});

test("`hold <q-id>` on a question whose options include `hold` holds it and records no answer; `answer <q-id> hold` still answers", () => {
  const b = sandbox();
  const q = askQuestion(b, { name: "secret", options: "yes,hold,no" });
  const r = apply(b, [{ tokens: ["hold", q], text: `hold ${q}` }]).results[0];
  assert.equal(r.status, "ok", r.message);
  assert.match(r.message, /held: waiting on the human/);
  let db = openDb(b);
  assert.equal(row(db, "SELECT state FROM cc_questions WHERE id = ?", q).state, "held");
  assert.equal(count(db, "cc_answers"), 0);
  db.close();
  const via = cli(b, ["hold", q]);
  assert.equal(via.code, 0, via.out + via.err);
  db = openDb(b);
  assert.equal(count(db, "cc_answers"), 0, "the CLI path too");
  db.close();
  const a = cli(b, ["answer", q, "hold"]);
  assert.equal(a.code, 0, a.out + a.err);
  db = openDb(b);
  assert.equal(row(db, "SELECT word FROM cc_answers WHERE question_id = ?", q).word, "hold");
  db.close();
});
