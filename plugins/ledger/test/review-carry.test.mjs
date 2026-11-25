// review-carry.test.mjs — 0.4.12: a dismissal carries to the same finding raised again on a
// descendant commit only when every path the finding cites resolves to one tracked path that has
// not changed or been renamed since (lib/review.mjs citedPaths); and every stored lab row's
// verdict and findings text are derived from its items (settle, findingsText).

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./helpers.mjs";
import { repo, git, commit, stub, kimiStub, review, push, decision, denyText, typed, reviewRows, dismissals, openIds } from "./review-helpers.mjs";
import { citedPaths, findingsText, gateDecision, headState, settle, verdictOf } from "../lib/review.mjs";

// Every box this file makes: after each test (before its sandbox is removed), every lab row it
// stored has verdict verdictOf(items) and findings findingsText(items) (A5b).
const boxes = [];
let a5bRows = 0;
afterEach(() => {
  for (const b of boxes.splice(0)) {
    for (const r of reviewRows(b)) {
      if (r.lab === "ledger" || !r.items.length) continue;
      a5bRows++;
      assert.equal(r.verdict, verdictOf(r.items), `row ${r.id} verdict`);
      assert.equal(r.findings, findingsText(r.items) || null, `row ${r.id} findings`);
    }
  }
});
const mk = (review, files) => {
  const b = repo(review, files);
  boxes.push(b);
  return b;
};

/** Review with codex replying `reply`, then type a dismissal of the first open finding; returns its id. */
function reviewAndDismiss(b, reply, disposition = "wrong", env = {}) {
  const codex = stub(b, "codex", reply);
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path, ...env });
  const [id] = openIds(b);
  const t = typed(b, `review dismiss ${id} ${disposition} checked by hand`);
  assert.match(t.message, /ok dismissed /, t.message);
  return { id, codex, sha: git(b, "rev-parse", "HEAD") };
}

const latest = (b, lab = "codex") => reviewRows(b).filter((r) => r.lab === lab).at(-1);

test("carry integration: review with one blocking finding, dismiss it, commit an unrelated file, the lab repeats it; the stored row's verdict is pass, its findings text lists no open item and one dismissed line, the review output says pass and dismissed carried, headState is pass, gateDecision allows the push, and a second dismiss of the id is refused as already dismissed", () => {
  const b = mk();
  const { id, codex, sha } = reviewAndDismiss(b, "1. [blocking] a.txt:1 off by one");
  commit(b, "c.txt", "unrelated\n");
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const row = latest(b);
  assert.equal(row.verdict, "pass");
  assert.equal(row.findings, `dismissed: ${id} (wrong, at ${sha.slice(0, 8)})`);
  assert.equal(row.items[0].id, id);
  assert.match(r.out, /^codex: pass/m);
  assert.ok(r.out.includes(`  dismissed carried: ${id} (codex, wrong, from ${sha.slice(0, 8)})`), r.out);
  const db = openDb(b);
  try {
    const state = headState(db, b.work, git(b, "rev-parse", "HEAD"));
    assert.equal(state.kind, "pass");
    assert.equal(gateDecision(state, "gate").deny, undefined);
  } finally {
    db.close();
  }
  assert.equal(decision(push(b)), "allow");
  assert.match(typed(b, `review dismiss ${id} wrong again`).message, /already dismissed/);
  // identity: the repeat kept the id and raisedAt, and no new cc_dismissals row was written.
  assert.equal(dismissals(b).length, 1);
  assert.equal(row.items[0].raisedAt, reviewRows(b).find((x) => x.lab === "codex").items[0].raisedAt);
});

test("carry integration with two findings, one dismissed: stored verdict findings, findings text lists only the other, the push is denied naming only the other", () => {
  const b = mk();
  const { id, codex } = reviewAndDismiss(b, "1. [blocking] a.txt:1 off by one\n2. [should] b.txt:1 missing check");
  const other = openIds(b).find((x) => x !== id);
  commit(b, "c.txt", "unrelated\n");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const row = latest(b);
  assert.equal(row.verdict, "findings");
  assert.match(row.findings, new RegExp(`^1\\. \\[should\\] ${other}: b\\.txt:1 missing check\\ndismissed: ${id} `));
  const deny = denyText(push(b));
  assert.ok(deny.includes(`${other}: b.txt:1`));
  assert.ok(!deny.includes(`${id}: a.txt:1`));
  assert.ok(deny.includes(`review dismiss ${other} wrong|intentional|doesnt-matter "<your reason>"`));
  assert.ok(!deny.includes(`review dismiss ${id} `));
});

