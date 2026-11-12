import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { sandbox, hook, cli, apply, idOf } from "./helpers.mjs";

const SID = "s-up-owed";
const prompt = (box, text) => hook(box, "user-prompt", { session_id: SID, cwd: box.work, hook_event_name: "UserPromptSubmit", prompt: text });
const seed = (box) => cli(box, ["note", "seed"]);

test("a prose prompt with nothing owed returns nothing", () => {
  const box = sandbox();
  seed(box);
  const r = prompt(box, "what does the cache TTL default to?");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "");
});

test("one owed item is listed for Claude, with the ways out, and the output has no decision field", () => {
  const box = sandbox();
  seed(box);
  const id = idOf(apply(box, 'owe "Build the weekly digest exporter"', { sessionId: SID }));
  const r = prompt(box, "sounds good, but first, what does the cache TTL default to?");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.decision, undefined);
  assert.equal(r.json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^ledger: approved work still owed \(not started\)\. A new topic does not cancel it/);
  assert.match(ctx, /start <ow-id> "<agent id, session or command>".*hold <ow-id> "<why, until when>".*drop <ow-id> "<why>"/);
  assert.ok(ctx.includes(`- Build the weekly digest exporter (${id}, owed `), ctx);
  assert.equal(r.json.systemMessage, undefined, "the list is for Claude only");
});

test("thirty owed items: ten lines and the pointer to pending", () => {
  const box = sandbox();
  seed(box);
  apply(box, Array.from({ length: 30 }, (_, n) => `owe "work item ${n}"`), { sessionId: SID });
  const ctx = prompt(box, "next thing").json.hookSpecificOutput.additionalContext;
  assert.equal(ctx.split("\n").filter((l) => l.startsWith("- work item")).length, 10);
  assert.match(ctx, /… and 20 more; run `.*pending`$/);
});

test("started, held, dropped, done and another session's items are not listed", () => {
  const box = sandbox();
  seed(box);
  const ids = idOf(apply(box, ['owe "a"'], { sessionId: SID }));
  apply(box, [`start ${ids} "agent a1"`], { sessionId: SID });
  apply(box, ['owe "theirs"'], { sessionId: "s-other" });
  assert.equal(prompt(box, "hello there").out, "");
});

test("fail open: a broken owed table logs and the prompt passes with nothing added", () => {
  const box = sandbox();
  seed(box);
  apply(box, 'owe "x"', { sessionId: SID });
  const raw = new DatabaseSync(box.dbPath);
  raw.exec("PRAGMA foreign_keys = OFF; DROP TABLE cc_owed_moves; DROP TABLE cc_owed;");
  raw.close();
  const r = prompt(box, "hello there");
  assert.equal(r.code, 0, r.err);
  assert.notEqual(r.json?.decision, "block");
});
