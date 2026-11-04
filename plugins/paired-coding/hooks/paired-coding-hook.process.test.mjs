// The hook as Claude Code runs it: a spawned `node hooks/paired-coding-hook.mjs <event>` process
// fed the event's JSON on stdin, judged by its exit status and the JSON it prints. Every spawn
// has a 5 s budget; a hang fails the test. Covers the fault paths: empty and malformed stdin, an
// unwritable state directory, missing and malformed configuration, and a fault inside the gate
// while pairing (which fails closed) or outside it (which never blocks).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { faultReply, queueInput } from "./paired-coding-hook.mjs";
import { callTool } from "../server/pair-server.mjs";
import { SERVER_NAME, TOOL_PREFIX, writeBinding } from "../server/binding.mjs";
import { sandboxProblem } from "../lib/host-io.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "paired-coding-hook.mjs");
const BUDGET_MS = 5000;
const EVENTS = ["pre-tool-use", "user-prompt-submit", "stop", "session-start", "session-end"];
const hasSandbox = sandboxProblem() === null;

// Under $HOME, as the other hook tests: see paired-coding-hook.test.mjs for why not /tmp.
const FIXTURES = realpathSync(mkdtempSync(join(homedir(), ".pc-proc-")));
after(() => {
  spawnSync("/bin/chmod", ["-R", "u+rwx", FIXTURES]);
  rmSync(FIXTURES, { recursive: true, force: true });
});

function fixture() {
  const top = mkdtempSync(join(FIXTURES, "f-"));
  const root = join(top, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "alpha\n");
  const base = join(top, "state");
  const transcript = join(top, "projects", "p", "s1.jsonl");
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, "");
  return { top, root, base, transcript, env: { PAIRED_CODING_STATE_DIR: base }, common: { session_id: "s1", cwd: root, transcript_path: transcript } };
}

/** The JSON Claude Code sends for each event (hooks reference, PreToolUse/Stop/SessionStart/UserPromptSubmit/SessionEnd). */
function payload(event, f, extra = {}) {
  const c = { ...f.common, hook_event_name: event };
  switch (event) {
    case "pre-tool-use": return { ...c, tool_name: "Write", tool_input: { file_path: join(f.root, "a.txt"), content: "x" }, tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, ...extra };
    case "user-prompt-submit": return { ...c, prompt: "hello", prompt_id: `p-${Math.random().toString(36).slice(2)}`, ...extra };
    case "stop": return { ...c, stop_hook_active: false, ...extra };
    case "session-start": return { ...c, source: "startup", ...extra };
    case "session-end": return { ...c, reason: "other", ...extra };
    default: throw new Error(event);
  }
}

/** Spawn the hook once, as Claude Code does. `input` is a string (raw stdin) or an object. */
function runHook(event, input, env, { home } = {}) {
  const t0 = Date.now();
  const base = { ...process.env };
  delete base.PAIRED_CODING_STATE_DIR;
  const r = spawnSync(process.execPath, [HOOK, event], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...base, ...(home ? { HOME: home } : {}), ...env },
    encoding: "utf8",
    timeout: BUDGET_MS,
  });
  const ms = Date.now() - t0;
  let json = null;
  if (r.stdout) json = JSON.parse(r.stdout);
  return { status: r.status, signal: r.signal, error: r.error, stdout: r.stdout, stderr: r.stderr, ms, json };
}

/** Exit 0, inside the budget, nothing blocked. */
function assertAllowed(r, label) {
  assert.equal(r.error, undefined, `${label}: ${r.error}`);
  assert.equal(r.signal, null, `${label}: killed by ${r.signal} (hung past ${BUDGET_MS} ms)`);
  assert.equal(r.status, 0, `${label}: ${r.stderr}`);
  assert.ok(r.ms < BUDGET_MS, `${label}: took ${r.ms} ms`);
  assert.notEqual(r.json?.hookSpecificOutput?.permissionDecision, "deny", label);
  assert.notEqual(r.json?.decision, "block", label);
  assert.notEqual(r.json?.continue, false, label);
}

const logLines = (base) => (existsSync(join(base, "errors.log")) ? readFileSync(join(base, "errors.log"), "utf8").split("\n").filter(Boolean) : []);

