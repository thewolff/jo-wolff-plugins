import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cli, hook, openDb } from "./helpers.mjs";
import { repo, git, commit, stub, review, push, decision, denyText, typed, reviewRows, dismissals, openIds, judge, SID } from "./review-helpers.mjs";
import { branchRounds, dismiss, headState, outstanding, publishLabRow } from "../lib/review.mjs";
import { openStore } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";

const HOOK_PATH = new URL("../hooks/user-prompt.mjs", import.meta.url).pathname;

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

test("a stdin batch mixing a dismiss line with pending is refused whole before the store opens: nothing applied, the dismiss line says to type it as a prompt", () => {
  const { b, ids } = reviewed();
  const before = storeBytes(b);
  const r = cli(b, [], { input: `pending\nreview dismiss ${ids[0]} wrong the line is right\n`, env: { LEDGER_SESSION_ID: SID } });
  assert.equal(r.code, 1);
  assert.match(r.out, /^1: refused not applied: line 2 \(review dismiss\/waive\) is the human's/m);
  assert.match(r.out, /^2: refused review dismiss is the human's: .*as their whole prompt in a Claude Code session/m);
  assert.match(r.out, /^applied 0, refused 2, not commands 0$/m);
  assert.equal(storeBytes(b), before);
  assert.deepEqual(dismissals(b), []);
});

test("a mixed stdin batch with review waive against a state with no database: exit 1, no database file created, nothing applied", () => {
  const b = repo();
  const fresh = join(b.root, "fresh", "ledger.db");
  mkdirSync(join(b.root, "fresh"));
  for (const input of ["pending\nreview waive prototype\n", "note hello\nreview dismiss fd-abc wrong x\n\n"]) {
    const r = cli(b, [], { input, env: { LEDGER_DB: fresh, LEDGER_SESSION_ID: SID } });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /is the human's: ask them to type this as their whole prompt/);
    assert.match(r.out, /^applied 0, refused 2, not commands 0$/m);
    for (const s of ["", "-wal", "-shm"]) assert.equal(existsSync(fresh + s), false, `${fresh}${s} for ${JSON.stringify(input)}`);
  }
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

test("migration path: a pre-0.4.12 finding with no id, a rejected review addressed claim, then the human dismisses the resulting HEAD finding by its new id (R5-02)", () => {
  const b = repo();
  const top = b.work;
  const legacySha = git(b, "rev-parse", "HEAD");
  const legacyAt = "2026-11-01T00:00:00.000Z";
  const db = openDb(b);
  try {
    insert(db, { cwd: top, head: legacySha, base: git(b, "rev-parse", "main"), lab: "codex", verdict: "findings", findings: "1. [blocking] b.txt:1 off by one", items: [{ severity: "blocking", text: "b.txt:1 off by one" }], at: legacyAt });
  } finally {
    db.close();
  }
  const head = commit(b, "c.txt", "attempted fix\n");
  const r = review(b, ["addressed", "fixed in c.txt"], { LEDGER_JUDGE_BIN: judge(b, "no") });
  assert.equal(r.code, 1, r.out);
  const row = reviewRows(b).filter((x) => x.lab === "codex").at(-1);
  assert.equal(row.head_sha, head);
  assert.equal(row.items.length, 1);
  assert.match(row.items[0].id ?? "", /^fd-/, JSON.stringify(row.items));
  assert.equal(row.items[0].raisedAt, legacyAt, "a legacy finding's raisedAt is its first round's");
  const [id] = openIds(b);
  const denied = push(b);
  assert.equal(decision(denied), "deny");
  assert.ok(denyText(denied).includes(`review dismiss ${id} wrong|intentional|doesnt-matter`), denyText(denied));
  assert.match(typed(b, `review dismiss ${id} intentional kept on purpose`).message, /ok dismissed /);
  assert.equal(dismissals(b).length, 1);
  assert.equal(decision(push(b)), "allow");
});

test("review addressed rejected: a finding that already has an id keeps it (R5-02)", () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [blocking] b.txt:1 off by one");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [id] = openIds(b);
  const raisedAt = reviewRows(b).at(-1).items[0].raisedAt;
  commit(b, "c.txt", "attempted fix\n");
  assert.equal(review(b, ["addressed", "fixed in c.txt"], { LEDGER_JUDGE_BIN: judge(b, "no") }).code, 1);
  const items = reviewRows(b).filter((x) => x.lab === "codex").at(-1).items;
  assert.deepEqual(items.map((i) => [i.id, i.raisedAt]), [[id, raisedAt]]);
});

test("prompt_id: a typed dismiss stores the hook input's prompt_id exactly, and null when the input has none (R5-03)", () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [blocking] a.txt:1 off by one\n2. [should] b.txt:1 missing check");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [first, second] = openIds(b);
  const promptId = "pr-7f3c1e2a-known";
  const r = hook(b, "user-prompt", { session_id: "s-typed", prompt_id: promptId, cwd: b.work, hook_event_name: "UserPromptSubmit", prompt: `review dismiss ${first} wrong checked by hand` });
  assert.match(r.json?.systemMessage ?? "", /ok dismissed /);
  assert.match(typed(b, `review dismiss ${second} wrong checked by hand`).message, /ok dismissed /);
  assert.deepEqual(dismissals(b).map((d) => [d.finding_id, d.prompt_id]).sort(), [[first, promptId], [second, null]].sort());
});

test("two similar prior findings, the reply lists only the first: the second goes to the judge, and dismissing the first leaves the gate held on the second (REV-01)", () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [blocking] a.txt:1 the first branch drops the error\n2. [blocking] a.txt:1 the second branch drops the error");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path });
  const [first, second] = openIds(b);
  commit(b, "c.txt", "unrelated\n");
  codex.set("1. [blocking] a.txt:1 the first branch drops the error");
  const no = judge(b, "no");
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path, LEDGER_JUDGE_BIN: no });
  assert.ok(r.out.includes(`judge no: `) && r.out.includes("second branch"), r.out);
  assert.deepEqual(openIds(b).sort(), [first, second].sort());
  assert.match(typed(b, `review dismiss ${first} wrong checked by hand`).message, new RegExp(`still open: ${second}`));
  assert.equal(decision(push(b)), "deny");
});

