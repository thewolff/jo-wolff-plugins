// test/gates.test.mjs — gates 1, 4, 2 (spawn-gate), gate 3 (send-message-check) and the stop
// warning (subagent-stop), each spawned end-to-end through lib/hook-runner.mjs with the 4 s
// deadline, on allow / deny / block / warn / unparseable inputs, with the config overrides.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { box, errorsLog, gitRepo, runHook, setConfig, skippedLog, spawnPayload, GOOD_BRIEF, HOW_ONLY } from "./helpers.mjs";
import { HOW_IT_FAILS_SECTION, SPIRAL_BOUND_SECTION, STOPPED_LINE, TEMPLATE, stoppedBecause } from "../lib/brief.mjs";
import { compareVersionsDesc } from "../lib/receipt.mjs";

const deny = (r) => r.out?.hookSpecificOutput?.permissionDecision === "deny" ? r.out.hookSpecificOutput.permissionDecisionReason : null;

function repoWithReceipt(t, env, session = "s-test-1") {
  const repo = gitRepo(join(env.HOME, "repo"), env);
  mkdirSync(join(repo, ".pattern-check"), { recursive: true });
  writeFileSync(join(repo, ".pattern-check", `${session}.md`), "# receipt\n");
  return repo;
}

// ---- gate 1 / gate 4 / gate 2: spawn-gate ----

test("spawn-gate: a builder brief with both headings and a receipt is allowed, in silence", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(t, env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo }), env);
  assert.equal(r.status, 0);
  assert.equal(r.out, null, r.stdout);
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
  assert.equal(skippedLog(env), "");
});

test("spawn-gate: gate 1 denies a prompt with no How-it-fails heading and carries that section in full; a non-builder deny has no closing-line sentence", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(t, env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: "Do the thing.\n\n## Spiral bound\n- one retry\n" }), env);
  const reason = deny(r);
  assert.ok(reason, r.stdout);
  assert.equal(r.out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(reason, /^Spawn refused: the prompt has no "## How it fails" heading\. Re-issue the spawn with the same prompt plus the section below, filled in \(keep the heading line as written; the gate reads it literally\)\. The report ends with one line: `Stopped because: acceptance met \| bound hit \| told to stop`\. Full template: templates\/builder-brief\.md in the delegation plugin\.\n\n## How it fails\n/);
  assert.ok(reason.endsWith(`\n\n${HOW_IT_FAILS_SECTION}`), reason);
  assert.ok(!reason.includes(SPIRAL_BOUND_SECTION));
  const scout = deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: "Do the thing.", subagent_type: "scout" }), env));
  assert.ok(!scout.includes(STOPPED_LINE), "a scout is not told about the closing line");
  assert.ok(scout.endsWith(`\n\n${HOW_IT_FAILS_SECTION}`));
});

test("spawn-gate: gate 4 denies a builder-class prompt with How-it-fails but no Spiral bound, carrying that section", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(t, env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, subagent_type: "beefy-builder" }), env);
  const reason = deny(r);
  assert.ok(reason, r.stdout);
  assert.match(reason, /^Spawn refused: builder-class "beefy-builder" needs a "## Spiral bound" heading too\. Re-issue the spawn/);
  assert.ok(reason.includes(TEMPLATE));
  assert.ok(reason.endsWith(`\n\n${SPIRAL_BOUND_SECTION}`), reason);
  assert.ok(!reason.includes(HOW_IT_FAILS_SECTION));
});

test("spawn-gate: both headings missing on a builder-class spawn is one deny carrying both sections, and the brief rebuilt from it passes", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(t, env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: "just do it" }), env);
  const reason = deny(r);
  assert.match(reason, /^Spawn refused: the prompt has no "## How it fails" or "## Spiral bound" heading; builder-class "builder" needs both\. Re-issue the spawn with the same prompt plus the sections below/);
  assert.ok(reason.endsWith(`\n\n${HOW_IT_FAILS_SECTION}\n\n${SPIRAL_BOUND_SECTION}`), reason);
  const rebuilt = `just do it\n\n${reason.slice(reason.indexOf("\n\n## How it fails"))}`;
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: rebuilt }), env).out, null, "the refusal's own sections satisfy the gate");
});

