import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sandbox, hook, cli, openDb } from "./helpers.mjs";
import { MIGRATIONS, open, storeVersion } from "../lib/db.mjs";

const A = "s-asker";
const B = "s-other";

/** Session A started, one question asked in it, and a first prompt so A has a mark. */
function setup(box, name = "colour") {
  hook(box, "session-start", { session_id: A, cwd: box.work, hook_event_name: "SessionStart", source: "startup" });
  const q = /q-[a-z0-9]+/.exec(cli(box, ["ask", `Which ${name}?`, "--name", name, "--options", "green,red"], { env: { LEDGER_SESSION_ID: A } }).out)[0];
  assert.equal(prompt(box).out, "");
  return q;
}
const prompt = (box, text = "carry on with the refactor") => hook(box, "user-prompt", { session_id: A, cwd: box.work, hook_event_name: "UserPromptSubmit", prompt: text });
const context = (r) => {
  assert.equal(r.code, 0, r.err);
  return r.json?.hookSpecificOutput?.additionalContext ?? null;
};

test("session B answers A's question → A's next prompt gets the line; the prompt after that gets nothing", () => {
  const box = sandbox();
  const q = setup(box);
  cli(box, ["answer", q, "red"], { env: { LEDGER_SESSION_ID: B }, cwd: box.sibling });
  const first = prompt(box);
  assert.equal(context(first), "ledger: answered since your last turn: colour → red (via cli)");
  assert.equal(first.json.systemMessage, undefined);
  assert.equal(prompt(box).out, "");
});

test("an answer recorded before the session's mark → nothing", () => {
  const box = sandbox();
  const q = setup(box);
  cli(box, ["answer", q, "green"], { env: { LEDGER_SESSION_ID: B } });
  const db = openDb(box);
  db.prepare("UPDATE cc_sessions SET last_prompt_seen_at = ? WHERE id = ?").run(new Date(Date.now() + 1000).toISOString(), A);
  db.close();
  assert.equal(prompt(box).out, "");
});

test("an answer A recorded itself → nothing", () => {
  const box = sandbox();
  const q = setup(box);
  cli(box, ["answer", q, "green"], { env: { LEDGER_SESSION_ID: A } });
  assert.equal(prompt(box).out, "");
});

test("withdrawn elsewhere → the withdrawn line; with ledger lines in the same prompt, it comes first", () => {
  const box = sandbox();
  const q = setup(box, "size");
  cli(box, ["withdraw", q], { env: { LEDGER_SESSION_ID: B } });
  const text = context(prompt(box, "pending"));
  assert.ok(text.startsWith("ledger: answered since your last turn: size withdrawn (via cli)\n\nledger applied the lines in this prompt"), text);
});

test("inject.answers false → nothing", () => {
  const box = sandbox();
  const q = setup(box);
  box.writeConfig({ inject: { answers: false } });
  cli(box, ["answer", q, "red"], { env: { LEDGER_SESSION_ID: B } });
  assert.equal(prompt(box).out, "");
});

test("the prompt hook switched off → exit 0, no output, no crash", () => {
  const box = sandbox();
  const q = setup(box);
  box.writeConfig({ hooks: { userPromptCommands: false } });
  cli(box, ["answer", q, "red"], { env: { LEDGER_SESSION_ID: B } });
  const r = prompt(box);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "");
});

test("an ordinary prompt with no database yet does not create one", () => {
  const box = sandbox();
  const r = prompt(box);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "");
  assert.equal(existsSync(box.dbPath), false);
});

test("migration 5: a store at version 4 keeps its rows and gains the answer session and the prompt mark", () => {
  const box = sandbox();
  const dir = join(box.root, "v4");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "ledger.db");
  const old = new DatabaseSync(p);
  old.exec("PRAGMA foreign_keys = ON");
  old.exec("CREATE TABLE cc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const m of MIGRATIONS.slice(0, 4)) m(old);
  old.exec("INSERT INTO cc_meta VALUES ('schema_version', '4')");
  old.exec(`INSERT INTO cc_questions (id, cwd, name, body, options, default_opt, state, asked_by, asked_at, resolved_at)
            VALUES ('q-a1', '/w', 'a', 'A?', '["yes","no"]', 'yes', 'answered', 'agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z')`);
  old.exec("INSERT INTO cc_answers VALUES ('an-1', 'q-a1', 'yes', 'jo', '2026-01-01T00:01:00.000Z', 'cli')");
  old.exec("INSERT INTO cc_sessions (id, cwd, started_at) VALUES ('s-1', '/w', '2026-01-01T00:00:00.000Z')");
  old.close();
  const { db } = open(p);
  assert.equal(storeVersion(db), 7);
  assert.deepEqual({ ...db.prepare("SELECT id, word, session_id FROM cc_answers").get() }, { id: "an-1", word: "yes", session_id: null });
  assert.deepEqual({ ...db.prepare("SELECT id, last_prompt_seen_at FROM cc_sessions").get() }, { id: "s-1", last_prompt_seen_at: null });
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});
