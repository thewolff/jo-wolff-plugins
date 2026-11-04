// End to end, as processes: a real `git init` repository and a private state and config
// directory, the two hooks spawned with the JSON Claude Code sends them, and the exact record
// command the deny prints, run through /bin/sh from the repository. Every child has a 5 s timeout;
// a hang fails the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN = dirname(fileURLToPath(import.meta.url));
const PRE = join(PLUGIN, "hooks", "pattern-check-pretooluse.mjs");
const STOP = join(PLUGIN, "hooks", "pattern-check-stop.mjs");
const SESSION = "6f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f607";
const PLAN = "## Implementation plan\n1. Add a webhook parser in src/webhooks/\n2. Add a retry queue\n3. Wire both into the router";

function setup(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pattern-check-e2e-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  // A controlled environment, not the parent's: no inherited PATTERN_CHECK_* or GIT_* overrides,
  // no user or system git config.
  const env = { PATH: process.env.PATH, HOME: base, XDG_STATE_HOME: join(base, "state"), XDG_CONFIG_HOME: join(base, "config"), CLAUDE_PLUGIN_ROOT: PLUGIN, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = spawnSync("git", ["init", "-q", repo], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(git.error, undefined, String(git.error));
  assert.equal(git.status, 0, git.stderr);
  // The full default config at the repository root, so a config in an ancestor of the temp
  // directory cannot change the threshold or the hooks.
  writeFileSync(join(repo, ".pattern-check.json"), JSON.stringify({ threshold: 3, denyCommands: [], receiptDir: ".pattern-check", hooks: { preToolUse: true, stop: true } }));
  const common = { session_id: SESSION, transcript_path: join(base, "transcript.jsonl"), cwd: repo, permission_mode: "default" };
  const spawnHook = (script, payload) => {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), env, encoding: "utf8", timeout: 5000 });
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.status, 0, r.stderr);
    return r.stdout === "" ? null : JSON.parse(r.stdout);
  };
  let n = 0;
  const pre = (tool_name, tool_input) => spawnHook(PRE, { ...common, hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: `toolu_${++n}` });
  const stop = (message, active = false) => spawnHook(STOP, { ...common, hook_event_name: "Stop", stop_hook_active: active, last_assistant_message: message, background_tasks: [], session_crons: [] });
  const sh = (command) => spawnSync("/bin/sh", ["-c", command], { cwd: repo, env, encoding: "utf8", timeout: 5000 });
  return { base, repo, env, pre, stop, sh, file: (p) => join(repo, p) };
}