test("spawn-gate: a non-builder spawn needs only How-it-fails and no receipt", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env); // no receipt
  for (const type of ["scout", "reader", "research", "plugin:reader"]) {
    const r = runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, subagent_type: type }), env);
    assert.equal(r.out, null, `${type}: ${r.stdout}`);
  }
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: "no headings", subagent_type: "scout" }), env);
  assert.match(deny(r), /no "## How it fails" heading/);
  assert.doesNotMatch(deny(r), /Spiral/);
});

test("spawn-gate: a missing subagent_type is general-purpose, which is builder-class", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(t, env);
  const payload = spawnPayload({ cwd: repo, prompt: HOW_ONLY });
  delete payload.tool_input.subagent_type;
  const r = runHook("spawn-gate", payload, env);
  assert.match(deny(r), /builder-class "general-purpose" needs a "## Spiral bound"/);
});

test("spawn-gate: headings match at any level, any case, with a trailing colon; prose mentions do not", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(t, env);
  const ok = ["### HOW IT FAILS\nx\n#### spiral bound:\ny", "# How it fails #\n\n# Spiral Bound\n", "   ## How it fails\n## Spiral bound\n", "## How it fails (both tasks)\n## Spiral bound (builder)\n", "```\nx\n```\n## How it fails\n~~~\n## nope\n~~~\n## Spiral bound\n"];
  for (const prompt of ok) assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt }), env).out, null, prompt);
  const bad = ["How it fails: it just does. Spiral bound: 3.", "**How it fails**\n**Spiral bound**", "> ## How it fails\n> ## Spiral bound\n", "x\n```\n## How it fails\n## Spiral bound\n```\ny", "x\n````md\n## How it fails\n```\n## Spiral bound\n````\n", "## How it fails (a) (b)\n## Spiral bound extra\n"];
  for (const prompt of bad) assert.ok(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt }), env)), prompt);
});

test("spawn-gate: a read-only agent needs How-it-fails only, never Spiral bound or a receipt, even when also listed as builder-class", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env); // no receipt
  for (const type of ["reviewer-codex", "auditor", "plugin:scout", "research"]) {
    assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, subagent_type: type }), env).out, null, type);
  }
  assert.match(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: "review it", subagent_type: "reviewer-codex" }), env)), /^Spawn refused: the prompt has no "## How it fails" heading\./);
  setConfig(env, { builderClass: ["builder", "reviewer"], readOnlyAgents: ["reviewer"] });
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, subagent_type: "reviewer" }), env).out, null, "read-only wins");
  setConfig(env, { readOnlyAgents: [] });
  assert.match(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, subagent_type: "builder" }), env)), /Spiral bound/);
});

test("spawn-gate: the Task tool name is gated the same as Agent; other tools are ignored", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(t, env);
  assert.ok(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: "x", tool_name: "Task" }), env)));
  assert.equal(runHook("spawn-gate", { ...spawnPayload({ cwd: repo, prompt: "x" }), tool_name: "Bash", tool_input: { command: "ls" } }, env).out, null);
});

test("spawn-gate: gate 2 denies a builder-class spawn with no pattern-check receipt, naming the command", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: join(repo, "src"), session_id: "s-abc" }), env);
  const reason = deny(r);
  assert.ok(reason, r.stdout);
  assert.ok(reason.includes(`${join(repo, ".pattern-check", "s-abc.md")}`), reason);
  assert.match(reason, /pattern-check\.mjs" open "<what you are about to build>" then node ".*pattern-check\.mjs" record --session s-abc/);
  assert.match(reason, /Then re-issue this spawn\. To turn this gate off instead, set `"requirePatternCheck": false` in .*delegation\/config\.json\.$/);
});

