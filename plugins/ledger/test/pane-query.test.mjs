// pane-query.test.mjs — mods/pane/query.mjs: the snapshot the pane draws, in process and as the
// subprocess the mod runs. Elsewhere questions come from other folders only; answers since the
// session's prompt mark are the ones the UserPromptSubmit hook would inject next; every fault is
// `{ ok: false, error }` with exit 0.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, hook, cli, openDb, PLUGIN_ROOT } from "./helpers.mjs";
import { main, parseArgs, snapshot } from "../mods/pane/query.mjs";

const QUERY = join(PLUGIN_ROOT, "mods", "pane", "query.mjs");
const A = "s-asker";
const B = "s-other";

const startSession = (box, id, cwd) => hook(box, "session-start", { session_id: id, cwd, hook_event_name: "SessionStart", source: "startup" });
const prompt = (box, id, cwd) => hook(box, "user-prompt", { session_id: id, cwd, hook_event_name: "UserPromptSubmit", prompt: "carry on" });
const ask = (box, name, cwd, sessionId) => /q-[a-z0-9]+/.exec(cli(box, ["ask", `Which ${name}?`, "--name", name, "--options", "green,red", "--default", "green"], { cwd, env: { LEDGER_SESSION_ID: sessionId } }).out)[0];

/** Run query.mjs as the mod does: a subprocess with the sandbox env, JSON on stdout. */
function query(box, args, { env = {}, cwd = box.work } = {}) {
  const r = spawnSync(process.execPath, [QUERY, ...args], { cwd, env: { ...box.env, ...env }, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

test("parseArgs reads --session and --cwd and drops a session id with odd characters", () => {
  assert.deepEqual(parseArgs(["--session", "abc-123", "--cwd", "/work"]), { sessionId: "abc-123", cwd: "/work" });
  assert.deepEqual(parseArgs(["--session", "", "--cwd", "/work"]), { sessionId: null, cwd: "/work" });
  assert.deepEqual(parseArgs(["--session", "a b"]), { sessionId: null, cwd: null });
  assert.deepEqual(parseArgs([]), { sessionId: null, cwd: null });
});

test("elsewhere: a question in another folder is listed with body, options, default, state and age; this folder's own is not", () => {
  const box = sandbox();
  startSession(box, A, box.work);
  const own = ask(box, "own", box.work, A);
  const other = ask(box, "other", box.sibling, B);
  const db = openDb(box);
  const snap = snapshot(db, { sessionId: A, cwd: box.work, now: Date.now() + 5 * 60_000 });
  db.close();
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.elsewhere.map((q) => q.id), [other]);
  const [q] = snap.elsewhere;
  assert.equal(q.cwd, box.sibling);
  assert.equal(q.name, "other");
  assert.equal(q.body, "Which other?");
  assert.deepEqual(q.options, ["green", "red"]);
  assert.equal(q.default, "green");
  assert.equal(q.state, "open");
  assert.equal(q.age, "5m ago");
  assert.ok(q.asked_at);
  assert.notEqual(own, other);
});

test("answers: another session's answer on this session's question shows until this session's next prompt moves the mark", () => {
  const box = sandbox();
  startSession(box, A, box.work);
  const q = ask(box, "colour", box.work, A);
  assert.equal(prompt(box, A, box.work).out, "");
  cli(box, ["answer", q, "red"], { cwd: box.sibling, env: { LEDGER_SESSION_ID: B } });
  let db = openDb(box);
  let snap = snapshot(db, { sessionId: A, cwd: box.work });
  db.close();
  assert.deepEqual(snap.answers, [{ id: q, name: "colour", body: "Which colour?", state: "answered", word: "red", via: "cli" }]);
  assert.ok(snap.since, "the session's mark is the cursor");
  // The next prompt injects the line and moves the mark: the pane shows nothing new after it.
  assert.match(prompt(box, A, box.work).json.hookSpecificOutput.additionalContext, /colour → red/);
  db = openDb(box);
  snap = snapshot(db, { sessionId: A, cwd: box.work });
  db.close();
  assert.deepEqual(snap.answers, []);
});

test("answers: an answer this session recorded itself, and one before the mark, are left out; no session id → none", () => {
  const box = sandbox();
  startSession(box, A, box.work);
  const q = ask(box, "size", box.work, A);
  cli(box, ["answer", q, "red"], { env: { LEDGER_SESSION_ID: A } });
  let db = openDb(box);
  assert.deepEqual(snapshot(db, { sessionId: A, cwd: box.work }).answers, []);
  assert.deepEqual(snapshot(db, { sessionId: null, cwd: box.work }).answers, []);
  db.close();
  const q2 = ask(box, "shape", box.work, A);
  cli(box, ["withdraw", q2], { env: { LEDGER_SESSION_ID: B } });
  db = openDb(box);
  assert.deepEqual(snapshot(db, { sessionId: A, cwd: box.work }).answers, [{ id: q2, name: "shape", body: "Which shape?", state: "withdrawn", word: "withdraw", via: "cli" }]);
  db.prepare("UPDATE cc_sessions SET last_prompt_seen_at = ? WHERE id = ?").run(new Date(Date.now() + 1000).toISOString(), A);
  assert.deepEqual(snapshot(db, { sessionId: A, cwd: box.work }).answers, []);
  db.close();
});

test("as a subprocess: JSON on stdout, exit 0, the sibling's question and the session's new answer", () => {
  const box = sandbox();
  startSession(box, A, box.work);
  const q = ask(box, "colour", box.work, A);
  const other = ask(box, "other", box.sibling, B);
  cli(box, ["answer", q, "green"], { cwd: box.sibling, env: { LEDGER_SESSION_ID: B } });
  const r = query(box, ["--session", A, "--cwd", box.work]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "", "nothing on stderr");
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.elsewhere.map((x) => x.id), [other]);
  assert.deepEqual(r.json.answers.map((x) => [x.id, x.word]), [[q, "green"]]);
});

test("as a subprocess with no --cwd: the process cwd binds the folder", () => {
  const box = sandbox();
  const other = ask(box, "other", box.sibling, B);
  const r = query(box, [], { cwd: box.work });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.elsewhere.map((x) => x.id), [other]);
  assert.deepEqual(r.json.answers, []);
  assert.equal(r.json.since, null);
});

