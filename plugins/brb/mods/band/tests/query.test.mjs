// query.test.mjs — mods/band/query.mjs, as the subprocess the mod runs and through its exports:
// home → `{ ok: true, away: false, checklist: null }`; after `brb` → the hold's since, note,
// counts and held items; after `back` → home with the
// checklist `back` wrote; another session's hold is not this session's; a missing --session, a
// state file that is a directory, a link or over MAX_BYTES are `{ ok: false, error }`; the bound
// holds on the descriptor read, so a file replaced or grown after the check is still bounded;
// every run exits 0, prints JSON and writes nothing. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

import { main, parseArgs, snapshot } from "../query.mjs";
import { MAX_BYTES } from "../data.mjs";
import { PLUGIN_ROOT, box, promptInput, runHook } from "../../../test/helpers.mjs";

const QUERY = join(PLUGIN_ROOT, "mods", "band", "query.mjs");
const HOLD = join(PLUGIN_ROOT, "scripts", "brb.mjs");
const HOME = { ok: true, away: false, checklist: null, hideRows: true };

/** Run query.mjs as the mod does: `node query.mjs --session <id>` with the sandbox env; JSON on stdout. */
function query(b, args) {
  const r = spawnSync(process.execPath, [QUERY, ...args], { cwd: b.work, env: b.env, encoding: "utf8", timeout: 10_000 });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const hold = (b, session, item) => spawnSync(process.execPath, [HOLD, "hold", "--session", session, item], { cwd: b.work, env: b.env, encoding: "utf8", timeout: 10_000 });

test("parseArgs reads --session as two tokens or one; a missing or blank id is null", () => {
  assert.deepEqual(parseArgs(["--session", "s1"]), { sessionId: "s1" });
  assert.deepEqual(parseArgs(["--session=s1"]), { sessionId: "s1" });
  assert.deepEqual(parseArgs(["--session", ""]), { sessionId: null });
  assert.deepEqual(parseArgs(["--session", "   "]), { sessionId: null });
  assert.deepEqual(parseArgs(["--session"]), { sessionId: null });
  assert.deepEqual(parseArgs([]), { sessionId: null });
});

test("home: no away.json and no checklist is `away: false, checklist: null`, exit 0, and the state directory is left untouched", () => {
  const b = box();
  try {
    const r = query(b, ["--session", "s1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json, HOME);
    assert.equal(r.stderr, "");
    assert.equal(existsSync(join(b.env.XDG_STATE_HOME, "brb")), false, "the query created the state directory");
  } finally {
    b.release();
  }
});

test("away: after `brb lunch` the snapshot carries since, the note, the counts and the held items in order; `back` leaves the checklist", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb lunch"));
    const before = Date.now() - 1000;
    const r = query(b, ["--session", "s1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.away, true);
    assert.equal(r.json.note, "lunch");
    assert.equal(r.json.held, 0);
    assert.equal(r.json.onFire, 0);
    assert.deepEqual(r.json.items, []);
    assert.ok(Date.parse(r.json.since) >= before, `since ${r.json.since} is before the hold began`);
    assert.deepEqual(Object.keys(r.json).sort(), ["away", "held", "hideRows", "items", "note", "ok", "onFire", "since"]);

    assert.equal(hold(b, "s1", "Pick Redis or in-process for the cache").stdout, "held 1\n");
    hold(b, "s1", "Approve the schema change");
    const two = query(b, ["--session", "s1"]).json;
    assert.equal(two.held, 2);
    assert.deepEqual(two.items, ["Pick Redis or in-process for the cache", "Approve the schema change"]);

    runHook(b, "user-prompt-submit", promptInput(b, "back"));
    const after = query(b, ["--session", "s1"]).json;
    assert.equal(after.away, false);
    assert.deepEqual(after.checklist.items, [
      { text: "Pick Redis or in-process for the cache", heading: after.checklist.items[0].heading, done: false },
      { text: "Approve the schema change", heading: after.checklist.items[0].heading, done: false },
    ]);
    assert.match(after.checklist.items[0].heading, /^\d{4}-\d\d-\d\d /);
    assert.equal(after.checklist.note, "lunch");
  } finally {
    b.release();
  }
});

test("another session's hold is not this one's: s2 away leaves s1 home; the id is read as lib/state.mjs keys it", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb", { session_id: "s2" }));
    assert.deepEqual(query(b, ["--session", "s1"]).json, HOME);
    assert.equal(query(b, ["--session", "s2"]).json.away, true);
    runHook(b, "user-prompt-submit", promptInput(b, "brb", { session_id: "odd id/here" }));
    assert.equal(query(b, ["--session", "odd id/here"]).json.away, true);
    assert.equal(query(b, ["--session", "odd_id_here"]).json.away, true);
  } finally {
    b.release();
  }
});

test("faults are `{ ok: false, error }` with exit 0: no --session, an away.json that is a directory, one over the byte limit, a checklist that is a directory", () => {
  const b = box();
  try {
    const none = query(b, []);
    assert.equal(none.status, 0);
    assert.deepEqual(none.json, { ok: false, error: "query needs --session <id>" });

    mkdirSync(join(b.stateDir("s3"), "away.json"), { recursive: true });
    const dir = query(b, ["--session", "s3"]);
    assert.equal(dir.status, 0);
    assert.equal(dir.json.ok, false);
    assert.match(dir.json.error, /away\.json is not a regular file$/);

    mkdirSync(b.stateDir("s4"), { recursive: true });
    const big = JSON.stringify({ since: "2026-11-04T18:42:00.000Z", note: "x".repeat(MAX_BYTES), held: 1 });
    writeFileSync(join(b.stateDir("s4"), "away.json"), big);
    const over = query(b, ["--session", "s4"]);
    assert.equal(over.status, 0);
    assert.equal(over.json.ok, false);
    assert.match(over.json.error, new RegExp(`away\\.json is ${big.length} bytes, over the ${MAX_BYTES} byte limit$`));

    // An away.json that does not parse is home, the same reading the hooks make; so is a checklist that does not parse.
    mkdirSync(b.stateDir("s5"), { recursive: true });
    writeFileSync(join(b.stateDir("s5"), "away.json"), "{not json");
    writeFileSync(join(b.stateDir("s5"), "checklist.json"), "{not json");
    assert.deepEqual(query(b, ["--session", "s5"]).json, HOME);

    mkdirSync(join(b.stateDir("s6"), "checklist.json"), { recursive: true });
    const cdir = query(b, ["--session", "s6"]);
    assert.equal(cdir.json.ok, false);
    assert.match(cdir.json.error, /checklist\.json is not a regular file$/);

    assert.deepEqual(readdirSync(b.stateDir("s4")), ["away.json"]);
    assert.deepEqual(readdirSync(b.stateDir("s5")).sort(), ["away.json", "checklist.json"]);
  } finally {
    b.release();
  }
});

test("in process: snapshot and main agree with the subprocess, and main returns 0 after printing one JSON line", () => {
  const b = box();
  try {
    assert.deepEqual(snapshot("s1", { env: b.env }), HOME);
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    assert.equal(snapshot("s1", { env: b.env }).away, true);
    let printed = "";
    const code = main(["--session", "s1"], { env: b.env, out: (s) => (printed += s) });
    assert.equal(code, 0);
    assert.match(printed, /^\{.*\}\n$/);
    assert.equal(JSON.parse(printed).away, true);
    let none = "";
    assert.equal(main([], { env: b.env, out: (s) => (none += s) }), 0);
    assert.deepEqual(JSON.parse(none), { ok: false, error: "query needs --session <id>" });
  } finally {
    b.release();
  }
});

/** Run fn with node:fs `name` wrapped by `wrap(original)`, visible to query.mjs's named import; restored after. */
function withFs(name, wrap, fn) {
  const original = fs[name];
  fs[name] = wrap(original);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs[name] = original;
    syncBuiltinESMExports();
  }
}