test("carry: a changed cited file reopens and says which", () => {
  const b = mk();
  const { id, codex, sha } = reviewAndDismiss(b, "1. [blocking] a.txt:1 off by one");
  commit(b, "a.txt", "changed\n");
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  assert.ok(r.out.includes(`  codex raised ${id} again (dismissed at ${sha.slice(0, 8)} as wrong); a.txt changed since, so it is open again`), r.out);
  assert.equal(latest(b).verdict, "findings");
  assert.deepEqual(openIds(b), [id]);
});

/** Dismiss the finding `reply` raises, commit `next`, review again: the latest row and the output. */
function again(b, reply, next = ["c.txt", "unrelated\n"]) {
  const { id, codex } = reviewAndDismiss(b, reply);
  commit(b, ...next);
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  return { id, row: latest(b), out: r.out, carried: latest(b).verdict === "pass" };
}

test("carry: a unique cited path unchanged since the dismissal carries", () => {
  assert.equal(again(mk(), "1. [should] b.txt:1 missing check").carried, true);
});

test("carry: a path with a space, unquoted, does not carry", () => {
  const b = mk({}, { "src/my file.ts": "x\n", "lib/file.ts": "y\n" });
  const r = again(b, "1. [should] src/my file.ts:10 the handler swallows errors");
  assert.equal(r.carried, false);
  assert.match(r.out, /does not resolve, so it is open again/);
});

test("carry: the same path quoted or backticked resolves and carries", () => {
  for (const q of ["`", '"']) {
    const b = mk({}, { "src/my file.ts": "x\n", "lib/file.ts": "y\n" });
    assert.equal(again(b, `1. [should] ${q}src/my file.ts${q}:10 the handler swallows errors`).carried, true, q);
  }
});

test("carry: a Unicode path in NFD on one side and NFC on the other resolves and carries; an unresolvable Unicode citation does not", () => {
  const nfc = "docs/café.md";
  const nfd = "docs/café.md";
  const b = mk({}, { [nfc]: "x\n" });
  assert.equal(again(b, `1. [should] ${nfd}:1 the heading is wrong`).carried, true);
  const c = mk({}, { [nfc]: "x\n" });
  assert.equal(again(c, "1. [should] docs/naïve.md:1 the heading is wrong").carried, false);
});

test("carry: an ambiguous abbreviation does not carry", () => {
  const b = mk({}, { "a/util.js": "x\n", "b/util.js": "y\n" });
  const r = again(b, "1. [should] util.js:3 leaks a handle");
  assert.equal(r.carried, false);
  assert.match(r.out, /cites an ambiguous path, so it is open again/);
});

test("carry: a renamed cited file does not carry", () => {
  const b = mk();
  const { id, codex } = reviewAndDismiss(b, "1. [should] b.txt:1 missing check");
  git(b, "mv", "b.txt", "moved.txt");
  git(b, "commit", "-qm", "rename");
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  assert.match(r.out, new RegExp(`codex raised ${id} again .*cites b\\.txt, which was renamed, so it is open again`));
  assert.deepEqual(openIds(b), [id]);
});

test("carry: no citation, or an orphan line number, does not carry", () => {
  const none = again(mk(), "1. [should] the error handling is weak");
  assert.equal(none.carried, false);
  assert.match(none.out, /cites no path that resolves, so it is open again/);
  const orphan = again(mk(), "1. [should] b.txt is fine but see :10 in the parser");
  assert.equal(orphan.carried, false);
  assert.match(orphan.out, /line number on no path that resolves/);
});

test("carry: a git failure does not carry", () => {
  const b = mk();
  const head = git(b, "rev-parse", "HEAD");
  assert.deepEqual(citedPaths(b.work, "0".repeat(40), head, ["b.txt:1 x"]), { ok: false, why: "could not be checked (git failed)" });
  assert.equal(citedPaths(b.work, head, head, ["b.txt:1 x"]).ok, true);
});

test("carry: two cited files, one quoted with a line number and one unquoted with none; changing either reopens, changing neither carries", () => {
  const reply = "1. [should] `a.txt`:1 and b.txt disagree on the format";
  assert.equal(again(mk(), reply).carried, true);
  assert.equal(again(mk(), reply, ["a.txt", "changed\n"]).carried, false);
  assert.equal(again(mk(), reply, ["b.txt", "changed\n"]).carried, false);
});

test("carry: a finding citing a.txt and a quoted extensionless Makefile; changing Makefile reopens, changing neither carries (R5-01)", () => {
  for (const reply of ["1. [should] `a.txt` disagrees with `Makefile`", "1. [should] `a.txt`:1 disagrees with `Makefile:10`", "1. [should] `a.txt` disagrees with `Makefile`:10"]) {
    const files = { Makefile: "all:\n" };
    assert.equal(again(mk({}, files), reply).carried, true, reply);
    const r = again(mk({}, files), reply, ["Makefile", "changed:\n"]);
    assert.equal(r.carried, false, reply);
    assert.match(r.out, /Makefile changed since, so it is open again/, reply);
  }
});

