// 0.3.3 repro data: a bounce row keeps what fired the rule (the reply excerpt or the shell command,
// cut to 500 characters) and the transcript path the event named; the judge cache keeps the
// passage and question it was given, readable with `review judge <key>`.

import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, hook, cli, openDb, row } from "./helpers.mjs";
import { BOUNCE_TEXT_MAX, bounceText, oneLine } from "../lib/bounces.mjs";

const start = (box, sid) => hook(box, "session-start", { session_id: sid, cwd: box.work, hook_event_name: "SessionStart", source: "startup" });

test("a Stop bounce keeps the reply (cut to 500 chars with a marker) and the transcript path; `bounces` shows both", () => {
  const box = sandbox();
  start(box, "s-1");
  const long = "I compared both layouts and the trade-offs are even. ".repeat(12) + "Should I put the runner under plugins/ or inside ledger?";
  assert.ok(long.length > BOUNCE_TEXT_MAX);
  const r = hook(box, "stop", { session_id: "s-1", cwd: box.work, hook_event_name: "Stop", prompt_id: "p-1", stop_hook_active: false, last_assistant_message: long, transcript_path: "/Users/example/.claude/projects/x/s-1.jsonl" });
  assert.equal(r.json?.decision, "block", r.out);
  const b = row(openDb(box), "SELECT rule, text, transcript_path FROM cc_bounces");
  assert.equal(b.rule, "stopAskRule");
  assert.equal(b.text.length, BOUNCE_TEXT_MAX);
  assert.ok(b.text.endsWith("…"), b.text.slice(-10));
  assert.equal(b.text.slice(0, 40), long.slice(0, 40));
  assert.equal(b.transcript_path, "/Users/example/.claude/projects/x/s-1.jsonl");
  const out = cli(box, ["bounces"]).out;
  assert.match(out, /^#1 \S+  s-1 {5}  stopAskRule .* open\n {4}text: I compared both layouts/m);
  assert.match(out, /^ {4}transcript: \/Users\/example\/\.claude\/projects\/x\/s-1\.jsonl$/m);
});

test("a PreToolUse deny keeps the command; no transcript_path → NULL and the row is still written", () => {
  const box = sandbox();
  start(box, "s-2");
  const r = hook(box, "pre-tool-use", { session_id: "s-2", cwd: box.work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" } });
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, "deny", r.out);
  const b = row(openDb(box), "SELECT rule, tool, text, transcript_path FROM cc_bounces");
  assert.deepEqual({ ...b }, { rule: "pushNeedsNote", tool: "Bash", text: "git push origin main", transcript_path: null });
  assert.equal(bounceText("   "), null);
  assert.equal(bounceText("x".repeat(600)).length, BOUNCE_TEXT_MAX);
  assert.equal(oneLine("a\n\n  b   c", 4), "a b…");
});

test("review judge <key> prints a cached answer with its passage; an unknown key is exit 1 with the way out", () => {
  const box = sandbox();
  const db = openDb(box);
  db.prepare("INSERT INTO cc_judge_cache (key, question, passage, answer, at) VALUES (?, ?, ?, ?, ?)").run("judge:abc123", "Does the change address the finding?", "Finding:\nx\n\nChange:\ny", "no", "2026-11-03T00:00:00.000Z");
  db.prepare("INSERT INTO cc_judge_cache (key, answer) VALUES (?, ?)").run("judge:old", "yes");
  db.close();
  const r = cli(box, ["review", "judge", "abc123"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "judge:abc123\nanswer: no at 2026-11-03T00:00:00.000Z\nquestion: Does the change address the finding?\npassage:\nFinding:\nx\n\nChange:\ny\n");
  assert.match(cli(box, ["review", "judge", "judge:old"]).out, /question: \(not kept: cached before 0\.3\.2\)\npassage:\n\(not kept: cached before 0\.3\.2\)/);
  const miss = cli(box, ["review", "judge", "nope"]);
  assert.equal(miss.code, 1);
  assert.match(miss.out, /no cached judge answer for nope; keys are listed in `.* report`/);
});