/** Start pairing for session s1 the way Claude Code does: the hook binds the call, the server runs it. */
async function startPairing(f) {
  const id = `toolu_start${Math.random().toString(36).slice(2)}`;
  const pre = runHook("pre-tool-use", { ...f.common, hook_event_name: "PreToolUse", tool_name: `${TOOL_PREFIX}pair_start`, mcp_server: { name: SERVER_NAME, source: "plugin" }, tool_input: {}, tool_use_id: id }, f.env);
  assertAllowed(pre, "pair_start PreToolUse");
  const r = await callTool({ name: "pair_start", arguments: {}, _meta: { "claudecode/toolUseId": id } }, { env: f.env });
  assert.equal(r.isError, false, r.content[0].text);
}

test("a session that never paired: every event exits 0 with no output and creates no state", () => {
  const f = fixture();
  for (const event of EVENTS) {
    const r = runHook(event, payload(event, f), f.env);
    assertAllowed(r, event);
    assert.equal(r.stdout, "", event);
  }
  assert.equal(existsSync(f.base), false);
});

test("empty stdin: every event exits 0, lets the call through, warns once and logs one line", () => {
  for (const event of EVENTS) {
    const f = fixture();
    const r = runHook(event, "", f.env);
    assertAllowed(r, event);
    assert.match(r.json.systemMessage, /stdin was empty/, event);
    assert.ok(r.json.systemMessage.includes(`Logged to ${join(f.base, "errors.log")}`), event);
    assert.equal(r.json.hookSpecificOutput, undefined, event);
    const lines = logLines(f.base);
    assert.equal(lines.length, 1, event);
    assert.match(lines[0], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+Z hooks/paired-coding-hook\\.mjs ${event} session=-: stdin was empty$`));
  }
});

test("malformed stdin (not JSON, or JSON that is not an object): exit 0, allowed, one warning, one log line", () => {
  for (const event of EVENTS) {
    for (const raw of ["{not json", "[1,2]", "null"]) {
      const f = fixture();
      const r = runHook(event, raw, f.env);
      assertAllowed(r, `${event} ${raw}`);
      assert.match(r.json.systemMessage, /could not read its input \(stdin is not a hook event object: .+\), so it did nothing\. Logged to /, `${event} ${raw}`);
      const lines = logLines(f.base);
      assert.equal(lines.length, 1, `${event} ${raw}`);
      assert.match(lines[0], new RegExp(` hooks/paired-coding-hook\\.mjs ${event} session=-: stdin is not a hook event object: `));
    }
  }
});

test("an unwritable state directory: a session that never paired is untouched; this plugin's own tool is refused, naming the tool and the way out", () => {
  const f = fixture();
  mkdirSync(f.base, { recursive: true });
  chmodSync(f.base, 0o500);
  try {
    for (const event of EVENTS) {
      const r = runHook(event, payload(event, f), f.env);
      assertAllowed(r, event);
      assert.equal(r.stdout, "", event);
    }
    // pair_start must bind through the state base; that write fails, and an own tool fails closed.
    const r = runHook("pre-tool-use", payload("pre-tool-use", f, { tool_name: `${TOOL_PREFIX}pair_start`, mcp_server: { name: SERVER_NAME, source: "plugin" }, tool_input: {} }), f.env);
    assert.equal(r.status, 0);
    assert.ok(r.ms < BUDGET_MS);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, "deny");
    const why = r.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(why, /pair_start is refused/);
    assert.match(why, /EACCES|permission denied/i);
    assert.match(why, /could not be logged to .*errors\.log/);
    assert.match(why, /type pair stop/);
    assert.match(why, /\/plugin disable paired-coding/);
    assert.match(r.json.systemMessage, /could not be logged to .*errors\.log/);
  } finally {
    chmodSync(f.base, 0o700);
  }
});

test("missing or malformed configuration: no PAIRED_CODING_STATE_DIR, a relative one, or one that is a file leaves a never-paired session untouched", () => {
  const f = fixture();
  const home = join(f.top, "home");
  mkdirSync(home);
  const asFile = join(f.top, "state-is-a-file");
  writeFileSync(asFile, "not a directory\n");
  for (const env of [{}, { PAIRED_CODING_STATE_DIR: "" }, { PAIRED_CODING_STATE_DIR: "relative/state" }, { PAIRED_CODING_STATE_DIR: asFile }]) {
    for (const event of EVENTS) {
      const r = runHook(event, payload(event, f), env, { home });
      assertAllowed(r, `${JSON.stringify(env)} ${event}`);
      assert.equal(r.stdout, "", `${JSON.stringify(env)} ${event}`);
    }
  }
  assert.equal(existsSync(join(home, ".local")), false, "the default state base was never created");
  assert.equal(readFileSync(asFile, "utf8"), "not a directory\n");
});

test("a session-start fault in a session that never paired is warned and logged, and blocks nothing", () => {
  const f = fixture();
  const r = runHook("session-start", payload("session-start", f, { source: "clear", cwd: join(f.top, "gone") }), f.env);
  assertAllowed(r, "session-start");
  assert.match(r.json.systemMessage, /ENOENT/);
  assert.match(r.json.systemMessage, /Logged to .*errors\.log/);
  assert.match(r.json.systemMessage, /pairing did not carry over/);
  assert.equal(r.json.hookSpecificOutput, undefined);
  const lines = logLines(f.base);
  assert.equal(lines.length, 1);
  assert.match(lines[0], / lib\/host-io\.mjs:\d+ session-start session=s1: ENOENT/);
});

test("a gate fault for a host tool in a session that never paired lets the call through with a warning", () => {
  const f = fixture();
  const out = faultReply("pre-tool-use", payload("pre-tool-use", f), f.env, new Error("boom\nsecond line"));
  assert.equal(out.hookSpecificOutput, undefined, "no decision: the call goes ahead");
  assert.match(out.systemMessage, /boom second line/);
  assert.match(out.systemMessage, /Logged to .*errors\.log/);
  assert.match(out.systemMessage, /Write went ahead/);
  assert.equal(logLines(f.base).length, 1);
});

test("while pairing, a malformed state file reads as closed: Write is refused, Read is not, and each event warns and logs the degraded read once", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await startPairing(f);
  writeFileSync(join(f.base, "s1", "state.json"), "{garbage");
  const r = runHook("pre-tool-use", payload("pre-tool-use", f), f.env);
  assert.equal(r.status, 0);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, "deny");
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /Write is the host's own mutating tool/);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /write with pair_write or pair_edit/);
  assert.match(r.json.systemMessage, /state file unreadable/);
  assert.match(r.json.systemMessage, /Logged to /);
  assert.match(r.json.systemMessage, /by typing pair stop\.$/);
  const read = runHook("pre-tool-use", payload("pre-tool-use", f, { tool_name: "Read", tool_input: { file_path: join(f.root, "a.txt") } }), f.env);
  assertAllowed(read, "Read");
  assert.match(read.json.systemMessage, /state file unreadable/);
  const prompt = runHook("user-prompt-submit", payload("user-prompt-submit", f), f.env);
  assertAllowed(prompt, "user-prompt-submit");
  assert.match(prompt.json.systemMessage, /state file unreadable/);
  const lines = logLines(f.base);
  assert.deepEqual(lines.map((l) => / (pre-tool-use|user-prompt-submit) session=s1: session state degraded \(state file unreadable\)/.exec(l)?.[1]), ["pre-tool-use", "pre-tool-use", "user-prompt-submit"]);
});

for (const event of ["pre-tool-use", "user-prompt-submit"]) {
  test(`while pairing, a degraded read is warned and logged once by ${event} even when a queued typed turn saves the state first`, { skip: !hasSandbox }, async () => {
    const real = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prompt-entries.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.entrypoint === "cli");
    const f = fixture();
    await startPairing(f);
    // A typed ordinary turn, queued and in the transcript, waiting to be judged by the next event.
    const p = payload("user-prompt-submit", f, { prompt: "keep going" });
    assertAllowed(runHook("user-prompt-submit", p, f.env), "queued prompt");
    appendFileSync(f.transcript, `${JSON.stringify({ ...real, promptId: p.prompt_id, message: { role: "user", content: "keep going" } })}\n`);
    writeFileSync(join(f.base, "s1", "state.json"), "{garbage");
    const r = runHook(event, payload(event, f), f.env);
    assert.equal(r.status, 0);
    if (event === "pre-tool-use") assert.equal(r.json.hookSpecificOutput.permissionDecision, "deny");
    assert.match(r.json.systemMessage, /state file unreadable/);
    assert.match(r.json.systemMessage, /Logged to /);
    const journal = readFileSync(join(f.base, "s1", "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(journal.filter((e) => e.type === "input" && e.text === "keep going").length, 1, "the queued turn was judged in this event");
    const lines = logLines(f.base);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(` ${event} session=s1: session state degraded \\(state file unreadable\\)`));
  });
}

for (const event of ["pre-tool-use", "user-prompt-submit"]) {
  test(`a degraded read taken before a queued typed pair stop is warned and logged once by ${event}, the warning says pairing ended, and nothing is refused`, { skip: !hasSandbox }, async () => {
    const real = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prompt-entries.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.entrypoint === "cli");
    const f = fixture();
    await startPairing(f);
    const p = payload("user-prompt-submit", f, { prompt: "pair stop" });
    assertAllowed(runHook("user-prompt-submit", p, f.env), "queued stop");
    appendFileSync(f.transcript, `${JSON.stringify({ ...real, promptId: p.prompt_id, message: { role: "user", content: "pair stop" } })}\n`);
    writeFileSync(join(f.base, "s1", "state.json"), "{garbage");
    const r = runHook(event, payload(event, f), f.env);
    assertAllowed(r, event);
    assert.equal(JSON.parse(readFileSync(join(f.base, "s1", "state.json"), "utf8")).phase, "inactive", "the queued stop ended pairing");
    assert.match(r.json.hookSpecificOutput.additionalContext, /your partner typed pair stop/);
    assert.match(r.json.systemMessage, /state file unreadable/);
    assert.match(r.json.systemMessage, /typed pair stop ended pairing in this event\. Host tools are no longer refused\./);
    assert.doesNotMatch(r.json.systemMessage, /treats pairing as on/);
    assert.match(r.json.systemMessage, /Logged to /);
    const lines = logLines(f.base);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(` ${event} session=s1: session state degraded \\(state file unreadable\\) in \\S+; pairing then ended by a typed stop$`));
  });
}

test("while pairing, a session directory the gate cannot even look into is uncertain and fails closed", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await startPairing(f);
  const dir = join(f.base, "s1");
  chmodSync(dir, 0o000);
  try {
    for (const tool_name of ["Write", "Read"]) {
      const r = runHook("pre-tool-use", payload("pre-tool-use", f, { tool_name }), f.env);
      assert.equal(r.status, 0, tool_name);
      assert.ok(r.ms < BUDGET_MS, tool_name);
      assert.equal(r.json.hookSpecificOutput.permissionDecision, "deny", tool_name);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, new RegExp(`^paired-coding: ${tool_name} is refused: `), tool_name);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /cannot tell whether pairing is on: .*activated is unreadable \(EACCES\)/, tool_name);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /pair stop/, tool_name);
    }
    // The other events never block, and say so.
    for (const event of ["user-prompt-submit", "stop", "session-end"]) {
      const r = runHook(event, payload(event, f), f.env);
      assertAllowed(r, event);
      assert.match(r.json.systemMessage, /EACCES/, event);
    }
  } finally {
    chmodSync(dir, 0o700);
  }
  const lines = logLines(f.base);
  assert.equal(lines.length, 5);
  for (const l of lines) assert.match(l, /cannot tell whether pairing is on/, l);
});

test("a state base the gate cannot look into is uncertain even for a session that never paired: tools fail closed, the warning says the log could not be written", () => {
  const f = fixture();
  mkdirSync(f.base, { recursive: true });
  chmodSync(f.base, 0o000);
  try {
    const r = runHook("pre-tool-use", payload("pre-tool-use", f), f.env);
    assert.equal(r.status, 0);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, "deny");
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /Write is refused: .*EACCES/);
    assert.match(r.json.systemMessage, /could not be logged to .*errors\.log/);
  } finally {
    chmodSync(f.base, 0o700);
  }
});

test("after a typed pair stop, a fault in the hook's own bookkeeping never refuses a tool", { skip: !hasSandbox }, async () => {
  const real = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prompt-entries.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.entrypoint === "cli");
  const f = fixture();
  await startPairing(f);
  const p = payload("user-prompt-submit", f, { prompt: "pair stop" });
  assertAllowed(runHook("user-prompt-submit", p, f.env), "stop prompt");
  appendFileSync(f.transcript, `${JSON.stringify({ ...real, promptId: p.prompt_id, message: { role: "user", content: "pair stop" } })}\n`);
  assertAllowed(runHook("stop", payload("stop", f), f.env), "stop");
  const dir = join(f.base, "s1");
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).phase, "inactive");
  assert.equal(JSON.parse(readFileSync(join(dir, "activated"), "utf8")).ended, true);
  // The pending directory (stashed notices, queued turns) can no longer be locked.
  chmodSync(join(dir, "pending"), 0o500);
  try {
    const r = runHook("pre-tool-use", payload("pre-tool-use", f), f.env);
    assertAllowed(r, "Write after the stop");
    assert.match(r.json.systemMessage, /Write went ahead: this session is not pairing/);
  } finally {
    chmodSync(join(dir, "pending"), 0o700);
  }
  assert.equal(logLines(f.base).length, 1);
});

test("while pairing, a gate fault fails closed for tools and never blocks a prompt, a stop or a session end; each is warned and logged", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await startPairing(f);
  const dir = join(f.base, "s1");
  chmodSync(dir, 0o500);
  try {
    for (const tool_name of ["Write", "Read"]) {
      const r = runHook("pre-tool-use", payload("pre-tool-use", f, { tool_name }), f.env);
      assert.equal(r.status, 0, tool_name);
      assert.ok(r.ms < BUDGET_MS, tool_name);
      assert.equal(r.json.hookSpecificOutput.permissionDecision, "deny", tool_name);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, new RegExp(`^paired-coding: ${tool_name} is refused: the gate's hook failed \\(.+\\) and fails closed while pairing\\. Logged to .*errors\\.log\\. Tell your partner; the way out is for them to type pair stop`), tool_name);
      assert.match(r.json.systemMessage, new RegExp(`${tool_name} was refused because the gate fails closed while pairing\\.$`), tool_name);
    }
    const prompt = runHook("user-prompt-submit", payload("user-prompt-submit", f), f.env);
    assertAllowed(prompt, "user-prompt-submit");
    assert.match(prompt.json.systemMessage, /^paired-coding: the user-prompt-submit hook failed at .+ This turn was not queued for the typed-input check/);
    // Stop judges queued turns; there are none, so make one it cannot clear.
    chmodSync(dir, 0o700);
    mkdirSync(join(dir, "pending"), { recursive: true });
    writeFileSync(join(dir, "pending", "inputs.jsonl"), "{}\n");
    chmodSync(join(dir, "pending"), 0o500);
    const stop = runHook("stop", payload("stop", f), f.env);
    assertAllowed(stop, "stop");
    assert.match(stop.json.systemMessage, /^paired-coding: the stop hook failed at .+ Queued turns were not judged/);
    chmodSync(join(dir, "pending"), 0o700);
    chmodSync(dir, 0o500);
    const end = runHook("session-end", payload("session-end", f), f.env);
    assertAllowed(end, "session-end");
    assert.match(end.json.systemMessage, /^paired-coding: the session-end hook failed at .+ The final snapshot, the reap of pair_run processes or the pair-accepted receipt may not have completed/);
  } finally {
    chmodSync(dir, 0o700);
  }
  const lines = logLines(f.base);
  assert.deepEqual(lines.map((l) => / (pre-tool-use|user-prompt-submit|stop|session-end) session=s1: /.exec(l)?.[1]), ["pre-tool-use", "pre-tool-use", "user-prompt-submit", "stop", "session-end"]);
  for (const l of lines) assert.match(l, /^\S+Z (hooks|lib|core|server)\/[\w.-]+\.mjs:\d+ /, l);
});

