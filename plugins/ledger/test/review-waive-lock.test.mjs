// review-waive-lock.test.mjs — 0.4.12: `review waive` is the human's. It is applied only when
// typed as a prompt (the UserPromptSubmit hook, via "prompt-hook"); the CLI refuses it before the
// store opens, with the line for the human to type.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cli } from "./helpers.mjs";
import { repo, git, push, decision, typed, reviewRows, SID } from "./review-helpers.mjs";

function storeBytes(b) {
  return ["", "-wal", "-shm"].map((s) => (existsSync(b.dbPath + s) ? createHash("sha256").update(readFileSync(b.dbPath + s)).digest("hex") : "absent")).join(" ");
}

test("waive from the CLI is refused before the store opens: argv, stdin, --by human, and waive --help; exit 1 and nothing written", () => {
  const b = repo();
  const head = git(b, "rev-parse", "HEAD");
  const before = storeBytes(b);
  for (const [args, input] of [
    [["review", "waive", "prototype, push it"], null],
    [["review", "waive", "--help"], null],
    [["--by", "human", "review", "waive", "prototype"], null],
    [[], "review waive prototype\n\nreview waive --help\n"],
  ]) {
    const r = cli(b, args, { input, env: { LEDGER_SESSION_ID: SID } });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, input ? /^1: refused review waive is the human's: / : /^refused review waive is the human's: /);
    assert.ok(r.out.includes(`review waive --in ${b.work} --head ${head} "<their reason>"`), r.out);
    if (input) assert.match(r.out, /^2: skipped \(blank\)\n3: refused review waive is the human's: .*\napplied 0, refused 2, not commands 0$/m);
  }
  assert.equal(storeBytes(b), before);
  assert.equal(decision(push(b)), "deny");
});

test("waive from the CLI with an inaccessible store and with a read-only store that needs migration: exit 1 and the refusal", () => {
  const b = repo();
  const locked = join(b.root, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const r = cli(b, ["review", "waive", "x"], { env: { LEDGER_DB: join(locked, "ledger.db") } });
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /^refused review waive is the human's/);
  } finally {
    chmodSync(locked, 0o755);
  }
  const old = join(b.root, "old.db");
  const db = new DatabaseSync(old);
  db.exec("PRAGMA user_version = 11");
  db.close();
  chmodSync(old, 0o444);
  const r = cli(b, ["review", "waive", "x"], { env: { LEDGER_DB: old } });
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /^refused review waive is the human's/);
});

test("waive typed as a prompt records a waived row and the push is allowed", () => {
  const b = repo();
  assert.equal(decision(push(b)), "deny");
  const t = typed(b, "review waive prototype, the human said push it");
  assert.match(t.message, /^1: ok\n?.*waived the review gate for [0-9a-f]{8}/m, t.message);
  assert.deepEqual(reviewRows(b).map((r) => [r.lab, r.verdict, r.reason, r.session_id]), [["ledger", "waived", "prototype, the human said push it", "s-typed"]]);
  assert.equal(decision(push(b)), "allow");
});
