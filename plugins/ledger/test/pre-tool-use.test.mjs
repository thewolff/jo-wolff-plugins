import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sandbox, hook, cli, openDb, count } from "./helpers.mjs";
import { evaluate, isPushCommand } from "../lib/gate.mjs";

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

test("other tools and other Bash commands are never touched, even with no question or note: Write, rm, npm test, git status", () => {
  const b = sandbox();
  for (const c of ["rm -rf build", "npm test", "git status", "git pull --rebase", "gh pr view 12", "echo git push"]) allowed(hook(b, "pre-tool-use", bash(c, b.work)));
  allowed(hook(b, "pre-tool-use", { session_id: "s", cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(b.sibling, "x.txt") } }));
  allowed(hook(b, "pre-tool-use", { session_id: "s", cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} }));
});

test("push gate: `git push` and `gh pr create` are denied while the session has no note, naming `ledger note`; one note in the session lifts it", () => {
  const b = sandbox();
  hook(b, "session-start", { session_id: "s-push", cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  const payload = (c) => ({ ...bash(c, b.work), session_id: "s-push" });
  for (const c of ["git push", "git push origin HEAD", "git -C . push --tags", "npm test && git push", "gh pr create --fill", "cd sub; gh pr create -t x"]) {
    const r = hook(b, "pre-tool-use", payload(c));
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, "deny", c);
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /^ledger: record what this push is before pushing: `node \S*scripts\/ledger\.mjs note "<what and why>"` or `node \S*scripts\/ledger\.mjs outcome <ref> "<what and why>"` \(one in this session lifts the gate\)\.$/);
  }
  const db = openDb(b);
  assert.equal(count(db, "cc_notes"), 0, "a deny writes nothing");
  db.close();
  // A note tagged with the session (the CLI gets LEDGER_SESSION_ID from the SessionStart hook) lifts it.
  cli(b, ["note", "pushing the smoke fix so CI runs it"], { env: { LEDGER_SESSION_ID: "s-push" } });
  allowed(hook(b, "pre-tool-use", payload("git push origin main")));
  allowed(hook(b, "pre-tool-use", payload("gh pr create --fill")));
  // Another session is still gated; an untagged note made after that session started lifts it too.
  hook(b, "session-start", { session_id: "s-other", cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  assert.equal(hook(b, "pre-tool-use", { ...bash("git push", b.work), session_id: "s-other" }).json?.hookSpecificOutput?.permissionDecision, "deny");
  cli(b, ["note", "untagged note from the CLI"]);
  allowed(hook(b, "pre-tool-use", { ...bash("git push", b.work), session_id: "s-other" }));
  // A withdraw/extend note is not a `note`: it does not lift the gate.
  const c = sandbox();
  hook(c, "session-start", { session_id: "s-w", cwd: c.work, hook_event_name: "SessionStart", source: "startup" });
  const q = /q-[a-z0-9]+/.exec(cli(c, ["ask", "W?", "--name", "w", "--options", "a,b"]).out)[0];
  cli(c, ["withdraw", q]);
  assert.equal(hook(c, "pre-tool-use", { ...bash("git push", c.work), session_id: "s-w" }).json?.hookSpecificOutput?.permissionDecision, "deny");
});

test("push gate: forcing.pushNeedsNote false passes; with no session id nothing can be attributed, so the push is denied until a tagged note exists", () => {
  const b = sandbox();
  b.writeConfig({ forcing: { pushNeedsNote: false } });
  allowed(hook(b, "pre-tool-use", { ...bash("git push", b.work), session_id: "s-off" }));
  const c = sandbox();
  const r = hook(c, "pre-tool-use", { ...bash("git push", c.work), session_id: "" });
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, "deny");
});

test("push gate fails open: a read-only store passes the push with a systemMessage (the `note` it would demand cannot be written)", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const b = sandbox();
  cli(b, ["help"]);
  hook(b, "session-start", { session_id: "s-ro", cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  globalThis.process.getBuiltinModule("node:fs").chmodSync(b.dbPath, 0o444);
  try {
    const r = hook(b, "pre-tool-use", { ...bash("git push", b.work), session_id: "s-ro" });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json?.hookSpecificOutput, undefined);
    assert.match(r.json?.systemMessage ?? "", /^ledger: database read-only at .*; the ledger gate is not enforced for this call$/);
  } finally {
    globalThis.process.getBuiltinModule("node:fs").chmodSync(b.dbPath, 0o644);
  }
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

test("evaluate (pure): AskUserQuestion needs an open question, a push needs a session note, nothing else is seen", () => {
  const db = openDb(box);
  const config = { forcing: { denyAskWithoutRow: true, pushNeedsNote: true } };
  const verdict = evaluate({ tool_name: "AskUserQuestion" }, { db, config, cwd: box.sibling, cli: "ledger" });
  assert.equal(verdict?.rule, "denyAskWithoutRow");
  assert.match(verdict.reason, /^ledger: ask the question through the ledger first: `ledger ask /);
  assert.equal(evaluate({ tool_name: "Bash", tool_input: { command: "git push" } }, { db, config, cwd: box.sibling, sessionId: "none" })?.rule, "pushNeedsNote");
  assert.equal(evaluate({ tool_name: "Bash", tool_input: { command: "git push" } }, { db, config: { forcing: { pushNeedsNote: false } }, cwd: box.sibling, sessionId: "none" }), null);
  assert.equal(evaluate({ tool_name: "Bash", tool_input: { command: "git status" } }, { db, config, cwd: box.sibling, sessionId: "none" }), null);
  assert.equal(evaluate({ tool_name: "Write", tool_input: { file_path: "/x" } }, { db, config, cwd: box.sibling, sessionId: "none" }), null);
  assert.equal(evaluate({ tool_name: "AskUserQuestion" }, { db, config: { forcing: { denyAskWithoutRow: false } }, cwd: box.sibling }), null);
  db.close();
});

test("isPushCommand (pure): the shapes that count and the ones that do not", () => {
  for (const c of ["git push", "git push -u origin x", "git -C /r push", "git -c core.x=1 push", "/usr/bin/git push", "\\git push", "command git push", "GIT_SSH=x git push", "a && git push", "a || git push", "a; git push", "a | git push", "a\ngit push", "gh pr create", "gh pr create --fill", "env gh pr create"]) assert.ok(isPushCommand(c), c);
  for (const c of ["git pushx", "git status", "git pull", "gh pr view", "gh pr create-x", "gh issue create", "echo 'git push'", "mygit push", "git --no-pager log", "", null, 42]) assert.ok(!isPushCommand(c), String(c));
});
