import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cli, hook, openDb } from "./helpers.mjs";
import { repo, git, commit, stub, review, push, decision, denyText, typed, reviewRows, dismissals, openIds, judge, SID } from "./review-helpers.mjs";
import { branchRounds, headState, outstanding, publishLabRow } from "../lib/review.mjs";

const insert = (db, r) =>
  db
    .prepare("INSERT INTO cc_reviews (session_id, cwd, head_sha, base_ref, branch, lab, model, verdict, findings, findings_json, reason, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(null, r.cwd, r.head, r.base ?? null, "feat", r.lab, null, r.verdict, r.findings ?? null, r.items ? JSON.stringify(r.items) : null, r.reason ?? null, r.at);

test("ordering: headState, outstanding and branchRounds pick the highest id when at runs backwards", () => {
  const b = repo();
  const top = b.work;
  const head = git(b, "rev-parse", "HEAD");
  const base = git(b, "rev-parse", "main");
  const db = openDb(b);
  try {
    // The later-published row carries the earlier timestamp: insertion order is publication order.
    insert(db, { cwd: top, head, base, lab: "codex", verdict: "pass", at: "2026-11-24T10:00:05.000Z" });
    insert(db, { cwd: top, head, base, lab: "codex", verdict: "findings", findings: "1. [blocking] x", items: [{ id: "fd-1", severity: "blocking", text: "x" }], at: "2026-11-24T10:00:01.000Z" });
    const s = headState(db, top, head);
    assert.equal(s.kind, "findings");
    assert.equal(s.labRows[0].verdict, "findings");
    const rounds = branchRounds(db, top, base, head);
    assert.deepEqual(rounds[0].rows.map((r) => r.verdict), ["pass", "findings"]);
    const owed = outstanding(db, top, rounds, head);
    assert.deepEqual(owed.get("codex").items.map((i) => i.id), ["fd-1"]);
    // An addressed row published after a findings row with a later `at` still counts as after it.
    const next = commit(b, "c.txt", "three\n");
    insert(db, { cwd: top, head: next, base, lab: "codex", verdict: "findings", items: [{ id: "fd-2", severity: "should", text: "y" }], at: "2026-11-24T10:00:09.000Z" });
    insert(db, { cwd: top, head: next, base, lab: "ledger", verdict: "addressed", reason: "r", at: "2026-11-24T10:00:02.000Z" });
    assert.equal(headState(db, top, next).kind, "addressed");
  } finally {
    db.close();
  }
});

test("publishLabRow reconciles: a dismissal on the same sha marks the item, re-derives the verdict, and returns the stored row", () => {
  const b = repo();
  const top = b.work;
  const head = git(b, "rev-parse", "HEAD");
  const db = openDb(b);
  try {
    db.prepare("INSERT INTO cc_dismissals (id, finding_id, review_id, cwd, head_sha, branch, lab, severity, text, disposition, reason, by, via, session_id, prompt_id, at) VALUES ('dm-1','fd-a',NULL,?,?,'feat','codex','blocking','a.txt:1 off by one','wrong','the lab misread it','jo','prompt-hook',NULL,NULL,'2026-11-24T10:00:00.000Z')").run(top, head);
    const items = [
      { id: "fd-a", severity: "blocking", text: "a.txt:1 off by one" },
      { id: "fd-b", severity: "nit", text: "b.txt:1 rename" },
    ];
    for (const lab of ["codex", "kimi"]) {
      const out = publishLabRow(db, b.dbPath, { cwd: top, head, branch: "feat", lab, verdict: "findings", items, reason: "from round 1", at: "2026-11-24T10:00:01.000Z" });
      const stored = { ...db.prepare("SELECT * FROM cc_reviews WHERE id = ?").get(out.id) };
      assert.equal(stored.verdict, out.verdict);
      assert.equal(stored.findings, out.findings);
      if (lab === "codex") {
        assert.equal(out.verdict, "pass-with-nits");
        assert.equal(out.reason, "from round 1; 1 dismissed");
        assert.equal(out.findings, "1. [nit] fd-b: b.txt:1 rename\ndismissed: fd-a (wrong, at " + head.slice(0, 8) + ")");
      } else {
        // Another lab's finding with the same id is not dismissed.
        assert.equal(out.verdict, "findings");
        assert.equal(out.reason, "from round 1");
      }
    }
    // A row with no items keeps its findings as given.
    const pass = publishLabRow(db, b.dbPath, { cwd: top, head, lab: "codex", verdict: "unavailable", findings: null, items: [], reason: "codex not found", at: "2026-11-24T10:00:02.000Z" });
    assert.equal(pass.findings, null);
    assert.equal(pass.verdict, "unavailable");
  } finally {
    db.close();
  }
});

// ---- The typed-prompt channel and the CLI refusal (T3) ----

/** sha256 of the database file and its -wal and -shm companions, for "nothing was written". */
function storeBytes(b) {
  return ["", "-wal", "-shm"].map((s) => (existsSync(b.dbPath + s) ? createHash("sha256").update(readFileSync(b.dbPath + s)).digest("hex") : "absent")).join(" ");
}

/** A repo whose codex review left `findings` blocking findings on HEAD; returns the box and their ids. */
function reviewed(findings = ["a.txt:1 off by one"]) {
  const b = repo();
  const reply = findings.map((f, i) => `${i + 1}. [blocking] ${f}`).join("\n");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", reply).path });
  return { b, ids: openIds(b) };
}

test("dismiss from the CLI is refused before the store opens: argv, stdin, --by human; exit 1 and the database bytes unchanged", () => {
  const { b, ids } = reviewed();
  const before = storeBytes(b);
  for (const [args, input] of [
    [["review", "dismiss", ids[0], "wrong", "the line is right"], null],
    [["--by", "human", "review", "dismiss", ids[0], "wrong", "the line is right"], null],
    [[], `review dismiss ${ids[0]} wrong the line is right\n`],
  ]) {
    const r = cli(b, args, { input, env: { LEDGER_SESSION_ID: SID } });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, input ? /^1: refused review dismiss is the human's: / : /^refused review dismiss is the human's: /);
    assert.ok(r.out.includes(`review dismiss ${ids[0]} wrong "<their reason>"`), r.out);
    assert.match(r.out, /in a Claude Code session/);
    assert.match(r.out, /nothing recorded \(needs hooks\.userPromptCommands on\)/);
    if (input) assert.match(r.out, /^applied 0, refused 1, not commands 0$/m);
  }
  assert.equal(storeBytes(b), before);
  assert.deepEqual(dismissals(b), []);
});

