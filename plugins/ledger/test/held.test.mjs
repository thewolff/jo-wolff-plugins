// held.test.mjs — 0.2.1's held questions (formed, deliberately deferred for the human) and
// outcome notes (what a decision or an answered question produced), plus migration 3 that adds
// both to a store created by 0.2.0.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { open, MIGRATIONS, SCHEMA_VERSION, storeVersion } from "../lib/db.mjs";
import { buildInjection } from "../lib/inject.mjs";
import { DEFAULTS } from "../lib/config.mjs";
import { sandbox, apply, askQuestion, cli, hook, openDb, row, count } from "./helpers.mjs";

const box = sandbox();
const line = (tokens) => ({ tokens, text: tokens.join(" ") });
const one = (b, tokens, opts) => apply(b, [line(tokens)], opts).results[0];

test("migration 3: a store left at version 2 by 0.2.0 keeps every row, gains held and outcome, and keeps foreign keys on", () => {
  const dir = join(box.root, "v2");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "ledger.db");
  const old = new DatabaseSync(p);
  old.exec("PRAGMA foreign_keys = ON");
  old.exec("CREATE TABLE other_tool (x INTEGER)");
  old.exec("CREATE TABLE cc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  MIGRATIONS[0](old);
  MIGRATIONS[1](old);
  old.exec("INSERT INTO cc_meta VALUES ('schema_version', '2')");
  old.exec(`INSERT INTO cc_questions (id, cwd, name, body, options, default_opt, state, asked_by, asked_at, resolved_at)
            VALUES ('q-a1', '/w', 'a', 'A?', '["yes","no"]', 'yes', 'answered', 'agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'),
                   ('q-b2', '/w', 'b', 'B?', '["yes","no"]', 'yes', 'open', 'agent', '2026-01-01T00:02:00.000Z', NULL)`);
  old.exec("INSERT INTO cc_answers VALUES ('an-1', 'q-a1', 'yes', 'jo', '2026-01-01T00:01:00.000Z', 'cli')");
  old.exec("INSERT INTO cc_notes (id, cwd, kind, body, question_id, made_by, made_at) VALUES ('nt-1', '/w', 'note', 'kept', 'q-a1', 'agent', '2026-01-01T00:03:00.000Z')");
  old.exec("INSERT INTO cc_sessions (id, cwd, started_at, last_stop_prompt) VALUES ('s-1', '/w', '2026-01-01T00:00:00.000Z', 'p-1')");
  old.close();

  const r = open(p);
  const db = r.db;
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(storeVersion(db), 3);
  assert.equal(r.shared, true);
  assert.deepEqual(db.prepare("SELECT id, state, resolved_at FROM cc_questions ORDER BY id").all().map((x) => ({ ...x })), [
    { id: "q-a1", state: "answered", resolved_at: "2026-01-01T00:01:00.000Z" },
    { id: "q-b2", state: "open", resolved_at: null },
  ]);
  assert.deepEqual({ ...db.prepare("SELECT id, kind, body, question_id, ref FROM cc_notes").get() }, { id: "nt-1", kind: "note", body: "kept", question_id: "q-a1", ref: null });
  assert.equal(count(db, "cc_answers"), 1);
  assert.equal(row(db, "SELECT last_stop_prompt FROM cc_sessions WHERE id = 's-1'").last_stop_prompt, "p-1");
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'cc_questions_cwd_state'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'cc_notes_cwd_at'").get());
  db.exec("UPDATE cc_questions SET state = 'held' WHERE id = 'q-b2'");
  assert.throws(() => db.exec("INSERT INTO cc_answers VALUES ('an-2', 'q-nope', 'yes', 'jo', 'x', 'cli')"), /FOREIGN KEY/);
  db.close();
});

