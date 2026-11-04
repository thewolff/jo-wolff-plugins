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

test("step 8: a question while the session has no open row → block with the ask reason; the same prompt_id again → pass (guard)", () => {
  blocked(hook(box, "stop", payload(LONG_Q)), /asks the human a question but there is no open question row for this folder.*ledger\.mjs ask/);
  passed(hook(box, "stop", payload(LONG_Q)));
  passed(hook(box, "stop", payload(LONG_Q, { stop_hook_active: true })));
  blocked(hook(box, "stop", payload(LONG_Q, { prompt_id: "p-2" })), /no open question row for this folder/);
  const db = openDb(box);
  assert.deepEqual(row(db, "SELECT last_block_prompt, last_block_rule FROM cc_sessions WHERE id = 's-stop'"), { last_block_prompt: "p-2", last_block_rule: "stopAskRule" });
  db.close();
});

// The answer flow: the agent asks in plain words, the human replies in plain words, the agent
// records the reply. No id crosses to the human, so nothing reads ids out of the reply.
const SID = "s-ans";
const sessionEnv = { LEDGER_SESSION_ID: SID };
const stopIn = (b, prompt_id, message = "Working on it; the tests are running and I will report back shortly.") =>
  hook(b, "stop", { ...payload(message), session_id: SID, cwd: b.work, prompt_id });
const askIn = (b, name) => /q-[a-z0-9]+/.exec(cli(b, ["ask", `${name} or not?`, "--name", name, "--options", "yes,no"], { env: sessionEnv }).out)[0];
const startSession = (b) => hook(b, "session-start", { session_id: SID, cwd: b.work, hook_event_name: "SessionStart", source: "startup" });