test("carry: a line reference inside a quoted span must resolve; a quoted extensionless name that is not tracked does not count as a path (R5-01)", () => {
  const b = mk({}, { Makefile: "all:\n" });
  const head = git(b, "rev-parse", "HEAD");
  assert.deepEqual(citedPaths(b.work, head, head, ["`a.txt` and `Nowhere:10`"]), { ok: false, why: "cites a path that does not resolve" });
  assert.deepEqual(citedPaths(b.work, head, head, ["`a.txt` and `see foo:3`"]), { ok: false, why: "cites a path that does not resolve" });
  assert.deepEqual(citedPaths(b.work, head, head, ["`a.txt` and `Makefile:10`"]), { ok: true, paths: ["a.txt", "Makefile"] });
  assert.equal(citedPaths(b.work, head, head, ["`a.txt` uses `retry` here"]).ok, true, "a quoted identifier is not a path");
});

test("carry: an unquoted token with a tracked extension that resolves nowhere blocks the carry; a version number does not", () => {
  assert.equal(again(mk(), "1. [should] b.txt:1 and gone.txt disagree").carried, false);
  assert.equal(again(mk(), "1. [should] b.txt:1 breaks since 0.4.12").carried, true);
});

test("carry: another lab's matching finding is not dismissed", () => {
  const b = mk({ labs: ["codex", "kimi"] });
  const reply = "1. [blocking] a.txt:1 off by one";
  const env = { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", reply).path, LEDGER_REVIEW_BIN_KIMI: kimiStub(b, reply).path };
  review(b, [], env);
  const [codexId] = openIds(b, "codex");
  const [kimiId] = openIds(b, "kimi");
  const t = typed(b, `review dismiss ${codexId} wrong checked`);
  assert.ok(t.message.includes(`still open: ${kimiId} (kimi)`), t.message);
  commit(b, "c.txt", "unrelated\n");
  review(b, [], env);
  assert.equal(latest(b, "codex").verdict, "pass");
  assert.equal(latest(b, "kimi").verdict, "findings");
  assert.equal(decision(push(b)), "deny");
});

test("first review, no dismissal history: one blocking finding's fd- id is the same string in findings_json, the review output, review status, the push denial's grouped text and its paste-ready line (A5c)", () => {
  const b = mk();
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] a.txt:1 off by one").path });
  const [id] = openIds(b);
  assert.match(id, /^fd-[a-z0-9]+$/);
  assert.ok(r.out.includes(`1. [blocking] ${id}: a.txt:1 off by one`));
  const status = review(b, ["status"]).out;
  assert.ok(status.includes(`1. [blocking] ${id}: a.txt:1 off by one`));
  assert.ok(status.includes(`  review dismiss ${id} wrong|intentional|doesnt-matter "<your reason>"`), status);
  const deny = denyText(push(b));
  assert.ok(deny.includes(`1. [blocking] ${id}: a.txt:1 off by one`));
  assert.ok(deny.includes(`ask the human to type one of these as their whole prompt, with their own reason:\nreview dismiss ${id} wrong|intentional|doesnt-matter "<your reason>"`), deny);
});

test("findingsText: a multi-line item, a fault-tolerance item, a carried item and a judged-no item render with id, severity, full text and note; a superseding dismiss row re-renders the same notes", () => {
  const items = [
    { id: "fd-1", severity: "blocking", text: "a.txt:1 first line\nsecond line" },
    { id: "fd-2", severity: "should", kind: "fault-tolerance", text: "b.txt:2 fails open silently" },
    { id: "fd-3", severity: "should", text: "c.txt:3 carried", note: "from round 1" },
    { id: "fd-4", severity: "blocking", text: "d.txt:4 judged", judge: "no", note: "from round 1; the judge says it is not resolved" },
  ];
  const text = findingsText(items);
  assert.equal(
    text,
    [
      "1. [blocking] fd-1: a.txt:1 first line",
      "   second line",
      "2. [should] fd-2: fault-tolerance: b.txt:2 fails open silently",
      "3. [should] fd-3: c.txt:3 carried (from round 1)",
      "4. [blocking] fd-4: d.txt:4 judged (from round 1; the judge says it is not resolved)",
    ].join("\n"),
  );
  const marked = items.map((i) => (i.id === "fd-1" ? { ...i, resolved: true, dismissed: { id: "dm-1", disposition: "wrong", by: "Jo", at: "t", sha: "abcdef1234" } } : i));
  const after = findingsText(marked);
  assert.ok(after.includes("2. [should] fd-3: c.txt:3 carried (from round 1)"));
  assert.ok(after.includes("3. [blocking] fd-4: d.txt:4 judged (from round 1; the judge says it is not resolved)"));
  assert.ok(after.endsWith("dismissed: fd-1 (wrong, at abcdef12)"));
});

