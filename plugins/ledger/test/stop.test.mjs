import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, hook, cli, openDb, row } from "./helpers.mjs";
import { checkStop, stripCode, stripQuoted, decisionPhrase, MIN_CHARS } from "../lib/stop-rules.mjs";
import { DEFAULTS } from "../lib/config.mjs";

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

const PHRASES = DEFAULTS.forcing.decisionPhrases;
const DECISION = "I looked at both caches. I decided to keep the LRU one because it is already measured and the other is not.";

test("decision rule: a stated decision with no note this turn → block once, naming `ledger note`; a note in the same turn → pass; once per turn", () => {
  const b = sandbox();
  const p = (message, extra = {}) => ({ ...payload(message, extra), cwd: b.work, session_id: "s-dec" });
  hook(b, "session-start", { session_id: "s-dec", cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  const r = hook(b, "stop", p(DECISION));
  blocked(r, /^ledger: this turn states a decision \("I decided"\) but recorded no note\. Run `node \S*scripts\/ledger\.mjs note "<what you decided and why>"`, then finish\.$/);
  const db = openDb(b);
  assert.deepEqual(row(db, "SELECT last_block_prompt, last_block_rule FROM cc_sessions WHERE id = 's-dec'"), { last_block_prompt: "p-1", last_block_rule: "stopDecisionRule" });
  assert.ok(row(db, "SELECT last_stop_at FROM cc_sessions WHERE id = 's-dec'").last_stop_at, "every Stop stamps last_stop_at");
  db.close();
  // The guard: the same prompt again passes even without a note.
  passed(hook(b, "stop", p(DECISION)));
  // Next turn: a note recorded in that turn lets the same message through.
  cli(b, ["note", "kept the LRU cache: measured, the other is not"], { env: { LEDGER_SESSION_ID: "s-dec" } });
  passed(hook(b, "stop", p(DECISION, { prompt_id: "p-2" })));
  // The turn after: that note is now in a previous turn, so a new decision needs a new note.
  blocked(hook(b, "stop", p(DECISION, { prompt_id: "p-3" })), /states a decision/);
  // An untagged CLI note made in this turn counts too.
  passed(hook(b, "stop", p(DECISION, { prompt_id: "p-3" })));
  cli(b, ["note", "untagged, still this session"]);
  passed(hook(b, "stop", p(DECISION, { prompt_id: "p-4" })));
});

test("decision rule: every default phrase fires, a phrase inside double quotes or code does not, the ask rule wins when both apply, the switch turns it off", () => {
  for (const phrase of PHRASES) {
    const v = checkStop(`Looking at the options, ${phrase} the smaller one for now.`, { forcing: DEFAULTS.forcing, turnNotes: 0 });
    assert.equal(v?.rule, "stopDecisionRule", phrase);
    assert.ok(v.reason.includes(`("${phrase}")`), v.reason);
  }
  assert.equal(checkStop(`The spec says "assuming the cache is warm" and nothing more.`, { forcing: DEFAULTS.forcing, turnNotes: 0 }), null);
  assert.equal(checkStop(`Jo wrote \u201cgoing with B\u201d in the ticket; I have not acted on it.`, { forcing: DEFAULTS.forcing, turnNotes: 0 }), null);
  assert.equal(checkStop("Run `ledger note \"chose A\"` to record it.", { forcing: DEFAULTS.forcing, turnNotes: 0 }), null);
  assert.equal(checkStop("The chosen path is wider; assumptions are listed below.", { forcing: DEFAULTS.forcing, turnNotes: 0 }), null, "whole words only");
  assert.equal(checkStop("Chose A.", { forcing: DEFAULTS.forcing, turnNotes: 0 })?.rule, "stopDecisionRule", "no length floor");
  assert.equal(checkStop(DECISION, { forcing: DEFAULTS.forcing, turnNotes: 1 }), null);
  assert.equal(checkStop(DECISION, { forcing: { ...DEFAULTS.forcing, stopDecisionRule: false }, turnNotes: 0 }), null);
  assert.equal(checkStop(`${DECISION} Should I keep it?`, { forcing: DEFAULTS.forcing, turnNotes: 0 })?.rule, "stopAskRule");
  assert.equal(checkStop("We went with a flat file.", { forcing: { ...DEFAULTS.forcing, decisionPhrases: ["went with"] }, turnNotes: 0 })?.rule, "stopDecisionRule", "the list is configurable");
  assert.equal(decisionPhrase("I DECIDED yesterday", PHRASES), "I decided");
  assert.equal(decisionPhrase("a trade-off, yes", PHRASES), "trade-off");
  assert.equal(decisionPhrase("nothing here", PHRASES), null);
  assert.equal(stripQuoted('a "b c" d \u201ce\u201d f'), "a   d   f");
});

test("decision rule: forcing.decisionPhrases of the wrong shape falls back to the default list with a notice; the switch stopDecisionRule false passes", () => {
  const b = sandbox();
  b.writeConfig({ forcing: { decisionPhrases: ["ok", 3] } });
  const p = (message, extra = {}) => ({ ...payload(message, extra), cwd: b.work, session_id: "s-cfg" });
  const r = hook(b, "stop", p(DECISION));
  blocked(r, /states a decision \("I decided"\)/);
  assert.match(r.json.systemMessage, /forcing\.decisionPhrases must be string\[\]; ignoring it/);
  const c = sandbox();
  c.writeConfig({ forcing: { stopDecisionRule: false } });
  passed(hook(c, "stop", { ...payload(DECISION), cwd: c.work, session_id: "s-off" }));
});
