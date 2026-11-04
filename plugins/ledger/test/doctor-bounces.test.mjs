import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../lib/config.mjs";
import { logError } from "../lib/failopen.mjs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, open, storeVersion } from "../lib/db.mjs";
import { stopRemedyDone } from "../lib/bounces.mjs";
import { sandbox, cli, hook, openDb, row, count, askQuestion } from "./helpers.mjs";

const DECISION = "I decided to keep the cache in memory because the file is small enough.";

function start(b, sid, source = "startup") {
  return hook(b, "session-start", { session_id: sid, cwd: b.work, hook_event_name: "SessionStart", source });
}
function stop(b, sid, prompt_id, message, active = false) {
  return hook(b, "stop", { session_id: sid, cwd: b.work, hook_event_name: "Stop", prompt_id, stop_hook_active: active, last_assistant_message: message });
}
function bounces(b, where = "1=1", ...params) {
  const db = openDb(b);
  try {
    return db.prepare(`SELECT session_id, rule, prompt_id, tool, outcome, satisfied_at FROM cc_bounces WHERE ${where} ORDER BY id`).all(...params).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

test("(a) a Stop bounce inserts a bounce row; the satisfying note and the next Stop mark it satisfied", () => {
  const b = sandbox();
  start(b, "s-a");
  const first = stop(b, "s-a", "p-1", DECISION);
  assert.equal(first.json?.decision, "block", first.out);
  let rows = bounces(b);
  assert.deepEqual(rows.map(({ satisfied_at, ...r }) => r), [{ session_id: "s-a", rule: "stopDecisionRule", prompt_id: "p-1", tool: null, outcome: null }]);
  cli(b, ["note", "cache stays in memory"], { env: { LEDGER_SESSION_ID: "s-a" } });
  assert.equal(stop(b, "s-a", "p-1", DECISION, true).out, "");
  rows = bounces(b);
  assert.equal(rows[0].outcome, "satisfied");
  assert.ok(rows[0].satisfied_at);
});

test("(a) a Stop bounce whose remedy did not happen stays open at the next Stop of that prompt", () => {
  const b = sandbox();
  start(b, "s-a2");
  stop(b, "s-a2", "p-1", DECISION);
  assert.equal(stop(b, "s-a2", "p-1", "Done, nothing else to report from this turn of work.", true).out, "");
  assert.equal(bounces(b)[0].outcome, null);
});

test("(b) a PreToolUse deny inserts a row; a later allow for the same rule marks it satisfied", () => {
  const b = sandbox();
  start(b, "s-b");
  const ask = () => hook(b, "pre-tool-use", { session_id: "s-b", prompt_id: "p-1", cwd: b.work, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: {} });
  const push = () => hook(b, "pre-tool-use", { session_id: "s-b", cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin HEAD" } });
  assert.equal(ask().json?.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(push().json?.hookSpecificOutput?.permissionDecision, "deny");
  let rows = bounces(b);
  assert.deepEqual(rows.map((r) => [r.rule, r.tool, r.prompt_id, r.outcome]), [
    ["denyAskWithoutRow", "AskUserQuestion", "p-1", null],
    ["pushNeedsNote", "Bash", null, null],
  ]);
  cli(b, ["ask", "Ship it?", "--name", "ship", "--options", "yes,no"], { env: { LEDGER_SESSION_ID: "s-b" } });
  assert.equal(ask().out, "");
  rows = bounces(b);
  assert.deepEqual(rows.map((r) => r.outcome), ["satisfied", null], "only the rule that passed is satisfied");
  cli(b, ["note", "pushing the fix"], { env: { LEDGER_SESSION_ID: "s-b" } });
  assert.equal(push().out, "");
  assert.deepEqual(bounces(b).map((r) => r.outcome), ["satisfied", "satisfied"]);
  // A Bash call that is not a push does not touch the rows.
  assert.equal(hook(b, "pre-tool-use", { session_id: "s-b", cwd: b.work, tool_name: "Bash", tool_input: { command: "ls" } }).out, "");
});

test("(c) SessionEnd marks the session's open rows bypassed and leaves other sessions alone", () => {
  const b = sandbox();
  start(b, "s-c");
  start(b, "s-other");
  stop(b, "s-c", "p-1", DECISION);
  stop(b, "s-other", "p-1", DECISION);
  hook(b, "session-end", { session_id: "s-c", cwd: b.work, hook_event_name: "SessionEnd", reason: "exit" });
  assert.deepEqual(bounces(b).map((r) => [r.session_id, r.outcome]), [
    ["s-c", "bypassed"],
    ["s-other", null],
  ]);
});

test("(d) bounces counts per rule; --since 1h leaves out older rows", () => {
  const b = sandbox();
  const db = openDb(b);
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const ins = db.prepare("INSERT INTO cc_bounces (session_id, rule, tool, at, outcome) VALUES (?,?,?,?,?)");
  ins.run("sess-aaaaaaaa1", "pushNeedsNote", "Bash", ago(60_000), "satisfied");
  ins.run("sess-aaaaaaaa1", "pushNeedsNote", "Bash", ago(120_000), null);
  ins.run("sess-bbbbbbbb2", "pushNeedsNote", "Bash", ago(3 * 3_600_000), "bypassed");
  ins.run("sess-bbbbbbbb2", "stopDecisionRule", null, ago(2 * 3_600_000), "satisfied");
  ins.run("sess-old", "stopAskRule", null, ago(10 * 86_400_000), "bypassed");
  db.close();
  const week = cli(b, ["bounces"]);
  assert.equal(week.code, 0, week.err);
  const lines = week.out.split("\n");
  assert.match(lines[0], /^bounces since .* \(7d\)$/);
  assert.match(lines[1], /^rule\s+fired  satisfied  bypassed  open$/);
  assert.match(lines[2], /^pushNeedsNote\s+3\s+1\s+1\s+1$/);
  assert.match(lines[3], /^stopDecisionRule\s+1\s+1\s+0\s+0$/);
  assert.ok(!week.out.includes("stopAskRule"), "a row older than 7d is out");
  assert.match(week.out, /last 4:\n#\d+ \S+  sess-aaa  pushNeedsNote\s+Bash\s+satisfied\n/);
  const hour = cli(b, ["bounces", "--since", "1h"]).out;
  assert.match(hour, /^pushNeedsNote\s+2\s+1\s+0\s+1$/m);
  assert.ok(!hour.includes("stopDecisionRule"), hour);
  assert.match(cli(b, ["bounces", "--since", "soon"]).out, /usage: bounces/);
});

function doctor(b, env = {}) {
  const r = cli(b, ["doctor"], { env });
  return { ...r, lines: r.out.trim().split("\n").filter((l) => !l.startsWith(" ")) };
}

test("(e) doctor on a healthy store: every check ok, exit 0", () => {
  const b = sandbox();
  openDb(b).close();
  const r = doctor(b, { LEDGER_REVIEW_BIN_CODEX: process.execPath, LEDGER_JUDGE_BIN: "echo yes" });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.lines.map((l) => l.split(":")[0]), ["ok   db", "ok   schema", "ok   config", "ok   hooks", "ok   errors", "ok   bounces", "ok   stale", "ok   digest", "ok   decision log", "ok   review codex", "ok   judge"]);
  assert.match(r.out, /config: db from env, enabled = true from env/);
});

test("(f) doctor on a missing db: warn, exit 0, and the file is still not there", () => {
  const b = sandbox();
  const r = doctor(b);
  assert.equal(r.code, 0, r.out);
  assert.match(r.lines[0], /^warn db: db does not exist yet at /);
  assert.equal(existsSync(b.dbPath), false);
});

test("(g) doctor on a store at an older schema version: fail, exit 1, and the store is not migrated", () => {
  const b = sandbox();
  const db = openDb(b);
  db.exec("UPDATE cc_meta SET value = '5' WHERE key = 'schema_version'");
  db.close();
  const r = doctor(b);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^fail schema: version 5, this plugin expects 8$/m);
  const raw = new DatabaseSync(b.dbPath);
  assert.equal(storeVersion(raw), 5, "doctor never writes");
  raw.close();
});

test("(h) two recent errors.log lines for this database: doctor warns per hook and SessionStart ends with the doctor line, compact too", () => {
  const b = sandbox();
  openDb(b).close();
  mkdirSync(dirname(b.errorsLog), { recursive: true });
  const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
  const now = new Date().toISOString();
  writeFileSync(b.errorsLog, `${old} Stop ancient [db ${b.dbPath}]\n${now} Stop boom one [db ${b.dbPath}]\n${now} PreToolUse boom two [db ${b.dbPath}]\n`);
  const r = doctor(b);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^warn errors: 2 errors\.log line\(s\) for this database in the last 7 days: PreToolUse 1, Stop 1 /m);
  assert.match(r.out, /^ {7}\S+ PreToolUse boom two$/m);
  assert.ok(!r.out.includes("ancient"));
  for (const source of ["startup", "compact"]) {
    const ctx = start(b, `s-h-${source}`, source).json.hookSpecificOutput.additionalContext;
    assert.match(ctx.split("\n\n").at(-1), /^ledger: doctor reports 1 issue\(s\); run `node .*ledger\.mjs doctor`$/, source);
  }
});

test("(h2) errors.log lines for another database or from ledger 0.2.x are not counted: doctor ok, no SessionStart doctor line", () => {
  // The live run: 0.2.3 wrote untagged lines against another database in the same state folder.
  const b = sandbox();
  openDb(b).close();
  mkdirSync(dirname(b.errorsLog), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(b.errorsLog, `${now} SessionEnd ledger: database read-only at /elsewhere/ledger.db: attempt to write a readonly database\n${now} Stop boom [db /elsewhere/ledger.db]\n`);
  const r = doctor(b);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ok {3}errors: no errors\.log lines for this database in the last 7 days \(.*; 2 other line\(s\) are for another database or an older ledger, not counted\)$/m);
  assert.ok(!start(b, "s-h2").json.hookSpecificOutput.additionalContext.includes("doctor reports"));
  // A line logged after this sandbox's config loaded carries its database, and doctor counts it.
  loadConfig({ env: b.env, cwd: b.work });
  logError("Stop", "boom here", b.env);
  assert.match(readFileSync(b.errorsLog, "utf8").trim().split("\n").at(-1), / Stop boom here \[db .*\]$/);
  assert.match(doctor(b).out, /^warn errors: 1 errors\.log line\(s\) for this database/m);
});

test("(i) inject.doctor false: no doctor line", () => {
  const b = sandbox();
  openDb(b).close();
  mkdirSync(dirname(b.errorsLog), { recursive: true });
  writeFileSync(b.errorsLog, `${new Date().toISOString()} Stop boom [db ${b.dbPath}]\n`);
  b.writeConfig({ inject: { doctor: false } });
  const ctx = start(b, "s-i").json.hookSpecificOutput.additionalContext;
  assert.ok(!ctx.includes("doctor reports"), ctx);
});

test("(j) a version 5 store migrates to 8 keeping its rows; the new tables are empty and the judge words move", () => {
  const b = sandbox();
  const p = join(b.root, "v5.db");
  const old = new DatabaseSync(p);
  old.exec("CREATE TABLE cc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const m of MIGRATIONS.slice(0, 5)) m(old);
  old.exec("INSERT INTO cc_meta VALUES ('schema_version', '5')");
  old.exec("INSERT INTO cc_notes (id, cwd, kind, body, made_by, made_at) VALUES ('nt-1', '/w', 'note', 'kept', 'agent', '2026-01-01T00:00:00.000Z')");
  old.exec("INSERT INTO cc_sessions (id, cwd, started_at, last_block_rule) VALUES ('s-1', '/w', '2026-01-01T00:00:00.000Z', 'stopAskRule')");
  old.exec("INSERT INTO cc_meta VALUES ('judge:abc', 'yes')");
  old.exec("INSERT INTO cc_meta VALUES ('judge:def', 'maybe')");
  old.close();
  const { db } = open(p);
  assert.equal(storeVersion(db), 8);
  // 7: the judge's words moved to cc_judge_cache (a passage is "not kept" for them); a value that
  // is not yes|no is dropped rather than failing the migration.
  assert.deepEqual(db.prepare("SELECT key, answer, passage FROM cc_judge_cache ORDER BY key").all().map((r) => ({ ...r })), [{ key: "judge:abc", answer: "yes", passage: null }]);
  assert.equal(count(db, "cc_meta", "key LIKE 'judge:%'"), 0);
  assert.equal(count(db, "cc_canary_runs"), 0);
  assert.equal(count(db, "cc_gate_checks"), 0);
  // 8: the canary rows gained tree_sha and writes; the prune table exists and is empty.
  assert.deepEqual(db.prepare("PRAGMA table_info(cc_canary_runs)").all().map((c) => c.name).filter((n) => n === "tree_sha" || n === "writes"), ["tree_sha", "writes"]);
  assert.equal(count(db, "cc_canary_prunes"), 0);
  assert.deepEqual(row(db, "SELECT id, body FROM cc_notes"), { id: "nt-1", body: "kept" });
  assert.equal(row(db, "SELECT last_block_rule FROM cc_sessions").last_block_rule, "stopAskRule");
  assert.equal(count(db, "cc_bounces"), 0);
  assert.equal(count(db, "cc_reviews"), 0);
  assert.throws(() => db.exec("INSERT INTO cc_bounces (rule, at, outcome) VALUES ('x', 'y', 'maybe')"), /CHECK/);
  db.close();
});

test("(k) doctor through stdin stays read-only: a lone `doctor` line does not create the store; inside a batch it is refused", () => {
  const b = sandbox();
  const r = cli(b, [], { input: "doctor\n" });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^warn db: /m);
  assert.ok(!existsSync(b.dbPath), "stdin doctor must not create the database");
  const mixed = cli(b, [], { input: "note checking\ndoctor\n" });
  assert.equal(mixed.code, 1);
  assert.match(mixed.out, /2: refused doctor runs on its own line/);
});

test("(l) an untagged answer to an untagged session question satisfies the stopAnswerRule bounce", () => {
  const b = sandbox();
  start(b, "s-l");
  const qid = askQuestion(b, { name: "untagged" });
  const db = openDb(b);
  try {
    const at = new Date().toISOString();
    db.prepare("INSERT INTO cc_bounces (session_id, rule, prompt_id, at) VALUES ('s-l', 'stopAnswerRule', 'p-1', ?)").run(at);
    const bounce = row(db, "SELECT * FROM cc_bounces WHERE session_id = 's-l'");
    assert.equal(stopRemedyDone(db, bounce, { sessionId: "s-l", cwd: b.work }), false, "nothing answered yet");
    const answered = cli(b, ["answer", qid, "a"]);
    assert.equal(answered.code, 0, answered.out + answered.err);
    assert.equal(stopRemedyDone(db, bounce, { sessionId: "s-l", cwd: b.work }), true);
    assert.equal(stopRemedyDone(db, bounce, { sessionId: "s-l", cwd: b.sibling }), false, "a question from an unrelated folder does not count");
  } finally {
    db.close();
  }
});

test("(m) SessionEnd under a held lock changes nothing: the end stamp and the bypass land together or not at all", () => {
  const b = sandbox();
  start(b, "s-m");
  stop(b, "s-m", "p-1", DECISION);
  const db = openDb(b);
  db.exec("BEGIN IMMEDIATE");
  const r = hook(b, "session-end", { session_id: "s-m", cwd: b.work, hook_event_name: "SessionEnd", reason: "exit" });
  db.exec("ROLLBACK");
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.equal(row(db, "SELECT ended_at FROM cc_sessions WHERE id = 's-m'").ended_at, null);
  assert.deepEqual(bounces(b).map((x) => x.outcome), [null]);
  db.close();
  hook(b, "session-end", { session_id: "s-m", cwd: b.work, hook_event_name: "SessionEnd", reason: "exit" });
  assert.deepEqual(bounces(b).map((x) => x.outcome), ["bypassed"]);
});

test("live run finding 1: a bounce bypassed at SessionEnd is satisfied by the remedy after a resume under the same session id", () => {
  const b = sandbox();
  const pushInput = (sid) => ({ session_id: sid, cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" } });
  start(b, "s-resume");
  assert.equal(hook(b, "pre-tool-use", pushInput("s-resume")).json.hookSpecificOutput.permissionDecision, "deny");
  hook(b, "session-end", { session_id: "s-resume", cwd: b.work, hook_event_name: "SessionEnd", reason: "other" });
  assert.deepEqual(bounces(b).map((x) => x.outcome), ["bypassed"]);
  start(b, "s-resume", "resume");
  cli(b, ["note", "pushing after the resume"], { env: { LEDGER_SESSION_ID: "s-resume" } });
  assert.equal(hook(b, "pre-tool-use", pushInput("s-resume")).json?.hookSpecificOutput?.permissionDecision ?? "allow", "allow");
  const [row] = bounces(b);
  assert.equal(row.outcome, "satisfied");
  assert.ok(row.satisfied_at);
});

test("live run finding 3, through the hook: a reply stating the default of a question asked this turn is not sent back", () => {
  const b = sandbox();
  start(b, "s-def");
  stop(b, "s-def", "p-0", "Ready.");
  cli(b, ["ask", "Which name for the helper?", "--name", "helper-name", "--options", "alpha,beta", "--default", "alpha"], { env: { LEDGER_SESSION_ID: "s-def" } });
  const r = stop(b, "s-def", "p-1", "Which name do you want for the helper, alpha or beta? If you don't answer, I'll go with alpha.");
  assert.equal(r.json?.decision, undefined, r.out);
});
