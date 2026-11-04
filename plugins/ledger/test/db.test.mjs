import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { open, migrate, transaction, storeVersion, foreignTables, StoreError, SCHEMA_VERSION, OWN_TABLES } from "../lib/db.mjs";
import { sandbox } from "./helpers.mjs";

const box = sandbox();
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

test("opening a path in a missing directory creates it; schema_version lives in cc_meta, PRAGMA user_version stays 0", () => {
  const p = join(box.root, "deep", "er", "ledger.db");
  const r = open(p);
  assert.ok(existsSync(p));
  assert.equal(storeVersion(r.db), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 5);
  assert.equal(r.db.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(r.shared, false);
  assert.deepEqual(r.notices, []);
  assert.deepEqual(tables(r.db), [...OWN_TABLES].sort());
  assert.equal(r.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(r.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  r.db.close();
});

test("healCorrupt (the default path): a junk file is moved to *.corrupt-<stamp>, a fresh db works, the notice names the move", () => {
  const dir = join(box.root, "corrupt");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "ledger.db");
  writeFileSync(p, "x".repeat(4096));
  const r = open(p, { now: Date.UTC(2026, 10, 3, 12, 0, 0), healCorrupt: true });
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /^ledger: moved corrupt database aside to .*ledger\.db\.corrupt-2026-11-03T12-00-00\.000Z$/);
  const files = readdirSync(dir);
  assert.ok(files.includes("ledger.db.corrupt-2026-11-03T12-00-00.000Z"), files.join(","));
  assert.equal(storeVersion(r.db), SCHEMA_VERSION);
  r.db.exec("INSERT INTO cc_notes (id, cwd, kind, body, made_by, made_at) VALUES ('nt-1','/x','note','t','me','2026-01-01T00:00:00.000Z')");
  r.db.close();
});

test("without healCorrupt (a configured path): a junk file throws StoreError corrupt and is left byte for byte, unrenamed, with no -wal or -shm", () => {
  const dir = join(box.root, "configured-corrupt");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "ledger.db");
  writeFileSync(p, "x".repeat(4096));
  const hash = () => createHash("sha256").update(readFileSync(p)).digest("hex");
  const before = hash();
  const mtime = statSync(p).mtimeMs;
  assert.throws(
    () => open(p, { now: Date.UTC(2026, 10, 3, 12, 0, 0) }),
    (err) => {
      assert.ok(err instanceof StoreError);
      assert.equal(err.kind, "corrupt");
      assert.equal(err.path, p);
      assert.ok(err.message.startsWith(`ledger: database corrupt at ${p}: `), err.message);
      assert.match(err.message, /not a database/);
      return true;
    },
  );
  assert.equal(hash(), before);
  assert.equal(statSync(p).mtimeMs, mtime);
  assert.deepEqual(readdirSync(dir), ["ledger.db"]);
});

test("migrate is idempotent: a second open does not rerun migrations", () => {
  const p = join(box.root, "twice.db");
  const a = open(p);
  a.db.close();
  const b = open(p);
  assert.equal(migrate(b.db), SCHEMA_VERSION);
  b.db.close();
});

test("shared file: another tool's tables and its user_version are left alone; only the cc_ tables are added; shared is reported", () => {
  const p = join(box.root, "shared.db");
  const theirs = new DatabaseSync(p);
  theirs.exec("PRAGMA user_version = 7; CREATE TABLE workloads (id TEXT PRIMARY KEY, title TEXT); INSERT INTO workloads VALUES ('wl-1', 'theirs')");
  theirs.close();
  const r = open(p);
  assert.equal(r.shared, true);
  assert.deepEqual(foreignTables(r.db), ["workloads"]);
  assert.equal(r.db.prepare("PRAGMA user_version").get().user_version, 7);
  assert.equal(storeVersion(r.db), SCHEMA_VERSION);
  assert.deepEqual(tables(r.db), [...OWN_TABLES, "workloads"].sort());
  assert.deepEqual({ ...r.db.prepare("SELECT * FROM workloads").get() }, { id: "wl-1", title: "theirs" });
  r.db.close();
  const again = open(p);
  assert.equal(again.db.prepare("PRAGMA user_version").get().user_version, 7);
  assert.equal(again.shared, true);
  again.db.close();
});