test("faults: an unwritable db directory → { ok: false, error } with exit 0 and an errors.log line", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const box = sandbox();
  const dir = join(box.root, "ro");
  mkdirSync(dir);
  chmodSync(dir, 0o500);
  try {
    const r = query(box, ["--cwd", box.work], { env: { LEDGER_DB: join(dir, "sub", "ledger.db") } });
    assert.equal(r.code, 0);
    assert.equal(r.err, "");
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /^ledger: database unavailable at /);
    assert.match(readFileSync(box.errorsLog, "utf8"), /pane-query ledger: database unavailable at/);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("faults: a corrupt db at an explicit path → { ok: false, error } naming the corruption, the file untouched", () => {
  const box = sandbox();
  writeFileSync(box.dbPath, "junk ".repeat(1000));
  const r = query(box, ["--cwd", box.work]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /database corrupt at .*not a database/);
  assert.equal(readFileSync(box.dbPath, "utf8"), "junk ".repeat(1000));
});

test("faults: a disabled folder → ok with disabled and nothing listed", () => {
  const box = sandbox();
  ask(box, "other", box.sibling, B);
  const r = query(box, ["--cwd", box.work], { env: { LEDGER_ENABLED: "0" } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json, { ok: true, disabled: true, since: null, elsewhere: [], answers: [] });
});

test("main() in process prints one JSON line and returns 0", () => {
  const box = sandbox();
  const other = ask(box, "other", box.sibling, B);
  let printed = "";
  const code = main(["--cwd", box.work], { env: box.env, out: (s) => (printed += s) });
  assert.equal(code, 0);
  assert.ok(printed.endsWith("\n"));
  assert.deepEqual(JSON.parse(printed).elsewhere.map((x) => x.id), [other]);
});
