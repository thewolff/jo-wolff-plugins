import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { open, MIGRATIONS, SCHEMA_VERSION, storeVersion, missingSchema, transaction } from "../lib/db.mjs";
import { recordBranch } from "../lib/branches.mjs";
import { quickIssues } from "../lib/doctor.mjs";
import { sandbox, cli } from "./helpers.mjs";

const T = "2026-01-01T00:00:00.000Z";
const BRANCH_COLUMNS = ["repo", "git_dir", "branch", "head_sha", "branch_state", "checked_at"];
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const indexExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
const dump = (db, table, cols) => db.prepare(`SELECT ${cols.join(", ")} FROM ${table} ORDER BY 1`).all().map((r) => ({ ...r }));

/** The 0.5.0 line's migration 10, as it stands on that unreleased branch: the advice mark only. */
const otherLineMigration10 = (db) => db.exec("ALTER TABLE cc_sessions ADD COLUMN last_advise_block_prompt TEXT");

/** A store at version 10 built by `migration10`, with one owed row and one session row. */
function v10Store(box, name, migration10) {
  const dir = join(box.root, name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "ledger.db");
  const old = new DatabaseSync(p);
  old.exec("PRAGMA foreign_keys = ON");
  old.exec("CREATE TABLE cc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const m of MIGRATIONS.slice(0, 9)) m(old);
  migration10(old);
  old.exec("INSERT INTO cc_meta VALUES ('schema_version', '10')");
  old.exec(`INSERT INTO cc_sessions (id, cwd, started_at, last_owed_block_prompt) VALUES ('s-1', '/w', '${T}', 'p1')`);
  old.exec(`INSERT INTO cc_owed (id, cwd, body, origin, made_by, made_at, changed_at) VALUES ('ow-1', '/w', 'kept', 'agent', 'agent', '${T}', '${T}')`);
  old.close();
  return p;
}

test("a version 10 store from the other line's migration 10 (no branch columns) is repaired at 11: every branch column and the index added, no row changed", () => {
  const box = sandbox();
  const p = v10Store(box, "other-line", otherLineMigration10);
  const before = new DatabaseSync(p);
  assert.deepEqual(BRANCH_COLUMNS.filter((c) => columnsOf(before, "cc_owed").includes(c)), []);
  const owedCols = columnsOf(before, "cc_owed");
  const sessionCols = columnsOf(before, "cc_sessions");
  const owedRows = dump(before, "cc_owed", owedCols);
  const sessionRows = dump(before, "cc_sessions", sessionCols);
  before.close();

  const { db } = open(p);
  assert.equal(storeVersion(db), 11);
  assert.equal(SCHEMA_VERSION, 11);
  for (const c of BRANCH_COLUMNS) assert.ok(columnsOf(db, "cc_owed").includes(c), `cc_owed.${c} missing`);
  assert.ok(columnsOf(db, "cc_sessions").includes("last_advise_block_prompt"));
  assert.ok(indexExists(db, "cc_owed_open_branch"));
  assert.deepEqual(dump(db, "cc_owed", owedCols), owedRows);
  assert.deepEqual(dump(db, "cc_sessions", sessionCols), sessionRows);
  assert.equal(db.prepare("SELECT branch FROM cc_owed WHERE id = 'ow-1'").get().branch, null);
  assert.deepEqual(missingSchema(db), []);
  // The query branch tracking failed on is answerable now.
  db.prepare("SELECT id FROM cc_owed WHERE git_dir = ? AND branch = ?").all("/g", "b");
  db.close();
});

test("after the repair, branch tracking works on a store the other line stamped 10: a branch is recorded, read back, and a later commit updates the same row", () => {
  const box = sandbox();
  const p = v10Store(box, "other-line-record", otherLineMigration10);
  const { db } = open(p);
  const seen = (head) => ({ repo: "/w/repo", gitDir: "/w/repo/.git", branch: "feature", status: { state: "unpushed", head }, evidence: "header" });
  const first = transaction(db, () => recordBranch(db, seen("a".repeat(40)), { cwd: "/w", sessionId: "s-1", iso: T }));
  assert.equal(first.created, true);
  const rows = () => db.prepare("SELECT id, state, repo, git_dir, branch, head_sha, branch_state, checked_at FROM cc_owed WHERE branch IS NOT NULL").all().map((r) => ({ ...r }));
  assert.deepEqual(rows(), [{ id: first.item.id, state: "owed", repo: "/w/repo", git_dir: "/w/repo/.git", branch: "feature", head_sha: "a".repeat(40), branch_state: "unpushed", checked_at: T }]);
  // The second commit goes through the open-item lookup that logged `no such column: git_dir`.
  const second = transaction(db, () => recordBranch(db, seen("b".repeat(40)), { cwd: "/w", sessionId: "s-1", iso: T }));
  assert.equal(second.created, false);
  assert.equal(second.item.id, first.item.id);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].head_sha, "b".repeat(40));
  assert.equal(db.prepare("SELECT body FROM cc_owed WHERE id = 'ow-1'").get().body, "kept");
  db.close();
});

test("a version 10 store from this line's migration 10 opens at 11 and gains only the advice column", () => {
  const box = sandbox();
  const p = v10Store(box, "this-line", MIGRATIONS[9]);
  const { db } = open(p);
  assert.equal(storeVersion(db), 11);
  assert.ok(columnsOf(db, "cc_sessions").includes("last_advise_block_prompt"));
  for (const c of BRANCH_COLUMNS) assert.ok(columnsOf(db, "cc_owed").includes(c));
  assert.deepEqual(missingSchema(db), []);
  db.close();
});

test("migration 11 is idempotent: running it again on a complete store changes nothing and does not throw", () => {
  const box = sandbox();
  const { db } = open(join(box.root, "fresh.db"));
  const cols = columnsOf(db, "cc_owed");
  MIGRATIONS[10](db);
  MIGRATIONS[10](db);
  assert.deepEqual(columnsOf(db, "cc_owed"), cols);
  db.close();
});

test("doctor fails the schema check with the missing column names when the version matches but the columns are not there", () => {
  const box = sandbox();
  cli(box, ["note", "seed"]);
  // A store stamped 11 that never got the branch columns: what a second number collision would leave.
  const raw = new DatabaseSync(box.env.LEDGER_DB);
  raw.exec("DROP INDEX cc_owed_open_branch");
  for (const c of ["checked_at", "branch_state", "head_sha", "branch", "git_dir", "repo"]) raw.exec(`ALTER TABLE cc_owed DROP COLUMN ${c}`);
  raw.close();
  const r = cli(box, ["doctor"]);
  assert.match(
    r.out,
    /^fail +schema: version 11, but missing cc_owed\.repo, cc_owed\.git_dir, cc_owed\.branch, cc_owed\.head_sha, cc_owed\.branch_state, cc_owed\.checked_at, index cc_owed_open_branch$/m,
    r.out,
  );
  const db = new DatabaseSync(box.env.LEDGER_DB, { readOnly: true });
  assert.ok(quickIssues(db, { env: box.env }) >= 1);
  db.close();
});

test("doctor prints `ok schema: version 11` on a fresh store", () => {
  const box = sandbox();
  cli(box, ["note", "seed"]);
  const r = cli(box, ["doctor"]);
  assert.match(r.out, /^ok +schema: version 11$/m, r.out);
});
