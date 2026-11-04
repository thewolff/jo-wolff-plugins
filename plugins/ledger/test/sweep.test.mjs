// sweep.test.mjs — 0.3.2 leftover questions: doctor's `stale` check and the SessionStart
// auto-withdraw. Ages are set by backdating rows in SQL; the clock is real.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { sandbox, cli, hook, askQuestion, openDb, row, count } from "./helpers.mjs";
import { nowIso } from "../lib/time.mjs";

const H = 3_600_000;
const D = 24 * H;

/** Ask one question tagged with `sessionId`, then backdate it (and its session's end) as told. */
function leftover(b, { name, sessionId, askedAgoMs, endedAgoMs = null, cwd = b.work, extra = [] }) {
  const id = askQuestion(b, { name, sessionId, cwd, extra });
  const db = openDb(b);
  db.prepare("UPDATE cc_questions SET asked_at = ? WHERE id = ?").run(nowIso(Date.now() - askedAgoMs), id);
  if (sessionId) {
    db.prepare("INSERT INTO cc_sessions (id, cwd, started_at, ended_at, end_reason) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, end_reason = excluded.end_reason").run(
      sessionId,
      cwd,
      nowIso(Date.now() - askedAgoMs - H),
      endedAgoMs === null ? null : nowIso(Date.now() - endedAgoMs),
      endedAgoMs === null ? null : "exit",
    );
  }
  db.close();
  return id;
}

function doctor(b) {
  const r = cli(b, ["doctor"], { env: { LEDGER_REVIEW_BIN_CODEX: process.execPath, LEDGER_JUDGE_BIN: "echo yes" } });
  return { ...r, lines: r.out.trim().split("\n") };
}

test("D1 doctor stale: a question whose session ended more than 24h ago warns with the way out; a live session's, a just-ended session's and a CLI question do not", () => {
  const b = sandbox();
  const old = leftover(b, { name: "old", sessionId: "s-old", askedAgoMs: 3 * D, endedAgoMs: 2 * D });
  leftover(b, { name: "live", sessionId: "s-live", askedAgoMs: 3 * D, endedAgoMs: null });
  leftover(b, { name: "fresh", sessionId: "s-fresh", askedAgoMs: 2 * D, endedAgoMs: H });
  leftover(b, { name: "nosession", sessionId: null, askedAgoMs: 3 * D });
  const heldOld = leftover(b, { name: "heldold", sessionId: "s-held", askedAgoMs: 3 * D, endedAgoMs: 30 * H });
  assert.equal(cli(b, ["hold", heldOld]).code, 0);
  const r = doctor(b);
  assert.equal(r.code, 0, r.out);
  const stale = r.lines.find((l) => /^warn stale:/.test(l));
  assert.ok(stale, r.out);
  assert.match(stale, /^warn stale: 2 open or held question\(s\) whose session ended more than 24h ago: /);
  assert.ok(stale.includes(old) && stale.includes(heldOld), stale);
  assert.match(stale, /answer <id> <option>, withdraw <id>, or ask it again from a live session to adopt it$/);
  const detail = r.lines.filter((l) => l.startsWith("  ") && /^\s+q-/.test(l));
  assert.equal(detail.length, 2, r.out);
  assert.match(detail[0], /^\s+q-\S+  (open|held)  \S+ · asked \S+ · session ended \S+ · /);
  for (const other of ["live", "fresh", "nosession"]) assert.ok(!r.out.includes(` ${other} ·`), `${other} is not stale: ${r.out}`);
  // Nothing was changed by doctor.
  const db = openDb(b);
  assert.equal(count(db, "cc_questions", "state IN ('open','held')"), 5);
  db.close();
});

