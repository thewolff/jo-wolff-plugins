// db.mjs — open the SQLite store, migrate it forward, and keep failures recoverable.
//
// open(path):
//   1. create the parent directory;
//   2. open with node:sqlite, WAL, busy_timeout 2000 ms, foreign keys on;
//   3. a file that is not a database (SQLITE_NOTADB 26) or is corrupt (SQLITE_CORRUPT 11) is,
//      with `healCorrupt` (the caller sets it only for the plugin's own default path), renamed
//      `<path>.corrupt-<timestamp>` and a fresh one is created, the move returned as a notice;
//      without it (a configured path, which may be another tool's file) the file is left exactly
//      as found and a StoreError with kind `corrupt` is thrown;
//   4. a locked database (SQLITE_BUSY 5) is retried up to OPEN_ATTEMPTS times in all, with a
//      jittered 25–200 ms pause, while busy_timeout has not run out (one retry always), then
//      thrown as a StoreError with kind `busy`, so every caller can say "nothing applied" in one line;
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

import { accessSync, constants as fsConstants, existsSync, mkdirSync, renameSync } from "node:fs";
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
  /** @param {"busy"|"open"|"migrate"|"readonly"|"corrupt"} kind */
  constructor(kind, path, cause) {
    super(`ledger: database ${storeWord(kind)} at ${path}${cause ? `: ${cause.message}` : ""}`);
    this.name = "StoreError";
    this.kind = kind;
    this.path = path;
    this.cause = cause;
  }
}

/** The word for a StoreError kind in a one-line notice: busy, read-only, corrupt, unavailable. */
export function storeWord(kind) {
  return kind === "busy" ? "busy" : kind === "readonly" ? "read-only" : kind === "corrupt" ? "corrupt" : "unavailable";
}

