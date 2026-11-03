// The plugin never causes a Claude Code permission prompt and never asks the human anything on
// its own. Hooks deny-with-reason, block-with-reason, annotate, or stamp; that is the whole list.
// Questions reach the human only through a q- row the agent raised.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, hook, cli, openDb, count, HOOKS, PLUGIN_ROOT } from "./helpers.mjs";

const HOOK_NAMES = Object.keys(HOOKS);
const LONG_Q = "I looked through the code and found two viable designs for the cache. Should I use A or B?";

function allOutputs(box) {
  const base = { session_id: "s-np", cwd: box.work };
  const cases = [
    ["session-start", { ...base, hook_event_name: "SessionStart", source: "startup" }],
    ["session-start", { ...base, hook_event_name: "SessionStart", source: "compact" }],
    ["pre-tool-use", { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" } }],
    ["pre-tool-use", { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr create" } }],
    ["pre-tool-use", { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } }],
    ["pre-tool-use", { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(box.sibling, "x") } }],
    ["pre-tool-use", { ...base, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: {} }],
    ["stop", { ...base, hook_event_name: "Stop", prompt_id: "p1", stop_hook_active: false, last_assistant_message: LONG_Q }],
    ["stop", { ...base, hook_event_name: "Stop", prompt_id: "p2", stop_hook_active: false, last_assistant_message: "All done with the work on this one." }],
    ["user-prompt", { ...base, hook_event_name: "UserPromptSubmit", prompt: "approve q-nope" }],
    ["user-prompt", { ...base, hook_event_name: "UserPromptSubmit", prompt: "please carry on" }],
    ["session-end", { ...base, hook_event_name: "SessionEnd", reason: "other" }],
  ];
  return cases.map(([name, p]) => [name, p, hook(box, name, p)]);
}

test("no hook output, on any path, contains a permissionDecision of `ask` or any field that opens a dialog", () => {
  for (const withQuestion of [false, true]) {
    const box = sandbox();
    if (withQuestion) cli(box, ["ask", "Np?", "--name", "np", "--options", "a,b"]);
    for (const [name, p, r] of allOutputs(box)) {
      assert.equal(r.code, 0, `${name}: ${r.err}`);
      const j = r.json ?? {};
      const flat = JSON.stringify(j);
      assert.notEqual(j.hookSpecificOutput?.permissionDecision, "ask", `${name} ${JSON.stringify(p.tool_input)}: ${flat}`);
      assert.notEqual(j.decision, "ask", name);
      assert.ok(!/"permissionDecision":"ask"/.test(flat), `${name}: ${flat}`);
      assert.ok(!("updatedInput" in (j.hookSpecificOutput ?? {})), `${name} rewrote tool input`);
      assert.ok(!("continue" in j), `${name} set continue`);
      const allowed = new Set(["systemMessage", "hookSpecificOutput", "decision", "reason"]);
      for (const k of Object.keys(j)) assert.ok(allowed.has(k), `${name} emitted unexpected top-level field ${k}`);
      if (j.decision !== undefined) assert.equal(j.decision, "block", name);
      if (j.hookSpecificOutput?.permissionDecision !== undefined) assert.equal(j.hookSpecificOutput.permissionDecision, "deny", name);
    }
  }
});

test("the hook sources never write `ask` or `allow` as a permissionDecision, and never exit 2", () => {
  const files = [...readdirSync(join(PLUGIN_ROOT, "hooks")).map((f) => join(PLUGIN_ROOT, "hooks", f)), ...readdirSync(join(PLUGIN_ROOT, "lib")).map((f) => join(PLUGIN_ROOT, "lib", f))];
  for (const f of files.filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/permissionDecision:\s*["'](ask|allow)["']/.test(src), `${f} sets permissionDecision ask/allow`);
    assert.ok(!/process\.exit\(2\)|exit\(2\)/.test(src), `${f} exits 2`);
  }
});

test("every agent-side write goes through the one CLI path; hooks.json names only the hook scripts", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")).hooks;
  const scripts = new Set();
  for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) {
    assert.equal(h.command, "node", "exec form: node with args");
    assert.equal(h.args.length, 1);
    scripts.add(h.args[0].replace("${CLAUDE_PLUGIN_ROOT}/", ""));
  }
  assert.deepEqual([...scripts].sort(), ["hooks/pre-tool-use.mjs", "hooks/session-end.mjs", "hooks/session-start.mjs", "hooks/stop.mjs", "hooks/user-prompt.mjs"]);
  const cliFiles = readdirSync(join(PLUGIN_ROOT, "scripts"));
  assert.deepEqual(cliFiles, ["ledger.mjs"], "exactly one script for the agent to call");
});

test("questions reach the human only through a q- row: hooks never insert questions", () => {
  const box = sandbox();
  for (const [, , r] of allOutputs(box)) assert.equal(r.code, 0);
  const d = openDb(box);
  assert.equal(count(d, "cc_questions"), 0);
  d.close();
});
