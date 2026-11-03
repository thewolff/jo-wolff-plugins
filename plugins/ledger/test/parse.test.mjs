import test from "node:test";
import assert from "node:assert/strict";
import { parseLine, tokenize, tokenizeLine, stripComment, editDistance, closestWord, splitFlags, VERBS, VERB_SET, promptApplicable } from "../lib/parse.mjs";
import { isId, isCutShort, newId, prefixOf, PREFIXES } from "../lib/ids.mjs";

// A fixed store view: q-1 offers withdraw, q-2 and q-3 do not; wl-1 exists.
const QUESTIONS = {
  "q-1": { id: "q-1", options: ["approve", "deny", "withdraw"], state: "open", workloadStatus: "open" },
  "q-2": { id: "q-2", options: ["approve", "deny"], state: "open", workloadStatus: "open" },
  "q-3": { id: "q-3", options: ["extend", "accept", "stop"], state: "open", workloadStatus: "open" },
};
const lookup = {
  question: (id) => QUESTIONS[id] ?? null,
  offering: (word) => Object.values(QUESTIONS).filter((q) => q.options.includes(word)).map((q) => q.id),
  optionWords: () => [...new Set(Object.values(QUESTIONS).flatMap((q) => q.options))],
  exists: (id) => id in QUESTIONS || id === "wl-1",
};
const p = (line) => parseLine(line, lookup);

