import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { open, migrate, transaction, StoreError, SCHEMA_VERSION } from "../lib/db.mjs";
import { sandbox } from "./helpers.mjs";

const box = sandbox();

test("step 2 (a): opening a path in a missing directory creates it; user_version = 1", () => {
  const p = join(box.root, "deep", "er", "ledger.db");
  const r = open(p);
  assert.ok(existsSync(p));
  assert.equal(r.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(r.notices, []);
  assert.equal(r.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(r.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  r.db.close();
});

test("step 2 (b): a junk file is moved to *.corrupt-<stamp>, a fresh db works, the notice names the move", () => {
  const dir = join(box.root, "corrupt");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "ledger.db");
  writeFileSync(p, "x".repeat(4096));
  const r = open(p, { now: Date.UTC(2026, 10, 3, 12, 0, 0) });
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /^ledger: moved corrupt database aside to .*ledger\.db\.corrupt-2026-11-03T12-00-00\.000Z$/);
  const files = readdirSync(dir);
  assert.ok(files.includes("ledger.db.corrupt-2026-11-03T12-00-00.000Z"), files.join(","));
  assert.equal(r.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  r.db.exec("INSERT INTO workloads (id, title, cwd, opened_at, last_seen_at) VALUES ('wl-1','t','/x','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
  r.db.close();
});

test("migrate is idempotent: a second open does not rerun migrations", () => {
  const p = join(box.root, "twice.db");
  const a = open(p);
  a.db.close();
  const b = open(p);
  assert.equal(migrate(b.db), SCHEMA_VERSION);
  b.db.close();
});

test("fail-open table: a held write lock → StoreError kind busy after one retry, nothing applied", () => {
  const p = join(box.root, "busy.db");
  const holder = open(p);
  holder.db.exec("BEGIN IMMEDIATE");
  const other = open(p, { busyTimeoutMs: 20 });
  assert.throws(() => transaction(other.db, () => other.db.exec("INSERT INTO sessions (id, cwd, started_at) VALUES ('s','/x','now')"), p), (e) => e instanceof StoreError && e.kind === "busy" && e.path === p);
  other.db.close();
  holder.db.exec("ROLLBACK");
  assert.equal(holder.db.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
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

test("schema invariants: closed needs closed_at; non-open needs a reason; options need two entries", () => {
  const r = open(join(box.root, "invariants.db"));
  const d = r.db;
  const t = "2026-01-01T00:00:00.000Z";
  assert.throws(() => d.exec(`INSERT INTO workloads (id,title,cwd,status,opened_at,last_seen_at) VALUES ('wl-a','t','/x','closed','${t}','${t}')`), /CHECK/);
  assert.throws(() => d.exec(`INSERT INTO workloads (id,title,cwd,status,opened_at,last_seen_at) VALUES ('wl-a','t','/x','parked','${t}','${t}')`), /CHECK/);
  d.exec(`INSERT INTO workloads (id,title,cwd,opened_at,last_seen_at) VALUES ('wl-a','t','/x','${t}','${t}')`);
  assert.throws(() => d.exec(`INSERT INTO questions (id,workload_id,name,body,options,default_opt,asked_by,asked_at) VALUES ('q-a','wl-a','n','b','["one"]','one','agent','${t}')`), /CHECK/);
  assert.throws(() => d.exec(`INSERT INTO questions (id,workload_id,name,body,options,default_opt,asked_by,asked_at) VALUES ('q-a','wl-none','n','b','["a","b"]','a','agent','${t}')`), /FOREIGN KEY/);
  d.close();
});