const SINCE = "2026-11-04T18:42:00.000Z";

test("the bound is on the descriptor read: an away.json atomically replaced by an oversized one after the open is not read", () => {
  const b = box();
  try {
    const dir = b.stateDir("s1");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "away.json");
    const swap = join(dir, "away.tmp");
    writeFileSync(path, JSON.stringify({ since: SINCE, note: "small" }));
    writeFileSync(swap, JSON.stringify({ since: SINCE, note: "x".repeat(MAX_BYTES) }));
    let swapped = false;
    const result = withFs("openSync", (open) => (...args) => {
      const fd = open(...args);
      if (args[0] === path && !swapped) {
        renameSync(swap, path);
        swapped = true;
      }
      return fd;
    }, () => snapshot("s1", { env: b.env }));
    assert.equal(swapped, true);
    assert.deepEqual(result, { ok: true, away: true, since: SINCE, note: "small", held: 0, onFire: 0, items: [], hideRows: true });
  } finally {
    b.release();
  }
});

test("the read stops at MAX_BYTES + 1: a file that grows past the limit after fstat is a fault, not a parse", () => {
  const b = box();
  try {
    const dir = b.stateDir("s1");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "away.json");
    writeFileSync(path, JSON.stringify({ since: SINCE, note: "small" }));
    const result = withFs("fstatSync", (fstat) => (...args) => {
      const st = fstat(...args);
      fs.appendFileSync(path, " ".repeat(MAX_BYTES));
      return st;
    }, () => snapshot("s1", { env: b.env }));
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(`away\\.json is over the ${MAX_BYTES} byte limit$`));
  } finally {
    b.release();
  }
});

test("a link at away.json is not followed: it is `not a regular file`, even when it points at a valid record", () => {
  const b = box();
  try {
    const dir = b.stateDir("s1");
    mkdirSync(dir, { recursive: true });
    const real = join(b.env.XDG_STATE_HOME, "elsewhere.json");
    writeFileSync(real, JSON.stringify({ since: SINCE, note: "linked" }));
    symlinkSync(real, join(dir, "away.json"));
    const r = query(b, ["--session", "s1"]);
    assert.equal(r.status, 0);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /away\.json is not a regular file$/);
  } finally {
    b.release();
  }
});

test("hideRows: config.json's switch rides every answer, home and away; an unreadable file is off", () => {
  const b = box();
  try {
    assert.equal(query(b, ["--session", "s1"]).json.hideRows, true, "no config: on");
    mkdirSync(join(b.env.XDG_CONFIG_HOME, "brb"), { recursive: true });
    writeFileSync(join(b.env.XDG_CONFIG_HOME, "brb", "config.json"), JSON.stringify({ hideRows: "off" }));
    assert.equal(query(b, ["--session", "s1"]).json.hideRows, false, "home, off");
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const away = query(b, ["--session", "s1"]).json;
    assert.equal(away.away, true);
    assert.equal(away.hideRows, false, "away, off");
    writeFileSync(join(b.env.XDG_CONFIG_HOME, "brb", "config.json"), "{ not json");
    assert.equal(query(b, ["--session", "s1"]).json.hideRows, false, "unparsable: off");
  } finally {
    b.release();
  }
});
