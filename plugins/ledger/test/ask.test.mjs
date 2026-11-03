import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, apply, openWorkload, askQuestion, openDb, count } from "./helpers.mjs";
import { checkStop } from "../lib/stop-rules.mjs";

const box = sandbox();
const ask = (args) => apply(box, [{ tokens: ["ask", ...args], text: `ask ${args.join(" ")}` }]).results[0];

test("§7 row 6 (P-11): the same ask twice → the same q- id, one row; a Stop message naming it passes", () => {
  openWorkload(box, "row 6");
  const a = ask(["Which colour?", "--name", "colour", "--options", "green,red"]);
  const b = ask(["Which colour?", "--name", "colour", "--options", "green,red"]);
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
  assert.equal(a.id, b.id);
  assert.match(b.message, /already asked and still open/);
  const db = openDb(box);
  assert.equal(count(db, "questions", "body = ?", "Which colour?"), 1);
  db.close();
  const verdict = checkStop(`I need a call on the colour before continuing. Which colour should the button be?\n\ngreen ${a.id}  # colour · default green`, { openQuestionIds: [a.id], forcing: {} });
  assert.equal(verdict, null);
});

test("ask needs an open workload for the folder unless --wl names one", () => {
  const other = sandbox();
  const r = apply(other, [{ tokens: ["ask", "Anything?", "--name", "x", "--options", "a,b"], text: "" }]).results[0];
  assert.equal(r.status, "refused");
  assert.match(r.message, /no open workload for .*: open "<title>" first, or pass --wl/);
});

test("ask validates: name, two options, default among options, kind, allows keys, deadline", () => {
  openWorkload(box, "validate");
  assert.match(ask(["Q?", "--options", "a,b"]).message, /needs --name/);
  assert.match(ask(["Q?", "--name", "n"]).message, /needs --options/);
  assert.match(ask(["Q?", "--name", "n", "--options", "a"]).message, /at least two distinct words/);
  assert.match(ask(["Q?", "--name", "n", "--options", "a,a"]).message, /at least two distinct words/);
  assert.match(ask(["Q?", "--name", "n", "--options", "a,b", "--default", "c"]).message, /--default c is not one of the options a, b/);
  assert.match(ask(["Q?", "--name", "n", "--options", "a,b", "--kind", "poll"]).message, /--kind must be one of/);
  assert.match(ask(["Q?", "--name", "n", "--options", "a,b", "--allows", "c: nope"]).message, /--allows names c/);
  assert.match(ask(["Q?", "--name", "n", "--options", "a,b", "--deadline", "soon"]).message, /--deadline takes a duration/);
  const ok = ask(["Q?", "--name", "n", "--options", "a,b", "--deadline", "2h"]);
  assert.equal(ok.status, "ok", ok.message);
  const db = openDb(box);
  const q = db.prepare("SELECT deadline, deadline_span_ms, default_opt FROM questions WHERE id = ?").get(ok.id);
  assert.equal(q.deadline_span_ms, 2 * 3_600_000);
  assert.equal(q.default_opt, "a");
  assert.ok(Date.parse(q.deadline) > Date.now() + 3_600_000);
  db.close();
});

test("--kind approval defaults to approve,deny with default deny; --kind plan needs --allows for every option", () => {
  openWorkload(box, "kinds");
  const ap = ask(["Ship it?", "--name", "ship", "--kind", "approval"]);
  assert.equal(ap.status, "ok", ap.message);
  const db = openDb(box);
  const row = db.prepare("SELECT options, default_opt FROM questions WHERE id = ?").get(ap.id);
  assert.deepEqual(JSON.parse(row.options), ["approve", "deny"]);
  assert.equal(row.default_opt, "deny");
  db.close();
  const plan = ask(["Go with plan A?", "--name", "plan", "--kind", "plan", "--options", "approve,revise", "--allows", "approve: build it"]);
  assert.equal(plan.status, "refused");
  assert.match(plan.message, /missing: revise/);
  // codex review: an option named like an inherited Object property is not covered by accident.
  const inherited = ask(["Proceed?", "--name", "inh", "--kind", "plan", "--options", "approve,constructor", "--allows", "approve: build it"]);
  assert.equal(inherited.status, "refused");
  assert.match(inherited.message, /missing: constructor/);
  const planOk = ask(["Go with plan A?", "--name", "plan", "--kind", "plan", "--options", "approve,revise", "--allows", "approve: build it; revise: send a new plan"]);
  assert.equal(planOk.status, "ok", planOk.message);
  assert.match(planOk.message, /allows:\n {4}approve: build it\n {4}revise: send a new plan/);
});

test("ask on a parked workload named by --wl is refused with the open line", () => {
  const wl = openWorkload(box, "parked ask");
  apply(box, [`park ${wl} later`]);
  const r = ask(["Q?", "--name", "n", "--options", "a,b", "--wl", wl]);
  assert.equal(r.status, "refused");
  assert.match(r.message, new RegExp(`${wl} is parked \\(later\\); open ${wl} first`));
});

test("the ask reply ends with the pending line for the question", () => {
  openWorkload(box, "reply");
  const r = ask(["Which colour?", "--name", "colour", "--options", "green,red", "--default", "red"]);
  const last = r.message.split("\n").pop();
  assert.equal(last, `red ${r.id}  # colour · Which colour? · default red · also: green / withdraw`);
});

test("askQuestion helper sanity: returns a q- id", () => {
  openWorkload(box, "helper");
  assert.match(askQuestion(box, { name: "h" }), /^q-/);
});
