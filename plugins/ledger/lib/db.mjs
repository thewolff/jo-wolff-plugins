// db.mjs — open the SQLite store, migrate it forward, and keep failures recoverable.
//
// open(path):
//   1. create the parent directory;
//   2. open with node:sqlite, WAL, busy_timeout 2000 ms, foreign keys on;
//   3. a file that is not a database (SQLITE_NOTADB 26) or is corrupt (SQLITE_CORRUPT 11) is
//      renamed `<path>.corrupt-<timestamp>` and a fresh one is created; the move is returned as a
//      notice so the caller can show it;
//   4. a locked database (SQLITE_BUSY 5, after busy_timeout) is retried once, then thrown as a
//      StoreError with kind `busy`, so every caller can say "nothing applied" in one line;
//   5. migrations run inside one transaction, from the cc_meta schema_version up to the latest.
//
// Every table is prefixed `cc_` and the schema version lives in `cc_meta`, not in
// PRAGMA user_version, so the store can live inside another tool's SQLite file: the plugin
// creates and touches only its own tables and never reads, alters or depends on the foreign
// ones. MIGRATIONS is ordered; migration N brings a store at version N-1 to N. Never edit a
// shipped migration: append one.
//
// node:sqlite is experimental on Node 22 and 24 and prints an ExperimentalWarning on first
// load. The CLI's stdout is read by an agent and a hook's stderr is shown to the person, so the
// SQLite warning (only that one) is dropped while the module loads.

import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === "string" ? warning : warning?.message;
  const type = typeof warning === "string" ? (typeof rest[0] === "string" ? rest[0] : rest[0]?.type) : warning?.name;
  if (type === "ExperimentalWarning" && /sqlite/i.test(String(text))) return;
  return originalEmitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = originalEmitWarning;

export const SQLITE_BUSY = 5;
export const SQLITE_CORRUPT = 11;
export const SQLITE_NOTADB = 26;

export class StoreError extends Error {
  /** @param {"busy"|"open"|"migrate"|"readonly"} kind */
  constructor(kind, path, cause) {
    super(`ledger: database ${kind === "busy" ? "busy" : kind === "readonly" ? "read-only" : "unavailable"} at ${path}${cause ? `: ${cause.message}` : ""}`);
    this.name = "StoreError";
    this.kind = kind;
    this.path = path;
    this.cause = cause;
  }
}

/** The tables this plugin owns, in creation order. Anything else in the file is foreign. */
export const OWN_TABLES = Object.freeze(["cc_meta", "cc_questions", "cc_answers", "cc_notes", "cc_sessions"]);

