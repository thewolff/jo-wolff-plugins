// Regression for finding A of the live Desktop session 782c0b72 of 2026-11-03 (0.3.0): an untagged
// `ask` had left an open row in the folder from an earlier run; the new session's identical `ask`
// was a no-op ("already asked and still open"), so the session had no row of its own and the Stop
// ask rule bounced every reply with "this session has no open question row": nine bounces, no way
// out. Now the asking session adopts the row, and the ask rule stands down on any question open
// for the folder. The texts are the session's own, shortened.

import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, hook, cli, apply, askQuestion, openDb, row } from "./helpers.mjs";

const stop = (box, sid, prompt, last_assistant_message, extra = {}) =>
  hook(box, "stop", { session_id: sid, cwd: box.work, hook_event_name: "Stop", prompt_id: prompt, stop_hook_active: false, last_assistant_message, ...extra });
const start = (box, sid, cwd = box.work) => hook(box, "session-start", { session_id: sid, cwd, hook_event_name: "SessionStart", source: "startup" });

const BODY = "Should the plugin-kit runner bundle be a new package under plugins/, or live inside plugins/ledger?";
const ASKS_A_OR_B = "I looked at both layouts and either works. Should the runner be a separate package under plugins/, or live inside plugins/ledger? I'd go separate.";