test("hold and reopen: open → held → open; resolved_at stays NULL while held; the schema refuses a resolved held row", () => {
  const b = sandbox();
  const q = askQuestion(b, { name: "later", options: "yes,no" });
  const held = one(b, ["hold", q]);
  assert.equal(held.status, "ok", held.message);
  assert.match(held.message, /held: waiting on the human/);
  assert.equal(one(b, ["hold", q]).status, "ok", "holding a held question is a no-op, reported ok");
  let db = openDb(b);
  assert.deepEqual(row(db, "SELECT state, resolved_at FROM cc_questions WHERE id = ?", q), { state: "held", resolved_at: null });
  assert.throws(() => db.prepare("UPDATE cc_questions SET resolved_at = 'x' WHERE id = ?").run(q), /CHECK/);
  db.close();
  const before = row(openDb(b), "SELECT asked_at FROM cc_questions WHERE id = ?", q).asked_at;
  const re = one(b, ["reopen", q], { now: Date.parse(before) + 60_000 });
  assert.equal(re.status, "ok", re.message);
  db = openDb(b);
  const after = row(db, "SELECT state, resolved_at, asked_at FROM cc_questions WHERE id = ?", q);
  db.close();
  assert.equal(after.state, "open");
  assert.equal(after.resolved_at, null);
  assert.ok(after.asked_at > before, "reopening is asking: asked_at moves to now");
  assert.match(one(b, ["reopen", q]).message, /already open/);
  one(b, ["answer", q, "yes"]);
  assert.match(one(b, ["hold", q]).message, /is answered; only an open question can be held/);
  assert.match(one(b, ["reopen", q]).message, /is answered; only a held question can be reopened/);
});

