import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { sandbox, hook, cli, openDb, apply, row } from "./helpers.mjs";
import { buildInjection, CAP, allowRule, invocation, shellPath, cliPath, truncate } from "../lib/inject.mjs";
import { loadConfig } from "../lib/config.mjs";

const box = sandbox();
const start = (extra = {}) => ({ session_id: "s-start", cwd: box.work, hook_event_name: "SessionStart", source: "startup", ...extra });
const end = (extra = {}) => ({ session_id: "s-start", cwd: box.work, hook_event_name: "SessionEnd", reason: "other", ...extra });

test("an empty db → only the verb summary, with the exact invocation and the allow rule; the session row is written", () => {
  const r = hook(box, "session-start", start());
  assert.equal(r.code, 0, r.err);
  const text = r.json.hookSpecificOutput.additionalContext;
  assert.equal(r.json.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(text, /^ledger: questions to the human and decisions made without asking are recorded with the `ledger` CLI/);
  assert.ok(text.includes(`Always run it exactly as \`${invocation()} <verb> …\``), text);
  assert.ok(text.includes(allowRule()), text);
  assert.ok(!text.includes("open questions"));
  assert.ok(!text.includes("entries for"));
  const db = openDb(box);
  assert.equal(db.prepare("SELECT cwd FROM cc_sessions WHERE id = 's-start'").get().cwd, box.work);
  db.close();
});

test("with one open question and two notes → questions, then the last entries, then the verbs; compact drops the entries and the verb list", () => {
  const q = /q-[a-z0-9]+/.exec(cli(box, ["ask", "Which?", "--name", "which", "--options", "a,b"]).out)[0];
  cli(box, ["note", "first note"]);
  cli(box, ["note", "second note"]);
  const r = hook(box, "session-start", start());
  const text = r.json.hookSpecificOutput.additionalContext;
  const i = (s) => text.indexOf(s);
  assert.ok(i("ledger: open questions for") >= 0, text);
  assert.ok(i(`a ${q}  # which · Which?`) > 0);
  assert.ok(i("ledger: last 3 entries for") > i("ledger: open questions for"), text);
  assert.ok(i("second note") < i("first note"));
  assert.ok(i("first note") < i(`agent asked: which`));
  assert.ok(i("Verbs:") > i("entries for"));
  const compact = hook(box, "session-start", start({ source: "compact" })).json.hookSpecificOutput.additionalContext;
  assert.ok(compact.includes(q));
  assert.equal(compact.indexOf("entries for"), -1);
  assert.equal(compact.indexOf("Verbs:"), -1);
  assert.ok(compact.includes(invocation()), compact);
});

test("200 notes seeded with inject.notes 200 → injection under the cap, questions intact, entries truncated first", () => {
  const b = sandbox();
  const q = /q-[a-z0-9]+/.exec(cli(b, ["ask", "Still here?", "--name", "here", "--options", "yes,no"]).out)[0];
  b.writeConfig({ inject: { notes: 200 } });
  apply(b, Array.from({ length: 200 }, (_, i) => ({ tokens: ["note", `note number ${i} ${"x".repeat(80)}`], text: "" })));
  const db = openDb(b);
  const { text, sections } = buildInjection(db, b.work, loadConfig({ env: b.env, cwd: b.work }).config);
  db.close();
  assert.ok(text.length <= CAP, String(text.length));
  assert.ok(text.includes(q));
  assert.deepEqual(sections, ["questions", "notes", "summary"]);
  assert.match(text, /… \(truncated\)/);
});

test("truncate never exceeds its budget, marker included, whatever the line layout (the macOS CI case)", () => {
  const block = Array.from({ length: 60 }, (_, i) => `line ${i} ${"y".repeat(i % 23)}`).join("\n");
  for (let max = 40; max < block.length + 5; max++) {
    const out = truncate(block, max);
    assert.ok(out.length <= max, `max ${max} gave ${out.length}`);
    if (out.length < block.length) assert.match(out, /\n… \(truncated\)$/);
  }
  assert.equal(truncate(block, 39), "");
  assert.equal(truncate("", 100), "");
});

test("inject.notes 0 → no entries section even with notes recorded", () => {
  const b = sandbox();
  cli(b, ["note", "quiet"]);
  b.writeConfig({ inject: { notes: 0 } });
  const db = openDb(b);
  const { sections } = buildInjection(db, b.work, loadConfig({ env: b.env, cwd: b.work }).config);
  db.close();
  assert.deepEqual(sections, ["summary"]);
});

test("SessionEnd stamps ended_at and the reason on the session row, prints nothing, and is quick; nothing else changes", () => {
  const b = sandbox();
  const q = /q-[a-z0-9]+/.exec(cli(b, ["ask", "Open at end?", "--name", "end", "--options", "a,b"]).out)[0];
  hook(b, "session-start", { ...start(), cwd: b.work, session_id: "s-end" });
  const t0 = performance.now();
  const r = hook(b, "session-end", { ...end(), cwd: b.work, session_id: "s-end" });
  const ms = performance.now() - t0;
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "");
  assert.ok(ms < 500, `SessionEnd took ${ms.toFixed(0)} ms`);
  const db = openDb(b);
  const s = row(db, "SELECT cwd, end_reason, ended_at FROM cc_sessions WHERE id = 's-end'");
  assert.equal(s.cwd, b.work);
  assert.equal(s.end_reason, "other");
  assert.ok(Date.parse(s.ended_at) > Date.now() - 60_000);
  assert.equal(db.prepare("SELECT state FROM cc_questions WHERE id = ?").get(q).state, "open", "questions are left as they are");
  db.close();
  const clear = hook(b, "session-end", { ...end(), cwd: b.work, session_id: "s-unseen", reason: "clear" });
  assert.equal(clear.out, "");
  const db2 = openDb(b);
  assert.equal(db2.prepare("SELECT end_reason FROM cc_sessions WHERE id = 's-unseen'").get().end_reason, "clear", "a session the start hook never saw still gets a row");
  db2.close();
});

