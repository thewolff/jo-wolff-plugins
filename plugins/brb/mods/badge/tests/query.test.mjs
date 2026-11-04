// query.test.mjs — mods/badge/query.mjs, as the subprocess the mod runs and through its exports:
// home → `{ ok: true, away: false }`; after `brb` → the hold's since, note and count; a hold
// command bumps the count; another session's hold is not this session's; a missing --session,
// an away.json that is a directory, and one over AWAY_MAX_BYTES are `{ ok: false, error }`;
// every run exits 0, prints JSON and writes nothing. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { main, parseArgs, snapshot } from "../query.mjs";
import { AWAY_MAX_BYTES } from "../data.mjs";
import { PLUGIN_ROOT, box, promptInput, runHook } from "../../../test/helpers.mjs";

const QUERY = join(PLUGIN_ROOT, "mods", "badge", "query.mjs");
const HOLD = join(PLUGIN_ROOT, "scripts", "brb.mjs");

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

test("home: no away.json is `away: false`, exit 0, and the state directory is left untouched", () => {
  const b = box();
  try {
    const r = query(b, ["--session", "s1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json, { ok: true, away: false });
    assert.equal(r.stderr, "");
    assert.equal(existsSync(join(b.env.XDG_STATE_HOME, "brb")), false, "the query created the state directory");
  } finally {
    b.release();
  }
});

test("away: after `brb lunch` the snapshot carries since, the note and the counts; a hold bumps the count; `back` ends it", () => {
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
    assert.ok(Date.parse(r.json.since) >= before, `since ${r.json.since} is before the hold began`);
    assert.deepEqual(Object.keys(r.json).sort(), ["away", "held", "note", "ok", "onFire", "since"]);

    const h = hold(b, "s1", "Pick Redis or in-process for the cache");
    assert.equal(h.stdout, "held 1\n", h.stderr);
    assert.equal(query(b, ["--session", "s1"]).json.held, 1);
    hold(b, "s1", "Approve the schema change");
    assert.equal(query(b, ["--session", "s1"]).json.held, 2);

    runHook(b, "user-prompt-submit", promptInput(b, "back"));
    assert.deepEqual(query(b, ["--session", "s1"]).json, { ok: true, away: false });
  } finally {
    b.release();
  }
});

test("another session's hold is not this one's: s2 away leaves s1 home; the id is read as lib/state.mjs keys it", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb", { session_id: "s2" }));
    assert.deepEqual(query(b, ["--session", "s1"]).json, { ok: true, away: false });
    assert.equal(query(b, ["--session", "s2"]).json.away, true);
    // An id with characters the state directory maps to `_` finds the same record the hook wrote.
    runHook(b, "user-prompt-submit", promptInput(b, "brb", { session_id: "odd id/here" }));
    assert.equal(query(b, ["--session", "odd id/here"]).json.away, true);
    assert.equal(query(b, ["--session", "odd_id_here"]).json.away, true);
  } finally {
    b.release();
  }
});

test("faults are `{ ok: false, error }` with exit 0: no --session, an away.json that is a directory, one over the byte limit", () => {
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
    const big = JSON.stringify({ since: "2026-11-04T18:42:00.000Z", note: "x".repeat(AWAY_MAX_BYTES), held: 1 });
    writeFileSync(join(b.stateDir("s4"), "away.json"), big);
    const over = query(b, ["--session", "s4"]);
    assert.equal(over.status, 0);
    assert.equal(over.json.ok, false);
    assert.match(over.json.error, new RegExp(`away\\.json is ${big.length} bytes, over the ${AWAY_MAX_BYTES} byte limit$`));

    // An away.json that does not parse is home, the same reading the hooks make.
    mkdirSync(b.stateDir("s5"), { recursive: true });
    writeFileSync(join(b.stateDir("s5"), "away.json"), "{not json");
    assert.deepEqual(query(b, ["--session", "s5"]).json, { ok: true, away: false });

    // Nothing was written by any of the reads: the session directories hold only what the test put there.
    assert.deepEqual(readdirSync(b.stateDir("s4")), ["away.json"]);
    assert.deepEqual(readdirSync(b.stateDir("s5")), ["away.json"]);
  } finally {
    b.release();
  }
});

test("in process: snapshot and main agree with the subprocess, and main returns 0 after printing one JSON line", () => {
  const b = box();
  try {
    assert.deepEqual(snapshot("s1", { env: b.env }), { ok: true, away: false });
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