const TABLE = [
  // step 3 accept rows
  ["withdraw q-1", { kind: "command", verb: "answer", id: "q-1", word: "withdraw" }, "#319: the option wins over the verb"],
  ["withdraw q-2", { kind: "command", verb: "withdraw", id: "q-2" }, "no such option → the verb withdraws"],
  ["raise q-3", { kind: "refused" }, "#315 #316 #320: not an option → refused, options listed"],
  ["aprove q-1", { kind: "prose", closest: "approve" }, "#313: near-miss is prose with closest"],
  ["open the window", { kind: "prose", closest: null }, "#197: a sentence starting with a verb is prose"],
  ["approve q-", { kind: "refused" }, "cut-short id is refused, never prose"],
  ["close wl- out of time", { kind: "refused" }, "cut-short id after a verb is refused"],
  ['decide "q-"', { kind: "command", verb: "decide", textArg: "q-" }, "codex review: a quoted q- is free text, not a cut-short id"],
  ["please explain q-", { kind: "prose", closest: null }, "codex review: a longer line with a cut-short token is prose"],
  ['open "unfinished title', { kind: "refused" }, "codex review: an unterminated quote is refused, nothing written"],
  ["1 approve", { kind: "command", verb: "answer", ordinal: 1, word: "approve" }, "ordinal into pending"],
  ["ceiling $60 8h wl-1", { kind: "command", verb: "ceiling", id: "wl-1", usd: 60, hours: 8 }, "ceiling with $ and h"],
  ["ceiling 60 wl-1 8", { kind: "command", verb: "ceiling", id: "wl-1", usd: 60, hours: 8 }, "ceiling, plain numbers, id in the middle"],
  ["close wl-1 done because tests pass  # note", { kind: "command", verb: "close", id: "wl-1", reason: "done because tests pass" }, "trailing comment dropped"],
  ["help", { kind: "command", verb: "help" }, "help"],
  // more shapes
  ["approve q-2", { kind: "command", verb: "answer", id: "q-2", word: "approve" }, "<word> <q-id>"],
  ["APPROVE q-2", { kind: "command", verb: "answer", id: "q-2", word: "approve" }, "case-insensitive word"],
  ["answer q-2 deny", { kind: "command", verb: "answer", id: "q-2", word: "deny" }, "answer spelled out"],
  ["answer deny q-2", { kind: "command", verb: "answer", id: "q-2", word: "deny" }, "answer, word first"],
  ["extend q-3", { kind: "command", verb: "answer", id: "q-3", word: "extend" }, "extend as an option wins over the verb"],
  ["extend q-2", { kind: "command", verb: "extend", id: "q-2" }, "extend as a verb on a question"],
  ["extend wl-1", { kind: "command", verb: "extend", id: "wl-1" }, "extend a workload"],
  ["halt wl-1", { kind: "command", verb: "halt", id: "wl-1" }, "halt"],
  ["open wl-1", { kind: "command", verb: "open", id: "wl-1" }, "open resumes by id"],
  ['open "fix the login"', { kind: "command", verb: "open", textArg: "fix the login" }, "open with a quoted title"],
  ['open "fix the login" --stakes production', { kind: "command", verb: "open", textArg: "fix the login", flags: { stakes: "production" } }, "open with a flag"],
  ['ask "Which colour?" --name colour --options green,red --default green', { kind: "command", verb: "ask", textArg: "Which colour?", flags: { name: "colour", options: "green,red", default: "green" } }, "ask with flags"],
  ['decide "use sqlite"', { kind: "command", verb: "decide", textArg: "use sqlite" }, "decide"],
  ["park wl-1 waiting on design", { kind: "command", verb: "park", id: "wl-1", reason: "waiting on design" }, "park with reason"],
  ["close wl-1", { kind: "refused" }, "close needs a reason"],
  ["park wl-1", { kind: "refused" }, "park needs a reason"],
  ["pending", { kind: "command", verb: "pending" }, "pending"],
  ["stale", { kind: "command", verb: "stale", days: null }, "stale default"],
  ["stale 3", { kind: "command", verb: "stale", days: 3 }, "stale N"],
  ["config", { kind: "command", verb: "config" }, "config"],
  ["approve", { kind: "refused" }, "bare approve with two questions offering it → refused: which one?"],
  ["stop", { kind: "command", verb: "answer", id: "q-3", word: "stop" }, "bare option word offered by exactly one question"],
  ["accept", { kind: "command", verb: "answer", id: "q-3", word: "accept" }, "bare option word, again"],
  ["extend the deadline please", { kind: "prose", closest: null }, "#197: a sentence starting with a verb is prose"],
  ["thanks, looks good", { kind: "prose", closest: null }, "plain prose"],
  ["pendng", { kind: "prose", closest: "pending" }, "near-miss of a verb"],
  ["acept", { kind: "prose", closest: "accept" }, "near-miss of an option word"],
  ["approve q-9", { kind: "refused" }, "unknown question → refused"],
  ["approve wl-1", { kind: "refused" }, "approve on a workload id → refused"],
  ["halt q-1", { kind: "refused" }, "halt on a question id → refused"],
  ["withdraw", { kind: "refused" }, "withdraw without an id → refused"],
  ["open", { kind: "refused" }, "open without a title → refused"],
  ["ceiling wl-1", { kind: "refused" }, "ceiling without an amount → refused"],
  ["ceiling 60 q-1", { kind: "refused" }, "ceiling on a question → refused"],
  ["# just a comment", { kind: "blank" }, "comment-only line is blank"],
  ["   ", { kind: "blank" }, "whitespace is blank"],
  ["approve q-2  # the colour one", { kind: "command", verb: "answer", id: "q-2", word: "approve" }, "comment after an answer"],
  ["answer q-2", { kind: "refused" }, "answer without a word"],
  ["deny wl-1", { kind: "refused" }, "deny on a workload id"],
  ["de-1 whatever", { kind: "prose" }, "a de- id first is not a shape"],
  ["note de-1", { kind: "refused" }, "a de- id after a word → refused (nothing to do with it)"],
];

for (const [line, want, why] of TABLE) {
  test(`parse: ${JSON.stringify(line)} → ${want.kind}${want.verb ? ` ${want.verb}` : ""} (${why})`, () => {
    const got = p(line);
    for (const [k, v] of Object.entries(want)) {
      if (k === "flags") assert.deepEqual(got.flags, v, `${k}: ${JSON.stringify(got)}`);
      else assert.equal(got[k], v, `${k}: ${JSON.stringify(got)}`);
    }
  });
}

test("refused `raise q-3` lists the options with withdraw", () => {
  const r = p("raise q-3");
  assert.equal(r.kind, "refused");
  assert.match(r.reason, /options: extend, accept, stop \(or withdraw\)/);
});

