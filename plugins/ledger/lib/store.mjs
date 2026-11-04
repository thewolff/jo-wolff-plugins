// store.mjs — config + database + the execution context, assembled the same way for the CLI
// and every hook.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describeConfig, loadConfig, userName } from "./config.mjs";
import { open, StoreError, storeWord } from "./db.mjs";
import { whoSays } from "./parse.mjs";

/**
 * What every hook does first: bind the folder, load config for it, and decide whether to run at
 * all. Returns null when the ledger is not enabled for the folder or the hook's own switch is
 * off; the database is not opened in either case, so an ordinary session costs one stat walk.
 */
export function hookConfig(env, input, hookSwitch) {
  const cwd = resolveCwd(env, input.cwd);
  const cfg = loadConfig({ env, cwd });
  if (!cfg.config.enabled || !cfg.config.hooks[hookSwitch]) return null;
  return { cfg, cwd };
}

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
export function openStore({ env = process.env, now = Date.now(), cwd = null, cfg = null } = {}) {
  cfg ??= loadConfig({ env, cwd });
  // LEDGER_BUSY_TIMEOUT_MS exists for the test suite, so a held lock fails in milliseconds, not seconds.
  const busy = Number(env.LEDGER_BUSY_TIMEOUT_MS);
  // Only the plugin's own default file is ever moved aside when corrupt. A configured `db` (env,
  // project or user file) may be another tool's database: it is reported, never renamed.
  const store = open(cfg.config.db, {
    now,
    busyTimeoutMs: Number.isFinite(busy) && busy >= 0 ? busy : undefined,
    healCorrupt: cfg.sources.db === "default",
  });
  return {
    config: cfg.config,
    sources: cfg.sources,
    path: cfg.path,
    projectPath: cfg.projectPath,
    notices: [...cfg.notices, ...store.notices],
    db: store.db,
    dbPath: store.path,
    shared: store.shared,
    configText: describeConfig({ ...cfg, shared: store.shared }),
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
 * `cfg` is the config hookConfig already checked, so the file is read once and the enabled
 * decision cannot change between the check and the open.
 * @param whatWasSkipped  e.g. "no injection this session", "the ledger gate is not enforced for this call"
 */
export function withStore({ env, now, notices = [], cwd = null, cfg = null }, whatWasSkipped, fn) {
  let store;
  try {
    store = openStore({ env, now, cwd, cfg });
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
  const why = err.kind === "corrupt" && err.cause ? `: ${err.cause.message}` : "";
  const line = `ledger: database ${storeWord(err.kind)} at ${err.path}${why}; ${whatWasSkipped}`;
  return { systemMessage: [...notices, line].join("\n") };
}
