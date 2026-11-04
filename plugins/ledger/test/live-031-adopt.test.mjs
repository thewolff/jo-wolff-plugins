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
  assert.match(r.out, new RegExp(`^ok ${left} already asked and still open; it is now this session's question`, "m"));
  assert.match(r.out, /answer q-\S+ <option>/);
  assert.match(r.out, /^separate q-\S+  # runner home · .* · default separate · also: inside \/ withdraw$/m);
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
  assert.match(again.out, new RegExp(`^ok ${id} already asked and still open$`, "m"));
  assert.ok(!again.out.includes("now this session's question"), again.out);
  apply(box, [`hold ${id}`]);
  const held = cli(box, ["ask", BODY, "--name", "runner home", "--options", "separate,inside"], { env: { LEDGER_SESSION_ID: "s-other" } });
  assert.match(held.out, /already asked and held; run `reopen/);
  assert.equal(row(openDb(box), "SELECT session_id FROM cc_questions WHERE id = ?", id).session_id, "s-own");
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
