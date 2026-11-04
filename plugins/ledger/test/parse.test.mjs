import test from "node:test";
import assert from "node:assert/strict";
import { parseLine, tokenize, tokenizeLine, stripComment, editDistance, closestWord, splitFlags, VERBS, VERB_SET, promptApplicable } from "../lib/parse.mjs";
import { isId, isCutShort, newId, prefixOf, PREFIXES } from "../lib/ids.mjs";

// A fixed store view: q-1 offers withdraw, q-2 and q-3 do not; nt-1 exists.
const QUESTIONS = {
  "q-1": { id: "q-1", options: ["approve", "deny", "withdraw"], state: "open" },
  "q-2": { id: "q-2", options: ["approve", "deny"], state: "open" },
  "q-3": { id: "q-3", options: ["extend", "accept", "stop"], state: "open" },
};
const lookup = {
  question: (id) => QUESTIONS[id] ?? null,
  offering: (word) => Object.values(QUESTIONS).filter((q) => q.options.includes(word)).map((q) => q.id),
  optionWords: () => [...new Set(Object.values(QUESTIONS).flatMap((q) => q.options))],
  exists: (id) => id in QUESTIONS || id === "nt-1",
};
const p = (line) => parseLine(line, lookup);

const TABLE = [
  // step 3 accept rows
  ["withdraw q-1", { kind: "command", verb: "answer", id: "q-1", word: "withdraw" }, "#319: the option wins over the verb"],
  ["withdraw q-2", { kind: "command", verb: "withdraw", id: "q-2" }, "no such option → the verb withdraws"],
  ["raise q-3", { kind: "refused" }, "#315 #316 #320: not an option → refused, options listed"],
  ["aprove q-1", { kind: "prose", closest: "approve" }, "#313: near-miss is prose with closest"],
  ["note the window", { kind: "prose", closest: null }, "#197: a sentence starting with a verb is prose"],
  ["approve q-", { kind: "refused" }, "cut-short id is refused, never prose"],
  ["extend q- out of time", { kind: "refused" }, "cut-short id after a verb is refused"],
  ['note "q-"', { kind: "command", verb: "note", textArg: "q-" }, "codex review: a quoted q- is free text, not a cut-short id"],
  ["please explain q-", { kind: "prose", closest: null }, "codex review: a longer line with a cut-short token is prose"],
  ['note "unfinished text', { kind: "refused" }, "codex review: an unterminated quote is refused, nothing written"],
  ["1 approve", { kind: "command", verb: "answer", ordinal: 1, word: "approve" }, "ordinal into pending"],
  ["extend q-2  # more time", { kind: "command", verb: "extend", id: "q-2" }, "trailing comment dropped"],
  ["help", { kind: "command", verb: "help" }, "help"],
  // more shapes
  ["approve q-2", { kind: "command", verb: "answer", id: "q-2", word: "approve" }, "<word> <q-id>"],
  ["APPROVE q-2", { kind: "command", verb: "answer", id: "q-2", word: "approve" }, "case-insensitive word"],
  ["answer q-2 deny", { kind: "command", verb: "answer", id: "q-2", word: "deny" }, "answer spelled out"],
  ["answer deny q-2", { kind: "command", verb: "answer", id: "q-2", word: "deny" }, "answer, word first"],
  ["answer q-2 Purple haze", { kind: "command", verb: "answer", id: "q-2", word: "purple haze", reply: "Purple haze" }, "answer spelled out keeps a multi-word reply as given"],
  ["extend q-3", { kind: "command", verb: "answer", id: "q-3", word: "extend" }, "extend as an option wins over the verb"],
  ["extend q-2", { kind: "command", verb: "extend", id: "q-2" }, "extend as a verb on a question"],
  ['ask "Ship it?" --name ship --options approve,deny --ceiling $40', { kind: "command", verb: "ask", textArg: "Ship it?", flags: { name: "ship", options: "approve,deny", ceiling: "$40" } }, "ask with flags"],
  ['ask "Which colour?" --name colour --options green,red --default green', { kind: "command", verb: "ask", textArg: "Which colour?", flags: { name: "colour", options: "green,red", default: "green" } }, "ask with flags"],
  ['note "use sqlite"', { kind: "command", verb: "note", textArg: "use sqlite" }, "note"],
  ["enable", { kind: "command", verb: "enable" }, "enable"],
  ["disable", { kind: "command", verb: "disable" }, "disable"],
  ["pending", { kind: "command", verb: "pending" }, "pending"],
  ["log", { kind: "command", verb: "log", count: null }, "log default"],
  ["log 3", { kind: "command", verb: "log", count: 3 }, "log N"],
  ["log three", { kind: "prose" }, "log with a non-number is prose"],
  ["config", { kind: "command", verb: "config" }, "config"],
  ["approve", { kind: "refused" }, "bare approve with two questions offering it → refused: which one?"],
  ["stop", { kind: "command", verb: "answer", id: "q-3", word: "stop" }, "bare option word offered by exactly one question"],
  ["accept", { kind: "command", verb: "answer", id: "q-3", word: "accept" }, "bare option word, again"],
  ["extend the deadline please", { kind: "prose", closest: null }, "#197: a sentence starting with a verb is prose"],
  ["thanks, looks good", { kind: "prose", closest: null }, "plain prose"],
  ["pendng", { kind: "prose", closest: "pending" }, "near-miss of a verb"],
  ["acept", { kind: "prose", closest: "accept" }, "near-miss of an option word"],
  ["approve q-9", { kind: "refused" }, "unknown question → refused"],
  ["approve nt-1", { kind: "refused" }, "approve on a note id → refused"],
  ["pending q-1", { kind: "refused" }, "pending does not take an id → refused"],
  ["withdraw", { kind: "refused" }, "withdraw without an id → refused"],
  ["note", { kind: "refused" }, "note without text → refused"],
  ["ask", { kind: "refused" }, "ask without a body → refused"],
  ["# just a comment", { kind: "blank" }, "comment-only line is blank"],
  ["   ", { kind: "blank" }, "whitespace is blank"],
  ["approve q-2  # the colour one", { kind: "command", verb: "answer", id: "q-2", word: "approve" }, "comment after an answer"],
  ["answer q-2", { kind: "refused" }, "answer without a word"],
  ["deny nt-1", { kind: "refused" }, "deny on a note id"],
  ["nt-1 whatever", { kind: "prose" }, "an nt- id first is not a shape"],
  ["extend nt-1", { kind: "refused" }, "an nt- id after a verb → refused (nothing to do with it)"],
  ["approve q-9", { kind: "refused" }, "no such question → refused, never prose"],
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
  assert.deepEqual(tokenize(`note "fix the login" --by 'some one'`), ["note", "fix the login", "--by", "some one"]);
  assert.deepEqual(tokenize(`ask "say \\"hi\\"" --name x`), ["ask", 'say "hi"', "--name", "x"]);
  assert.deepEqual(tokenize(`a ""`), ["a", ""]);
  assert.deepEqual(tokenizeLine(`note "x y" z`), { tokens: ["note", "x y", "z"], quoted: new Set([1]), unterminated: false });
  assert.equal(tokenizeLine(`note "x y`).unterminated, true);
});

