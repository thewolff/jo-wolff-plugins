import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, hook, cli, openDb, row } from "./helpers.mjs";
import { checkStop, stripCode, MIN_CHARS } from "../lib/stop-rules.mjs";

const box = sandbox();
const payload = (last_assistant_message, extra = {}) => ({
  session_id: "s-stop",
  cwd: box.work,
  hook_event_name: "Stop",
  prompt_id: "p-1",
  stop_hook_active: false,
  last_assistant_message,
  ...extra,
});
const LONG_Q = "I looked through the code and found two viable designs for the cache. Should I use A or B?";

function blocked(r, rule) {
  assert.equal(r.code, 0, r.err);
  assert.ok(r.json, `expected JSON, got ${JSON.stringify(r.out)}`);
  assert.equal(r.json.decision, "block");
  assert.match(r.json.reason, rule);
  assert.equal(r.json.permissionDecision, undefined);
}
function passed(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "", `expected no output, got ${r.out}`);
}

test("step 8: a question with no q-id → block with the ask reason; the same prompt_id again → pass (guard)", () => {
  blocked(hook(box, "stop", payload(LONG_Q)), /asks the human a question but names no open question row.*ledger\.mjs ask/);
  passed(hook(box, "stop", payload(LONG_Q)));
  passed(hook(box, "stop", payload(LONG_Q, { stop_hook_active: true })));
  blocked(hook(box, "stop", payload(LONG_Q, { prompt_id: "p-2" })), /names no open question row/);
  const db = openDb(box);
  assert.deepEqual(row(db, "SELECT last_block_prompt, last_block_rule FROM cc_sessions WHERE id = 's-stop'"), { last_block_prompt: "p-2", last_block_rule: "stopAskRule" });
  db.close();
});

test("step 8: the same question naming an open q-id → pass; naming an answered one → block", () => {
  const b = sandbox();
  const q = /q-[a-z0-9]+/.exec(cli(b, ["ask", "A or B?", "--name", "ab", "--options", "a,b"]).out)[0];
  passed(hook(b, "stop", { ...payload(`${LONG_Q}\n\na ${q}  # ab · A or B? · default a · also: b / withdraw`), cwd: b.work }));
  cli(b, ["a", q]);
  blocked(hook(b, "stop", { ...payload(`${LONG_Q}\n\na ${q}`), cwd: b.work, prompt_id: "p-9" }), /names no open question row/);
});

test("step 8: a `?` only inside a fenced block or inline code → pass; a 30-char message → pass", () => {
  passed(hook(box, "stop", payload("Here is the script I ran, which prints a prompt for the user:\n```sh\nread -p 'Continue?' x\n```\nIt worked and the output is attached above.", { prompt_id: "p-3" })));
  passed(hook(box, "stop", payload("I ran `grep -n 'why?' src/a.ts` and it printed the three lines you expected to see there.", { prompt_id: "p-4" })));
  passed(hook(box, "stop", payload("Should I use A or B? Tell me", { prompt_id: "p-5" })));
});



test("step 8: hooks.stop false → nothing; stopAskRule false → a bare question passes", () => {
  const b = sandbox();
  b.writeConfig({ hooks: { stop: false } });
  passed(hook(b, "stop", { ...payload(LONG_Q), cwd: b.work }));
  b.writeConfig({ forcing: { stopAskRule: false } });
  passed(hook(b, "stop", { ...payload(LONG_Q), cwd: b.work }));
});

test("a 'done' line with no question in it passes: there is no done rule any more", () => {
  const b = sandbox();
  passed(hook(b, "stop", { ...payload("All three slices landed and the tests are green, so this is done. Nothing else is pending on my side."), cwd: b.work }));
});

test("checkStop (pure): the floor, code stripping, the `?` line rule and the named-open-id escape", () => {
  assert.equal(MIN_CHARS, 40);
  assert.equal(stripCode("a `b?` c ```\nd?\n``` e"), "a   c   e");
  assert.equal(checkStop("x".repeat(38) + "?", {}), null);
  assert.equal(checkStop("x".repeat(39) + "?", {})?.rule, "stopAskRule");
  assert.equal(checkStop(LONG_Q, {})?.rule, "stopAskRule");
  assert.equal(checkStop(LONG_Q, { openQuestionIds: ["q-1"] })?.rule, "stopAskRule");
  assert.equal(checkStop(`${LONG_Q} approve q-1`, { openQuestionIds: ["q-1"] }), null);
  assert.equal(checkStop(`${LONG_Q}\napprove q-2`, { openQuestionIds: ["q-1"] })?.rule, "stopAskRule", "naming a question that is not open does not count");
  assert.equal(checkStop(LONG_Q, { forcing: { stopAskRule: false } }), null);
  assert.match(checkStop(LONG_Q, { cli: "node /x/ledger.mjs" }).reason, /`node \/x\/ledger\.mjs ask /);
});