/** The tables this plugin owns, in creation order. Anything else in the file is foreign. */
export const OWN_TABLES = Object.freeze(["cc_meta", "cc_questions", "cc_answers", "cc_notes", "cc_sessions", "cc_bounces", "cc_reviews", "cc_judge_cache", "cc_canary_runs", "cc_gate_checks", "cc_canary_prunes"]);

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
        last_block_rule   TEXT,
        last_stop_at      TEXT
      );
    `);
  },
  // 2: the prompt_id of the session's last Stop. A Stop with a different prompt_id is a new turn,
  // so the human has written since that last Stop; the Stop hook uses it to ask the agent to
  // record the answer to a question asked before then.
  (db) => {
    db.exec("ALTER TABLE cc_sessions ADD COLUMN last_stop_prompt TEXT");
  },
  // 3: held questions and outcomes. A question can be `held`: formed and deliberately deferred
  // for the human, unresolved like `open` (resolved_at stays NULL). A note can be an `outcome`
  // carrying `ref` (a PR URL, a commit, a path), required for that kind. CHECK constraints cannot
  // be altered in SQLite, so both tables are rebuilt (create, copy, drop, rename; migrate() turns
  // foreign keys off around it and runs foreign_key_check before committing).
  (db) => {
    const qCols = "id, cwd, kind, name, body, about, options, allows, default_opt, ceiling_usd, deadline, deadline_span_ms, state, asked_by, asked_at, resolved_at, session_id";
    db.exec(`
      CREATE TABLE cc_questions_v3 (
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
        state            TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','held','answered','withdrawn')),
        asked_by         TEXT NOT NULL,
        asked_at         TEXT NOT NULL,
        resolved_at      TEXT,
        session_id       TEXT,
        CHECK ((state IN ('open','held')) = (resolved_at IS NULL))
      );
      INSERT INTO cc_questions_v3 (${qCols}) SELECT ${qCols} FROM cc_questions;
      DROP TABLE cc_questions;
      ALTER TABLE cc_questions_v3 RENAME TO cc_questions;
      CREATE INDEX cc_questions_cwd_state ON cc_questions (cwd, state);

      CREATE TABLE cc_notes_v3 (
        id          TEXT PRIMARY KEY CHECK (id GLOB 'nt-?*'),
        cwd         TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('note','withdraw','extend','outcome')),
        body        TEXT NOT NULL,
        question_id TEXT REFERENCES cc_questions(id),
        made_by     TEXT NOT NULL,
        made_at     TEXT NOT NULL,
        session_id  TEXT,
        ref         TEXT CHECK (ref IS NULL OR length(trim(ref)) > 0),
        CHECK (kind <> 'outcome' OR ref IS NOT NULL)
      );
      INSERT INTO cc_notes_v3 (id, cwd, kind, body, question_id, made_by, made_at, session_id)
        SELECT id, cwd, kind, body, question_id, made_by, made_at, session_id FROM cc_notes;
      DROP TABLE cc_notes;
      ALTER TABLE cc_notes_v3 RENAME TO cc_notes;
      CREATE INDEX cc_notes_cwd_at ON cc_notes (cwd, made_at);
    `);
  },
  // 4: free-form answers. `answer <q-id> <reply>` with a reply that is not one of the options
  // records it as given, with via `freeform`. The CHECK on `via` cannot be altered, so
  // cc_answers is rebuilt the way migration 3 rebuilt its tables.
  (db) => {
    const aCols = "id, question_id, word, answered_by, answered_at, via";
    db.exec(`
      CREATE TABLE cc_answers_v4 (
        id          TEXT PRIMARY KEY CHECK (id GLOB 'an-?*'),
        question_id TEXT NOT NULL UNIQUE REFERENCES cc_questions(id),
        word        TEXT NOT NULL,
        answered_by TEXT NOT NULL,
        answered_at TEXT NOT NULL,
        via         TEXT NOT NULL CHECK (via IN ('cli','prompt-hook','freeform'))
      );
      INSERT INTO cc_answers_v4 (${aCols}) SELECT ${aCols} FROM cc_answers;
      DROP TABLE cc_answers;
      ALTER TABLE cc_answers_v4 RENAME TO cc_answers;
    `);
  },
  // 5: answers reach the asking session mid-session. cc_sessions.last_prompt_seen_at is the
  // UserPromptSubmit hook's mark: answers to the session's questions recorded after it are shown
  // at the next prompt. cc_answers.session_id is the session that recorded the answer, so a
  // session is not told about answers it recorded itself.
  (db) => {
    db.exec("ALTER TABLE cc_sessions ADD COLUMN last_prompt_seen_at TEXT");
    db.exec("ALTER TABLE cc_answers ADD COLUMN session_id TEXT");
  },
  // 6: the bounce ledger and the cross-lab review record, both new tables (nothing rebuilt).
  // cc_bounces: one row per Stop block, PreToolUse deny or review-gate notice; closed as
  // `satisfied` when the remedy happens in the session, as `bypassed` at SessionEnd otherwise.
  // cc_reviews: one row per `ledger review` run (and per waive / addressed), keyed by HEAD sha;
  // `branch` and `base_ref` (a resolved sha) let a branch's rounds keep one base across reviews.
  (db) => {
    db.exec(`
      CREATE TABLE cc_bounces (
        id           INTEGER PRIMARY KEY,
        session_id   TEXT,
        rule         TEXT NOT NULL,
        prompt_id    TEXT,
        tool         TEXT,
        at           TEXT NOT NULL,
        satisfied_at TEXT,
        outcome      TEXT CHECK (outcome IS NULL OR outcome IN ('satisfied','bypassed'))
      );
      CREATE INDEX cc_bounces_session_outcome ON cc_bounces (session_id, outcome);
      CREATE INDEX cc_bounces_at ON cc_bounces (at);

      CREATE TABLE cc_reviews (
        id         INTEGER PRIMARY KEY,
        session_id TEXT,
        cwd        TEXT NOT NULL,
        head_sha   TEXT NOT NULL,
        base_ref   TEXT,
        branch     TEXT,
        lab        TEXT NOT NULL,
        model      TEXT,
        verdict    TEXT NOT NULL CHECK (verdict IN ('pass','pass-with-nits','findings','addressed','unavailable','waived')),
        findings   TEXT,
        findings_json TEXT CHECK (findings_json IS NULL OR json_valid(findings_json)),
        reason     TEXT,
        at         TEXT NOT NULL
      );
      CREATE INDEX cc_reviews_cwd_head ON cc_reviews (cwd, head_sha, at);
      CREATE INDEX cc_reviews_head ON cc_reviews (head_sha);
    `);
  },
  // 7 (0.3.3): repro data and the feedback loop.
  //   cc_bounces.text            what fired the rule: the reply excerpt (Stop) or the shell
  //                              command (PreToolUse), cut to BOUNCE_TEXT_MAX chars; NULL when the
  //                              hook had none.
  //   cc_bounces.transcript_path the session transcript the event named, so the row can be
  //                              reproduced; NULL from the CLI or an older Claude Code.
  //   cc_judge_cache             the judge's answers with the passage they were given (was
  //                              `judge:<sha>` → yes|no in cc_meta with no passage). The old rows
  //                              move here with passage NULL and leave cc_meta.
  //   cc_canary_runs             one row per nightly canary run of one plugin's live-run.sh.
  //   cc_gate_checks             one row per (commit, plugin, check) of the plugin push gate, with
  //                              the hash of the plugin's tree in that commit (what was checked).
  (db) => {
    db.exec(`
      ALTER TABLE cc_bounces ADD COLUMN text TEXT;
      ALTER TABLE cc_bounces ADD COLUMN transcript_path TEXT;

      CREATE TABLE cc_judge_cache (
        key      TEXT PRIMARY KEY,
        question TEXT,
        passage  TEXT,
        answer   TEXT NOT NULL CHECK (answer IN ('yes','no')),
        at       TEXT
      );

      CREATE TABLE cc_canary_runs (
        id              INTEGER PRIMARY KEY,
        plugin          TEXT NOT NULL,
        at              TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('pass','fail','unavailable')),
        exit_code       INTEGER,
        duration_ms     INTEGER,
        transcript_path TEXT,
        output_path     TEXT,
        summary         TEXT,
        diff            TEXT,
        grade           TEXT CHECK (grade IS NULL OR grade IN ('biting','silent','fine')),
        graded_by       TEXT,
        note            TEXT
      );
      CREATE INDEX cc_canary_runs_plugin_at ON cc_canary_runs (plugin, at);

      CREATE TABLE cc_gate_checks (
        id       INTEGER PRIMARY KEY,
        cwd      TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        plugin   TEXT NOT NULL,
        name     TEXT NOT NULL,
        status   TEXT NOT NULL CHECK (status IN ('pass','fail','skipped')),
        detail   TEXT,
        tree_sha TEXT NOT NULL,
        at       TEXT NOT NULL,
        UNIQUE (cwd, head_sha, plugin, name)
      );
    `);
    const old = db.prepare("SELECT key, value FROM cc_meta WHERE key LIKE 'judge:%'").all();
    const put = db.prepare("INSERT OR IGNORE INTO cc_judge_cache (key, answer) VALUES (?, ?)");
    for (const r of old) if (r.value === "yes" || r.value === "no") put.run(r.key, r.value);
    db.prepare("DELETE FROM cc_meta WHERE key LIKE 'judge:%'").run();
  },
  // 8 (0.3.5): the canary certifies a tree and observes writes; retention runs are recorded.
  //   cc_canary_runs.tree_sha    the plugin tree (`git rev-parse HEAD:plugins/<p>`) the run
  //                              certifies: NULL when the checkout had uncommitted changes under
  //                              the plugin or is in no repository. The gate's `evals` row wants
  //                              a pass row for the committed tree.
  //   cc_canary_runs.writes      JSON array of the files the live run left outside the work
  //                              directory, in placeholder form (`$XDG_STATE_HOME/<p>/x`), from
  //                              the script's `wrote:` lines; the gate's `retention` row checks
  //                              each against the plugin's declared `state`.
  //   cc_canary_prunes           one row per declared `state[].prune` the canary ran after the
  //                              live runs: the command, its exit, and the bytes it freed.
  (db) => {
    db.exec(`
      ALTER TABLE cc_canary_runs ADD COLUMN tree_sha TEXT;
      ALTER TABLE cc_canary_runs ADD COLUMN writes TEXT;

      CREATE TABLE cc_canary_prunes (
        id          INTEGER PRIMARY KEY,
        plugin      TEXT NOT NULL,
        at          TEXT NOT NULL,
        path        TEXT NOT NULL,
        command     TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('pass','fail','unavailable')),
        exit_code   INTEGER,
        bytes_freed INTEGER,
        note        TEXT
      );
      CREATE INDEX cc_canary_prunes_plugin_at ON cc_canary_prunes (plugin, at);
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

