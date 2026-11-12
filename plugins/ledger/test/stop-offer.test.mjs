import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, hook, cli, openDb, count, row } from "./helpers.mjs";

const SID = "s-offer-stop";
const env = { LEDGER_SESSION_ID: SID };
const OFFER = "I can run the scrub over the rest next.";

function start(b) {
  hook(b, "session-start", { session_id: SID, cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
}
function stop(b, prompt_id, message, { typed = false, extra = {} } = {}) {
  const transcript_path = join(b.root, "transcript.jsonl");
  appendFileSync(transcript_path, typed ? `${JSON.stringify({ type: "user", origin: { kind: "human" }, timestamp: new Date().toISOString(), message: { role: "user", content: `prompt ${prompt_id}` } })}\n` : "");
  return hook(b, "stop", { session_id: SID, cwd: b.work, hook_event_name: "Stop", prompt_id, stop_hook_active: false, last_assistant_message: message, transcript_path, ...extra });
}
const blocked = (r, re) => {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json?.decision, "block", r.out);
  assert.match(r.json.reason, re);
};
const passes = (r) => {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json?.decision, undefined, r.out);
};
const ask = (b, body, name, extra = []) => /q-[a-z0-9]+/.exec(cli(b, ["ask", body, "--name", name, ...(extra.includes("--kind") ? [] : ["--options", "yes,no"]), ...extra], { env }).out)[0];

test("the trigger case: a reply that is only the offer blocks with stopOfferRule", () => {
  const b = sandbox();
  start(b);
  const r = stop(b, "p-1", OFFER);
  blocked(r, /offers to do work the human has not approved/);
  assert.ok(r.json.reason.includes(`- ${OFFER}`), r.json.reason);
  assert.match(r.json.reason, /ask "<the question, in plain words>" --kind approval --name <short> --about "<the offer sentence, verbatim>"/);
  passes(stop(b, "p-1", OFFER));
  const db = openDb(b);
  assert.equal(count(db, "cc_bounces", "rule = 'stopOfferRule'"), 1);
  db.close();
});

test("the bypass: a question open in scope does not let a new offer through; the offer recorded in an open question's about passes", () => {
  const b = sandbox();
  start(b);
  ask(b, "Which region should the cache use?", "region");
  blocked(stop(b, "p-1", `The cache is done. ${OFFER}`), /offers to do work/);
  const b2 = sandbox();
  start(b2);
  ask(b2, "Run the scrub over the rest?", "scrub", ["--kind", "approval", "--about", OFFER]);
  passes(stop(b2, "p-1", `The cache is done. ${OFFER}`));
});

test("an offer already answered by this session, restated later, is not new; a second, different offer is", () => {
  const b = sandbox();
  start(b);
  const q = ask(b, "Run the scrub over the rest?", "scrub", ["--kind", "approval", "--about", OFFER]);
  cli(b, ["answer", q, "approve", "--nothing"], { env });
  passes(stop(b, "p-1", OFFER));
  // A declarative second offer: a question-worded one would meet the ask rule first.
  const r = stop(b, "p-2", `${OFFER} Next, I could add the missing index.`);
  blocked(r, /offers to do work/);
  assert.ok(!r.json.reason.includes(`- ${OFFER}`), "the recorded one is not listed");
  assert.ok(r.json.reason.includes("- Next, I could add the missing index."), r.json.reason);
});

test("the escape: the answer rule blocks on p-2, the follow-up carries a new offer and blocks once, the third Stop passes", () => {
  const b = sandbox();
  start(b);
  const q = ask(b, "Ship the parser fix?", "parser");
  passes(stop(b, "p-1", "Asked about the parser fix; waiting on the reply before I go further."));
  blocked(stop(b, "p-2", "Thanks, noted.", { typed: true }), /the human has written since you asked/);
  cli(b, ["answer", q, "yes", "--nothing"], { env });
  blocked(stop(b, "p-2", `Recorded. ${OFFER}`), /offers to do work/);
  passes(stop(b, "p-2", `Recorded. ${OFFER}`));
  const db = openDb(b);
  assert.equal(row(db, "SELECT last_block_prompt, last_owed_block_prompt FROM cc_sessions WHERE id = ?", SID).last_owed_block_prompt, "p-2");
  db.close();
});

test("owed work and an offer in one Stop: one block lists both, and one bounce per rule", () => {
  const b = sandbox();
  start(b);
  const q = ask(b, "Ship the parser fix?", "parser");
  cli(b, ["answer", q, "yes"], { env });
  const r = stop(b, "p-1", OFFER);
  blocked(r, /still owed[\s\S]*offers to do work/);
  const db = openDb(b);
  assert.deepEqual(db.prepare("SELECT rule FROM cc_bounces ORDER BY id").all().map((x) => x.rule), ["stopOwedRule", "stopOfferRule"]);
  db.close();
});

test("away (brb present): the offer reason is the record-and-hold variant", () => {
  const b = sandbox();
  start(b);
  const dir = join(b.root, "state", "brb", SID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "away.json"), JSON.stringify({ since: new Date().toISOString() }));
  blocked(stop(b, "p-1", OFFER), /away \(brb\)[\s\S]*hold <q-id>/);
});

test("no prompt id: the offer check never blocks; forcing.stopOfferRule false: no offer block", () => {
  const b = sandbox();
  start(b);
  passes(hook(b, "stop", { session_id: SID, cwd: b.work, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: OFFER }));
  const off = sandbox();
  off.writeConfig({ forcing: { stopOfferRule: false } });
  start(off);
  passes(stop(off, "p-1", OFFER));
});

test("prose with no offer, code holding one, and a quoted one pass", () => {
  const b = sandbox();
  start(b);
  passes(stop(b, "p-1", "The tests pass and the branch is pushed for review."));
  passes(stop(b, "p-2", "Here is the line:\n```\nI can run it next.\n```"));
  passes(stop(b, "p-3", 'You said "I can run the scrub next." earlier.'));
});
