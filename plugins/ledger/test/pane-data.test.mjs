// pane-data.test.mjs — the pane's pure functions (mods/pane/data.mjs): the /ledger grammar, the
// CLI argv and read-back, the snapshot parser, the fallback line, and selection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PANE_ID, USAGE, answerArgv, answersHeading, byFolder, emptySnapshot, fallbackLine, fingerprint, folderLabels, headline, optionLabel, optionList, parseCommand, readCliResult, readSnapshot, selectQuestion, waitingHeading, withoutIds } from "../mods/pane/data.mjs";
import { cli, sandbox } from "./helpers.mjs";

const Q = (over = {}) => ({ id: "q-mw1a", cwd: "/Users/example/code/a", name: "ship", body: "Ship it?", options: ["approve", "deny"], default: "approve", state: "open", asked_at: "2026-11-04T06:00:00.000Z", age: "3m ago", ...over });
const A = (over = {}) => ({ id: "q-mw1z", name: "colour", body: "Which colour?", state: "answered", word: "green", via: "cli", ...over });

test("parseCommand: open, close, answer, short form, usage", () => {
  assert.deepEqual(parseCommand(""), { kind: "open" });
  assert.deepEqual(parseCommand("  open "), { kind: "open" });
  assert.deepEqual(parseCommand("Close"), { kind: "close" });
  assert.deepEqual(parseCommand("answer q-mw1a approve"), { kind: "answer", id: "q-mw1a", reply: "approve" });
  assert.deepEqual(parseCommand("answer Q-MW1A  use the   left one"), { kind: "answer", id: "q-mw1a", reply: "use the left one" });
  assert.deepEqual(parseCommand("approve q-mw1a"), { kind: "answer", id: "q-mw1a", reply: "approve" });
  assert.equal(parseCommand("answer q-mw1a").kind, "usage");
  assert.match(parseCommand("answer q-mw1a").text, /needs a reply/);
  assert.equal(parseCommand("answer nope yes").kind, "usage");
  assert.deepEqual(parseCommand("whatever"), { kind: "usage", text: USAGE });
  assert.deepEqual(parseCommand(undefined), { kind: "open" });
});

test("answerArgv keeps the reply as one token with its spaces collapsed", () => {
  assert.deepEqual(answerArgv("q-mw1a", "  use   the left "), ["--json", "answer", "q-mw1a", "use the left"]);
});

test("readCliResult: the CLI's JSON array, a plain store line, and nothing", () => {
  const ok = readCliResult({ exitCode: 0, stdout: JSON.stringify([{ line: 1, text: "answer q-1 approve", status: "ok", id: "an-1", message: "an-1 approve → q-1 (ship)" }]), stderr: "" });
  assert.deepEqual(ok, { status: "ok", message: "an-1 approve → q-1 (ship)" });
  const refused = readCliResult({ exitCode: 1, stdout: JSON.stringify([{ status: "refused", id: null, message: "no such question q-9" }]), stderr: "" });
  assert.equal(refused.status, "refused");
  const busy = readCliResult({ exitCode: 2, stdout: "ledger: database busy at /tmp/x.db; nothing applied\n", stderr: "" });
  assert.deepEqual(busy, { status: "error", message: "ledger: database busy at /tmp/x.db; nothing applied" });
  const crash = readCliResult({ exitCode: 1, stdout: "", stderr: "TypeError: boom\n    at x" });
  assert.deepEqual(crash, { status: "error", message: "TypeError: boom" });
  assert.deepEqual(readCliResult({ exitCode: 127, stdout: "", stderr: "" }), { status: "error", message: "ledger exited 127" });
  assert.equal(readCliResult({ exitCode: 0, stdout: "[]", stderr: "" }).status, "error");
});

