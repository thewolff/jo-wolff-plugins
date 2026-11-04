// Regression for finding C of the live Desktop session dd4858cd of 2026-11-03 (0.3.0), in
// projects-trial: Jo answered a question asked in ANOTHER folder with the bare word "local"; the
// session only had a count ("1 question waiting on you in 1 other folder"), could not tell the
// reply was an answer, and recorded nothing. SessionStart now lists the other-folder questions
// in full, and a bare-option prompt comes with the `answer` command as a hint.

import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, hook, cli, apply, askQuestion, openDb, row } from "./helpers.mjs";
import { bareOption } from "../lib/commands.mjs";

const stop = (box, sid, prompt, last_assistant_message, extra = {}) =>
  hook(box, "stop", { session_id: sid, cwd: box.work, hook_event_name: "Stop", prompt_id: prompt, stop_hook_active: false, last_assistant_message, ...extra });
const start = (box, sid, cwd = box.work) => hook(box, "session-start", { session_id: sid, cwd, hook_event_name: "SessionStart", source: "startup" });
const prompt = (box, sid, text, cwd = box.work) => hook(box, "user-prompt", { session_id: sid, cwd, hook_event_name: "UserPromptSubmit", prompt: text });

test("C: SessionStart lists other-folder questions with body, options, default and id; a bare option as the prompt hints the answer command; recording it clears the block", () => {
  const box = sandbox();
  const other = `${box.root}/projects-trial`;
  const q = askQuestion(box, { name: "db mode", body: "Should the trial use a local or a remote database?", options: "local,remote", extra: ["--default", "remote"], cwd: other });
  const r = start(box, "s-c");
  const text = r.json.hookSpecificOutput.additionalContext;
  const i = text.indexOf("1 question waiting on you in 1 other folder");
  assert.ok(i >= 0, text);
  const block = text.slice(i).split("\n");
  assert.match(block[0], /answer <q-id> <option>/, "the header names the command");
  assert.equal(block[1], other);
  assert.match(block[2], new RegExp(`^remote ${q}  # db mode · Should the trial use a local or a remote database\\? · default remote · also: local / withdraw$`));

  // Jo's prompt is the bare option word: the prompt hook hints, records nothing.
  const p = prompt(box, "s-c", "Local.");
  assert.equal(p.code, 0, p.err);
  assert.ok(p.json?.hookSpecificOutput?.additionalContext, p.out);
  const ctx = p.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, new RegExp(`is option local of an open question \\(asked in ${other}\\)`));
  assert.match(ctx, new RegExp(`remote ${q}  # db mode · Should the trial use a local or a remote database\\? · default remote · also: local / withdraw`), "the question's pending line");
  assert.match(ctx, new RegExp(`ledger answer ${q} local`), "the command to run");
  assert.equal(p.json.systemMessage, undefined, "the human is not shown the hint");
  assert.equal(row(openDb(box), "SELECT state FROM cc_questions WHERE id = ?", q).state, "open");

  // A prompt that is not a bare option, or names a word no question offers: no hint.
  assert.equal(prompt(box, "s-c", "local is fine but remote later").out, "");
  assert.equal(prompt(box, "s-c", "sqlite").out, "");
  assert.equal(bareOption(" Remote! ", ["local", "remote"]), "remote");
  assert.equal(bareOption("remote please", ["local", "remote"]), null);

  // The session records the answer from its own folder; the block clears and the question is answered.
  const a = cli(box, ["answer", q, "local"], { env: { LEDGER_SESSION_ID: "s-c" } });
  assert.equal(a.code, 0, a.err);
  assert.equal(row(openDb(box), "SELECT state FROM cc_questions WHERE id = ?", q).state, "answered");
  assert.ok(!start(box, "s-c2").json.hookSpecificOutput.additionalContext.includes("other folder"));
});

// Codex review of 0.3.1, should-fix: a held question elsewhere carried only id, name and body.
test("C: a held question in another folder carries its options and default at SessionStart, marked held; the bare option still hints it", () => {
  const box = sandbox();
  const other = `${box.root}/elsewhere`;
  const q = askQuestion(box, { name: "storage", body: "Which storage mode?", options: "local,remote", extra: ["--default", "remote"], cwd: other });
  apply(box, [`hold ${q}`], { cwd: other });
  const text = start(box, "s-h").json.hookSpecificOutput.additionalContext;
  const i = text.indexOf("1 question waiting on you in 1 other folder");
  assert.ok(i >= 0, text);
  const block = text.slice(i).split("\n");
  assert.equal(block[1], other);
  assert.equal(block[2], `held ${q}  # storage · Which storage mode? · default remote · also: local / withdraw`);
  const p = prompt(box, "s-h", "local");
  assert.match(p.json?.hookSpecificOutput?.additionalContext ?? "", new RegExp(`ledger answer ${q} local`));
  assert.equal(row(openDb(box), "SELECT state FROM cc_questions WHERE id = ?", q).state, "held", "a hint records nothing");
});

test("C: the hint ranks this session's question first, then this folder's, then elsewhere; held rows count", () => {
  const box = sandbox();
  const far = askQuestion(box, { name: "far", options: "yes,no", cwd: box.sibling });
  const near = askQuestion(box, { name: "near", options: "yes,no" });
  apply(box, [`hold ${near}`]);
  start(box, "s-rank");
  const mine = cli(box, ["ask", "Mine?", "--name", "mine", "--options", "yes,no"], { env: { LEDGER_SESSION_ID: "s-rank" } }).out.match(/q-[a-z0-9]+/)[0];
  const ctx = prompt(box, "s-rank", "yes").json.hookSpecificOutput.additionalContext;
  const ids = ctx.match(/answer (q-[a-z0-9]+) yes/g).map((s) => s.split(" ")[1]);
  assert.deepEqual(ids, [mine, near, far]);
  // Without a session id (no session) the hook does not look.
  assert.equal(hook(box, "user-prompt", { cwd: box.work, hook_event_name: "UserPromptSubmit", prompt: "yes" }).out, "");
});