test("refused `approve q-` names the cut-short id", () => {
  assert.match(p("approve q-").reason, /id cut short: q-/);
});

test("`withdraw q-1` records the answer even though withdraw is a verb (#319), and a withdraw-less question withdraws", () => {
  assert.deepEqual(p("withdraw q-1"), { kind: "command", text: "withdraw q-1", verb: "answer", id: "q-1", word: "withdraw" });
  assert.deepEqual(p("withdraw q-2"), { kind: "command", text: "withdraw q-2", verb: "withdraw", id: "q-2" });
});

test("tokenize honours quotes and escapes", () => {
  assert.deepEqual(tokenize(`open "fix the login" --stakes 'prod uction'`), ["open", "fix the login", "--stakes", "prod uction"]);
  assert.deepEqual(tokenize(`ask "say \\"hi\\"" --name x`), ["ask", 'say "hi"', "--name", "x"]);
  assert.deepEqual(tokenize(`a ""`), ["a", ""]);
  assert.deepEqual(tokenizeLine(`open "x y" z`), { tokens: ["open", "x y", "z"], quoted: new Set([1]), unterminated: false });
  assert.equal(tokenizeLine(`open "x y`).unterminated, true);
});

test("stripComment keeps # inside quotes and without a leading space", () => {
  assert.equal(stripComment('open "issue #12" # tag'), 'open "issue #12"');
  assert.equal(stripComment("close wl-1 fixed#3"), "close wl-1 fixed#3");
  assert.equal(stripComment("# all comment"), "");
});

test("argv mode: tokens are taken as given, no re-tokenising", () => {
  const r = parseLine("", lookup, ["open", "fix the login bug"]);
  assert.equal(r.kind, "command");
  assert.equal(r.textArg, "fix the login bug");
  assert.equal(r.text, 'open "fix the login bug"');
  const multi = parseLine("", lookup, ["open", "the", "window"]);
  assert.equal(multi.kind, "prose");
});

test("splitFlags: --k v, --k=v, bare --flag, multi-word values", () => {
  assert.deepEqual(splitFlags(["body", "--name", "x", "--allows", "a: one; b: two", "--kind=plan", "--flag"]), {
    flags: { name: "x", allows: "a: one; b: two", kind: "plan", flag: true },
    positional: ["body"],
  });
});

test("editDistance and closestWord", () => {
  assert.equal(editDistance("aprove", "approve"), 1);
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(closestWord("aprove", ["approve", "deny"]), "approve");
  assert.equal(closestWord("approve", ["approve"]), null);
  assert.equal(closestWord("zzzzzz", ["approve"]), null);
});

test("ids: shape, prefix, cut-short", () => {
  const id = newId("wl", 1_700_000_000_000);
  assert.ok(isId(id), id);
  assert.equal(prefixOf(id), "wl");
  assert.ok(isCutShort("q-"));
  assert.ok(!isCutShort("q-1"));
  assert.ok(!isId("xx-1"));
  assert.deepEqual(Object.values(PREFIXES), ["wl", "q", "an", "de", "ce", "se"]);
  assert.equal(newId("q", 1_700_000_000_000).length, "q-".length + 8 + 4);
});

test("#179: the help table and the parser's verb set are the same list", () => {
  assert.deepEqual(new Set(VERBS.map((v) => v.verb)), VERB_SET);
  assert.equal(VERBS.length, 16);
  for (const v of VERBS) assert.ok(v.usage && v.help && ["agent", "human", "either"].includes(v.who), v.verb);
});

test("promptApplicable: id-bearing and read-only commands only; free-text verbs and config never", () => {
  assert.ok(promptApplicable(p("approve q-2")));
  assert.ok(promptApplicable(p("1 approve")));
  assert.ok(promptApplicable(p("pending")));
  assert.ok(promptApplicable(p("close wl-1 done")));
  assert.ok(!promptApplicable(p('open "x"')));
  assert.ok(!promptApplicable(p('decide "x"')));
  assert.ok(!promptApplicable(p("config")));
  assert.ok(!promptApplicable(p("raise q-3")));
});