test("A: an open row left by an earlier (untagged) run is adopted by the session that asks the same question; its Stop passes", () => {
  const box = sandbox();
  // The earlier run: a CLI `ask` with no session id.
  const left = askQuestion(box, { name: "runner home", body: BODY, options: "separate,inside" });
  assert.equal(row(openDb(box), "SELECT session_id FROM cc_questions WHERE id = ?", left).session_id, null);

  // The new session asks the same question: it adopts the row instead of a no-op.
  start(box, "s-new");
  const r = cli(box, ["ask", BODY, "--name", "runner home", "--options", "separate,inside"], { env: { LEDGER_SESSION_ID: "s-new" } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.match(/q-[a-z0-9]+/)[0], left, "the existing id, not a new one");
  assert.match(r.out, /this session's question/);
  assert.match(r.out, new RegExp(`answer ${left} <option>`));
  assert.match(r.out, new RegExp(`^separate ${left}  # runner home · .* · default separate · also: inside / withdraw$`, "m"));
  const db = openDb(box);
  assert.equal(row(db, "SELECT session_id FROM cc_questions WHERE id = ?", left).session_id, "s-new");
  assert.equal(db.prepare("SELECT count(*) AS n FROM cc_questions").get().n, 1, "adopted, not duplicated");

  // The session's reply asks the question: no bounce.
  const r2 = stop(box, "s-new", "p-1", ASKS_A_OR_B);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(r2.out, "", r2.out);
  assert.equal(db.prepare("SELECT count(*) AS n FROM cc_bounces").get().n, 0);
});

test("A: the same question asked again by the owning session is still a no-op; a held row is not adopted", () => {
  const box = sandbox();
  start(box, "s-own");
  const env = { LEDGER_SESSION_ID: "s-own" };
  const first = cli(box, ["ask", BODY, "--name", "runner home", "--options", "separate,inside"], { env });
  const id = first.out.match(/q-[a-z0-9]+/)[0];
  const again = cli(box, ["ask", BODY, "--name", "runner home", "--options", "separate,inside"], { env });
  assert.equal(again.out.match(/q-[a-z0-9]+/)[0], id);
  assert.match(again.out, /already asked and still open/);
  assert.ok(!again.out.includes("this session's question"), again.out);
  apply(box, [`hold ${id}`]);
  const held = cli(box, ["ask", BODY, "--name", "runner home", "--options", "separate,inside"], { env: { LEDGER_SESSION_ID: "s-other" } });
  assert.match(held.out, /already asked and held; run `reopen/);
  assert.equal(row(openDb(box), "SELECT session_id FROM cc_questions WHERE id = ?", id).session_id, "s-own");
});

// Codex review of 0.3.1, blocking: the same text with the same options in another order created a
// second open row. Identity is now folder + text + option set, order-insensitive; the existing
// row's options and default stay authoritative.
test("A: session A → session B adoption in the same cwd; reversed option order is the same question; the existing default wins", () => {
  const box = sandbox();
  start(box, "s-a");
  // Session A's row, asked an hour ago (in-process, so the clock can be set).
  const id = askQuestion(box, { name: "runner home", body: BODY, options: "separate,inside", extra: ["--default", "inside"], sessionId: "s-a", now: Date.now() - 3_600_000 });
  const before = row(openDb(box), "SELECT session_id, asked_at, default_opt FROM cc_questions WHERE id = ?", id);
  assert.equal(before.session_id, "s-a");
  start(box, "s-b");
  const r = cli(box, ["ask", BODY, "--name", "runner home", "--options", "inside,separate", "--default", "separate"], { env: { LEDGER_SESSION_ID: "s-b" } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.match(/q-[a-z0-9]+/)[0], id, "the original id");
  assert.match(r.out, /this session's question/);
  const db = openDb(box);
  const after = row(db, "SELECT session_id, asked_at, default_opt, options, state FROM cc_questions WHERE id = ?", id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM cc_questions").get().n, 1, "one row");
  assert.equal(after.session_id, "s-b", "the new owner");
  assert.equal(after.state, "open");
  assert.equal(after.default_opt, "inside", "the existing default is kept; the new --default is not written over it");
  assert.deepEqual(JSON.parse(after.options), ["separate", "inside"], "the existing order is kept");
  assert.ok(after.asked_at > before.asked_at, `asked_at refreshed: ${before.asked_at} → ${after.asked_at}`);
  // Ownership moved: session A no longer sees it as its own; B's Stop passes and B records the answer.
  assert.equal(stop(box, "s-b", "p-1", ASKS_A_OR_B).out, "");
  const a = cli(box, ["answer", id, "inside"], { env: { LEDGER_SESSION_ID: "s-b" } });
  assert.equal(a.code, 0, a.err);
  assert.equal(row(openDb(box), "SELECT state FROM cc_questions WHERE id = ?", id).state, "answered");
});

test("A: the same text in another cwd is a new row (no stealing); a different option set is a new row; asking again after an answer is a new row", () => {
  const box = sandbox();
  start(box, "s-a");
  const a = cli(box, ["ask", BODY, "--name", "runner home", "--options", "separate,inside"], { env: { LEDGER_SESSION_ID: "s-a" } }).out.match(/q-[a-z0-9]+/)[0];
  // Another folder, same text: its own row; A keeps its row.
  const other = cli(box, ["ask", BODY, "--name", "runner home", "--options", "separate,inside"], { env: { LEDGER_SESSION_ID: "s-b" }, cwd: box.sibling }).out.match(/q-[a-z0-9]+/)[0];
  assert.notEqual(other, a);
  let db = openDb(box);
  assert.equal(row(db, "SELECT session_id FROM cc_questions WHERE id = ?", a).session_id, "s-a");
  assert.equal(row(db, "SELECT cwd FROM cc_questions WHERE id = ?", other).cwd, box.sibling);
  // Same folder, same text, a third option: a different question.
  const wider = cli(box, ["ask", BODY, "--name", "runner home", "--options", "separate,inside,shared"], { env: { LEDGER_SESSION_ID: "s-b" } }).out.match(/q-[a-z0-9]+/)[0];
  assert.notEqual(wider, a);
  assert.equal(openDb(box).prepare("SELECT count(*) AS n FROM cc_questions WHERE cwd = ?").get(box.work).n, 2);
  // Answered rows are not adopted: asking again opens a new row.
  cli(box, ["answer", a, "separate"], { env: { LEDGER_SESSION_ID: "s-a" } });
  cli(box, ["withdraw", wider], { env: { LEDGER_SESSION_ID: "s-b" } });
  const again = cli(box, ["ask", BODY, "--name", "runner home", "--options", "separate,inside"], { env: { LEDGER_SESSION_ID: "s-c" } });
  const fresh = again.out.match(/q-[a-z0-9]+/)[0];
  assert.notEqual(fresh, a);
  assert.match(again.out, new RegExp(`^ok ${fresh} asked for`, "m"));
  db = openDb(box);
  assert.equal(row(db, "SELECT state, session_id FROM cc_questions WHERE id = ?", a).state, "answered");
  assert.deepEqual(row(db, "SELECT state, session_id FROM cc_questions WHERE id = ?", fresh), { state: "open", session_id: "s-c" });
});

test("A: the Stop ask rule stands down on any open question in scope for the folder, not only this session's", () => {
  const box = sandbox();
  // Open rows in the cwd (untagged, an earlier run) and in a parent folder, none tagged s-x.
  askQuestion(box, { name: "in cwd", body: BODY, options: "separate,inside" });
  start(box, "s-x");
  const r = stop(box, "s-x", "p-1", ASKS_A_OR_B);
  assert.equal(r.out, "", r.out);
  const box2 = sandbox();
  askQuestion(box2, { name: "in parent", cwd: box2.root });
  start(box2, "s-y");
  assert.equal(stop(box2, "s-y", "p-1", ASKS_A_OR_B).out, "");
  // An open row in an unrelated folder is not in scope: the rule still fires there.
  const box3 = sandbox();
  askQuestion(box3, { name: "elsewhere", cwd: box3.sibling });
  start(box3, "s-z");
  const r3 = stop(box3, "s-z", "p-1", ASKS_A_OR_B);
  assert.equal(r3.json?.decision, "block", r3.out);
  assert.match(r3.json.reason, /no open question row for this folder/);
});