test("D2 auto-withdraw at SessionStart: rows older than 7 days whose session ended (or that had no session) are withdrawn with a note; younger, live-session and future-deadline rows stay", () => {
  const b = sandbox();
  const gone = leftover(b, { name: "gone", sessionId: "s-gone", askedAgoMs: 8 * D, endedAgoMs: 7 * D });
  const goneCli = leftover(b, { name: "gonecli", sessionId: null, askedAgoMs: 9 * D });
  const goneHeld = leftover(b, { name: "goneheld", sessionId: "s-goneheld", askedAgoMs: 10 * D, endedAgoMs: 9 * D });
  assert.equal(cli(b, ["hold", goneHeld]).code, 0);
  const young = leftover(b, { name: "young", sessionId: "s-young", askedAgoMs: 6 * D, endedAgoMs: 5 * D });
  const live = leftover(b, { name: "live", sessionId: "s-live", askedAgoMs: 8 * D, endedAgoMs: null });
  const due = leftover(b, { name: "due", sessionId: "s-due", askedAgoMs: 8 * D, endedAgoMs: 7 * D, extra: ["--deadline", "30d"] });
  const sibling = leftover(b, { name: "sib", sessionId: "s-sib", askedAgoMs: 8 * D, endedAgoMs: 7 * D, cwd: b.sibling });

  const r = hook(b, "session-start", { session_id: "s-new", cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.json.systemMessage ?? "", /^ledger: withdrew 4 question\(s\) asked more than 7 days ago whose session had ended: /m);
  const db = openDb(b);
  const state = (id) => row(db, "SELECT state FROM cc_questions WHERE id = ?", id).state;
  for (const id of [gone, goneCli, goneHeld, sibling]) assert.equal(state(id), "withdrawn", id);
  for (const id of [young, live, due]) assert.equal(state(id), id === goneHeld ? "held" : "open", id);
  const an = row(db, "SELECT word, answered_by, via FROM cc_answers WHERE question_id = ?", gone);
  assert.deepEqual({ ...an }, { word: "withdraw", answered_by: "ledger-sweep", via: "cli" });
  const note = row(db, "SELECT body, cwd, made_by FROM cc_notes WHERE question_id = ? AND kind = 'withdraw'", gone);
  assert.match(note.body, new RegExp(`^${gone} \\(gone\\) withdrawn by the sweep: asked \\S+, more than 7 day\\(s\\) ago, and its session ended \\S+; ask it again if it still matters$`));
  assert.equal(note.cwd, b.work);
  assert.match(row(db, "SELECT body FROM cc_notes WHERE question_id = ? AND kind = 'withdraw'", goneCli).body, /and it had no session; ask it again/);
  db.close();
  // The sweep's note is in the folder's log, and the context no longer lists the question.
  assert.match(cli(b, ["log", "10"]).out, /withdrawn by the sweep/);
  assert.ok(!r.json.hookSpecificOutput.additionalContext.includes(`${gone}  #`), "swept question is not pending");
  assert.ok(r.json.hookSpecificOutput.additionalContext.includes(`${young}  #`), "young question is still pending");
  // Rerun: nothing left to sweep, no notice.
  const again = hook(b, "session-start", { session_id: "s-new2", cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  assert.ok(!(again.json.systemMessage ?? "").includes("withdrew"), again.out);
});

test("D2 bounds: at most 20 rows per start, the rest next time; sweep.autoWithdrawDays 0 turns it off and 1 shortens it", () => {
  const b = sandbox();
  for (let i = 0; i < 23; i++) leftover(b, { name: `q${i}`, sessionId: null, askedAgoMs: 8 * D + i * H });
  const r = hook(b, "session-start", { session_id: "s-a", cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  assert.match(r.json.systemMessage, /withdrew 20 question\(s\)/);
  let db = openDb(b);
  assert.equal(count(db, "cc_questions", "state = 'withdrawn'"), 20);
  assert.equal(row(db, "SELECT name FROM cc_questions WHERE state = 'open' ORDER BY asked_at LIMIT 1").name, "q2", "oldest first");
  db.close();
  const r2 = hook(b, "session-start", { session_id: "s-b", cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  assert.match(r2.json.systemMessage, /withdrew 3 question\(s\)/);

  // Off.
  const off = sandbox();
  mkdirSync(join(off.env.XDG_CONFIG_HOME, "ledger"), { recursive: true });
  writeFileSync(join(off.env.XDG_CONFIG_HOME, "ledger", "config.json"), JSON.stringify({ sweep: { autoWithdrawDays: 0 } }));
  const stays = leftover(off, { name: "stays", sessionId: null, askedAgoMs: 30 * D });
  const ro = hook(off, "session-start", { session_id: "s-off", cwd: off.work, hook_event_name: "SessionStart", source: "startup" });
  assert.ok(!(ro.json.systemMessage ?? "").includes("withdrew"), ro.out);
  db = openDb(off);
  assert.equal(row(db, "SELECT state FROM cc_questions WHERE id = ?", stays).state, "open");
  db.close();

  // One day.
  const one = sandbox();
  mkdirSync(join(one.env.XDG_CONFIG_HOME, "ledger"), { recursive: true });
  writeFileSync(join(one.env.XDG_CONFIG_HOME, "ledger", "config.json"), JSON.stringify({ sweep: { autoWithdrawDays: 1 } }));
  const twoDays = leftover(one, { name: "twodays", sessionId: null, askedAgoMs: 2 * D });
  const r1 = hook(one, "session-start", { session_id: "s-one", cwd: one.work, hook_event_name: "SessionStart", source: "startup" });
  assert.match(r1.json.systemMessage, /withdrew 1 question\(s\) asked more than 1 days ago/);
  db = openDb(one);
  assert.equal(row(db, "SELECT state FROM cc_questions WHERE id = ?", twoDays).state, "withdrawn");
  db.close();
});

test("D2 on a read-only database: nothing is swept, the start still injects and says the session was not recorded", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const b = sandbox();
  const gone = leftover(b, { name: "gone", sessionId: null, askedAgoMs: 8 * D });
  chmodSync(b.dbPath, 0o444);
  const r = hook(b, "session-start", { session_id: "s-ro", cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  chmodSync(b.dbPath, 0o644);
  assert.equal(r.code, 0, r.err);
  assert.match(r.json.systemMessage, /read-only .*this session was not recorded/);
  assert.ok(!r.json.systemMessage.includes("withdrew"), r.out);
  assert.ok(r.json.hookSpecificOutput.additionalContext.includes(`${gone}  #`), "still listed");
  const db = openDb(b);
  assert.equal(count(db, "cc_questions", "state = 'withdrawn'"), 0);
  db.close();
});
