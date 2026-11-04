// e2e.test.mjs — one user story, start to finish, through the command hooks.json registers.
//
// Install the plugin into a temp tree, start a session in a temp git repo, edit the contract and
// see the next session receive the edit, turn the injection off and on, break the contract and
// see the warning and the errors.log line, repair it and see the core come back; then finish a
// message with an unreceipted CLAIM and see the Stop hook's warning, and a receipted one and see
// nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POINTER, WARN_MARKERS } from "../lib/core.mjs";
import { BUDGET_MS, CONTRACT_REL, sandbox, sessionStartPayload, spanByLines } from "./helpers.mjs";

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: BUDGET_MS });
  assert.equal(r.status, 0, r.stderr);
}

/** Run the one command hooks.json registers for `event` the way Claude Code does: sh -c with CLAUDE_PLUGIN_ROOT set. */
function hook(box, plugin, event, input, env = {}) {
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8")).hooks[event];
  const commands = hooks.flatMap((h) => h.hooks.filter((x) => x.type === "command").map((x) => x.command));
  assert.equal(commands.length, 1, `one ${event} command`);
  const r = spawnSync("/bin/sh", ["-c", commands[0]], {
    cwd: box.work,
    env: { ...box.env, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: box.work, ...env },
    input,
    encoding: "utf8",
    timeout: BUDGET_MS,
    killSignal: "SIGKILL",
  });
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const sessionStart = (box, plugin, source, env = {}) => hook(box, plugin, "SessionStart", sessionStartPayload(box, source), env);

/** A one-line Claude Code transcript whose last assistant message is `text`, and the Stop payload naming it. */
function finished(box, text) {
  const dir = join(box.home, ".claude", "projects", "x");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "s.jsonl");
  writeFileSync(path, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n");
  return JSON.stringify({ session_id: "s1", transcript_path: path, cwd: box.work, hook_event_name: "Stop", stop_hook_active: false });
}

test("e2e: install → inject → edit the contract → off → broken contract → repaired → Stop warns on a bare CLAIM, silent on a receipted one", () => {
  const box = sandbox();
  git(box.work, "init", "-q");
  writeFileSync(join(box.work, "README.md"), "throwaway\n");
  git(box.work, "add", ".");
  git(box.work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const plugin = box.copyPlugin();
  const contract = join(plugin, CONTRACT_REL);

  // 1. A fresh session gets exactly the span between the markers, plus the pointer.
  const original = readFileSync(contract, "utf8");
  let out = sessionStart(box, plugin, "startup");
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.additionalContext, spanByLines(original) + POINTER);
  assert.equal(out.systemMessage, undefined);

  // 2. Editing the contract is editing what sessions receive: there is one copy.
  const edited = original.replace("\n<!-- inject:end -->", "\nAn added operative line.\n<!-- inject:end -->");
  writeFileSync(contract, edited);
  out = sessionStart(box, plugin, "resume");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("An added operative line.\nThe rest of the contract"));

  // 3. The off-switch silences it without uninstalling.
  assert.equal(sessionStart(box, plugin, "clear", { OUTPUT_TYPES_INJECT: "off" }), null);

  // 4. A bad edit drops a marker: the session still starts, with one warning and one log line.
  writeFileSync(contract, original.replace("\n<!-- inject:start -->\n", "\n"));
  out = sessionStart(box, plugin, "startup");
  assert.ok(out.systemMessage.startsWith(WARN_MARKERS), out.systemMessage);
  assert.equal(out.hookSpecificOutput.additionalContext, out.systemMessage);
  const logged = box.readErrors().split("\n").filter(Boolean);
  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes("hooks/output-types-inject.mjs inject markers missing from " + contract), logged[0]);

  // 5. Repaired: the core is back and the log does not grow.
  writeFileSync(contract, original);
  out = sessionStart(box, plugin, "compact");
  assert.equal(out.hookSpecificOutput.additionalContext, spanByLines(original) + POINTER);
  assert.equal(box.readErrors().split("\n").filter(Boolean).length, 1);

  // 6. A finished message with an unreceipted CLAIM: the Stop hook names the line and blocks nothing.
  let stop = hook(box, plugin, "Stop", finished(box, "Done.\n\n**CLAIM** the route returns 404 on a missing id.\n"));
  assert.deepEqual(Object.keys(stop), ["systemMessage"]);
  assert.match(stop.systemMessage, /^output-types: 1 labelled statement without a receipt that holds\./);
  assert.match(stop.systemMessage, /\n  line 3 \*\*CLAIM\*\* "the route returns 404 on a missing id\.": needs an absolute file:line/);

  // 7. The same message with its receipt: nothing to say. No judge ran (none configured).
  stop = hook(box, plugin, "Stop", finished(box, "Done.\n\n**CLAIM** the route returns 404 on a missing id: `curl -si localhost/x/9` → HTTP/1.1 404.\n"));
  assert.equal(stop, null);
  assert.equal(box.readErrors().split("\n").filter(Boolean).length, 1, "the Stop hook logged no fault");

  // The hook never wrote into the repo it ran in.
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: box.work, encoding: "utf8", timeout: BUDGET_MS });
  assert.equal(status.stdout, "");
});
