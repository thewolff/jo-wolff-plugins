import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { sandbox, hook, cli, openDb, count, apply, row } from "./helpers.mjs";
import { buildInjection, CAP, allowRule, invocation, shellPath, cliPath } from "../lib/inject.mjs";
import { loadConfig } from "../lib/config.mjs";

const box = sandbox();
const start = (extra = {}) => ({ session_id: "s-start", cwd: box.work, hook_event_name: "SessionStart", source: "startup", ...extra });
const end = (extra = {}) => ({ session_id: "s-start", cwd: box.work, hook_event_name: "SessionEnd", reason: "other", ...extra });

test("step 6: an empty db → only the gate line and the verb summary, with the exact invocation and the allow rule", () => {
  const r = hook(box, "session-start", start());
  assert.equal(r.code, 0, r.err);
  const text = r.json.hookSpecificOutput.additionalContext;
  assert.equal(r.json.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(text, /^No open workload for this folder: pushes, PR creation and writes outside it are denied until/);
  assert.ok(text.includes(`Always run it exactly as \`${invocation()} <verb> …\``), text);
  assert.ok(text.includes(allowRule()), text);
  assert.ok(!text.includes("open questions"));
  assert.ok(!text.includes("decisions:"));
  const db = openDb(box);
  assert.equal(db.prepare("SELECT cwd FROM sessions WHERE id = 's-start'").get().cwd, box.work);
  db.close();
});

test("step 6: with one open workload, one open question and two decisions → sections in § 4.1 order; compact drops decisions and the verb list", () => {
  const wl = /wl-[a-z0-9]+/.exec(cli(box, ["open", "injected"]).out)[0];
  const q = /q-[a-z0-9]+/.exec(cli(box, ["ask", "Which?", "--name", "which", "--options", "a,b"]).out)[0];
  cli(box, ["decide", "first decision"]);
  cli(box, ["decide", "second decision"]);
  const r = hook(box, "session-start", start());
  const text = r.json.hookSpecificOutput.additionalContext;
  const i = (s) => text.indexOf(s);
  assert.ok(i("ledger: open questions for") >= 0, text);
  assert.ok(i(`a ${q}  # which · Which?`) > 0);
  assert.ok(i("ledger: open workloads for") > i("ledger: open questions for"));
  assert.ok(i(`${wl} injected · normal · opened`) > 0);
  assert.ok(i("ledger: last 2 decisions:") > i("ledger: open workloads for"), text);
  assert.ok(i("second decision") < i("first decision"));
  assert.ok(i("Verbs:") > i("decisions:"));
  assert.equal(i("No open workload"), -1);
  const compact = hook(box, "session-start", start({ source: "compact" })).json.hookSpecificOutput.additionalContext;
  assert.ok(compact.includes(q) && compact.includes(wl));
  assert.equal(compact.indexOf("decisions:"), -1);
  assert.equal(compact.indexOf("Verbs:"), -1);
  assert.ok(compact.includes(invocation()), compact);
});

test("step 6: 200 decisions seeded → injection under the cap, questions intact, decisions truncated first", () => {
  const b = sandbox();
  cli(b, ["open", "many"]);
  const q = /q-[a-z0-9]+/.exec(cli(b, ["ask", "Still here?", "--name", "here", "--options", "yes,no"]).out)[0];
  b.writeConfig({ inject: { decisions: 200 } });
  apply(b, Array.from({ length: 200 }, (_, i) => ({ tokens: ["decide", `decision number ${i} ${"x".repeat(80)}`], text: "" })));
  const db = openDb(b);
  const { text, sections } = buildInjection(db, b.work, loadConfig({ env: b.env }).config);
  db.close();
  assert.ok(text.length <= CAP, String(text.length));
  assert.ok(text.includes(q));
  assert.deepEqual(sections, ["questions", "workloads", "decisions", "summary"]);
  assert.match(text, /… \(truncated\)/);
});

test("step 6: SessionEnd parks the session's open workload with the reason and a park decision; never closes", () => {
  const b = sandbox();
  const wl = /wl-[a-z0-9]+/.exec(cli(b, ["open", "to park"]).out)[0];
  hook(b, "session-start", { ...start(), cwd: b.work, session_id: "s-end" });
  const t0 = performance.now();
  const r = hook(b, "session-end", { ...end(), cwd: b.work, session_id: "s-end" });
  const ms = performance.now() - t0;
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "");
  assert.ok(ms < 500, `SessionEnd took ${ms.toFixed(0)} ms`);
  const db = openDb(b);
  const w = row(db, "SELECT status, status_reason, status_by FROM workloads WHERE id = ?", wl);
  assert.deepEqual(w, { status: "parked", status_reason: "session ended (other)", status_by: "hook:SessionEnd" });
  assert.equal(count(db, "decisions", "workload_id = ? AND kind = 'park' AND made_by = 'hook:SessionEnd'", wl), 1);
  assert.deepEqual(row(db, "SELECT end_reason FROM sessions WHERE id = 's-end'"), { end_reason: "other" });
  db.close();
  const again = hook(b, "session-start", { ...start(), cwd: b.work, session_id: "s-next" }).json.hookSpecificOutput.additionalContext;
  assert.ok(again.includes(`${wl} to park · parked (session ended (other)) · resume: ledger open ${wl}`), again);
  assert.match(again, /No open workload for this folder.*\(or `node \S*scripts\/ledger\.mjs open wl-[a-z0-9]+` to resume\)/);
});

test("step 6: SessionEnd `clear` and `resume` park too; a workload another session owns is left alone", () => {
  const b = sandbox();
  const mine = /wl-[a-z0-9]+/.exec(cli(b, ["open", "mine"]).out)[0];
  const theirs = /wl-[a-z0-9]+/.exec(cli(b, ["open", "theirs"], { cwd: b.sibling }).out)[0];
  const db = openDb(b);
  db.prepare("UPDATE workloads SET session_id = 'someone-else' WHERE id = ?").run(theirs);
  db.close();
  hook(b, "session-end", { ...end(), cwd: b.work, session_id: "s-clear", reason: "clear" });
  const db2 = openDb(b);
  assert.equal(db2.prepare("SELECT status_reason FROM workloads WHERE id = ?").get(mine).status_reason, "session ended (clear)");
  assert.equal(db2.prepare("SELECT status FROM workloads WHERE id = ?").get(theirs).status, "open");
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
  assert.equal(allowRule("/h/.claude/plugins/cache/jo-wolff-plugins/ledger/0.1.0/scripts/ledger.mjs"), "Bash(node /h/.claude/plugins/cache/jo-wolff-plugins/ledger/*/scripts/ledger.mjs *)");
  assert.equal(allowRule("/src/jo-wolff-plugins/plugins/ledger/scripts/ledger.mjs"), "Bash(node /src/jo-wolff-plugins/plugins/ledger/scripts/ledger.mjs *)");
  assert.equal(allowRule("/My Dir/plugins/ledger/scripts/ledger.mjs"), 'Bash(node "/My Dir/plugins/ledger/scripts/ledger.mjs" *)');
  assert.equal(shellPath("/plain/path"), "/plain/path");
  assert.equal(invocation("/plain/path"), "node /plain/path");
  assert.ok(cliPath().endsWith("/plugins/ledger/scripts/ledger.mjs"));
});
