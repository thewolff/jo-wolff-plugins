// hide.test.mjs — mods/band/hide.mjs under `node --test`: which transcript rows belong to the hold
// (by id, since the row sites carry no time), the on-fire exemption, runs of hidden rows (the
// first draws the line, the rest nothing), the end of a hold restoring every row and keeping a
// later hold to its own rows, a ToolGroup that spans the start of a hold, rows drawn before the
// mod knows the away state, and the system-prompt answer breaking the cache only at a change.

import test from "node:test";
import assert from "node:assert/strict";
import { AWAY_TEXT, ID_CAP, carriesFire, createLedger, rowIds, sectionAnswer } from "../hide.mjs";

const HOME = { known: true, away: false };
const AWAY = { known: true, away: true };
const msg = (id, text = "did a thing") => ({ component: "AssistantMessage", requestId: id, props: { text, isFirstOfReply: true } });
const tool = (id, component = "ToolUse") => ({ component, requestId: id, props: { tool_use_id: id, tool: "Bash", input: { command: "ls" } } });
const group = (...ids) => ({ component: "ToolGroup", requestId: ids[0], props: { calls: ids.map((tool_use_id) => ({ tool_use_id })), isActive: false, isExpanded: false } });
const user = (id) => ({ component: "UserMessage", requestId: id, props: { text: "hi" } });

test("rows drawn home are shown during a later hold; rows first drawn during it are hidden", () => {
  const l = createLedger();
  assert.equal(l.decide({ ...HOME, ...msg("m1") }), "show");
  assert.equal(l.decide({ ...HOME, ...tool("t1") }), "show");
  // brb; the old rows draw again (a scroll, a redraw) and stay as they were
  assert.equal(l.decide({ ...AWAY, ...msg("m1") }), "show");
  assert.equal(l.decide({ ...AWAY, ...tool("t1") }), "show");
  assert.notEqual(l.decide({ ...AWAY, ...msg("m2") }), "show");
  assert.notEqual(l.decide({ ...AWAY, ...tool("t2") }), "show");
  assert.equal(l.held, 2);
});

test("a tool call started home whose row first draws after brb predates the hold", () => {
  const l = createLedger();
  l.noteCall("t-long", HOME);
  assert.equal(l.decide({ ...AWAY, ...tool("t-long") }), "show");
  l.noteCall("t-away", AWAY);
  assert.notEqual(l.decide({ ...AWAY, ...tool("t-away") }), "show", "a call made while away is not recorded as the past");
});

test("a run of hidden rows draws one line, then nothing; a shown row ends the run", () => {
  const l = createLedger();
  l.decide({ ...HOME, ...msg("m0") });
  const verdicts = [msg("a1"), tool("a2"), tool("a2", "ToolResult"), group("a3", "a4"), msg("a5")].map((r) => l.decide({ ...AWAY, ...r }));
  assert.deepEqual(verdicts, ["line", "empty", "empty", "empty", "empty"]);
  assert.equal(l.decide({ ...AWAY, ...user("u1") }), "show", "Jo's own prompt is never hidden");
  assert.equal(l.decide({ ...AWAY, ...msg("a6") }), "line", "a new run after it starts with the line");
  // a redraw keeps each row's place: the opener stays the opener
  assert.equal(l.decide({ ...AWAY, ...msg("a1") }), "line");
  assert.equal(l.decide({ ...AWAY, ...tool("a2") }), "empty");
});

test("on-fire: an assistant row with an `on fire:` line is shown while away; `on fire: none` is not a fire", () => {
  const l = createLedger();
  assert.equal(l.decide({ ...AWAY, ...msg("f1", "brb: still away (5m, 0 held) — say `back` to read them\n\non fire: main is red since 4bd1e2") }), "show");
  assert.equal(l.decide({ ...AWAY, ...msg("f2", "- **On fire:** prod database is out of disk") }), "show");
  assert.notEqual(l.decide({ ...AWAY, ...msg("f3", "on fire: none\nidle: waiting on Jo") }), "show");
  assert.equal(carriesFire("```\non fire: a quoted log line\n```"), false, "a fire inside a code fence is not one (the Stop hook's rule)");
  assert.equal(carriesFire(undefined), false);
});

test("a fire row in a run: the hidden row after it starts a new run with the line", () => {
  const l = createLedger();
  assert.equal(l.decide({ ...AWAY, ...msg("x1") }), "line");
  assert.equal(l.decide({ ...AWAY, ...msg("x2", "on fire: the deploy key leaked") }), "show");
  assert.equal(l.decide({ ...AWAY, ...tool("x3") }), "line");
});

test("back: every row draws as is; a later hold hides only its own rows, including rows hidden in the last one that never drew again", () => {
  const l = createLedger();
  l.decide({ ...HOME, ...msg("h1") });
  assert.equal(l.decide({ ...AWAY, ...msg("a1") }), "line");
  l.endHold();
  assert.equal(l.held, 0);
  assert.equal(l.decide({ ...HOME, ...msg("a1") }), "show", "home again: the hidden row returns");
  // a row hidden in the first hold that the host did not draw again before the second
  assert.equal(l.decide({ ...AWAY, ...tool("a2") }), "line");
  l.endHold();
  assert.equal(l.decide({ ...AWAY, ...tool("a2") }), "show", "the first hold's rows are the second hold's past");
  assert.equal(l.decide({ ...AWAY, ...msg("b1") }), "line");
});

