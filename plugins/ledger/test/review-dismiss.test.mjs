import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./helpers.mjs";
import { repo, git, commit } from "./review-helpers.mjs";
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