test("a reply item that repeats one of two similar owed findings takes id, raisedAt, since and receipt from that same owed item (REV-02)", () => {
  const b = repo();
  const top = b.work;
  const h1 = git(b, "rev-parse", "HEAD");
  const h2 = commit(b, "c.txt", "three\n");
  const A = { id: "fd-aaaa", severity: "blocking", text: "b.txt:1 the parser drops the last line", since: h1, receipt: "a".repeat(64), raisedAt: "2026-11-20T00:00:00.000Z" };
  const B = { id: "fd-bbbb", severity: "blocking", text: "b.txt:1 the parser drops the first line", since: h2, receipt: "b".repeat(64), raisedAt: "2026-11-22T00:00:00.000Z" };
  const db = openDb(b);
  try {
    insert(db, { cwd: top, head: h2, base: git(b, "rev-parse", "main"), lab: "codex", verdict: "findings", findings: "x", items: [A, B], at: "2026-11-22T00:00:00.000Z" });
  } finally {
    db.close();
  }
  commit(b, "d.txt", "four\n");
  const codex = stub(b, "codex", `1. [blocking] ${B.text}`);
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: codex.path, LEDGER_JUDGE_BIN: judge(b, "yes") });
  const items = reviewRows(b).filter((x) => x.lab === "codex").at(-1).items;
  const repeat = items.find((i) => !i.resolved);
  assert.deepEqual([repeat.id, repeat.raisedAt, repeat.since, repeat.receipt], [B.id, B.raisedAt, B.since, B.receipt]);
  assert.equal(items.find((i) => i.id === A.id)?.resolved, true, "A is judged as dropped");
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

// ---- Races: dismiss reads and writes in one BEGIN IMMEDIATE; order is insertion id (T4) ----

const REVIEW_LIB = new URL("../lib/review.mjs", import.meta.url).href;

/** In-process dismiss against the sandbox store, as the prompt hook would call it. */
function dismissNow(b, findingId, opts = {}) {
  const store = openStore({ env: b.env, cwd: b.work });
  try {
    return dismiss({ db: store.db, dbPath: store.dbPath, via: "prompt-hook", findingId, disposition: "wrong", reason: "checked", config: store.config, ...opts });
  } finally {
    store.db.close();
  }
}

/** The latest codex row of HEAD as a publishLabRow input, with `extra` appended to its items. */
function republished(b, extra, at) {
  const row = reviewRows(b).filter((r) => r.lab === "codex").at(-1);
  return { cwd: row.cwd, head: row.head_sha, base: row.base_ref, branch: row.branch, lab: "codex", verdict: "findings", items: [...row.items.filter((i) => !i.dismissed).map((i) => ({ ...i })), ...extra], reason: null, at };
}

