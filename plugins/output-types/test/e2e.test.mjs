// e2e.test.mjs — one user story, start to finish, through the command hooks.json registers.
//
// Install the plugin into a temp tree, start a session in a temp git repo, edit the contract and
// see the next session receive the edit, turn the injection off and on, break the contract and
// see the warning and the errors.log line, repair it and see the core come back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POINTER, WARN_MARKERS } from "../lib/core.mjs";
import { BUDGET_MS, CONTRACT_REL, sandbox, sessionStartPayload, spanByLines } from "./helpers.mjs";

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: BUDGET_MS });
  assert.equal(r.status, 0, r.stderr);
}

/** Run every SessionStart command in the installed hooks.json the way Claude Code does: sh -c with CLAUDE_PLUGIN_ROOT set. */
function sessionStart(box, plugin, source, env = {}) {
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8")).hooks.SessionStart;
  const commands = hooks.flatMap((h) => h.hooks.filter((x) => x.type === "command").map((x) => x.command));
  assert.equal(commands.length, 1, "one SessionStart command");
  const r = spawnSync("/bin/sh", ["-c", commands[0]], {
    cwd: box.work,
    env: { ...box.env, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: box.work, ...env },
    input: sessionStartPayload(box, source),
    encoding: "utf8",
    timeout: BUDGET_MS,
    killSignal: "SIGKILL",
  });
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test("e2e: install → inject → edit the contract → off → broken contract → repaired", () => {
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

  // The hook never wrote into the repo it ran in.
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: box.work, encoding: "utf8", timeout: BUDGET_MS });
  assert.equal(status.stdout, "");
});