test("the 5 s budget holds for one PreToolUse that judges three queued turns whose transcript entries never land", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await startPairing(f);
  const dir = join(f.base, "s1");
  // Three turns queued at once, as after turns that made no tool call; built with the hook's own queue writer.
  for (let i = 0; i < 3; i++) queueInput(dir, { prompt_id: `never-${i}`, prompt: `turn ${i}`, transcript_path: f.transcript });
  assert.equal(readFileSync(join(dir, "pending", "inputs.jsonl"), "utf8").split("\n").filter(Boolean).length, 3);
  const r = runHook("pre-tool-use", payload("pre-tool-use", f, { tool_name: "Read" }), f.env);
  assertAllowed(r, "Read with three queued turns");
  const journal = readFileSync(join(dir, "journal.jsonl"), "utf8");
  assert.equal(journal.split("\n").filter((l) => l.includes("claude:no-transcript-entry")).length, 3);
  assert.equal(existsSync(join(dir, "pending", "inputs.jsonl")), false, "the queue was drained");
});

test("a typed turn from the real transcript shape is trusted through the spawned hook", { skip: !hasSandbox }, async () => {
  // The CLI entry from fixtures/prompt-entries.jsonl (captured from Claude Code), re-keyed to a new prompt id.
  const real = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prompt-entries.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.entrypoint === "cli");
  const f = fixture();
  await startPairing(f);
  const p = payload("user-prompt-submit", f, { prompt: real.message.content });
  assertAllowed(runHook("user-prompt-submit", p, f.env), "prompt");
  appendFileSync(f.transcript, `${JSON.stringify({ ...real, promptId: p.prompt_id })}\n`);
  assertAllowed(runHook("pre-tool-use", payload("pre-tool-use", f, { tool_name: "Read" }), f.env), "Read");
  const inputs = readFileSync(join(f.base, "s1", "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "input");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].text, real.message.content);
});