test("a ToolGroup is hidden only when none of its calls predates the hold", () => {
  const l = createLedger();
  l.noteCall("g1", HOME);
  assert.equal(l.decide({ ...AWAY, ...group("g1", "g2") }), "show", "the group began before brb");
  assert.notEqual(l.decide({ ...AWAY, ...group("g3", "g4") }), "show");
  assert.deepEqual(rowIds("ToolGroup", "g3", { calls: [{ tool_use_id: "g3" }, { tool_use_id: "g4" }] }), ["g3", "g4"]);
});

test("before the first query answers (or after a failed one): every row draws as is and nothing is recorded as the past", () => {
  const l = createLedger();
  assert.equal(l.decide({ known: false, away: false, ...msg("r1") }), "show");
  assert.equal(l.decide({ known: false, away: true, ...msg("r1") }), "show");
  l.noteCall("r2", { known: false, away: false });
  // the query answers: away. Neither row was seen home, so both belong to the hold.
  assert.notEqual(l.decide({ ...AWAY, ...msg("r1") }), "show");
  assert.notEqual(l.decide({ ...AWAY, ...tool("r2") }), "show");
});

test("a row with no id is drawn as is; a site the mod does not hide is drawn as is", () => {
  const l = createLedger();
  assert.equal(l.decide({ ...AWAY, component: "AssistantMessage", requestId: undefined, props: { text: "x" } }), "show");
  assert.equal(l.decide({ ...AWAY, component: "Spinner", requestId: "s", props: {} }), "show");
});

test("at the cap, home: an old row the ledger saw stays shown; once an id cannot be kept, a row it cannot place is shown, never taken for new", () => {
  const l = createLedger();
  assert.equal(l.decide({ ...HOME, ...msg("old") }), "show");
  for (let i = 0; i < ID_CAP; i++) l.noteCall(`c${i}`, HOME);
  assert.equal(l.full, true, "the set was at the cap when the last call came");
  assert.equal(l.decide({ ...AWAY, ...msg("old") }), "show", "the first row seen home is still known");
  assert.equal(l.decide({ ...AWAY, ...tool("c0") }), "show", "the oldest call id is still known");
  assert.equal(l.decide({ ...AWAY, ...tool(`c${ID_CAP - 1}`) }), "show", "an id the ledger could not keep is not taken for new");
  assert.equal(l.decide({ ...AWAY, ...msg("brand-new") }), "show", "full: a row it cannot place is shown");
});

test("at the cap, in a hold: rows already hidden stay hidden; rows past the cap show; after back the next hold hides nothing it cannot place", () => {
  const l = createLedger();
  assert.equal(l.decide({ ...AWAY, ...msg("first-held") }), "line");
  for (let i = 1; i < ID_CAP; i++) l.decide({ ...AWAY, ...msg(`held-${i}`) });
  assert.equal(l.full, false, "exactly at the cap, nothing dropped yet");
  assert.equal(l.decide({ ...AWAY, ...msg("over") }), "show", "the row past the cap shows");
  assert.equal(l.full, true);
  assert.notEqual(l.decide({ ...AWAY, ...msg("first-held") }), "show", "a row this hold already hid stays hidden");
  l.endHold();
  assert.equal(l.decide({ ...AWAY, ...msg("first-held") }), "show", "the last hold's oldest row is past for the next hold");
  assert.equal(l.decide({ ...AWAY, ...msg("next-hold-row") }), "show", "full: nothing it cannot place is hidden");
});

test("the section: the away text appended while away, core's answer as it came home; the cache breaks when the away state changed or the answer asked for it", () => {
  const core = { text: "Working directory: /w" };
  const away = sectionAnswer(core, true, false);
  assert.equal(away.breakPromptCache, true);
  assert.ok(away.text.startsWith("Working directory: /w"));
  assert.ok(away.text.endsWith(AWAY_TEXT));
  assert.deepEqual(sectionAnswer(core, true, true), { text: away.text }, "asked again for another reason: same text, no break");
  assert.deepEqual(sectionAnswer(core, false, true), { text: "Working directory: /w", breakPromptCache: true });
  assert.equal(sectionAnswer(core, false, false), core, "home with no change: the very answer that came");
  assert.equal(sectionAnswer(null, false, false), null, "a section core omits stays omitted home");
  assert.equal(sectionAnswer(null, true, false).text, AWAY_TEXT);
});

test("the section keeps another hook's cache break and every other field, home and away", () => {
  const theirs = { text: "OTHER MOD UPDATED THIS", breakPromptCache: true, extra: 1 };
  assert.deepEqual(sectionAnswer(theirs, false, false), theirs, "home, no change: theirs as is");
  const away = sectionAnswer(theirs, true, true);
  assert.equal(away.breakPromptCache, true, "away, no change of ours: theirs still breaks");
  assert.equal(away.extra, 1);
  assert.ok(away.text.startsWith("OTHER MOD UPDATED THIS"));
  assert.equal(sectionAnswer({ text: "x", breakPromptCache: false }, true, true).breakPromptCache, false, "a false flag is passed on, not raised");
});

test("the away text is fixed: no session id, path or note in it", () => {
  assert.doesNotMatch(AWAY_TEXT, /\/Users\/|\$\{|session/);
  assert.match(AWAY_TEXT, /idle: <why>/);
  assert.match(AWAY_TEXT, /hold/);
});