test("dismiss from the CLI with an inaccessible store and with a read-only store that needs migration: exit 1 and the refusal, never exit 2", () => {
  const b = repo();
  const locked = join(b.root, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const r = cli(b, ["review", "dismiss", "fd-abc", "wrong", "x"], { env: { LEDGER_DB: join(locked, "ledger.db") } });
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /^refused review dismiss is the human's/);
  } finally {
    chmodSync(locked, 0o755);
  }
  const old = join(b.root, "old.db");
  const db = new DatabaseSync(old);
  db.exec("PRAGMA user_version = 11");
  db.close();
  chmodSync(old, 0o444);
  const r = cli(b, ["review", "dismiss", "fd-abc", "wrong", "x"], { env: { LEDGER_DB: old } });
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /^refused review dismiss is the human's/);
});

test("a stdin batch mixing a dismiss line with pending: pending applies as before, the dismiss line is refused", () => {
  const { b, ids } = reviewed();
  const r = cli(b, [], { input: `pending\nreview dismiss ${ids[0]} wrong the line is right\n`, env: { LEDGER_SESSION_ID: SID } });
  assert.equal(r.code, 1);
  assert.match(r.out, /^1: ok\n/);
  assert.match(r.out, /^2: refused review dismiss is the human's: /m);
  assert.match(r.out, /^applied 1, refused 1, not commands 0$/m);
  assert.deepEqual(dismissals(b), []);
});

test("dismiss typed as the whole prompt clears one finding: a cc_dismissals row via prompt-hook and a superseding row built from the latest row", () => {
  const { b, ids } = reviewed();
  const head = git(b, "rev-parse", "HEAD");
  const latest = reviewRows(b).at(-1);
  const t = typed(b, `review dismiss ${ids[0]} wrong the off by one is intended`);
  assert.ok(t.message.includes(`ok dismissed ${ids[0]} (codex, wrong) on ${head.slice(0, 8)} in ${b.work}: the off by one is intended`), t.message);
  const [d] = dismissals(b);
  assert.match(d.id, /^dm-[a-z0-9]+$/);
  assert.deepEqual(
    { finding: d.finding_id, review: d.review_id, sha: d.head_sha, lab: d.lab, severity: d.severity, disposition: d.disposition, reason: d.reason, via: d.via, session: d.session_id },
    { finding: ids[0], review: latest.id, sha: head, lab: "codex", severity: "blocking", disposition: "wrong", reason: "the off by one is intended", via: "prompt-hook", session: "s-typed" },
  );
  const row = reviewRows(b).at(-1);
  assert.ok(row.id > latest.id);
  assert.equal(row.verdict, "pass");
  assert.equal(row.items[0].dismissed.id, d.id);
  assert.equal(row.items[0].resolved, true);
  assert.equal(row.findings, `dismissed: ${ids[0]} (wrong, at ${head.slice(0, 8)})`);
});

test("dismissing the last blocking finding opens the push gate; dismissing one of two keeps it shut and names the other", () => {
  const { b, ids } = reviewed(["a.txt:1 off by one", "b.txt:1 missing check"]);
  assert.equal(decision(push(b)), "deny");
  const one = typed(b, `review dismiss ${ids[0]} intentional kept on purpose`);
  assert.match(one.message, new RegExp(`still open: ${ids[1]} \\(codex\\)`));
  assert.equal(decision(push(b)), "deny");
  assert.ok(!denyText(push(b)).includes(`${ids[0]}: a.txt:1`), "the dismissed finding is not listed as open");
  const two = typed(b, `review dismiss ${ids[1]} doesnt-matter not reachable`);
  assert.match(two.message, /the review gate now allows [0-9a-f]{8}/);
  assert.equal(decision(push(b)), "allow");
});

test("dismiss refusals: unknown id, older sha, already dismissed, already resolved, legacy item, bad disposition, empty or placeholder reason, reason over 1000 characters", () => {
  const { b, ids } = reviewed(["a.txt:1 off by one", "b.txt:1 missing check"]);
  const refusal = (line) => {
    const t = typed(b, line);
    assert.match(t.message, /^1: refused /m, t.message);
    return t.message;
  };
  const rowsBefore = reviewRows(b).length;
  assert.match(refusal("review dismiss fd-nope wrong x"), /refused no finding fd-nope/);
  assert.match(refusal(`review dismiss ${ids[0]} maybe x`), /disposition is one of wrong, intentional, doesnt-matter/);
  assert.match(refusal(`review dismiss ${ids[0]} wrong`), /needs the reason/);
  assert.match(refusal(`review dismiss ${ids[0]} wrong "<your reason>"`), /not the placeholder <your reason>/);
  assert.match(refusal(`review dismiss ${ids[0]} wrong --help`), /reads as a flag/);
  assert.match(refusal(`review dismiss ${ids[0]} wrong ${"x".repeat(1001)}`), /1001 characters; at most 1000/);
  assert.match(refusal("review dismiss"), /usage: review dismiss <fd-id>/);
  assert.equal(reviewRows(b).length, rowsBefore);
  assert.deepEqual(dismissals(b), []);
  // Already dismissed.
  typed(b, `review dismiss ${ids[0]} wrong fine`);
  assert.match(refusal(`review dismiss ${ids[0]} wrong again`), /already dismissed \(wrong, by /);
  // An older sha: HEAD moved and nothing reviewed it.
  const old = git(b, "rev-parse", "HEAD");
  const now = commit(b, "c.txt", "more\n");
  assert.match(refusal(`review dismiss ${ids[1]} wrong x`), new RegExp(`${ids[1]} is on ${old.slice(0, 8)}, and .* is at ${now.slice(0, 8)} now; run review, then dismiss`));
  assert.equal(dismissals(b).length, 1);
});

test("dismiss refusals: a finding the judge already resolved, and a legacy item with no id", () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [blocking] a.txt:1 off by one\n2. [nit] b.txt:1 rename it");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [blockingId] = openIds(b);
  commit(b, "a.txt", "fixed\n");
  codex.set("1. [nit] b.txt:1 rename it");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path, LEDGER_JUDGE_BIN: judge(b, "yes") });
  assert.equal(reviewRows(b).at(-1).items.find((i) => i.id === blockingId).resolved, true);
  assert.match(typed(b, `review dismiss ${blockingId} wrong x`).message, /already resolved/);
  // A 0.4.11 row: its item has no id, so there is no id to type; the refusal says review gives it one.
  const db = openDb(b);
  try {
    db.prepare("INSERT INTO cc_reviews (cwd, head_sha, branch, lab, verdict, findings, findings_json, at) VALUES (?,?,?,?,?,?,?,?)").run(b.work, git(b, "rev-parse", "HEAD"), "feat", "kimi", "findings", "1. legacy", JSON.stringify([{ severity: "should", text: "legacy" }]), "2026-11-01T00:00:00.000Z");
  } finally {
    db.close();
  }
  assert.match(typed(b, "review dismiss fd-legacy wrong x").message, /no finding fd-legacy .*gets its id when review runs again/);
  assert.deepEqual(dismissals(b), []);
});

test("a dismiss line mixed with prose applies nothing and the hook says to type it alone", () => {
  const { b, ids } = reviewed();
  const t = typed(b, `please record this for me\nreview dismiss ${ids[0]} wrong the line is right`);
  assert.equal(t.message, "ledger: the review dismiss line was not applied: a prompt applies ledger lines only when every line is one; type it on its own");
  assert.deepEqual(dismissals(b), []);
  // With no session id and no store, the hook still says so.
  const fresh = repo();
  const r = hook(fresh, "user-prompt", { cwd: fresh.work, hook_event_name: "UserPromptSubmit", prompt: "thanks\nreview waive ship it" });
  assert.equal(r.json.systemMessage, "ledger: the review waive line was not applied: a prompt applies ledger lines only when every line is one; type it on its own");
});
