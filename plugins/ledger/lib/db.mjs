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
//   5. migrations run inside one transaction, from PRAGMA user_version up to the latest.
//
// The schema version is PRAGMA user_version. MIGRATIONS is ordered; migration N brings a
// database at user_version N-1 to N. Never edit a shipped migration: append one.
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
  /** @param {"busy"|"open"|"migrate"} kind */
  constructor(kind, path, cause) {
    super(`ledger: database ${kind === "busy" ? "busy" : "unavailable"} at ${path}${cause ? `: ${cause.message}` : ""}`);
    this.name = "StoreError";
    this.kind = kind;
    this.path = path;
    this.cause = cause;
  }
}

export const MIGRATIONS = [
  // 1: the initial schema.
  (db) => {
    db.exec(`
      CREATE TABLE workloads (
        id            TEXT PRIMARY KEY CHECK (id GLOB 'wl-?*'),
        title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
        cwd           TEXT NOT NULL,
        stakes        TEXT NOT NULL DEFAULT 'normal' CHECK (stakes IN ('throwaway','normal','production')),
        status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','parked','halted','closed')),
        status_reason TEXT,
        status_by     TEXT,
        opened_at     TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        closed_at     TEXT,
        session_id    TEXT,
        CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
        CHECK (status = 'open' OR status_reason IS NOT NULL)
      );
      CREATE INDEX workloads_cwd_status ON workloads (cwd, status);

      CREATE TABLE questions (
        id               TEXT PRIMARY KEY CHECK (id GLOB 'q-?*'),
        workload_id      TEXT NOT NULL REFERENCES workloads(id),
        kind             TEXT NOT NULL DEFAULT 'question' CHECK (kind IN ('question','approval','plan')),
        name             TEXT NOT NULL,
        body             TEXT NOT NULL CHECK (length(trim(body)) > 0),
        options          TEXT NOT NULL CHECK (json_valid(options) AND json_array_length(options) >= 2),
        allows           TEXT,
        default_opt      TEXT NOT NULL,
        deadline         TEXT,
        deadline_span_ms INTEGER,
        state            TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','withdrawn')),
        asked_by         TEXT NOT NULL,
        asked_at         TEXT NOT NULL,
        resolved_at      TEXT,
        CHECK ((state = 'open') = (resolved_at IS NULL))
      );
      CREATE INDEX questions_workload_state ON questions (workload_id, state);

      CREATE TABLE answers (
        id          TEXT PRIMARY KEY CHECK (id GLOB 'an-?*'),
        question_id TEXT NOT NULL UNIQUE REFERENCES questions(id),
        word        TEXT NOT NULL,
        answered_by TEXT NOT NULL,
        answered_at TEXT NOT NULL,
        via         TEXT NOT NULL CHECK (via IN ('cli','prompt-hook'))
      );

      CREATE TABLE decisions (
        id          TEXT PRIMARY KEY CHECK (id GLOB 'de-?*'),
        workload_id TEXT NOT NULL REFERENCES workloads(id),
        kind        TEXT NOT NULL CHECK (kind IN ('decide','halt','park','close','extend','ceiling','reopen')),
        body        TEXT NOT NULL,
        made_by     TEXT NOT NULL,
        made_at     TEXT NOT NULL
      );
      CREATE INDEX decisions_workload_at ON decisions (workload_id, made_at);

      CREATE TABLE ceilings (
        id          TEXT PRIMARY KEY CHECK (id GLOB 'ce-?*'),
        workload_id TEXT NOT NULL REFERENCES workloads(id),
        usd         REAL NOT NULL CHECK (usd > 0),
        hours       REAL CHECK (hours IS NULL OR hours > 0),
        block_usd   REAL NOT NULL,
        block_hours REAL,
        set_by      TEXT NOT NULL,
        set_at      TEXT NOT NULL
      );

      CREATE TABLE sessions (
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

function safeStamp(now) {
  return new Date(now).toISOString().replace(/:/g, "-");
}

export const BUSY_TIMEOUT_MS = 2000;

function openOnce(path, busyTimeoutMs) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
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

/** Bring `db` from its user_version to SCHEMA_VERSION inside one transaction. */
export function migrate(db) {
  const row = db.prepare("PRAGMA user_version").get();
  const from = Number(row.user_version ?? 0);
  if (from >= SCHEMA_VERSION) return from;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let v = from; v < SCHEMA_VERSION; v++) MIGRATIONS[v](db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
 * @returns {{ db: import("node:sqlite").DatabaseSync, notices: string[], path: string }}
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
      throw new StoreError(isBusy(err) ? "busy" : "open", path, err);
    }
  }

  try {
    migrate(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
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
      return { db: fresh.db, notices: [...notices, ...fresh.notices], path };
    }
    throw new StoreError(isBusy(err) ? "busy" : "migrate", path, err);
  }
  return { db, notices, path };
}

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
      throw isBusy(err) ? new StoreError("busy", path, err) : err;
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
      throw err;
    }
  }
}