test("fail-open table (SessionEnd): `not json` → exit 0, nothing on stdout, one line in errors.log", () => {
  const b = sandbox();
  const r = hook(b, "session-end", "not json");
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.ok(existsSync(b.errorsLog));
  const lines = readFileSync(b.errorsLog, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT.*Z SessionEnd stdin not JSON: /);
});

test("hooks.sessionStart false and hooks.sessionEnd false → nothing happens, no db is created", () => {
  const b = sandbox();
  b.writeConfig({ hooks: { sessionStart: false, sessionEnd: false } });
  const r = hook(b, "session-start", { ...start(), cwd: b.work });
  assert.equal(r.out, "");
  const e = hook(b, "session-end", { ...end(), cwd: b.work });
  assert.equal(e.out, "");
  assert.ok(!existsSync(b.dbPath));
});

test("allowRule: a marketplace cache path gets a version wildcard; any other path is exact; spaces are quoted", () => {
  assert.equal(allowRule("/h/.claude/plugins/cache/jo-wolff-plugins/ledger/0.2.0/scripts/ledger.mjs"), "Bash(node /h/.claude/plugins/cache/jo-wolff-plugins/ledger/*/scripts/ledger.mjs *)");
  assert.equal(allowRule("/src/jo-wolff-plugins/plugins/ledger/scripts/ledger.mjs"), "Bash(node /src/jo-wolff-plugins/plugins/ledger/scripts/ledger.mjs *)");
  assert.equal(allowRule("/My Dir/plugins/ledger/scripts/ledger.mjs"), 'Bash(node "/My Dir/plugins/ledger/scripts/ledger.mjs" *)');
  assert.equal(shellPath("/plain/path"), "/plain/path");
  assert.equal(invocation("/plain/path"), "node /plain/path");
  assert.ok(cliPath().endsWith("/plugins/ledger/scripts/ledger.mjs"));
});