test("readSnapshot: a good snapshot, a failed one, garbage, and mis-shaped rows", () => {
  const good = readSnapshot(JSON.stringify({ ok: true, since: "2026-11-04T06:00:00.000Z", elsewhere: [Q()], answers: [A()] }));
  assert.equal(good.ok, true);
  assert.equal(good.since, "2026-11-04T06:00:00.000Z");
  assert.deepEqual(good.elsewhere, [Q()]);
  assert.deepEqual(good.answers, [A()]);
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: false, error: "database busy" })), { ok: false, error: "database busy" });
  assert.deepEqual(readSnapshot("not json"), { ok: false, error: "query printed no JSON" });
  assert.deepEqual(readSnapshot(""), { ok: false, error: "query printed no JSON" });
  assert.deepEqual(readSnapshot("null"), { ok: false, error: "query printed no object" });
  const shaped = readSnapshot(JSON.stringify({ ok: true, elsewhere: [{ id: "q-1", options: "x", state: "weird" }, { nope: 1 }, null], answers: [{ id: "q-2" }, 5] }));
  assert.equal(shaped.ok, true);
  assert.equal(shaped.since, null);
  assert.deepEqual(shaped.elsewhere, [{ id: "q-1", cwd: "", name: "q-1", body: "", options: [], default: null, state: "open", asked_at: null, age: "" }]);
  assert.deepEqual(shaped.answers, [{ id: "q-2", name: "q-2", body: "", state: "answered", word: "", via: "" }]);
});

test("headline counts questions, folders and answers; names the error", () => {
  assert.equal(headline(emptySnapshot()), "nothing waiting elsewhere, no new answers");
  assert.equal(headline({ ok: true, since: null, elsewhere: [Q(), Q({ id: "q-2", cwd: "/Users/example/code/b" })], answers: [] }), "2 questions waiting in 2 other folders");
  assert.equal(headline({ ok: true, since: null, elsewhere: [Q()], answers: [A()] }), "1 question waiting in 1 other folder · 1 answer since your last turn");
  assert.equal(headline({ ok: false, error: "database busy" }), "ledger: database busy");
});

test("fallbackLine: null when nothing waits; otherwise every item and the command; the error when the query failed", () => {
  assert.equal(fallbackLine(emptySnapshot()), null);
  const text = fallbackLine({ ok: true, since: null, elsewhere: [Q(), Q({ id: "q-h", state: "held", options: [] })], answers: [A(), A({ id: "q-w", name: "wd", state: "withdrawn", word: "withdraw", via: "prompt-hook" })] });
  const lines = text.split("\n");
  assert.deepEqual(lines, [
    "answered since your last turn: colour → green (via cli)",
    "answered since your last turn: wd withdrawn (via prompt-hook)",
    "open q-mw1a in /Users/example/code/a: Ship it? · approve (default) · deny",
    "held q-h in /Users/example/code/a: Ship it?",
    "answer with /ledger answer <q-id> <reply>, or /ledger to open the pane",
  ]);
  assert.equal(fallbackLine({ ok: false, error: "database busy" }), "ledger pane: database busy");
});

test("optionList marks the default", () => {
  assert.equal(optionList(Q()), "approve (default) · deny");
  assert.equal(optionList(Q({ default: null })), "approve · deny");
});

test("optionLabel marks the default option only", () => {
  assert.equal(optionLabel(Q(), "approve"), "approve · default");
  assert.equal(optionLabel(Q(), "deny"), "deny");
  assert.equal(optionLabel(Q({ default: null }), "approve"), "approve");
});

test("the pane's headings lead with the count and say one folder or several", () => {
  const one = { ok: true, since: null, elsewhere: [Q(), Q({ id: "q-2" })], answers: [A()] };
  const two = { ...one, elsewhere: [Q(), Q({ id: "q-2", cwd: "/Users/example/code/b" })], answers: [A(), A({ id: "q-3" })] };
  assert.match(waitingHeading(one), /^2 questions .*another folder$/);
  assert.match(waitingHeading(two), /^2 questions .*other folders$/);
  assert.match(waitingHeading({ ...one, elsewhere: [Q()] }), /^1 question /);
  assert.match(answersHeading(one), /^1 answer /);
  assert.match(answersHeading(two), /^2 answers /);
});

test("folderLabels: the last path segment, longer only where two folders share it", () => {
  assert.deepEqual(folderLabels(["/Users/example/code/newdle-mobile", "/Users/example/code/newdle-api"]), ["newdle-mobile", "newdle-api"]);
  assert.deepEqual(folderLabels(["/x/a/web", "/x/b/web", "/x/api"]), ["a/web", "b/web", "api"]);
  assert.deepEqual(folderLabels(["/a/web", "/web"]), ["a/web", "web"]);
  assert.deepEqual(folderLabels(["C:\\code\\site", "/home/site"]), ["code/site", "home/site"]);
  assert.deepEqual(folderLabels(["", "/"]), ["(no folder)", "(no folder)"]);
});