test("spawn-gate: gate 2 is skipped with one skipped.log line when pattern-check is not installed; a receipt still counts", (t) => {
  const { env, root } = box(t);
  // CLAUDE_PLUGIN_ROOT names a plugin root with no pattern-check beside it and none in the cache above it.
  const lone = join(root, "cache", "mkt", "delegation", "0.1.0");
  mkdirSync(lone, { recursive: true });
  const repo = gitRepo(join(env.HOME, "repo"), env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo }), env, { extraEnv: { CLAUDE_PLUGIN_ROOT: lone } });
  assert.equal(r.out, null, r.stdout);
  assert.match(skippedLog(env), /^\S+ spawn-gate pattern-check receipt not checked: pattern-check is not installed .*; spawn allowed\n$/);
  // Installed in the cache beside it: the newest version by number is the one named.
  for (const v of ["0.3.9", "0.3.10", "0.2.99"]) {
    mkdirSync(join(root, "cache", "mkt", "pattern-check", v, "scripts"), { recursive: true });
    writeFileSync(join(root, "cache", "mkt", "pattern-check", v, "scripts", "pattern-check.mjs"), "");
  }
  const d = runHook("spawn-gate", spawnPayload({ cwd: repo }), env, { extraEnv: { CLAUDE_PLUGIN_ROOT: lone } });
  assert.match(deny(d), /pattern-check\/0\.3\.10\/scripts\/pattern-check\.mjs" open/);
  assert.deepEqual(["0.3.9", "0.3.10", "0.10.0", "0.2.99"].sort(compareVersionsDesc), ["0.10.0", "0.3.10", "0.3.9", "0.2.99"]);
  mkdirSync(join(repo, ".pattern-check"));
  writeFileSync(join(repo, ".pattern-check", "s-test-1.md"), "# r\n");
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo }), env, { extraEnv: { CLAUDE_PLUGIN_ROOT: join(root, "elsewhere", "x", "delegation") } }).out, null, "a receipt counts with no CLI found");
});

test("spawn-gate: gate 2 accepts pattern-check's state copy of the receipt", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env);
  mkdirSync(join(env.XDG_STATE_HOME, "pattern-check", "receipts"), { recursive: true });
  writeFileSync(join(env.XDG_STATE_HOME, "pattern-check", "receipts", "s-test-1.md"), "# r\n");
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo }), env).out, null);
});

test("spawn-gate: gate 2 keys an unusable session id the way pattern-check does (cwd hash)", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, session_id: "../bad id" }), env);
  assert.match(deny(r), /\.pattern-check\/cwd-[0-9a-f]{16}\.md/);
});

test("spawn-gate: gate 2 is skipped outside a git repository, with one skipped.log line", (t) => {
  const { env } = box(t);
  const dir = join(env.HOME, "loose");
  mkdirSync(dir);
  const r = runHook("spawn-gate", spawnPayload({ cwd: dir }), env);
  assert.equal(r.out, null, r.stdout);
  const log = skippedLog(env);
  assert.match(log, /^\S+ spawn-gate pattern-check receipt not checked: .*loose is in no git repository; spawn allowed\n$/);
});

test("spawn-gate: unparseable tool_input allows the call and logs one skipped.log line; malformed stdin fails open via errors.log", (t) => {
  const { env } = box(t);
  const r = runHook("spawn-gate", { session_id: "s", cwd: env.HOME, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { prompt: 42 } }, env);
  assert.equal(r.out, null, r.stdout);
  assert.match(skippedLog(env), /spawn-gate tool Agent: tool_input\.prompt is not a string; spawn allowed unchecked/);
  const m = runHook("spawn-gate", "{not json", env);
  assert.equal(m.status, 0);
  assert.equal(m.out.hookSpecificOutput, undefined);
  assert.match(m.out.systemMessage, /failed open/);
  assert.match(errorsLog(env), /spawn-gate stdin not JSON/);
});

test("spawn-gate: config builderClass, requireSpiralBound, requirePatternCheck, requireHowItFails and off", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env); // no receipt
  setConfig(env, { builderClass: ["forge"] });
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, subagent_type: "builder" }), env).out, null, "builder is no longer builder-class");
  assert.match(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, subagent_type: "Forge" }), env)), /builder-class "Forge"/);
  setConfig(env, { requireSpiralBound: false });
  assert.match(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY }), env)), /pattern-check receipt/, "spiral off, receipt still required");
  setConfig(env, { requireSpiralBound: false, requirePatternCheck: false });
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY }), env).out, null);
  setConfig(env, { requireHowItFails: false, requirePatternCheck: false });
  assert.match(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: "nothing" }), env)), /needs a "## Spiral bound" heading too/);
  setConfig(env, { off: true });
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: "nothing" }), env).out, null);
});