test("stripComment keeps # inside quotes and without a leading space", () => {
  assert.equal(stripComment('note "issue #12" # tag'), 'note "issue #12"');
  assert.equal(stripComment("note q-1 fixed#3"), "note q-1 fixed#3");
  assert.equal(stripComment("# all comment"), "");
});

test("codex review: an argv body that looks like an id is text, and an escaped quote does not open a comment", () => {
  assert.equal(parseLine("", lookup, ["note", "q-"]).kind, "command");
  assert.equal(parseLine("", lookup, ["note", "q-1"]).textArg, "q-1");
  assert.equal(parseLine("", lookup, ["ask", "q-1", "--name", "x", "--options", "a,b"]).textArg, "q-1");
  assert.equal(parseLine("", lookup, ["approve", "q-"]).kind, "refused", "an id position is still checked");
  assert.equal(stripComment('note "say \\" # hello"'), 'note "say \\" # hello"');
  assert.equal(p('note "say \\" # hello"').textArg, 'say " # hello');
});

test("argv mode: tokens are taken as given, no re-tokenising", () => {
  const r = parseLine("", lookup, ["note", "fix the login bug"]);
  assert.equal(r.kind, "command");
  assert.equal(r.textArg, "fix the login bug");
  assert.equal(r.text, 'note "fix the login bug"');
  const multi = parseLine("", lookup, ["note", "the", "window"]);
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
  const id = newId("nt", 1_700_000_000_000);
  assert.ok(isId(id), id);
  assert.equal(prefixOf(id), "nt");
  assert.ok(isCutShort("q-"));
  assert.ok(!isCutShort("q-1"));
  assert.ok(!isId("xx-1"));
  assert.ok(!isId("wl-1"), "workload ids are not a shape here");
  assert.deepEqual(Object.values(PREFIXES), ["q", "an", "nt"]);
  assert.equal(newId("q", 1_700_000_000_000).length, "q-".length + 8 + 4);
});

test("#179: the help table and the parser's verb set are the same list", () => {
  assert.deepEqual(new Set(VERBS.map((v) => v.verb)), VERB_SET);
  assert.equal(VERBS.length, 18);
  for (const v of VERBS) assert.ok(v.usage && v.help && ["agent", "human", "either"].includes(v.who), v.verb);
});

test("promptApplicable: id-bearing and read-only commands only; free-text verbs and config never", () => {
  assert.ok(promptApplicable(p("approve q-2")));
  assert.ok(promptApplicable(p("1 approve")));
  assert.ok(promptApplicable(p("pending")));
  assert.ok(promptApplicable(p("extend q-2")));
  assert.ok(promptApplicable(p("log 3")));
  assert.ok(!promptApplicable(p('ask "x" --name x --options a,b')));
  assert.ok(!promptApplicable(p('note "x"')));
  assert.ok(!promptApplicable(p("config")));
  assert.ok(!promptApplicable(p("enable")));
  assert.ok(!promptApplicable(p("disable")));
  assert.ok(!promptApplicable(p("raise q-3")));
});
