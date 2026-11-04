// hook-contract.test.mjs — the repository's hook bar (AGENTS.md item 2) for every hook listed in
// hooks/hooks.json, each run as a spawned `node` process: empty stdin, malformed JSON, a missing
// database, an unwritable database, and a missing config file all exit 0 inside 5 seconds and
// never deny or block. The unwritable case sends inputs that would be denied or blocked by a rule
// on a healthy store (a push with no note or review, an AskUserQuestion with no row, a reply
// ending in a question), so it proves a fault turns a deny into an allow. The missing-database and
// missing-config cases send inputs no rule stops: on those, a deny would be a rule, not a fault.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, PLUGIN_ROOT } from "./helpers.mjs";

const BUDGET_MS = 5_000;
const hooksJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
const HOOKS = Object.entries(hooksJson.hooks).map(([event, groups]) => {
  const { command, args = [] } = groups[0].hooks[0];
  const script = /hooks\/([a-z-]+\.mjs)/.exec([command, ...args].join(" "))[1];
  return { event, script: join(PLUGIN_ROOT, "hooks", script) };
});

const SID = "s-contract";
/** An input a rule would stop on a healthy store (gated), and one no rule stops (plain). */
function inputs(event, cwd) {
  const base = { session_id: SID, cwd, hook_event_name: event, prompt_id: "p-1" };
  switch (event) {
    case "PreToolUse":
      return {
        gated: [
          { ...base, tool_name: "Bash", tool_input: { command: "git push origin main" } },
          { ...base, tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which?" }] } },
        ],
        plain: [{ ...base, tool_name: "Bash", tool_input: { command: "ls" } }],
      };
    case "Stop":
      return {
        gated: [{ ...base, stop_hook_active: false, last_assistant_message: "Shall I use the small cache or rewrite the loader for this change?" }],
        plain: [{ ...base, stop_hook_active: false, last_assistant_message: "Done." }],
      };
    case "UserPromptSubmit":
      return { gated: [{ ...base, prompt: "pending" }], plain: [{ ...base, prompt: "carry on" }] };
    case "SessionStart":
      return { gated: [{ ...base, source: "startup" }], plain: [{ ...base, source: "startup" }] };
    default:
      return { gated: [{ ...base, reason: "exit" }], plain: [{ ...base, reason: "exit" }] };
  }
}

function run(b, script, stdin, env = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [script], { cwd: b.work, env: { ...b.env, ...env }, input: stdin, encoding: "utf8", timeout: BUDGET_MS, killSignal: "SIGKILL" });
  return { ...r, ms: Date.now() - started };
}

function assertAllowed(r, what) {
  assert.equal(r.error, undefined, `${what}: ${r.error?.message}`);
  assert.equal(r.status, 0, `${what}: exit ${r.status} ${r.stderr}`);
  assert.ok(r.ms < BUDGET_MS, `${what}: took ${r.ms} ms`);
  if (!r.stdout.trim()) return;
  const json = JSON.parse(r.stdout);
  assert.notEqual(json.hookSpecificOutput?.permissionDecision, "deny", `${what}: denied: ${r.stdout}`);
  assert.notEqual(json.decision, "block", `${what}: blocked: ${r.stdout}`);
  assert.notEqual(json.continue, false, `${what}: stopped: ${r.stdout}`);
}

test("hooks.json lists the five hooks this file covers", () => {
  assert.deepEqual(HOOKS.map((h) => h.event).sort(), ["PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
});

for (const { event, script } of HOOKS) {
  test(`${event}: empty stdin and malformed JSON → exit 0, allowed, under 5 s`, () => {
    const b = sandbox();
    assertAllowed(run(b, script, ""), `${event} empty stdin`);
    assertAllowed(run(b, script, "{not json"), `${event} malformed JSON`);
    assertAllowed(run(b, script, "[1,2]"), `${event} JSON that is not an object`);
  });

  test(`${event}: an unwritable database → exit 0, allowed, under 5 s, even for input a rule would stop`, () => {
    const b = sandbox();
    const locked = join(b.root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const env = { LEDGER_DB: join(locked, "ledger.db"), LEDGER_CONFIG: join(b.root, "c.json") };
      for (const input of inputs(event, b.work).gated) assertAllowed(run(b, script, JSON.stringify(input), env), `${event} unwritable db ${input.tool_name ?? ""}`);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test(`${event}: a missing database and a missing config file → exit 0, allowed, under 5 s`, () => {
    const b = sandbox();
    const env = { LEDGER_DB: join(b.root, "absent", "deeper", "ledger.db"), LEDGER_CONFIG: join(b.root, "no-such-config.json") };
    for (const input of inputs(event, b.work).plain) assertAllowed(run(b, script, JSON.stringify(input), env), `${event} missing db and config`);
  });
}