const NEW = { id: "fd-newone1", raisedAt: "2026-11-24T00:00:00.000Z", severity: "blocking", text: "z.txt:9 a new problem" };

test("race: a review publishes a new blocking finding for the same lab and HEAD while dismiss holds its transaction; afterwards the new finding is open and the dismissed one resolved", async () => {
  const { b, ids } = reviewed();
  const row = republished(b, [NEW], nowIso(Date.now()));
  // The child waits on the write lock that dismiss holds, then publishes.
  const script = `import { DatabaseSync } from "node:sqlite"; import { publishLabRow } from ${JSON.stringify(REVIEW_LIB)};
const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 10000");
process.stdout.write(String(publishLabRow(db, process.argv[1], JSON.parse(process.argv[2])).id));`;
  let child;
  const done = new Promise((resolve) => {
    const r = dismissNow(b, ids[0], {
      afterRead() {
        child = spawn(process.execPath, ["--input-type=module", "-e", script, b.dbPath, JSON.stringify(row)], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out }));
        // Hold the transaction long enough for the child to be waiting on the lock.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      },
    });
    assert.equal(r.code, 0, r.text);
  });
  const c = await done;
  assert.equal(c.code, 0);
  const last = reviewRows(b).at(-1);
  assert.equal(String(last.id), c.out, "the review published after the dismissal");
  assert.equal(last.items.find((i) => i.id === ids[0]).dismissed.disposition, "wrong");
  assert.equal(last.items.find((i) => i.id === NEW.id).resolved, undefined);
  assert.equal(last.verdict, "findings");
  assert.equal(decision(push(b)), "deny");
});

test("race: a review that published before dismiss read is the row dismiss builds on", () => {
  const { b, ids } = reviewed();
  const db = openDb(b);
  try {
    publishLabRow(db, b.dbPath, republished(b, [NEW], nowIso(Date.now())));
  } finally {
    db.close();
  }
  const r = dismissNow(b, ids[0]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /still open: fd-newone1 \(codex\)/);
  const last = reviewRows(b).at(-1);
  assert.deepEqual(last.items.map((i) => [i.id, Boolean(i.dismissed)]), [[ids[0], true], [NEW.id, false]]);
});

test("race: two dismissals of two findings on one lab row, started at once as two hook processes, both land", async () => {
  const { b, ids } = reviewed(["a.txt:1 off by one", "b.txt:1 missing check"]);
  const run = (id) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [HOOK_PATH], { cwd: b.work, env: { ...b.env, LEDGER_BUSY_TIMEOUT_MS: "10000" } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", () => resolve(out));
      p.stdin.end(JSON.stringify({ session_id: "s-race", cwd: b.work, hook_event_name: "UserPromptSubmit", prompt: `review dismiss ${id} wrong checked` }));
    });
  const outs = await Promise.all(ids.map(run));
  for (const o of outs) assert.match(JSON.parse(o).systemMessage, /ok dismissed /);
  assert.equal(dismissals(b).length, 2);
  const last = reviewRows(b).at(-1);
  assert.ok(last.items.every((i) => i.dismissed), JSON.stringify(last.items));
  assert.equal(last.verdict, "pass");
  assert.equal(decision(push(b)), "allow");
});

test("race: a review whose at is earlier than the dismissal's publishes after it; headState selects the review row, the new blocking finding is open, the dismissed one stays dismissed, and the push is denied", () => {
  const { b, ids } = reviewed();
  const t = Date.now();
  const earlier = republished(b, [NEW], nowIso(t - 1000));
  assert.equal(dismissNow(b, ids[0], { now: t }).code, 0);
  const db = openDb(b);
  try {
    const stored = publishLabRow(db, b.dbPath, earlier);
    const state = headState(db, b.work, git(b, "rev-parse", "HEAD"));
    assert.equal(state.labRows[0].id, stored.id);
    assert.equal(state.kind, "findings");
  } finally {
    db.close();
  }
  const last = reviewRows(b).at(-1);
  assert.ok(last.items.find((i) => i.id === ids[0]).dismissed);
  assert.equal(last.items.find((i) => i.id === NEW.id).dismissed, undefined);
  assert.equal(decision(push(b)), "deny");
});

