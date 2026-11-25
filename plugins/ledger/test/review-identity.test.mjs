import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./helpers.mjs";
import { repo, git, commit, stub, review, push, denyText, reviewRows, judge, judgeCalls } from "./review-helpers.mjs";
import { branchRounds, defaultBase, outstanding } from "../lib/review.mjs";

const FD = /^fd-[a-z0-9]+$/;
const labRows = (b, lab = "codex") => reviewRows(b).filter((r) => r.lab === lab);
const noDuplicateIds = (b) => {
  for (const r of reviewRows(b)) {
    const ids = r.items.map((i) => i.id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, `row ${r.id} holds an id twice: ${ids.join(", ")}`);
  }
};

test("every new finding gets an fd- id and raisedAt once; the same finding re-listed next round keeps both", () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [blocking] a.txt:1 off by one\n2. [should] b.txt:1 missing check");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [first] = labRows(b);
  assert.equal(first.items.length, 2);
  for (const i of first.items) {
    assert.match(i.id, FD);
    assert.equal(i.raisedAt, first.at);
  }
  assert.notEqual(first.items[0].id, first.items[1].id);
  commit(b, "c.txt", "unrelated\n");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const second = labRows(b).at(-1);
  assert.deepEqual(second.items.map((i) => [i.id, i.raisedAt]), first.items.map((i) => [i.id, i.raisedAt]));
  noDuplicateIds(b);
});

test("identity: a judge-resolved finding and a nit raised again later keep their ids; outstanding() still returns neither", () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [blocking] a.txt:1 off by one\n2. [nit] b.txt:1 rename the variable");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [blockingId, nitId] = labRows(b)[0].items.map((i) => i.id);
  commit(b, "a.txt", "fixed\n");
  codex.set("1. [nit] b.txt:1 rename the variable");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path, LEDGER_JUDGE_BIN: judge(b, "yes") });
  const r2 = labRows(b).at(-1);
  assert.equal(r2.items.find((i) => i.text.includes("rename")).id, nitId);
  assert.equal(r2.items.find((i) => i.text.includes("off by one")).id, blockingId);
  const db = openDb(b);
  try {
    const head = git(b, "rev-parse", "HEAD");
    const owed = outstanding(db, b.work, branchRounds(db, b.work, defaultBase(db, b.work, head, "feat"), head), head);
    assert.equal(owed.size, 0);
  } finally {
    db.close();
  }
  commit(b, "c.txt", "more\n");
  codex.set("1. [blocking] a.txt:1 off by one\n2. [nit] b.txt:1 rename the variable");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const r3 = labRows(b).at(-1);
  assert.deepEqual(r3.items.map((i) => i.id), [blockingId, nitId]);
  noDuplicateIds(b);
});

test("identity: nit to identical nit on the next commit keeps the id and raisedAt", () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [nit] b.txt:1 rename the variable");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [nit] = labRows(b)[0].items;
  commit(b, "c.txt", "unrelated\n");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [again] = labRows(b).at(-1).items;
  assert.equal(again.id, nit.id);
  assert.equal(again.raisedAt, nit.raisedAt);
});

test("identity: blocking to nit to blocking with the judge resolving the downgrade keeps one id and raisedAt; the round 2 row holds the id once, with judgedFrom", () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [blocking] a.txt:1 the parser drops the last line");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [orig] = labRows(b)[0].items;
  commit(b, "a.txt", "changed\n");
  codex.set("1. [nit] a.txt:1 the parser drops the last line");
  const yes = judge(b, "yes");
  const two = review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path, LEDGER_JUDGE_BIN: yes });
  // The downgrade goes to the judge exactly as in 0.4.11.
  assert.equal(judgeCalls(yes), 1);
  assert.match(two.out, /^ {2}judge yes: \[blocking\] fd-[a-z0-9]+: a\.txt:1 the parser drops the last line \(round 1\)$/m);
  const r2 = labRows(b).at(-1);
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].id, orig.id);
  assert.equal(r2.items[0].severity, "nit");
  assert.deepEqual(r2.items[0].judgedFrom, { severity: "blocking", judge: "yes" });
  commit(b, "c.txt", "more\n");
  codex.set("1. [blocking] a.txt:1 the parser drops the last line");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [r3] = labRows(b).at(-1).items;
  assert.equal(r3.id, orig.id);
  assert.equal(r3.raisedAt, orig.raisedAt);
  noDuplicateIds(b);
});