test("four processes opening the same fresh file at once all succeed; the schema is created once", () => {
  const p = join(box.root, "race", "ledger.db");
  const { spawn } = globalThis.process.getBuiltinModule("node:child_process");
  const script = `import { open, storeVersion } from ${JSON.stringify(new URL("../lib/db.mjs", import.meta.url).href)}; const r = open(${JSON.stringify(p)}); console.log(storeVersion(r.db)); r.db.close();`;
  const runs = Array.from({ length: 4 }, () => spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] }));
  return Promise.all(
    runs.map(
      (c) =>
        new Promise((resolve) => {
          let out = "";
          let err = "";
          c.stdout.on("data", (d) => (out += d));
          c.stderr.on("data", (d) => (err += d));
          c.on("close", (code) => resolve({ code, out: out.trim(), err }));
        }),
    ),
  ).then((results) => {
    for (const r of results) {
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, String(SCHEMA_VERSION));
    }
    const r = open(p);
    assert.equal(r.db.prepare("SELECT count(*) AS n FROM cc_meta").get().n, 1);
    r.db.close();
  });
});

test("fail-open table: a held write lock → StoreError kind busy after one retry, nothing applied", () => {
  const p = join(box.root, "busy.db");
  const holder = open(p);
  holder.db.exec("BEGIN IMMEDIATE");
  const other = open(p, { busyTimeoutMs: 20 });
  assert.throws(() => transaction(other.db, () => other.db.exec("INSERT INTO cc_sessions (id, cwd, started_at) VALUES ('s','/x','now')"), p), (e) => e instanceof StoreError && e.kind === "busy" && e.path === p);
  other.db.close();
  holder.db.exec("ROLLBACK");
  assert.equal(holder.db.prepare("SELECT count(*) AS n FROM cc_sessions").get().n, 0);
  holder.db.close();
});

test("fail-open table: an unwritable directory → StoreError kind open", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const dir = join(box.root, "readonly");
  mkdirSync(dir);
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => open(join(dir, "sub", "ledger.db")), (e) => e instanceof StoreError && e.kind === "open");
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("fail-open table: a read-only file → StoreError kind readonly on write; a migrated file still opens for reads; an unmigrated one fails at open", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const p = join(box.root, "ro.db");
  open(p).db.close();
  chmodSync(p, 0o444);
  try {
    const r = open(p);
    assert.equal(storeVersion(r.db), SCHEMA_VERSION);
    assert.throws(() => transaction(r.db, () => r.db.exec("INSERT INTO cc_sessions (id, cwd, started_at) VALUES ('s','/x','now')"), p), (e) => e instanceof StoreError && e.kind === "readonly" && e.path === p);
    r.db.close();
  } finally {
    chmodSync(p, 0o644);
  }
  const fresh = join(box.root, "ro-fresh.db");
  new DatabaseSync(fresh).close();
  chmodSync(fresh, 0o444);
  try {
    assert.throws(() => open(fresh), (e) => e instanceof StoreError && e.kind === "readonly");
  } finally {
    chmodSync(fresh, 0o644);
  }
});

test("schema invariants: options need two entries; an answer needs its question; state and resolved_at agree", () => {
  const r = open(join(box.root, "invariants.db"));
  const d = r.db;
  const t = "2026-01-01T00:00:00.000Z";
  assert.throws(() => d.exec(`INSERT INTO cc_questions (id,cwd,name,body,options,default_opt,asked_by,asked_at) VALUES ('q-a','/x','n','b','["one"]','one','agent','${t}')`), /CHECK/);
  assert.throws(() => d.exec(`INSERT INTO cc_questions (id,cwd,name,body,options,default_opt,asked_by,asked_at,state) VALUES ('q-a','/x','n','b','["a","b"]','a','agent','${t}','answered')`), /CHECK/);
  d.exec(`INSERT INTO cc_questions (id,cwd,name,body,options,default_opt,asked_by,asked_at) VALUES ('q-a','/x','n','b','["a","b"]','a','agent','${t}')`);
  assert.throws(() => d.exec(`INSERT INTO cc_answers (id,question_id,word,answered_by,answered_at,via) VALUES ('an-a','q-none','a','me','${t}','cli')`), /FOREIGN KEY/);
  d.close();
});