test("spawn-gate: a malformed config uses the defaults and says so once in a systemMessage", (t) => {
  const { env } = box(t, { config: "{ nope" });
  const repo = repoWithReceipt(t, env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo }), env);
  assert.equal(r.out.hookSpecificOutput, undefined);
  assert.match(r.out.systemMessage, /config ignored: .*config\.json is not JSON/);
  setConfig(env, { builderClass: "builder" });
  const d = runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: "x" }), env);
  assert.ok(deny(d), "defaults still gate");
  assert.match(d.out.systemMessage, /builderClass must be an array of strings/);
});

// ---- gate 3: send-message-check ----

const sendPayload = (tool_response, to = "Worker") => ({ session_id: "s", cwd: "/tmp", hook_event_name: "PostToolUse", tool_name: "SendMessage", tool_input: { to, summary: "s", message: "m" }, tool_response });

test("send-message-check: success:false blocks with the tool's own message plus the not-delivered line", (t) => {
  const { env } = box(t);
  const r = runHook("send-message-check", sendPayload({ success: false, message: "No agent named 'Worker' is reachable.\nUse ListAgents to see the running agents." }), env);
  assert.equal(r.out.decision, "block");
  assert.equal(r.out.reason, "No agent named 'Worker' is reachable.\nUse ListAgents to see the running agents. (to: Worker)\nthis message was NOT delivered; spawn a new agent or fix the name (a new `Agent` call, or `SendMessage` to a name that is running)");
});

test("send-message-check: success:false with no message still blocks with a stand-in line", (t) => {
  const { env } = box(t);
  const r = runHook("send-message-check", sendPayload({ success: false }), env);
  assert.equal(r.out.decision, "block");
  assert.match(r.out.reason, /^SendMessage returned success: false\. \(to: Worker\)\nthis message was NOT delivered/);
});

test("send-message-check: every other shape is silence", (t) => {
  const { env } = box(t);
  for (const resp of [{ success: true, message: "Message sent" }, { message: "x" }, "a string", null, undefined, { success: "false" }]) {
    assert.equal(runHook("send-message-check", sendPayload(resp), env).out, null, JSON.stringify(resp));
  }
  assert.equal(runHook("send-message-check", { ...sendPayload({ success: false }), tool_name: "Bash" }, env).out, null, "other tools");
  setConfig(env, { off: true });
  assert.equal(runHook("send-message-check", sendPayload({ success: false, message: "x" }), env).out, null, "off");
});

// ---- the stop warning: subagent-stop ----

const stopPayload = (agent_type, last_assistant_message, agent_id = "a1") => ({ session_id: "s", cwd: "/tmp", hook_event_name: "SubagentStop", stop_hook_active: false, agent_id, agent_type, last_assistant_message });

test("subagent-stop: a builder-class report without Stopped because gets a systemMessage, never a block", (t) => {
  const { env } = box(t);
  const r = runHook("subagent-stop", stopPayload("builder", "All done, tests green."), env);
  assert.equal(r.out.decision, undefined);
  assert.equal(r.out.continue, undefined);
  assert.equal(r.out.systemMessage, `delegation: builder-class agent "builder" (a1) ended without a "Stopped because:" line. Its report is unfinished until it says which applies. The report's last line is exactly one of: \`Stopped because: acceptance met\` (every acceptance check passed once), \`Stopped because: bound hit\` (a retry, commit, time or tool bound stopped it; name which after it), \`Stopped because: told to stop\` (the parent sent a stop). The next builder-class brief needs: "End your report with one line: ${STOPPED_LINE}." Full template: ${TEMPLATE} in the delegation plugin.`);
});

test("subagent-stop: a wrong value is named; a valid one in any case, bold, backticked or with a detail passes only as the last non-empty line", (t) => {
  const { env } = box(t);
  const r = runHook("subagent-stop", stopPayload("beefy-builder", "Report.\nStopped because: I felt like it"), env);
  assert.match(r.out.systemMessage, /ended with "Stopped because: i felt like it", which is not one of the three values/);
  for (const msg of ["x\nStopped because: acceptance met", "x\n**Stopped because:** Bound hit", "x\nStopped because: told to stop.\n", "The template says `Stopped because: x`.\n\nStopped because: acceptance met\n", "x\nStopped because: bound hit (retry on the lint step)", "x\n`Stopped because: acceptance met`\n\n", "x\nStopped because: bound hit: commit budget"]) {
    assert.equal(runHook("subagent-stop", stopPayload("builder", msg), env).out, null, msg);
  }
  const trailing = runHook("subagent-stop", stopPayload("builder", "Stopped because: acceptance met\nsome trailing text"), env);
  assert.match(trailing.out.systemMessage, /has "Stopped because: acceptance met" but not as its last line/);
  assert.deepEqual(stoppedBecause("Stopped because: bound hitting"), { found: true, value: "bound hitting", valid: false, misplaced: false });
});