export const MIGRATIONS = [
  // 1: the initial schema. Rows bind to a folder (`cwd`), never to a "workload" row: the folder
  // is the project, and the project's own tools say what is in flight.
  (db) => {
    db.exec(`
      CREATE TABLE cc_questions (
        id               TEXT PRIMARY KEY CHECK (id GLOB 'q-?*'),
        cwd              TEXT NOT NULL,
        kind             TEXT NOT NULL DEFAULT 'question' CHECK (kind IN ('question','approval','plan')),
        name             TEXT NOT NULL,
        body             TEXT NOT NULL CHECK (length(trim(body)) > 0),
        about            TEXT,
        options          TEXT NOT NULL CHECK (json_valid(options) AND json_array_length(options) >= 2),
        allows           TEXT,
        default_opt      TEXT NOT NULL,
        ceiling_usd      REAL CHECK (ceiling_usd IS NULL OR ceiling_usd > 0),
        deadline         TEXT,
        deadline_span_ms INTEGER,
        state            TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','withdrawn')),
        asked_by         TEXT NOT NULL,
        asked_at         TEXT NOT NULL,
        resolved_at      TEXT,
        session_id       TEXT,
        CHECK ((state = 'open') = (resolved_at IS NULL))
      );
      CREATE INDEX cc_questions_cwd_state ON cc_questions (cwd, state);

      CREATE TABLE cc_answers (
        id          TEXT PRIMARY KEY CHECK (id GLOB 'an-?*'),
        question_id TEXT NOT NULL UNIQUE REFERENCES cc_questions(id),
        word        TEXT NOT NULL,
        answered_by TEXT NOT NULL,
        answered_at TEXT NOT NULL,
        via         TEXT NOT NULL CHECK (via IN ('cli','prompt-hook'))
      );

      CREATE TABLE cc_notes (
        id          TEXT PRIMARY KEY CHECK (id GLOB 'nt-?*'),
        cwd         TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('note','withdraw','extend')),
        body        TEXT NOT NULL,
        question_id TEXT REFERENCES cc_questions(id),
        made_by     TEXT NOT NULL,
        made_at     TEXT NOT NULL,
        session_id  TEXT
      );
      CREATE INDEX cc_notes_cwd_at ON cc_notes (cwd, made_at);

      CREATE TABLE cc_sessions (
        id                TEXT PRIMARY KEY,
        cwd               TEXT NOT NULL,
        started_at        TEXT NOT NULL,
        ended_at          TEXT,
        end_reason        TEXT,
        last_block_prompt TEXT,
        last_block_rule   TEXT
      );
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function isBusy(err) {
  return err?.errcode === SQLITE_BUSY || /database is locked|SQLITE_BUSY/i.test(String(err?.message));
}

function isCorrupt(err) {
  return (
    err?.errcode === SQLITE_NOTADB ||
    err?.errcode === SQLITE_CORRUPT ||
    /not a database|malformed|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(String(err?.message))
  );
}

function isReadOnly(err) {
  return err?.errcode === 8 || /readonly|read-only|SQLITE_READONLY/i.test(String(err?.message));
}

function safeStamp(now) {
  return new Date(now).toISOString().replace(/:/g, "-");
}

export const BUSY_TIMEOUT_MS = 2000;

function openOnce(path, busyTimeoutMs) {
  const db = new DatabaseSync(path);
  try {
    // busy_timeout first: switching to WAL takes a lock, and two first opens at once must wait, not fail.
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (err) {
    try {
      db.close();
    } catch {
      /* already unusable */
    }
    throw err;
  }
  return db;
}

/** The store's schema version from cc_meta; 0 when the plugin's tables are not there yet. */
export function storeVersion(db) {
  const meta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cc_meta'").get();
  if (!meta) return 0;
  const row = db.prepare("SELECT value FROM cc_meta WHERE key = 'schema_version'").get();
  return Number(row?.value ?? 0);
}

/** Table names in the file that are not the plugin's own (another tool's schema). */
export function foreignTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((n) => !OWN_TABLES.includes(n));
}

/** Bring the plugin's tables from their cc_meta version to SCHEMA_VERSION inside one transaction. */
export function migrate(db) {
  // Read once without a lock so an up-to-date store (the common case, and the only one a
  // read-only file allows) never takes a write lock; re-read under the lock before migrating,
  // so two processes opening a fresh file at once cannot both run the same migration.
  if (storeVersion(db) >= SCHEMA_VERSION) return SCHEMA_VERSION;
  db.exec("BEGIN IMMEDIATE");
  try {
    const from = storeVersion(db);
    if (from >= SCHEMA_VERSION) {
      db.exec("COMMIT");
      return from;
    }
    db.exec("CREATE TABLE IF NOT EXISTS cc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (let v = from; v < SCHEMA_VERSION; v++) MIGRATIONS[v](db);
    db.prepare("INSERT INTO cc_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw err;
  }
  return SCHEMA_VERSION;
}

/**
 * Open (creating if needed) and migrate the store at `path`.
 * @returns {{ db: import("node:sqlite").DatabaseSync, notices: string[], path: string, shared: boolean }}
 *   `shared` is true when the file carries tables that are not the plugin's own.
 * @throws {StoreError} when the store cannot be opened: `busy` after one retry, or `open` for
 *   anything else (an unwritable directory, for example). Nothing is written in that case.
 */
export function open(path, { now = Date.now(), busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  const notices = [];
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    throw new StoreError("open", path, err);
  }

  let db;
  let attempt = 0;
  for (;;) {
    try {
      db = openOnce(path, busyTimeoutMs);
      break;
    } catch (err) {
      if (isCorrupt(err)) {
        const aside = `${path}.corrupt-${safeStamp(now)}`;
        try {
          renameSync(path, aside);
        } catch (renameErr) {
          throw new StoreError("open", path, renameErr);
        }
        notices.push(`ledger: moved corrupt database aside to ${aside}`);
        continue;
      }
      if (isBusy(err) && attempt === 0) {
        attempt++;
        continue;
      }
      throw new StoreError(isBusy(err) ? "busy" : isReadOnly(err) ? "readonly" : "open", path, err);
    }
  }

  let shared = false;
  try {
    shared = foreignTables(db).length > 0;
    migrate(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    if (isReadOnly(err)) throw new StoreError("readonly", path, err);
    if (isCorrupt(err)) {
      // Corruption surfaced by the first real statement rather than the pragmas.
      const aside = `${path}.corrupt-${safeStamp(now)}`;
      try {
        renameSync(path, aside);
      } catch (renameErr) {
        throw new StoreError("open", path, renameErr);
      }
      notices.push(`ledger: moved corrupt database aside to ${aside}`);
      const fresh = open(path, { now, busyTimeoutMs });
      return { db: fresh.db, notices: [...notices, ...fresh.notices], path, shared: fresh.shared };
    }
    throw new StoreError(isBusy(err) ? "busy" : "migrate", path, err);
  }
  return { db, notices, path, shared };
}

/**
 * Prove the store can take a write right now, without leaving one behind: take the write lock,
 * dirty one page of cc_meta, roll back. Throws StoreError `busy` or `readonly` like a real write
 * would; the gate uses it before a deny whose remedy is a write.
 */
export function assertWritable(db, path = "") {
  transaction(
    db,
    () => {
      db.prepare("UPDATE cc_meta SET value = value WHERE key = 'schema_version'").run();
      throw ROLLBACK;
    },
    path,
  );
}
const ROLLBACK = Symbol("rollback");

/**
 * Run `fn` inside BEGIN IMMEDIATE … COMMIT; roll back and rethrow on error. A `busy` failure to
 * take the write lock is retried once after the pragma's own wait, then thrown as a StoreError.
 */
export function transaction(db, fn, path = "") {
  let attempt = 0;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      if (isBusy(err) && attempt === 0) {
        attempt++;
        continue;
      }
      if (isBusy(err)) throw new StoreError("busy", path, err);
      if (isReadOnly(err)) throw new StoreError("readonly", path, err);
      throw err;
    }
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      if (err === ROLLBACK) return undefined;
      if (isReadOnly(err)) throw new StoreError("readonly", path, err);
      throw err;
    }
  }
}
