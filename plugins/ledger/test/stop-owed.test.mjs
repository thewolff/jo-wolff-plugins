import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sandbox, hook, cli, openDb, row, count } from "./helpers.mjs";

const SID = "s-owed-stop";
const env = { LEDGER_SESSION_ID: SID };
const QUIET = "Working on it; the tests are running and I will report back shortly.";

function start(b) {
  hook(b, "session-start", { session_id: SID, cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
}
/** A Stop for prompt `prompt_id`; `typed` appends a typed prompt to the transcript first. */
function stop(b, prompt_id, message = QUIET, { typed = false, extra = {} } = {}) {
  const transcript_path = join(b.root, "transcript.jsonl");
  if (typed) appendFileSync(transcript_path, `${JSON.stringify({ type: "user", origin: { kind: "human" }, timestamp: new Date().toISOString(), message: { role: "user", content: `prompt ${prompt_id}` } })}\n`);
  else appendFileSync(transcript_path, "");
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
  return r.json?.systemMessage ?? "";
};
const ask = (b, extra = []) => /q-[a-z0-9]+/.exec(cli(b, ["ask", "Build the weekly digest exporter now?", "--name", "digest-exporter", "--options", "yes,no", "--allows", "yes: Build the weekly digest exporter; no: leave it", ...extra], { env }).out)[0];
const owedId = (out) => /ow-[a-z0-9]+/.exec(out)[0];

test("the formal trace, steps 1 to 6: ask rule, answer rule, owed rule once, then a pass that shows what happened", () => {
  const b = sandbox();
  start(b);
  // 1. A question with no row: the ask rule blocks; after `ask`, the same prompt passes.
  blocked(stop(b, "p-1", "I have the plan for the digest. Should I build the weekly digest exporter now?"), /no open question row/);
  const q = ask(b);
  assert.equal(passes(stop(b, "p-1", "I have the plan for the digest. Should I build the weekly digest exporter now?")), "");
  // 3. The human replied: the answer rule blocks on p-2.
  blocked(stop(b, "p-2", QUIET, { typed: true }), /the human has written since you asked this question/);
  // 4. The answer records owed work.
  const a = cli(b, ["answer", q, "yes"], { env });
  assert.equal(a.code, 0, a.err);
  const ow = owedId(a.out);
  // 5. Shared mark spent: the owed rule blocks once.
  const r5 = stop(b, "p-2");
  blocked(r5, /work the human approved is still owed/);
  assert.match(r5.json.reason, /- Build the weekly digest exporter \(ow-[a-z0-9]+, owed /);
  assert.match(r5.json.reason, /start <ow-id>.*hold <ow-id>.*drop <ow-id>.*wait <ow-id> <q-id>.*done <ow-id>/s);
  // 6. Started: both marks spent, pass with the visible lines, bounce satisfied.
  assert.equal(cli(b, ["start", ow, "agent a1b2c3"], { env }).code, 0);
  const msg = passes(stop(b, "p-2"));
  assert.equal(msg, "ledger: owed: Build the weekly digest exporter\nledger: started: Build the weekly digest exporter (agent a1b2c3)");
  assert.equal(passes(stop(b, "p-2")), "", "lines are shown once");
  const db = openDb(b);
  assert.deepEqual(row(db, "SELECT outcome FROM cc_bounces WHERE rule = 'stopOwedRule'"), { outcome: "satisfied" });
  assert.equal(row(db, "SELECT last_owed_block_prompt FROM cc_sessions WHERE id = ?", SID).last_owed_block_prompt, "p-2");
  db.close();
});

test("the formal trace, step 7: ignored, the third Stop passes saying it is still owed; the next prompt blocks once more", () => {
  const b = sandbox();
  start(b);
  const q = ask(b);
  cli(b, ["answer", q, "yes"], { env });
  blocked(stop(b, "p-2"), /still owed/);
  const msg = passes(stop(b, "p-2"));
  assert.match(msg, /^ledger: owed: Build the weekly digest exporter$/m);
  assert.match(msg, /^ledger: still owed after one reminder, and the turn ended: Build the weekly digest exporter$/m);
  blocked(stop(b, "p-3"), /still owed/);
  assert.match(passes(stop(b, "p-3")), /still owed after one reminder/);
});

test("hold, drop, done and wait each clear the block; a wait on an open question leaves the blocking set", () => {
  const b = sandbox();
  start(b);
  for (const [verb, arg, line] of [
    ["hold", "after the release, Friday", "ledger: deferred: Build the weekly digest exporter: after the release, Friday"],
    ["drop", "superseded by the feed rewrite", "ledger: dropped: Build the weekly digest exporter: superseded by the feed rewrite"],
    ["done", null, "ledger: done: Build the weekly digest exporter"],
  ]) {
    const q = ask(b);
    const ow = owedId(cli(b, ["answer", q, "yes"], { env }).out);
    assert.equal(cli(b, [verb, ow, ...(arg ? [arg] : [])], { env }).code, 0, verb);
    const msg = passes(stop(b, `p-${verb}`));
    assert.match(msg, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), verb);
  }
  const q = ask(b);
  const ow = owedId(cli(b, ["answer", q, "yes"], { env }).out);
  const waitOn = /q-[a-z0-9]+/.exec(cli(b, ["ask", "Which region first?", "--name", "region", "--options", "east,west"], { env }).out)[0];
  assert.equal(cli(b, ["wait", ow, waitOn], { env }).code, 0);
  assert.match(passes(stop(b, "p-wait")), /waits on your answer to "region": Build the weekly digest exporter/);
  cli(b, ["answer", waitOn, "east", "--nothing"], { env });
  blocked(stop(b, "p-after"), /still owed/);
});

test("no prompt id: the owed rule never blocks", () => {
  const b = sandbox();
  start(b);
  cli(b, ["answer", ask(b), "yes"], { env });
  const r = hook(b, "stop", { session_id: SID, cwd: b.work, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: QUIET });
  passes(r);
});

test("away (brb present): the owed rule still blocks", () => {
  const b = sandbox();
  start(b);
  cli(b, ["answer", ask(b), "yes"], { env });
  const dir = join(b.root, "state", "brb", SID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "away.json"), JSON.stringify({ since: new Date().toISOString() }));
  blocked(stop(b, "p-away"), /still owed/);
});

test("another hook's continuation (stop_hook_active) with no owed mark yet: the owed rule blocks once", () => {
  const b = sandbox();
  start(b);
  cli(b, ["answer", ask(b), "yes"], { env });
  blocked(stop(b, "p-x", QUIET, { extra: { stop_hook_active: true } }), /still owed/);
  passes(stop(b, "p-x", QUIET, { extra: { stop_hook_active: true } }));
});

test("forcing.stopOwedRule false: no owed block", () => {
  const b = sandbox();
  b.writeConfig({ forcing: { stopOwedRule: false } });
  start(b);
  cli(b, ["answer", ask(b), "yes"], { env });
  passes(stop(b, "p-off"));
  const db = openDb(b);
  assert.equal(count(db, "cc_bounces", "rule = 'stopOwedRule'"), 0);
  db.close();
});

test("fail open: a broken owed table logs the error and the Stop passes", () => {
  const b = sandbox();
  start(b);
  cli(b, ["answer", ask(b), "yes"], { env });
  const raw = new DatabaseSync(b.dbPath);
  raw.exec("PRAGMA foreign_keys = OFF; DROP TABLE cc_owed_moves; DROP TABLE cc_owed;");
  raw.close();
  const r = stop(b, "p-broken");
  passes(r);
  assert.equal(r.code, 0);
});

test("fault inputs: empty stdin, malformed JSON and a missing database pass with no block", () => {
  const b = sandbox();
  for (const input of ["", "{not json"]) {
    const r = hook(b, "stop", input);
    assert.equal(r.code, 0, r.err);
    assert.notEqual(r.json?.decision, "block");
  }
  const r = hook(b, "stop", { session_id: SID, cwd: b.work, hook_event_name: "Stop", prompt_id: "p-1", last_assistant_message: QUIET }, { env: { LEDGER_DB: join(b.root, "missing", "dir", "ledger.db") } });
  assert.equal(r.code, 0, r.err);
  assert.notEqual(r.json?.decision, "block");
});

test("more than eight events: the ones past the cap are not marked shown and appear on the next Stop", () => {
  const b = sandbox();
  start(b);
  const ids = [];
  for (let n = 0; n < 10; n++) ids.push(owedId(cli(b, ["owe", `chore number ${n}`], { env }).out));
  for (const id of ids) cli(b, ["done", id], { env });
  const first = passes(stop(b, "p-many"));
  assert.match(first, /… and \d+ more/);
  assert.doesNotMatch(first, /chore number 8/);
  // 20 events at 8 per Stop: the second Stop starts where the first left off, the third finishes.
  const second = passes(stop(b, "p-many"));
  assert.match(second, /^ledger: owed: chore number 8$/m, "the events past the cap show on the next Stop");
  assert.match(passes(stop(b, "p-many")), /^ledger: done: chore number 9$/m);
  assert.equal(passes(stop(b, "p-many")), "", "each event is shown once");
});