test("identity: blocking to nit with the judge saying no keeps the blocking copy under its id and gives the nit a new one; no row holds an id twice", () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [blocking] a.txt:1 the parser drops the last line");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [orig] = labRows(b)[0].items;
  commit(b, "a.txt", "changed\n");
  codex.set("1. [nit] a.txt:1 the parser drops the last line");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path, LEDGER_JUDGE_BIN: judge(b, "no") });
  const r2 = labRows(b).at(-1);
  const blocking = r2.items.find((i) => i.severity === "blocking");
  const nit = r2.items.find((i) => i.severity === "nit");
  assert.equal(blocking.id, orig.id);
  assert.equal(blocking.judge, "no");
  assert.match(nit.id, FD);
  assert.notEqual(nit.id, orig.id);
  assert.match(r2.findings, new RegExp(`\\[blocking\\] ${orig.id}: a\\.txt:1 the parser drops the last line \\(from round 1; the judge says it is not resolved\\)`));
  noDuplicateIds(b);
});

test("two new findings similar to one prior finding: one keeps the id, the other gets a new one, neither vanishes", () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [should] a.txt:1 the loop bound is off by one");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [orig] = labRows(b)[0].items;
  commit(b, "c.txt", "unrelated\n");
  codex.set("1. [should] a.txt:1 the loop bound is off by one\n2. [should] a.txt:1 the loop bound is off by one here too");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const items = labRows(b).at(-1).items;
  assert.equal(items.length, 2);
  assert.equal(items[0].id, orig.id);
  assert.match(items[1].id, FD);
  assert.notEqual(items[1].id, orig.id);
});

test("a pre-0.4.12 finding gets an id when next carried or re-listed, with raisedAt from its first round", () => {
  const b = repo({ labs: ["codex", "kimi"] });
  const first = git(b, "rev-parse", "HEAD");
  const base = git(b, "rev-parse", "main");
  const db = openDb(b);
  try {
    // Two rows as 0.4.11 wrote them: raw reply text, items with no id.
    const ins = db.prepare("INSERT INTO cc_reviews (session_id, cwd, head_sha, base_ref, branch, lab, model, verdict, findings, findings_json, reason, at) VALUES (NULL,?,?,?,'feat',?,NULL,'findings',?,?,NULL,?)");
    ins.run(b.work, first, base, "codex", "1. a.txt:1 legacy codex", JSON.stringify([{ severity: "should", text: "a.txt:1 legacy codex", since: first }]), "2026-11-01T00:00:00.000Z");
    ins.run(b.work, first, base, "kimi", "1. b.txt:1 legacy kimi", JSON.stringify([{ severity: "should", text: "b.txt:1 legacy kimi", since: first }]), "2026-11-01T00:00:01.000Z");
  } finally {
    db.close();
  }
  commit(b, "c.txt", "unrelated\n");
  // codex re-lists its finding; kimi is unavailable, so its finding is carried.
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. a.txt:1 legacy codex").path, LEDGER_REVIEW_BIN_KIMI: "/nonexistent/kimi" });
  const [c] = labRows(b, "codex").at(-1).items;
  const [k] = labRows(b, "kimi").at(-1).items;
  assert.match(c.id, FD);
  assert.equal(c.raisedAt, "2026-11-01T00:00:00.000Z");
  assert.match(k.id, FD);
  assert.equal(k.raisedAt, "2026-11-01T00:00:01.000Z");
});

test("ids appear in review output, review status and the deny text", () => {
  const b = repo();
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] a.txt:1 off by one").path });
  const [item] = labRows(b)[0].items;
  const line = `1. [blocking] ${item.id}: a.txt:1 off by one`;
  assert.ok(r.out.includes(line), r.out);
  assert.ok(review(b, ["status"]).out.includes(line));
  assert.ok(denyText(push(b)).includes(line));
});