test("subagent-stop: non-builder and read-only agents, a missing or empty agent_type (Claude Code's internal agents), and off are silence; a missing message warns", (t) => {
  const { env } = box(t);
  assert.equal(runHook("subagent-stop", stopPayload("reader", "no line"), env).out, null);
  assert.equal(runHook("subagent-stop", stopPayload("newdle:scout", "no line"), env).out, null);
  assert.equal(runHook("subagent-stop", stopPayload("", "no line"), env).out, null, "empty agent_type");
  assert.equal(runHook("subagent-stop", stopPayload("  ", "no line"), env).out, null, "blank agent_type");
  const noType = stopPayload("builder", "no line");
  delete noType.agent_type;
  assert.equal(runHook("subagent-stop", noType, env).out, null);
  const noMsg = stopPayload("builder", undefined);
  assert.match(runHook("subagent-stop", noMsg, env).out.systemMessage, /ended without a "Stopped because:" line/);
  setConfig(env, { builderClass: ["reader"] });
  assert.equal(runHook("subagent-stop", stopPayload("reader", "no line"), env).out, null, "reader stays read-only by default");
  setConfig(env, { builderClass: ["reader"], readOnlyAgents: [] });
  assert.match(runHook("subagent-stop", stopPayload("reader", "no line"), env).out.systemMessage, /builder-class agent "reader"/);
  setConfig(env, { off: true });
  assert.equal(runHook("subagent-stop", stopPayload("builder", "no line"), env).out, null);
});

test("every gate answers well inside the 4 s deadline on a large prompt", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(t, env);
  const big = `${"lorem ipsum ".repeat(20_000)}\n${GOOD_BRIEF}`;
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: big }), env);
  assert.equal(r.out, null, r.stdout);
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
  const s = runHook("subagent-stop", stopPayload("builder", `${big}\nStopped because: bound hit`), env);
  assert.equal(s.out, null);
  assert.ok(s.ms < 4000, `took ${s.ms} ms`);
});

// ---- the teaching block: session-start ----

test("session-start: a fresh session gets the brief skeleton as additionalContext, under 25 lines, naming the configured builder class", (t) => {
  const { env } = box(t);
  const r = runHook("session-start", { session_id: "s", cwd: env.HOME, hook_event_name: "SessionStart", source: "startup" }, env);
  const ctx = r.out.hookSpecificOutput.additionalContext;
  assert.equal(r.out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(ctx.split("\n").length < 25, `${ctx.split("\n").length} lines`);
  assert.match(ctx, /^# Delegation: how to brief a subagent/);
  assert.match(ctx, /Before any Agent\/Task call, the prompt you hand the subagent carries these sections/);
  assert.match(ctx, /builder-class spawn \(builder, beefy-builder, task, sonic, general-purpose\)/);
  assert.match(ctx, /\n# Target .*\n# Change .*\n# Acceptance .*\n## How it fails\n- .*\n## Spiral bound\n- /);
  assert.ok(ctx.includes(`\`${STOPPED_LINE}\``));
  assert.match(ctx, /\*\*CLAIM\*\* \(file:line, or command and output\) or \*\*CITE\*\*/);
  for (const source of ["resume", "clear", "compact"]) assert.ok(runHook("session-start", { session_id: "s", cwd: env.HOME, hook_event_name: "SessionStart", source }, env).out.hookSpecificOutput.additionalContext, source);
  setConfig(env, { builderClass: ["forge"] });
  assert.match(runHook("session-start", { hook_event_name: "SessionStart", source: "startup" }, env).out.hookSpecificOutput.additionalContext, /builder-class spawn \(forge\)/);
  setConfig(env, { off: true });
  assert.equal(runHook("session-start", { hook_event_name: "SessionStart", source: "startup" }, env).out, null);
});