test("settle: an unavailable row and a pass row keep findings null or unchanged; a row with items and no dismissal keeps its writer's verdict and reason", () => {
  const unavailable = { lab: "codex", verdict: "unavailable", findings: null, items: [], reason: "codex not found" };
  assert.deepEqual(settle(unavailable), unavailable);
  const pass = { lab: "codex", verdict: "pass", findings: null, items: [], reason: null };
  assert.deepEqual(settle(pass), pass);
  const carried = { lab: "codex", verdict: "findings", items: [{ id: "fd-1", severity: "should", text: "x", note: "from round 1" }], reason: "not run this time; its findings from round 1 stay open" };
  const s = settle(carried);
  assert.equal(s.verdict, "findings");
  assert.equal(s.reason, carried.reason);
  assert.equal(s.findings, "1. [should] fd-1: x (from round 1)");
});

test("trace: review, push denied, the human types the paste-ready dismiss line from the denial, the hook's message matches gateDecision, the next push is allowed; with two labs and one still blocking, the message says still open with the other lab's id and the push stays denied", () => {
  const b = mk();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] a.txt:1 off by one").path });
  const deny = denyText(push(b));
  const line = deny.split("\n").find((l) => l.startsWith("review dismiss "));
  const t = typed(b, line.replace('wrong|intentional|doesnt-matter "<your reason>"', 'intentional "kept on purpose"'));
  assert.match(t.message, /the review gate now allows [0-9a-f]{8}/);
  assert.equal(decision(push(b)), "allow");

  const two = mk({ labs: ["codex", "kimi"] });
  review(two, [], { LEDGER_REVIEW_BIN_CODEX: stub(two, "codex", "1. [blocking] a.txt:1 off by one").path, LEDGER_REVIEW_BIN_KIMI: kimiStub(two, "1. [should] b.txt:1 missing check").path });
  const lines = denyText(push(two)).split("\n").filter((l) => l.startsWith("review dismiss "));
  assert.equal(lines.length, 2);
  const [kimiId] = openIds(two, "kimi");
  const t2 = typed(two, lines.find((l) => !l.includes(kimiId)).replace('wrong|intentional|doesnt-matter "<your reason>"', "wrong not a bug"));
  assert.ok(t2.message.includes(`still open: ${kimiId} (kimi)`), t2.message);
  assert.equal(decision(push(two)), "deny");
});

test("dismiss of an id the lab no longer lists on HEAD is refused and points to review status; review status marks the older row superseded", () => {
  const b = mk();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] a.txt:1 off by one").path });
  const [id] = openIds(b);
  // The lab runs again on HEAD and this time lists nothing (a row as a pass-only writer leaves it).
  const db = openDb(b);
  try {
    db.prepare("INSERT INTO cc_reviews (cwd, head_sha, branch, lab, verdict, at) VALUES (?,?,?,?,?,?)").run(b.work, git(b, "rev-parse", "HEAD"), "feat", "codex", "pass", "2026-11-24T00:00:00.000Z");
  } finally {
    db.close();
  }
  assert.match(typed(b, `review dismiss ${id} wrong x`).message, new RegExp(`${id} is no longer listed on [0-9a-f]{8} \\(the lab was run again\\); the current ids are in review status`));
  const status = review(b, ["status"]).out;
  assert.match(status, /codex {3}findings .*\(superseded\)$/m);
  assert.doesNotMatch(status, /codex {3}pass.*\(superseded\)/);
});

test("settle: dismiss's own superseding row of the last blocking finding stores verdict pass and the push is allowed; review status lists the dismissal with its reason", () => {
  const b = mk();
  const { id, sha } = reviewAndDismiss(b, "1. [blocking] a.txt:1 off by one", "doesnt-matter");
  assert.equal(latest(b).verdict, "pass");
  assert.equal(decision(push(b)), "allow");
  assert.ok(review(b, ["status"]).out.includes(`dismissals that apply to ${sha.slice(0, 8)}:\n  ${id} (codex, doesnt-matter, by `));
  assert.match(review(b, ["status"]).out, /at [0-9a-f]{8}\): checked by hand$/m);
});

test("settle: every row stored across the test file has verdict equal to verdictOf(items) and findings equal to findingsText(items) (A5b)", () => {
  // The check itself runs in afterEach; this last test asserts it saw enough rows to mean something.
  assert.ok(a5bRows > 20, `only ${a5bRows} rows checked`);
});