test("withoutIds: every refusal the real CLI gives the pane's own answer argv reads as a sentence with no id in it", () => {
  const box = sandbox();
  // The pane runs `--json answer <q-id> <reply>` (answerArgv) and reads it back with readCliResult.
  const record = (id, reply) => readCliResult({ exitCode: 0, stdout: cli(box, answerArgv(id, reply), { env: { LEDGER_SESSION_ID: "s-pane" } }).out });
  const ask = (name) => /q-[a-z0-9]+/.exec(cli(box, ["ask", `Which ${name}?`, "--name", `${name} (the (nested) one)`, "--options", "green,red", "--default", "green"]).out)[0];
  const answered = ask("colour");
  assert.equal(record(answered, "use q- here").status, "ok");
  const withdrawn = ask("size");
  assert.equal(record(withdrawn, "withdraw").status, "ok");
  const open = ask("shape");
  const cases = [
    ["answered, another reply", record(answered, "red"), /^Already answered with use q- here; an answer is final$/],
    ["answered, withdraw", record(answered, "withdraw"), /^Already answered with use q- here; .*cannot be withdrawn$/],
    ["withdrawn", record(withdrawn, "red"), /withdrawn/i],
    ["no such question", record("q-mvr3k2p9a1xq", "red"), /no longer|not in the ledger/i],
    ["too long", record(open, "x".repeat(201)), /200 characters/],
    ...["q-", "an-", "nt-"].map((cut) => [`cut short ${cut}`, record(open, cut), /nothing (was )?recorded/i]),
  ];
  const ID_TEXT = /\b(?:q|an|nt)-(?:[a-z0-9]{4,}\b|(?![a-z0-9]))/;
  for (const [label, result, meaning] of cases) {
    assert.equal(result.status, "refused", `${label}: ${result.message}`);
    const shown = withoutIds(result.message);
    // The reply the human typed ("use q- here") is their text and stays; only the CLI's ids go.
    assert.doesNotMatch(shown.replace("use q- here", ""), ID_TEXT, `${label}: ${shown}`);
    assert.doesNotMatch(shown, /\(\s*\)|<q-id>|\bid looks like\b|\(the \(nested\) one\)|nested/, `${label}: ${shown}`);
    assert.match(shown, meaning, `${label}: ${shown}`);
    assert.match(shown, /^[A-Z]/, `${label}: ${shown}`);
  }
});

test("withoutIds: a message in no known shape loses its ids and keeps its words", () => {
  assert.equal(withoutIds("ledger: database busy at /tmp/x/ledger.db; nothing applied"), "Ledger: database busy at /tmp/x/ledger.db; nothing applied");
  const shown = withoutIds("q-mw1a is closed (an-mw9z9z9z); see nt-mw8y8y8y and q- too");
  assert.doesNotMatch(shown, /\b(?:q|an|nt)-|\(\s*\)/);
  assert.match(shown, /is closed/);
  assert.equal(withoutIds(undefined), "");
});

test("selectQuestion keeps a listed selection, else the first open one, else the first held, else null", () => {
  const snap = { ok: true, since: null, elsewhere: [Q({ id: "q-h", state: "held" }), Q({ id: "q-o1" }), Q({ id: "q-o2" })], answers: [] };
  assert.equal(selectQuestion(snap, "q-o2"), "q-o2");
  assert.equal(selectQuestion(snap, "q-gone"), "q-o1");
  assert.equal(selectQuestion(snap, null), "q-o1");
  assert.equal(selectQuestion({ ...snap, elsewhere: [Q({ id: "q-h", state: "held" })] }, null), "q-h");
  assert.equal(selectQuestion(emptySnapshot(), "q-o1"), null);
  assert.equal(selectQuestion({ ok: false, error: "x" }, "q-o1"), null);
});

test("byFolder groups consecutive questions by folder", () => {
  const snap = { ok: true, since: null, elsewhere: [Q({ id: "q-1", cwd: "/a" }), Q({ id: "q-2", cwd: "/a" }), Q({ id: "q-3", cwd: "/b" })], answers: [] };
  assert.deepEqual(byFolder(snap).map((g) => [g.cwd, g.questions.map((q) => q.id)]), [["/a", ["q-1", "q-2"]], ["/b", ["q-3"]]]);
});

test("fingerprint differs when the data differs and the pane id is stable", () => {
  assert.notEqual(fingerprint(emptySnapshot()), fingerprint({ ok: true, since: null, elsewhere: [Q()], answers: [] }));
  assert.equal(fingerprint(emptySnapshot()), fingerprint(emptySnapshot()));
  assert.equal(PANE_ID, "ledger");
});
