// store.mjs — config + database + the execution context, assembled the same way for the CLI
// and every hook.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describeConfig, loadConfig, userName } from "./config.mjs";
import { open, StoreError } from "./db.mjs";
import { whoSays } from "./parse.mjs";

/** Resolve the folder a command binds to: LEDGER_CWD, else `given`, else the process cwd; realpath'd when it exists. */
export function resolveCwd(env = process.env, given = null) {
  const raw = env.LEDGER_CWD || given || process.cwd();
  const abs = resolve(raw);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Load config and open the store.
 * @returns {{ config, sources, path, notices: string[], db, dbPath, configText }}
 * @throws {StoreError} when the database cannot be opened.
 */
export function openStore({ env = process.env, now = Date.now() } = {}) {
  const cfg = loadConfig({ env });
  // LEDGER_BUSY_TIMEOUT_MS exists for the test suite, so a held lock fails in milliseconds, not seconds.
  const busy = Number(env.LEDGER_BUSY_TIMEOUT_MS);
  const store = open(cfg.config.db, { now, busyTimeoutMs: Number.isFinite(busy) && busy >= 0 ? busy : undefined });
  return {
    config: cfg.config,
    sources: cfg.sources,
    path: cfg.path,
    notices: [...cfg.notices, ...store.notices],
    db: store.db,
    dbPath: store.path,
    configText: describeConfig(cfg),
  };
}

/**
 * The context commands run in.
 * @param opts { store, cwd, via, by, sessionId, now }
 */
export function makeCtx({ store, cwd, via = "cli", by = null, sessionId = null, now = Date.now() }) {
  const human = userName(store.config);
  return {
    cwd,
    via,
    sessionId,
    now,
    config: store.config,
    configText: store.configText,
    dbPath: store.dbPath,
    actor(verb) {
      if (by) return by;
      if (via === "prompt-hook") return human;
      return whoSays(verb) === "human" ? human : "agent";
    },
  };
}

/**
 * Open the store, run `fn(store)`, close the store. A StoreError at open or inside `fn` (a lock
 * that outlasted busy_timeout, an unwritable directory) becomes a pass: the hook's "allow"
 * output with one systemMessage line saying what the ledger did not do. Nothing else is caught.
 * @param whatWasSkipped  e.g. "no injection this session", "the ledger gate is not enforced for this call"
 */
export function withStore({ env, now, notices = [] }, whatWasSkipped, fn) {
  let store;
  try {
    store = openStore({ env, now });
  } catch (err) {
    if (err instanceof StoreError) return storeFailure(err, notices, whatWasSkipped);
    throw err;
  }
  try {
    return fn(store);
  } catch (err) {
    if (err instanceof StoreError) return storeFailure(err, [...notices, ...store.notices], whatWasSkipped);
    throw err;
  } finally {
    try {
      store.db.close();
    } catch {
      /* already closed */
    }
  }
}

function storeFailure(err, notices, whatWasSkipped) {
  const line = `ledger: database ${err.kind === "busy" ? "busy" : "unavailable"} at ${err.path}; ${whatWasSkipped}`;
  return { systemMessage: [...notices, line].join("\n") };
}
