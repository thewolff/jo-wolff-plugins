import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, hook, cli, openDb, row } from "./helpers.mjs";
import { checkStop, stripCode, DONE_WORDS } from "../lib/stop-rules.mjs";

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
  assert.deepEqual(row(db, "SELECT last_block_prompt, last_block_rule FROM sessions WHERE id = 's-stop'"), { last_block_prompt: "p-2", last_block_rule: "stopAskRule" });
  db.close();
});

test("step 8: the same question naming an open q-id → pass; naming an answered one → block", () => {
  const b = sandbox();
  cli(b, ["open", "stop q"]);
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

test("step 8: `wl-… is done` while open → block; after close → pass; stopDoneRule false → pass", () => {
  const b = sandbox();
  const wl = /wl-[a-z0-9]+/.exec(cli(b, ["open", "done rule"]).out)[0];
  const msg = `All three slices landed and the tests are green, so ${wl} is done. Nothing else is pending on my side.`;
  blocked(hook(b, "stop", { ...payload(msg), cwd: b.work }), new RegExp(`${wl} reads as finished but is still open.*ledger\\.mjs close ${wl}`));
  cli(b, ["close", wl, "really done"]);
  passed(hook(b, "stop", { ...payload(msg), cwd: b.work, prompt_id: "p-2" }));
  const c = sandbox();
  c.writeConfig({ forcing: { stopDoneRule: false } });
  const wl2 = /wl-[a-z0-9]+/.exec(cli(c, ["open", "done rule off"]).out)[0];
  passed(hook(c, "stop", { ...payload(`Slices landed, tests green, ${wl2} is finished and I am stopping here for the night.`), cwd: c.work }));
});

test("step 8: Stop stamps last_seen_at on the gate workload every turn", () => {
  const b = sandbox();
  const wl = /wl-[a-z0-9]+/.exec(cli(b, ["open", "stamp"]).out)[0];
  const db = openDb(b);
  db.prepare("UPDATE workloads SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(wl);
  db.close();
  passed(hook(b, "stop", { ...payload("Short note."), cwd: b.work }));
  const db2 = openDb(b);
  const row = db2.prepare("SELECT last_seen_at, session_id FROM workloads WHERE id = ?").get(wl);
  assert.ok(Date.parse(row.last_seen_at) > Date.now() - 60_000);
  assert.equal(row.session_id, "s-stop");
  db2.close();
});

test("step 8: hooks.stop false → nothing; stopAskRule false → a bare question passes", () => {
  const b = sandbox();
  b.writeConfig({ hooks: { stop: false } });
  passed(hook(b, "stop", { ...payload(LONG_Q), cwd: b.work }));
  b.writeConfig({ forcing: { stopAskRule: false } });
  passed(hook(b, "stop", { ...payload(LONG_Q), cwd: b.work }));
});

test("checkStop (pure): the done lexicon, the floor, and code stripping", () => {
  assert.deepEqual(DONE_WORDS, ["done", "complete", "completed", "finished", "shipped", "landed", "merged", "closed"]);
  assert.equal(stripCode("a `b?` c ```\nd?\n``` e"), "a   c   e");
  const open = (id) => id === "wl-open1";
  assert.equal(checkStop("x".repeat(39), { isOpenWorkload: open }), null);
  assert.equal(checkStop("The work on wl-open1 is not done yet; two slices remain and I am continuing with them now.", { isOpenWorkload: open })?.rule, "stopDoneRule");
  assert.equal(checkStop("wl-other is done.\nwl-open1 continues in the next slice with the remaining work still open.", { isOpenWorkload: open }), null);
  assert.equal(checkStop("Finished wl-open1 and closed it out with the reason given in the ledger as requested by you.", { isOpenWorkload: open, forcing: { stopDoneRule: false } }), null);
  assert.equal(checkStop(LONG_Q, { openQuestionIds: ["q-1"] })?.rule, "stopAskRule");
  assert.equal(checkStop(`${LONG_Q} approve q-1`, { openQuestionIds: ["q-1"] }), null);
});