test("a held question is answerable and withdrawable, and asking the same body again points at reopen instead of a duplicate", () => {
  const b = sandbox();
  const q = askQuestion(b, { name: "h", body: "Hold me?", options: "yes,no" });
  one(b, ["hold", q]);
  const again = one(b, ["ask", "Hold me?", "--name", "h", "--options", "yes,no"]);
  assert.equal(again.id, q);
  assert.match(again.message, /already asked and held; run `reopen q-/);
  const a = one(b, ["answer", q, "no"]);
  assert.equal(a.status, "ok", a.message);
  const db = openDb(b);
  assert.equal(row(db, "SELECT state FROM cc_questions WHERE id = ?", q).state, "answered");
  db.close();
  const q2 = askQuestion(b, { name: "w", options: "yes,no" });
  one(b, ["hold", q2]);
  assert.equal(one(b, ["withdraw", q2]).status, "ok");
});

test("pending lists held rows marked `held` after the open ones; log marks a held question", () => {
  const b = sandbox();
  const open1 = askQuestion(b, { name: "now", options: "yes,no" });
  const h = askQuestion(b, { name: "deferred", body: "Rename the bucket?", options: "yes,no" });
  one(b, ["hold", h]);
  const r = cli(b, ["pending"]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split("\n");
  assert.match(lines[0], new RegExp(`^1\\. yes ${open1}`));
  assert.equal(lines.at(-1), `held ${h}  # deferred · Rename the bucket?`);
  assert.match(cli(b, ["log"]).out, new RegExp(`^${h} .* agent asked \\(held\\): deferred · Rename the bucket\\?$`, "m"));
  const onlyHeld = sandbox();
  const h2 = askQuestion(onlyHeld, { name: "x", options: "yes,no" });
  one(onlyHeld, ["hold", h2]);
  assert.match(cli(onlyHeld, ["pending"]).out, new RegExp(`^no open questions for .*\\nheld ${h2}  # x · `));
});

test("SessionStart: a Waiting on you block lists held questions, oldest first, before the open questions; compact keeps it", () => {
  const b = sandbox();
  const first = askQuestion(b, { name: "first-held", body: "Move the cron?", options: "yes,no", now: Date.parse("2026-11-03T10:00:00Z") });
  const second = askQuestion(b, { name: "second-held", body: "Drop the flag?", options: "yes,no", now: Date.parse("2026-11-03T10:01:00Z") });
  const open1 = askQuestion(b, { name: "open-one", options: "yes,no", now: Date.parse("2026-11-03T10:02:00Z") });
  one(b, ["hold", second]);
  one(b, ["hold", first]);
  const db = openDb(b);
  for (const source of ["startup", "compact"]) {
    const { text, sections } = buildInjection(db, b.work, DEFAULTS, { source });
    assert.deepEqual(sections.slice(0, 2), ["waiting", "questions"], source);
    assert.ok(text.startsWith("ledger: Waiting on you (held questions for "), text);
    const block = text.slice(0, text.indexOf("\n\n"));
    assert.deepEqual(block.split("\n").slice(1), [`- first-held: Move the cron? (${first})`, `- second-held: Drop the flag? (${second})`]);
    assert.ok(text.indexOf(open1) > block.length, "open questions come after");
  }
  db.close();
});

test("Stop answer rule ignores held questions: they were never put to the human", () => {
  const b = sandbox();
  const SID = "s-held";
  const env = { LEDGER_SESSION_ID: SID };
  hook(b, "session-start", { session_id: SID, cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  const q = /q-[a-z0-9]+/.exec(cli(b, ["ask", "Later?", "--name", "later", "--options", "yes,no"], { env }).out)[0];
  cli(b, ["hold", q], { env });
  const stop = (prompt_id) => hook(b, "stop", { session_id: SID, cwd: b.work, hook_event_name: "Stop", prompt_id, stop_hook_active: false, last_assistant_message: "Working on it; the tests are running and I will report back." });
  assert.equal(stop("p-1").out, "");
  assert.equal(stop("p-2").out, "", "a held question is not due after a human prompt");
});

test("outcome: needs a ref, links an optional question, and log prints the ref; it forces nothing", () => {
  const b = sandbox();
  const q = askQuestion(b, { name: "ship", options: "yes,no" });
  for (const bad of [["outcome"], ["outcome", "https://x/pr/1"], ["outcome", q]]) {
    const r = one(b, bad);
    assert.notEqual(r.status, "ok", bad.join(" "));
    assert.match(r.message, /outcome needs|outcome takes/, bad.join(" "));
  }
  assert.match(one(b, ["outcome", "https://x/pr/1", "q-nope0000000", "shipped"]).message, /no such question q-nope0000000/);
  const r = one(b, ["outcome", "https://github.com/o/r/pull/45", q, "opened the PR"]);
  assert.equal(r.status, "ok", r.message);
  assert.match(r.message, /^nt-[a-z0-9]+ outcome for .*: opened the PR → https:\/\/github\.com\/o\/r\/pull\/45 \(for q-/);
  const plain = one(b, ["outcome", "src/a.ts", "rewrote the cache"]);
  assert.equal(plain.status, "ok", plain.message);
  const log = cli(b, ["log"]).out;
  assert.match(log, new RegExp(`^${r.id} .* agent outcome: opened the PR → https://github\\.com/o/r/pull/45 \\(for ${q}\\)$`, "m"));
  assert.match(log, new RegExp(`^${plain.id} .* agent outcome: rewrote the cache → src/a\\.ts$`, "m"));
  const db = openDb(b);
  assert.throws(() => db.exec("INSERT INTO cc_notes (id, cwd, kind, body, made_by, made_at) VALUES ('nt-x1', '/w', 'outcome', 'no ref', 'a', 'x')"), /CHECK/);
  db.close();
  // An outcome is not a note: the push gate still wants a `note` in the session.
  const pre = hook(b, "pre-tool-use", { session_id: "s-o", cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" } });
  assert.equal(pre.json?.hookSpecificOutput?.permissionDecision, "deny");
  // Typed into a prompt it is never applied: outcome is a free-text verb.
  const typed = hook(b, "user-prompt", { session_id: "s-o", cwd: b.work, prompt: `outcome x ${q} "y"` });
  assert.match(typed.json.hookSpecificOutput.additionalContext, /1: not applied from a prompt/);
  const after = openDb(b);
  assert.equal(count(after, "cc_notes", "kind = 'outcome'"), 2);
  after.close();
});
