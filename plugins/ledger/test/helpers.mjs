// helpers.mjs — a temp HOME, a temp store, and subprocess runners for the CLI and the hooks.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import { openStore, makeCtx } from "../lib/store.mjs";
import { runBatch } from "../lib/batch.mjs";

export const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CLI = join(PLUGIN_ROOT, "scripts", "ledger.mjs");
export const HOOKS = Object.fromEntries(
  ["session-start", "session-end", "pre-tool-use", "stop", "user-prompt"].map((n) => [n, join(PLUGIN_ROOT, "hooks", `${n}.mjs`)]),
);

/** A fresh temp tree: HOME, a work folder, a sibling folder, and an env with nothing inherited from the user. */
export function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ledger-test-")));
  const home = join(root, "home");
  const work = join(root, "work");
  const sibling = join(root, "sibling");
  for (const d of [home, work, sibling, join(root, "tmp")]) mkdirSync(d, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    LEDGER_DB: join(root, "ledger.db"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    LEDGER_BUSY_TIMEOUT_MS: "50",
    TZ: "UTC",
    TMPDIR: join(root, "tmp"),
  };
  const box = {
    root,
    home,
    work,
    sibling,
    env,
    dbPath: env.LEDGER_DB,
    errorsLog: join(root, "state", "ledger", "errors.log"),
    configPath: join(root, "config", "ledger", "config.json"),
    writeConfig(value) {
      mkdirSync(join(root, "config", "ledger"), { recursive: true });
      writeFileSync(box.configPath, typeof value === "string" ? value : JSON.stringify(value));
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  after(() => box.cleanup());
  return box;
}

/** Run the CLI as a subprocess. `input` is piped to stdin when given (batch mode). */
export function cli(box, args, { input = null, cwd = box.work, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...box.env, ...env },
    input: input ?? "",
    stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Run one hook script with a JSON (or raw string) payload. */
export function hook(box, name, payload, { env = {}, cwd = box.work } = {}) {
  const r = spawnSync(process.execPath, [HOOKS[name]], {
    cwd,
    env: { ...box.env, ...env },
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  let json = null;
  if (r.stdout.trim()) {
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = undefined;
    }
  }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

/** Apply lines in-process against the sandbox store and return the batch; the store is closed after. */
export function apply(box, lines, { cwd = box.work, via = "cli", by = null, sessionId = null, now = Date.now() } = {}) {
  const store = openStore({ env: box.env, now });
  try {
    const ctx = makeCtx({ store, cwd, via, by, sessionId, now });
    return runBatch(Array.isArray(lines) ? lines : [lines], { db: store.db, ctx });
  } finally {
    store.db.close();
  }
}

/** Open the store for direct reads in a test; caller closes. */
export function openDb(box) {
  return openStore({ env: box.env }).db;
}

/** First result's id from an apply() call, or throws with the message. */
export function idOf(batch, n = 0) {
  const r = batch.results[n];
  if (r.status !== "ok" || !r.id) throw new Error(`line ${n + 1} did not produce an id: ${r.status} ${r.message}`);
  return r.id;
}

/** Shorthand: open a workload in the sandbox work folder, return its wl- id. */
export function openWorkload(box, title = "test workload", opts = {}) {
  return idOf(apply(box, [{ tokens: ["open", title], text: `open "${title}"` }], opts));
}

/** Shorthand: ask a question on the open workload, return its q- id. */
/** Asks a question; the default body carries the name so two asks on one workload never dedupe into one row. */
export function askQuestion(box, { name = "which", body = `Which way (${name})?`, options = "a,b", extra = [], ...opts } = {}) {
  return idOf(apply(box, [{ tokens: ["ask", body, "--name", name, "--options", options, ...extra], text: `ask "${body}"` }], opts));
}

/** A node:sqlite row as a plain object (rows come back with a null prototype). */
export function row(db, sql, ...params) {
  const r = db.prepare(sql).get(...params);
  return r ? { ...r } : r;
}

export function count(db, table, where = "1=1", ...params) {
  return db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params).n;
}
