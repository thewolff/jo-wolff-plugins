import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, apply, askQuestion, cli } from "./helpers.mjs";
import { pendingLines, renderPending } from "../lib/commands.mjs";

const box = sandbox();

test("§7 row 8 (#29): the pending line carries name → body → default → also, in that order", () => {
  const q = askQuestion(box, { body: "Which colour for the button?", name: "colour", options: "green,red,blue", extra: ["--default", "red"] });
  const r = apply(box, ["pending"]).results[0];
  assert.equal(r.status, "ok");
  const line = r.message.split("\n")[0];
  assert.equal(line, `1. red ${q}  # colour · Which colour for the button? · default red · also: green, blue / withdraw`);
  const iName = line.indexOf("colour ·");
  const iBody = line.indexOf("Which colour");
  const iDefault = line.indexOf("default red");
  const iAlso = line.indexOf("also:");
  assert.ok(iName < iBody && iBody < iDefault && iDefault < iAlso);
});

test("§7 row 8 (#196): a plan question without --allows is refused; with it, pending explains each option", () => {
  const bad = apply(box, [{ tokens: ["ask", "Plan A?", "--name", "plan", "--kind", "plan"], text: "" }]).results[0];
  assert.equal(bad.status, "refused");
  assert.match(bad.message, /--kind plan needs --allows covering every option; missing: approve, revise, cancel/);
  const q = askQuestion(box, { body: "Plan A?", name: "plan", options: "approve,revise", extra: ["--kind", "plan", "--allows", "approve: build slices 1-3; revise: send a new plan"] });
  const text = apply(box, ["pending"]).results[0].message;
  assert.ok(text.includes(`approve ${q}  # plan · Plan A?`), text);
  assert.match(text, /\n {2}allows:\n {4}approve: build slices 1-3\n {4}revise: send a new plan/);
});

test("pending shows deadlines as local time plus relative, with `overdue` once past", () => {
  const q = {
    id: "q-x",
    name: "n",
    body: "B?",
    options: ["a", "b"],
    default_opt: "a",
    allows: null,
    about: null,
    ceiling_usd: null,
    deadline: "2026-11-03T12:00:00.000Z",
  };
  const before = pendingLines(q, { now: Date.parse("2026-11-03T10:00:00.000Z"), timezone: "UTC" });
  assert.match(before[1], /^ {2}due .*2026.*12:00.*\(in 2h\)$/);
  const after = pendingLines(q, { now: Date.parse("2026-11-03T15:00:00.000Z"), timezone: "UTC" });
  assert.match(after[1], /\(overdue, 3h ago\)$/);
});

test("pending with nothing open says so and is scoped to the folder (ancestor questions count, siblings do not)", () => {
  const other = sandbox();
  assert.equal(renderPending([], other.work), `no open questions for ${other.work}`);
  const q = askQuestion(other, { name: "root q" , cwd: other.root });
  const fromWork = cli(other, ["pending"], { cwd: other.work });
  assert.ok(fromWork.out.includes(q), fromWork.out);
  const unrelated = cli(other, ["pending"], { env: { LEDGER_CWD: "/" } });
  assert.match(unrelated.out, /^no open questions for \//);
});
