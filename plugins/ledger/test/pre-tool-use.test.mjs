import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sandbox, hook, cli, openDb, count } from "./helpers.mjs";
import { evaluate } from "../lib/gate.mjs";

const box = sandbox();
const askTool = (cwd = box.work) => ({ session_id: "s", cwd, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [] } });
const bash = (command, cwd = box.work) => ({ session_id: "s", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

function denied(r, rule) {
  assert.equal(r.code, 0, r.err);
  assert.ok(r.json, `expected JSON, got ${JSON.stringify(r.out)}`);
  assert.equal(r.json.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(r.json.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, rule);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /node \S*scripts\/ledger\.mjs ask/);
}
function allowed(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "", `expected no output, got ${r.out}`);
}

test("AskUserQuestion with no open q- row is denied, naming the ledger ask; nothing is written", () => {
  denied(hook(box, "pre-tool-use", askTool()), /ask the question through the ledger first/);
  const db = openDb(box);
  assert.equal(count(db, "cc_questions"), 0);
  db.close();
});

test("after `ledger ask` in the cwd AskUserQuestion passes; once the question is answered it is denied again", () => {
  const q = /q-[a-z0-9]+/.exec(cli(box, ["ask", "Which?", "--name", "w", "--options", "a,b"]).out)[0];
  allowed(hook(box, "pre-tool-use", askTool()));
  cli(box, ["a", q]);
  denied(hook(box, "pre-tool-use", askTool()), /through the ledger first/);
});

test("a question asked in an ancestor folder covers a subfolder; a sibling folder is not covered", () => {
  const b = sandbox();
  cli(b, ["ask", "Up?", "--name", "up", "--options", "a,b"], { cwd: b.work });
  const sub = join(b.work, "packages", "api");
  globalThis.process.getBuiltinModule("node:fs").mkdirSync(sub, { recursive: true });
  allowed(hook(b, "pre-tool-use", askTool(sub)));
  allowed(hook(b, "pre-tool-use", askTool(b.work)));
  denied(hook(b, "pre-tool-use", askTool(b.sibling)), /through the ledger first/);
  denied(hook(b, "pre-tool-use", askTool(b.root)), /through the ledger first/);
});

test("other tools are never touched by this hook, even with no question open: Bash, Write, git push, gh pr create", () => {
  const b = sandbox();
  for (const c of ["git push origin main", "gh pr create --fill", "rm -rf build", "npm test"]) allowed(hook(b, "pre-tool-use", bash(c, b.work)));
  allowed(hook(b, "pre-tool-use", { session_id: "s", cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(b.sibling, "x.txt") } }));
  allowed(hook(b, "pre-tool-use", { session_id: "s", cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} }));
});

test("forcing.denyAskWithoutRow false → AskUserQuestion passes; hooks.preToolUse false → nothing at all, no db", () => {
  const b = sandbox();
  b.writeConfig({ forcing: { denyAskWithoutRow: false } });
  allowed(hook(b, "pre-tool-use", askTool(b.work)));
  const c = sandbox();
  c.writeConfig({ hooks: { preToolUse: false } });
  allowed(hook(c, "pre-tool-use", askTool(c.work)));
  assert.equal(globalThis.process.getBuiltinModule("node:fs").existsSync(c.dbPath), false, "a switched-off hook never opens the database");
});

test("evaluate (pure): only AskUserQuestion is ever denied, and only while no question is open", () => {
  const db = openDb(box);
  const config = { forcing: { denyAskWithoutRow: true } };
  const verdict = evaluate({ tool_name: "AskUserQuestion" }, { db, config, cwd: box.sibling, cli: "ledger" });
  assert.equal(verdict?.rule, "denyAskWithoutRow");
  assert.match(verdict.reason, /^ledger: ask the question through the ledger first: `ledger ask /);
  assert.equal(evaluate({ tool_name: "Bash", tool_input: { command: "git push" } }, { db, config, cwd: box.sibling }), null);
  assert.equal(evaluate({ tool_name: "AskUserQuestion" }, { db, config: { forcing: { denyAskWithoutRow: false } }, cwd: box.sibling }), null);
  db.close();
});
