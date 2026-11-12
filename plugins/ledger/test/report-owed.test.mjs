import test from "node:test";
import assert from "node:assert/strict";
import { gather, render, RULES, PARKED_FIX } from "../lib/report.mjs";
import { sandbox, apply, askQuestion, idOf, openDb, hook } from "./helpers.mjs";

const S = "s-report";
const report = (box, now = Date.now()) => {
  const db = openDb(box);
  try {
    const data = gather(db, { now, since: "7d" });
    return { data, text: render(data) };
  } finally {
    db.close();
  }
};

test("both new Stop rules are in the graded list; a session with no firing grades them silent", () => {
  assert.ok(RULES.includes("stopOwedRule") && RULES.includes("stopOfferRule"));
  const box = sandbox();
  hook(box, "session-start", { session_id: S, cwd: box.work, hook_event_name: "SessionStart", source: "startup" });
  const { data } = report(box);
  for (const rule of ["stopOwedRule", "stopOfferRule"]) assert.equal(data.rules.find((r) => r.rule === rule).mechanical, "silent", rule);
});

test("stopOfferRule is graded like any other rule: three bypassed bounces are biting", () => {
  const box = sandbox();
  apply(box, 'note "seed"');
  const db = openDb(box);
  const at = new Date().toISOString();
  for (let i = 0; i < 3; i++) db.prepare("INSERT INTO cc_bounces (session_id, rule, prompt_id, at, outcome, text) VALUES (?,?,?,?,?,?)").run(S, "stopOfferRule", `p-${i}`, at, "bypassed", "I can run it next.");
  db.close();
  const r = report(box).data.rules.find((x) => x.rule === "stopOfferRule");
  assert.deepEqual([r.fired, r.bypassed, r.mechanical], [3, 3, "biting"]);
});

test("the owed section counts formal and agent work by state, and answers that set nothing in motion", () => {
  const box = sandbox();
  const asks = Array.from({ length: 4 }, (_, i) => askQuestion(box, { name: `q${i}`, options: "yes,no" }));
  const formal = asks.slice(0, 3).map((q) => /ow-[a-z0-9]+/.exec(apply(box, `answer ${q} yes`, { sessionId: S }).results[0].message)[0]);
  apply(box, `answer ${asks[3]} yes --nothing`, { sessionId: S });
  apply(box, [`start ${formal[0]} "agent a1"`, `done ${formal[1]}`], { sessionId: S });
  const a = idOf(apply(box, 'owe "rotate the key"', { sessionId: S }));
  apply(box, [`drop ${a} "not needed"`, 'owe "write the runbook"'], { sessionId: S });
  const { data, text } = report(box);
  assert.deepEqual(data.owed.formal, { created: 3, owed: 1, started: 1, done: 1, deferred: 0, dropped: 0, notApproved: 1 });
  assert.deepEqual(data.owed.agent, { created: 2, owed: 1, started: 0, done: 0, deferred: 0, dropped: 1 });
  assert.match(text, /^owed work since .*, by where the approval came from:$/m);
  assert.match(text, /^source +created +owed +started +done +deferred +dropped +not approved$/m);
  assert.match(text, /^formal \(answer\) +3 +1 +1 +1 +0 +0 +1$/m);
  assert.match(text, /^agent \(owe\) +2 +1 +0 +0 +0 +1 +-$/m);
  assert.ok(!text.includes("deferred owed work:"), "no deferred line while nothing is deferred");
});

test("deferred work: the count, how many went into deferred over 7 days ago, and the parked fix", () => {
  const box = sandbox();
  const old = Date.now() - 9 * 86_400_000;
  const o1 = idOf(apply(box, 'owe "old one"', { sessionId: S, now: old }));
  apply(box, `hold ${o1} "after the release"`, { sessionId: S, now: old });
  const o2 = idOf(apply(box, 'owe "new one"', { sessionId: S }));
  apply(box, `hold ${o2} "tomorrow"`, { sessionId: S });
  const db = openDb(box);
  db.prepare("UPDATE cc_owed_moves SET at = ? WHERE owed_id = ?").run(new Date(old).toISOString(), o1);
  db.close();
  const { data, text } = report(box);
  assert.equal(data.owed.deferredNow, 2);
  assert.equal(data.owed.deferredOld, 1);
  assert.ok(text.includes(`deferred owed work: 2 item(s) deferred now, 1 of them deferred more than 7 days ago. ${PARKED_FIX}`), text);
});

test("an empty window prints `no owed work in the window`", () => {
  const box = sandbox();
  apply(box, 'note "seed"');
  assert.match(report(box).text, /^no owed work in the window$/m);
});