test("answer rule: an open question, then a human prompt, then a Stop with no answer recorded → bounced once, naming the id and `answer`", () => {
  const b = sandbox();
  startSession(b);
  const q = askIn(b, "ship");
  passed(stopIn(b, "p-1", LONG_Q));
  const r = stopIn(b, "p-2");
  blocked(r, /the human has written since you asked this question/);
  assert.ok(r.json.reason.includes(`${q} (ship): ship or not?`), r.json.reason);
  assert.match(r.json.reason, /Take the answer from the human's latest message and run `node .*ledger\.mjs answer <q-id> <option>`/);
  assert.match(r.json.reason, /Do not show the q- id to the human/);
  passed(stopIn(b, "p-2"));
  const db = openDb(b);
  assert.deepEqual(row(db, "SELECT last_block_prompt, last_block_rule, last_stop_prompt FROM cc_sessions WHERE id = ?", SID), { last_block_prompt: "p-2", last_block_rule: "stopAnswerRule", last_stop_prompt: "p-2" });
  db.close();
});

test("answer rule: the same flow after `ledger answer <q-id> <option>` → the Stop passes", () => {
  const b = sandbox();
  startSession(b);
  const q = askIn(b, "ship");
  passed(stopIn(b, "p-1", LONG_Q));
  const a = cli(b, ["answer", q, "yes"], { env: sessionEnv });
  assert.equal(a.code, 0, a.out + a.err);
  passed(stopIn(b, "p-2"));
});

test("answer rule: no human prompt since the question → the Stop passes (the agent is still waiting)", () => {
  const b = sandbox();
  startSession(b);
  askIn(b, "ship");
  passed(stopIn(b, "p-1", LONG_Q));
  passed(stopIn(b, "p-1", LONG_Q), "a second Stop of the same turn is not a reply");
  // A question asked during the new turn, after the previous Stop, is not due yet either.
  const c = sandbox();
  startSession(c);
  passed(stopIn(c, "p-1"));
  askIn(c, "later");
  passed(stopIn(c, "p-2", LONG_Q));
});

test("answer rule: several open questions → listed newest first; the bounce clears once every one asked before the latest prompt is answered", () => {
  const b = sandbox();
  startSession(b);
  const first = askIn(b, "first");
  const second = askIn(b, "second");
  passed(stopIn(b, "p-1", LONG_Q));
  const third = askIn(b, "third");
  const r = stopIn(b, "p-2");
  blocked(r, /since you asked these questions, and they have no answer recorded/);
  const ids = r.json.reason.match(/q-[a-z0-9]+(?= \()/g);
  assert.deepEqual(ids, [second, first], "newest first; the one asked in this turn is not due");
  cli(b, ["answer", second, "no"], { env: sessionEnv });
  const again = stopIn(b, "p-3");
  blocked(again, /since you asked these questions/);
  assert.deepEqual(again.json.reason.match(/q-[a-z0-9]+(?= \()/g), [third, first]);
  cli(b, ["answer", first, "yes"], { env: sessionEnv });
  cli(b, ["withdraw", third], { env: sessionEnv });
  passed(stopIn(b, "p-4"));
});

test("ask rule: a reply ending in `?` passes while the session has an open row and is sent back once that row is answered", () => {
  const b = sandbox();
  startSession(b);
  const q = askIn(b, "ab");
  passed(stopIn(b, "p-1", LONG_Q));
  cli(b, ["answer", q, "yes"], { env: sessionEnv });
  blocked(stopIn(b, "p-2", LONG_Q), /no open question row for this folder/);
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

test("checkStop (pure): the floor, code stripping, the `?` line rule, the open-row escape and the answer rule", () => {
  assert.equal(MIN_CHARS, 40);
  assert.equal(stripCode("a `b?` c ```\nd?\n``` e"), "a   c   e");
  assert.equal(checkStop("x".repeat(25) + " Should I do A or B?", {}), null); // 39 substantive chars
  assert.equal(checkStop("x".repeat(26) + " Should I do A or B?", {})?.rule, "stopAskRule"); // 40
  assert.equal(checkStop(LONG_Q, {})?.rule, "stopAskRule");
  assert.equal(checkStop(LONG_Q, { sessionHasOpenQuestion: true }), null);
  const due = [{ id: "q-2", name: "b", body: "B?" }, { id: "q-1", name: "a", body: "A?" }];
  const v = checkStop("Done.", { dueQuestions: due, sessionHasOpenQuestion: true });
  assert.equal(v?.rule, "stopAnswerRule");
  assert.ok(v.reason.indexOf("q-2 (b): B?") < v.reason.indexOf("q-1 (a): A?"), v.reason);
  assert.equal(checkStop(LONG_Q, { forcing: { stopAskRule: false } }), null);
  assert.equal(checkStop("Done.", { dueQuestions: due, forcing: { stopAskRule: false } }), null);
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

test("decision rule: an outcome recorded this turn does not count as the note a stated decision needs", () => {
  const b = sandbox();
  const p = (message, extra = {}) => ({ ...payload(message, extra), cwd: b.work, session_id: "s-dec-o" });
  hook(b, "session-start", { session_id: "s-dec-o", cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  cli(b, ["outcome", "src/cache.ts", "kept the LRU cache"], { env: { LEDGER_SESSION_ID: "s-dec-o" } });
  blocked(hook(b, "stop", p(DECISION)), /states a decision/);
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

// The live headless run of 0.3.0 (2026-11-03), findings 2 and 3: the texts are the model's own.
test("live run: a closing ask mid-line fires the ask rule; a URL query and a quoted question do not", () => {
  const closing = "**Closing ask:** Should I change the README heading from `# helper` to `# alpha` so the repo uses the name you picked? I recommend doing it: the README should match.";
  assert.equal(checkStop(closing, { forcing: DEFAULTS.forcing })?.rule, "stopAskRule");
  assert.equal(checkStop("Should I write a ledger note about the push again? I'd say yes, it is cheap.", { forcing: DEFAULTS.forcing })?.rule, "stopAskRule");
  assert.equal(checkStop("The docs are at https://example.com/page?id=4 and they cover the whole flag set.", { forcing: DEFAULTS.forcing }), null);
  assert.equal(checkStop('The ticket asked "should this be green?" and the answer was recorded already.', { forcing: DEFAULTS.forcing }), null);
});

test("live run: a stated default beside a question asked this turn, and a bug described with `instead of`, are not decisions", () => {
  const withDefault = "I asked which name you want for the helper; if you don't answer, I'll go with alpha.";
  assert.equal(checkStop(withDefault, { forcing: DEFAULTS.forcing, sessionHasOpenQuestion: true, turnQuestions: 1 }), null);
  assert.equal(checkStop(withDefault, { forcing: DEFAULTS.forcing, sessionHasOpenQuestion: true, turnQuestions: 0 })?.rule, "stopDecisionRule", "without a question this turn it is a decision");
  assert.equal(checkStop("Codex found that add subtracts instead of adding, so I fixed it and reran the review.", { forcing: DEFAULTS.forcing }), null);
  assert.ok(!PHRASES.includes("instead of"));
});