test("publishLabRow reconciles: addressed, carried and unavailable rows keep a dismissal on the same sha", () => {
  const { b, ids } = reviewed(["a.txt:1 off by one", "b.txt:1 missing check"]);
  assert.equal(dismissNow(b, ids[0]).code, 0);
  const base = republished(b, [], nowIso(Date.now()));
  const orig = reviewRows(b).filter((r) => r.lab === "codex")[0].items;
  const db = openDb(b);
  try {
    // addressed's rejected row: the judge said no to both, and one was dismissed on this sha.
    const rejected = publishLabRow(db, b.dbPath, { ...base, items: orig.map((i) => ({ ...i, judge: "no", note: "from round 1; the judge says it is not resolved" })), reason: "addressed rejected by the judge" });
    assert.equal(rejected.verdict, "findings");
    assert.deepEqual(rejected.items.filter((i) => !i.resolved).map((i) => i.id), [ids[1]]);
    assert.ok(!rejected.findings.includes(`${ids[0]}: a.txt:1`));
    assert.match(rejected.reason, /; 1 dismissed$/);
    // A carried row and the same items on an unavailable lab's carry.
    const carried = publishLabRow(db, b.dbPath, { ...base, items: orig.map((i) => ({ ...i, note: "from round 1" })), reason: "not run this time; its findings from round 1 stay open" });
    assert.equal(carried.reason, "not run this time; its findings from round 1 stay open; 1 dismissed");
  } finally {
    db.close();
  }
});

test("a dismissal that commits and then cannot read the gate state reports it applied, says the gate state could not be read, and the row exists (round 2)", () => {
  const { b, ids } = reviewed();
  const store = openStore({ env: b.env, cwd: b.work });
  let committed = false;
  // Every read after the COMMIT fails, as a database gone bad between the write and the read would.
  const db = new Proxy(store.db, {
    get(real, prop) {
      if (prop === "exec")
        return (sql) => {
          const r = real.exec(sql);
          if (sql === "COMMIT") committed = true;
          return r;
        };
      if (prop === "prepare")
        return (sql) => {
          if (committed) throw new Error("disk I/O error (test)");
          return real.prepare(sql);
        };
      const v = real[prop];
      return typeof v === "function" ? v.bind(real) : v;
    },
  });
  let r;
  try {
    r = dismiss({ db, dbPath: store.dbPath, via: "prompt-hook", findingId: ids[0], disposition: "wrong", reason: "checked by hand", config: store.config });
  } finally {
    store.db.close();
  }
  assert.equal(r.code, 0, r.text);
  assert.match(r.id, /^dm-/);
  assert.match(r.text, new RegExp(`^dismissed ${ids[0]} \\(codex, wrong\\) on [0-9a-f]{8} in .*: checked by hand\\nthe dismissal is recorded; the review gate's state could not be read \\(disk I/O error \\(test\\)\\); run review status$`));
  assert.deepEqual(dismissals(b).map((d) => [d.id, d.finding_id]), [[r.id, ids[0]]]);
  assert.match(typed(b, `review dismiss ${ids[0]} wrong again`).message, /already dismissed/);
});

test("a review whose late-dismissal read fails after the lab row commits returns its normal result, says the late dismissals could not be read, and leaves the finding open (round 2 sweep)", async () => {
  const b = repo();
  const codex = stub(b, "codex", "1. [blocking] a.txt:1 off by one");
  const { runReview } = await import("../lib/review.mjs");
  const store = openStore({ env: b.env, cwd: b.work });
  let committed = false;
  // Every cc_dismissals read after the lab row's COMMIT fails; reads before it (the carry check) work.
  const db = new Proxy(store.db, {
    get(real, prop) {
      if (prop === "exec")
        return (sql) => {
          const r = real.exec(sql);
          if (sql === "COMMIT") committed = true;
          return r;
        };
      if (prop === "prepare")
        return (sql) => {
          if (committed && /cc_dismissals/.test(sql)) throw new Error("disk I/O error (test)");
          return real.prepare(sql);
        };
      const v = real[prop];
      return typeof v === "function" ? v.bind(real) : v;
    },
  });
  let r;
  try {
    r = await runReview({ db, dbPath: store.dbPath, cwd: b.work, env: { ...b.env, LEDGER_REVIEW_BIN_CODEX: codex.path }, config: store.config, labs: ["codex"], sessionId: SID });
  } finally {
    store.db.close();
  }
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^codex: findings/m);
  assert.match(r.text, /^  codex: late dismissals could not be read \(disk I\/O error \(test\)\); any dismissal recorded while this review ran stays open until the next review; run review status$/m);
  assert.equal(reviewRows(b).filter((x) => x.lab === "codex").at(-1).verdict, "findings");
  assert.equal(decision(push(b)), "deny");
});
