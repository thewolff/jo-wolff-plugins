import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { open, MIGRATIONS, OWN_TABLES, storeVersion } from "../lib/db.mjs";
import { isId, prefixOf } from "../lib/ids.mjs";
import { sandbox, cli, count } from "./helpers.mjs";

const T = "2026-01-01T00:00:00.000Z";

/** A store at version 8, one row in each table that existing code writes. */
function v8Store(box) {
  const dir = join(box.root, "v8");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "ledger.db");
  const old = new DatabaseSync(p);
  old.exec("PRAGMA foreign_keys = ON");
  old.exec("CREATE TABLE cc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const m of MIGRATIONS.slice(0, 8)) m(old);
  old.exec("INSERT INTO cc_meta VALUES ('schema_version', '8')");
  old.exec(`INSERT INTO cc_questions (id, cwd, name, body, options, default_opt, state, asked_by, asked_at, resolved_at)
            VALUES ('q-a1', '/w', 'a', 'A?', '["yes","no"]', 'yes', 'answered', 'agent', '${T}', '${T}')`);
  old.exec(`INSERT INTO cc_answers (id, question_id, word, answered_by, answered_at, via) VALUES ('an-1', 'q-a1', 'yes', 'jo', '${T}', 'cli')`);
  old.exec(`INSERT INTO cc_notes (id, cwd, kind, body, made_by, made_at) VALUES ('nt-1', '/w', 'note', 'kept', 'agent', '${T}')`);
  old.exec(`INSERT INTO cc_sessions (id, cwd, started_at) VALUES ('s-1', '/w', '${T}')`);
  old.exec(`INSERT INTO cc_bounces (session_id, rule, at) VALUES ('s-1', 'stopAskRule', '${T}')`);
  old.close();
  return p;
}

const tablesOf = (db) => ["cc_questions", "cc_answers", "cc_notes", "cc_sessions", "cc_bounces"].map((t) => count(db, t));

test("migration 9: a version 8 store opens at 9 with equal row counts, the two owed tables empty, the new session column null", () => {
  const box = sandbox();
  const p = v8Store(box);
  const before = new DatabaseSync(p);
  const counts = tablesOf(before);
  before.close();
  const { db } = open(p);
  assert.equal(storeVersion(db), 9);
  assert.deepEqual(tablesOf(db), counts);
  assert.equal(count(db, "cc_owed"), 0);
  assert.equal(count(db, "cc_owed_moves"), 0);
  assert.equal(db.prepare("SELECT last_owed_block_prompt FROM cc_sessions WHERE id = 's-1'").get().last_owed_block_prompt, null);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.ok(OWN_TABLES.includes("cc_owed") && OWN_TABLES.includes("cc_owed_moves"));
  db.close();
});

test("migration 9: each CHECK refuses its bad row", () => {
  const box = sandbox();
  const { db } = open(join(box.root, "checks.db"));
  db.exec(`INSERT INTO cc_questions (id, cwd, name, body, options, default_opt, state, asked_by, asked_at, resolved_at)
           VALUES ('q-a1', '/w', 'a', 'A?', '["yes","no"]', 'yes', 'answered', 'agent', '${T}', '${T}')`);
  db.exec(`INSERT INTO cc_answers (id, question_id, word, answered_by, answered_at, via) VALUES ('an-1', 'q-a1', 'yes', 'jo', '${T}', 'cli')`);
  const ins = (cols, vals) => () => db.exec(`INSERT INTO cc_owed (id, cwd, body, origin, made_by, made_at, changed_at${cols}) VALUES ('ow-x${Math.random().toString(36).slice(2, 8)}', '/w', ${vals})`);
  const good = ins("", `'work', 'agent', 'agent', '${T}', '${T}'`);
  good();
  const bad = {
    "started without pointer": ins(", state", `'work', 'agent', 'agent', '${T}', '${T}', 'started'`),
    "deferred without reason": ins(", state", `'work', 'agent', 'agent', '${T}', '${T}', 'deferred'`),
    "dropped without reason": ins(", state, resolved_at", `'work', 'agent', 'agent', '${T}', '${T}', 'dropped', '${T}'`),
    "done without resolved_at": ins(", state", `'work', 'agent', 'agent', '${T}', '${T}', 'done'`),
    "owed with resolved_at": ins(", resolved_at", `'work', 'agent', 'agent', '${T}', '${T}', '${T}'`),
    "201-character body": ins("", `'${"x".repeat(201)}', 'agent', 'agent', '${T}', '${T}'`),
    "blank body": ins("", `'   ', 'agent', 'agent', '${T}', '${T}'`),
    "201-character pointer": ins(", state, pointer", `'work', 'agent', 'agent', '${T}', '${T}', 'started', '${"p".repeat(201)}'`),
    "201-character reason": ins(", state, reason", `'work', 'agent', 'agent', '${T}', '${T}', 'deferred', '${"r".repeat(201)}'`),
    "origin answer without answer_id": ins("", `'work', 'answer', 'agent', '${T}', '${T}'`),
    "origin offer (not in stage 1)": ins("", `'work', 'offer', 'agent', '${T}', '${T}'`),
    "an unknown state": ins(", state", `'work', 'agent', 'agent', '${T}', '${T}', 'waiting'`),
  };
  for (const [name, fn] of Object.entries(bad)) assert.throws(fn, /CHECK/, name);
  assert.throws(() => db.exec(`INSERT INTO cc_owed (id, cwd, body, origin, made_by, made_at, changed_at) VALUES ('nt-1', '/w', 'w', 'agent', 'a', '${T}', '${T}')`), /CHECK/, "id prefix");
  assert.throws(() => db.exec(`INSERT INTO cc_owed_moves (kind, moved_by, at) VALUES ('nothing', 'agent', '${T}')`), /CHECK/, "nothing move without answer_id");
  assert.throws(() => db.exec(`INSERT INTO cc_owed_moves (kind, moved_by, at) VALUES ('create', 'agent', '${T}')`), /CHECK/, "create move without owed_id");
  assert.throws(() => db.exec(`INSERT INTO cc_owed_moves (kind, answer_id, moved_by, at) VALUES ('not-approval', 'an-1', 'agent', '${T}')`), /CHECK/, "not-approval is not a stage 1 kind");
  db.exec(`INSERT INTO cc_owed_moves (kind, answer_id, moved_by, at) VALUES ('nothing', 'an-1', 'agent', '${T}')`);
  db.close();
});

test("the ow- prefix is an id everywhere; ordinary words are not", () => {
  assert.equal(isId("ow-mvx1abcd"), true);
  assert.equal(prefixOf("ow-mvx1abcd"), "ow");
  assert.equal(isId("ow-"), false);
  assert.equal(isId("owe"), false);
  assert.equal(isId("of-course"), false);
});

test("doctor prints `ok schema version 9` on a fresh store", () => {
  const box = sandbox();
  cli(box, ["note", "seed"]);
  const r = cli(box, ["doctor"]);
  assert.match(r.out, /^ok +schema: version 9$/m, r.out);
});