/** Tries at opening a busy file, the first included. */
export const OPEN_ATTEMPTS = 5;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms) {
  if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms);
}

/** The pause before retry `attempt` (0-based): jittered, 25 ms up to a 50–200 ms ceiling, never past `remaining`. */
function openBackoffMs(attempt, remaining) {
  const ceiling = Math.min(200, 25 * 2 ** (attempt + 1));
  return Math.max(0, Math.min(remaining, 25 + Math.random() * (ceiling - 25)));
}

function openOnce(path, busyTimeoutMs) {
  const db = new DatabaseSync(path);
  try {
    // busy_timeout first, so a lock someone holds is waited for. Switching a fresh file to WAL is
    // the one step SQLite can refuse at once without waiting (it holds a shared lock and needs an
    // exclusive one, so the busy handler stands aside to avoid a deadlock); open() retries that.
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
  // A migration that rebuilds a table drops a parent of foreign keys; SQLite's procedure is to
  // turn enforcement off (only possible outside a transaction), migrate, check, turn it back on.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    return migrateLocked(db);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateLocked(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const from = storeVersion(db);
    if (from >= SCHEMA_VERSION) {
      db.exec("COMMIT");
      return from;
    }
    db.exec("CREATE TABLE IF NOT EXISTS cc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (let v = from; v < SCHEMA_VERSION; v++) MIGRATIONS[v](db);
    // Only the plugin's own child tables: a foreign tool's tables in a shared file are not ours to judge.
    const broken = ["cc_answers", "cc_notes"].flatMap((t) => db.prepare(`PRAGMA foreign_key_check(${t})`).all());
    if (broken.length) throw new Error(`migration left ${broken.length} broken foreign key(s), first in ${broken[0].table}`);
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
 * @param opts.healCorrupt  move a corrupt file aside and start fresh; only for the default path.
 *   Off, a corrupt file is never renamed, recreated or written: `corrupt` is thrown instead.
 * @throws {StoreError} when the store cannot be opened: `busy` once the retries run out, `corrupt` for a
 *   corrupt file without healCorrupt, or `open` for anything else (an unwritable directory, for
 *   example). Nothing is written in that case.
 */
export function open(path, { now = Date.now(), busyTimeoutMs = BUSY_TIMEOUT_MS, healCorrupt = false } = {}) {
  const notices = [];
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    throw new StoreError("open", path, err);
  }

  let db;
  let attempt = 0;
  const started = Date.now();
  for (;;) {
    try {
      db = openOnce(path, busyTimeoutMs);
      break;
    } catch (err) {
      if (isCorrupt(err)) {
        if (!healCorrupt) throw new StoreError("corrupt", path, err);
        const aside = `${path}.corrupt-${safeStamp(now)}`;
        try {
          renameSync(path, aside);
        } catch (renameErr) {
          throw new StoreError("open", path, renameErr);
        }
        notices.push(`ledger: moved corrupt database aside to ${aside}`);
        continue;
      }
      // Several processes opening a fresh file at once race the switch to WAL, which fails at once
      // rather than waiting; a jittered pause lets one finish. One retry always (the pre-0.3.7
      // contract), more only while busy_timeout has not run out.
      const remaining = busyTimeoutMs - (Date.now() - started);
      if (isBusy(err) && attempt < OPEN_ATTEMPTS - 1 && (attempt === 0 || remaining > 0)) {
        sleepMs(openBackoffMs(attempt, remaining));
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
      if (!healCorrupt) throw new StoreError("corrupt", path, err);
      const aside = `${path}.corrupt-${safeStamp(now)}`;
      try {
        renameSync(path, aside);
      } catch (renameErr) {
        throw new StoreError("open", path, renameErr);
      }
      notices.push(`ledger: moved corrupt database aside to ${aside}`);
      const fresh = open(path, { now, busyTimeoutMs, healCorrupt });
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

/**
 * Look at the store at `path` without creating, migrating or writing it (the doctor's view).
 * @returns {{ exists: boolean, writable: boolean, version: number|null, error: string|null, query: Function|null }}
 *   `query(fn)` runs `fn(db)` on a read-only handle and closes it; null when the file cannot be read.
 */
export function probe(path) {
  if (!existsSync(path)) return { exists: false, writable: false, version: null, error: null, query: null };
  let writable = true;
  try {
    accessSync(path, fsConstants.W_OK);
    accessSync(dirname(path), fsConstants.W_OK);
  } catch {
    writable = false;
  }
  const query = (fn) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      return fn(db);
    } finally {
      db.close();
    }
  };
  try {
    const version = query((db) => {
      db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
      return storeVersion(db);
    });
    return { exists: true, writable, version, error: null, query };
  } catch (err) {
    return { exists: true, writable, version: null, error: err.message, query: null };
  }
}