test("e2e: files 1 and 2 allowed, the 3rd denied with the exact command; Stop refuses a design once; the command records; the 4th is allowed", (t) => {
  const e = setup(t);

  // 1 and 2: allowed, nothing printed.
  assert.equal(e.pre("Write", { file_path: e.file("src/one.ts"), content: "export {}" }), null);
  assert.equal(e.pre("Edit", { file_path: e.file("src/two.ts"), old_string: "a", new_string: "b", replace_all: false }), null);

  // 3: denied, the reason names the exact command.
  const denied = e.pre("Write", { file_path: e.file("src/three.ts"), content: "x" });
  assert.equal(denied.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  const reason = denied.hookSpecificOutput.permissionDecisionReason;
  const exact = `node "${join(PLUGIN, "scripts", "pattern-check.mjs")}" record --session ${SESSION} < table.md`;
  assert.ok(reason.split("\n").includes(`  ${exact}`), reason);
  assert.ok(reason.includes(`Blocked call: Write ${e.file("src/three.ts")}.`), reason);
  assert.ok(reason.includes("what exists already") && reason.includes("how does it fail"), reason);
  assert.equal(existsSync(e.file("src/three.ts")), false);

  // Stop: a design reply is refused once, never twice.
  const refused = e.stop(PLAN);
  assert.equal(refused.decision, "block");
  assert.ok(refused.reason.includes("what exists already") && refused.reason.includes("how does it fail"), refused.reason);
  assert.ok(refused.reason.includes(exact), refused.reason);
  assert.equal(e.stop(PLAN), null, "the same reply again is let through");
  assert.equal(e.stop(`${PLAN}\n4. and a cache`, true), null, "a continuation caused by a stop hook is let through");

  // The Bash call that runs the command is itself allowed by the held session (it reads, it does not write).
  const command = reason.split("\n").find((l) => l.startsWith("  node ")).trim();
  assert.equal(command, exact);
  assert.equal(e.pre("Bash", { command, description: "record the pattern-check receipt" }), null);

  // A table without the fail columns is refused, nothing written.
  writeFileSync(e.file("table.md"), "| webhook parser | (none: grep webhook in src/) | new | nothing parses inbound webhooks |\n");
  const refusedRecord = e.sh(command);
  assert.equal(refusedRecord.status, 1);
  assert.match(refusedRecord.stderr, /receipt not written: row "webhook parser" has no fail columns.*better design \| fails how \| next step \| restart-safe \| bounded \| evidence kept/);
  assert.equal(existsSync(e.file(`.pattern-check/${SESSION}.md`)), false);

  // A 0.3-shaped table, fail columns but no better design cell, is refused too, naming the cell.
  writeFileSync(e.file("table.md"), "| webhook parser | (none: grep webhook in src/) | new | nothing parses inbound webhooks | throws WebhookError; the router logs it and answers 400 | the 400 body names the field to fix | yes: parsing is pure | n/a: no retries, one parse per request | the request id in the access log |\n");
  const refusedDesign = e.sh(command);
  assert.equal(refusedDesign.status, 1);
  assert.match(refusedDesign.stderr, /receipt not written: row "webhook parser" has no "better design" cell; every piece needs it after the reason, before fails how \(write "none: <what was weighed>", or the better design with its axis and its cost\)/);
  assert.equal(existsSync(e.file(`.pattern-check/${SESSION}.md`)), false);

  // The full table records.
  writeFileSync(e.file("table.md"), [
    "| new piece | existing pattern (file:line) | reuse / replace / new | reason | better design | fails how | next step | restart-safe | bounded | evidence kept |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| webhook parser | (none: grep webhook, inbound in src/) | new | nothing parses inbound webhooks | none: weighed one inbound module holding parse and verify, more than one route needs | throws WebhookError; the router logs it and answers 400 | the 400 body names the field to fix | yes: parsing is pure | n/a: no retries, one parse per request | the request id and error line in the access log |",
    "",
  ].join("\n"));
  const recorded = e.sh(command);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /receipt recorded for session 6f1d2c3b/);
  const receipt = readFileSync(e.file(`.pattern-check/${SESSION}.md`), "utf8");
  assert.match(receipt, /\| webhook parser \| .* \| new \| .* \| none: weighed one inbound module .* \| throws WebhookError; .* \| yes: parsing is pure \| n\/a: no retries, one parse per request \|/);
  assert.equal(existsSync(join(e.base, "state", "pattern-check", "receipts", `${SESSION}.md`)), true);

  // After the receipt: the 3rd and a 4th file, a commit, and a new design reply all go through.
  assert.equal(e.pre("Write", { file_path: e.file("src/three.ts"), content: "x" }), null);
  assert.equal(e.pre("Write", { file_path: e.file("src/four.ts"), content: "x" }), null);
  assert.equal(e.pre("Bash", { command: "git add -A && git commit -m wip" }), null);
  assert.equal(e.stop("## Design\nA second plan, after the receipt."), null);

  // Nothing went wrong, so nothing was logged.
  assert.equal(existsSync(join(e.base, "state", "pattern-check", "errors.log")), false);
});

test("e2e: the hold also covers commit and PR once the 3rd file was denied, and a shell write inside the repo is counted and denied", (t) => {
  const e = setup(t);
  assert.equal(e.pre("Write", { file_path: e.file("a.ts"), content: "x" }), null);
  assert.equal(e.pre("Bash", { command: "echo x > b.ts" }), null); // the 2nd distinct file, through a redirect
  const third = e.pre("Bash", { command: "cat <<'EOF' > c.ts\nversion >= 2\nEOF" });
  assert.equal(third.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(third.hookSpecificOutput.permissionDecisionReason.includes("Blocked call: Bash cat <<'EOF' > c.ts\nversion >= 2\nEOF."), third.hookSpecificOutput.permissionDecisionReason);
  assert.equal(e.pre("Bash", { command: "git commit -am x" }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(e.pre("Bash", { command: "gh pr create --fill" }).hookSpecificOutput.permissionDecision, "deny");
  // a write outside the repository is not this check's business
  assert.equal(e.pre("Bash", { command: `echo x > ${join(e.base, "outside.txt")}` }), null);
});
