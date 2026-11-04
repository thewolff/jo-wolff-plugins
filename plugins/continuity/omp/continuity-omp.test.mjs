// omp/continuity-omp.test.mjs — the OMP adapter: the payload it builds from OMP's
// session_before_compact event (the three host fields buildSnapshot reads, no transcript_path),
// the budgets against the hook runner's deadline and OMP's handler timeout, each handler's
// fail-open paths with a fake runner, the four registrations and the auto/manual trigger
// bookkeeping, and one round trip through the real hooks: a save spawned from a fake OMP event
// lands in the plugin's state dir and the restore spawned after it hands the snapshot, the rules
// section and the liveness line to sendMessage.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { DEADLINE_MS } from "../lib/hook-runner.mjs";
import { walkRules } from "../lib/repo-rules.mjs";
import { MAX_SECTION_CHARS } from "../lib/snapshot.mjs";
import { box } from "../test/helpers.mjs";
import continuityOmp, {
  MAX_FILE_OPS_CHARS,
  OMP_HOST_RULES,
  MAX_INTENTS,
  MAX_INTENT_CHARS,
  OMP_HANDLER_BUDGET_MS,
  PRE_COMPACT_HOOK,
  PRE_COMPACT_TIMEOUT_MS,
  RESTORE_HOOK,
  RESTORE_MESSAGE_TYPE,
  RESTORE_TIMEOUT_MS,
  beforeCompactHandler,
  buildPreCompactPayload,
  buildRestorePayload,
  compactionEntryId,
  defaultStateDir,
  fileOperationsFrom,
  intentsFrom,
  resolveNode,
  sessionCompactHandler,
  spawnHook,
  userText,
} from "./continuity-omp.ts";

const ctx = (over = {}) => ({ cwd: "/work", sessionManager: { getSessionId: () => "seat-lintel-1789498192-31073" }, hasUI: true, ...over });
const user = (content) => ({ role: "user", content });
const preparation = (over = {}) => ({
  messagesToSummarize: [user("fix the flaky test"), { role: "assistant", content: "On it." }, user([{ type: "text", text: "then bump the version" }, { type: "toolResult", text: "ignored" }])],
  turnPrefixMessages: [user("last ask before the cut")],
  tokensBefore: 181_000,
  fileOps: { read: new Set(["/w/b.ts", "/w/a.ts"]), written: new Set(), edited: new Set(["/w/c.ts"]) },
  ...over,
});

test("userText: string content, joined text blocks, nothing for assistants or empty content", () => {
  assert.equal(userText(user("hello")), "hello");
  assert.equal(userText(user([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])), "a\nb");
  assert.equal(userText({ role: "assistant", content: "no" }), undefined);
  assert.equal(userText(user("")), undefined);
  assert.equal(userText(user([{ type: "toolResult", text: "x" }])), undefined);
  assert.equal(userText(null), undefined);
  assert.equal(userText("a string"), undefined);
});

test("intentsFrom: the user texts of the discarded messages, prefix after summarized, the last MAX_INTENTS, each cut to MAX_INTENT_CHARS", () => {
  assert.deepEqual(intentsFrom(preparation()), ["fix the flaky test", "then bump the version", "last ask before the cut"]);
  const many = Array.from({ length: 9 }, (_, i) => user(`ask ${i}`));
  assert.deepEqual(intentsFrom({ messagesToSummarize: many, turnPrefixMessages: [] }), ["ask 4", "ask 5", "ask 6", "ask 7", "ask 8"]);
  assert.equal(MAX_INTENTS, 5);
  const [long] = intentsFrom({ messagesToSummarize: [user(`  ${"x".repeat(2 * MAX_INTENT_CHARS)}  `)] });
  assert.equal(long.length, MAX_INTENT_CHARS);
  assert.deepEqual(intentsFrom(undefined), []);
  assert.deepEqual(intentsFrom({ messagesToSummarize: "not an array" }), []);
});

test("fileOperationsFrom: Sets expanded and sorted with counts; an empty record says so with the category count; arrays accepted; capped", () => {
  assert.equal(fileOperationsFrom(preparation().fileOps), "**read** (2)\n- /w/a.ts\n- /w/b.ts\n\n**written** (0)\n\n**edited** (1)\n- /w/c.ts");
  assert.equal(fileOperationsFrom({ read: new Set(), written: new Set(), edited: new Set() }), "(the host reported no file operations across 3 categories)");
  assert.equal(fileOperationsFrom(undefined), "(the host reported no file operations)");
  assert.equal(fileOperationsFrom({ read: ["z", "y"] }), "**read** (2)\n- y\n- z");
  const huge = fileOperationsFrom({ read: new Set(Array.from({ length: 2_000 }, (_, i) => `/deep/path/to/file-${String(i).padStart(5, "0")}.ts`)) });
  assert.ok(huge.length <= MAX_FILE_OPS_CHARS + 80, `capped near ${MAX_FILE_OPS_CHARS}: ${huge.length}`);
  assert.match(huge, /TRUNCATED by the adapter at 6000 characters$/);
  assert.ok(MAX_FILE_OPS_CHARS < MAX_SECTION_CHARS, "the adapter's cap sits under the snapshot's own section cap, so the save never truncates it a second time");
});

test("buildPreCompactPayload: the PreCompact shape the hook reads, from the OMP event, with no transcript_path", () => {
  const p = JSON.parse(buildPreCompactPayload({ preparation: preparation(), customInstructions: "keep the todo list" }, ctx(), "auto"));
  assert.deepEqual(p, {
    hook_event_name: "PreCompact",
    session_id: "seat-lintel-1789498192-31073",
    cwd: "/work",
    trigger: "auto",
    custom_instructions: "keep the todo list",
    intents: ["fix the flaky test", "then bump the version", "last ask before the cut"],
    file_operations: "**read** (2)\n- /w/a.ts\n- /w/b.ts\n\n**written** (0)\n\n**edited** (1)\n- /w/c.ts",
    token_count: 181_000,
  });
  assert.equal("transcript_path" in p, false, "an OMP session file is not a Claude Code transcript; the hook must not be told it read one");
  const bare = JSON.parse(buildPreCompactPayload({}, ctx({ sessionManager: undefined }), "manual"));
  assert.equal(bare.trigger, "manual");
  assert.equal(bare.session_id, "");
  assert.equal(bare.custom_instructions, "");
  assert.deepEqual(bare.intents, []);
  assert.equal(bare.file_operations, "(the host reported no file operations)");
  assert.equal("token_count" in bare, false, "no tokensBefore: the field is absent, not 0, so the calibration record is not fed a zero");
  assert.equal("token_count" in JSON.parse(buildPreCompactPayload({ preparation: { tokensBefore: Number.NaN } }, ctx(), "auto")), false);
  const throwing = ctx({ sessionManager: { getSessionId: () => { throw new Error("no session yet"); } } });
  assert.equal(JSON.parse(buildPreCompactPayload({}, throwing, "auto")).session_id, "");
});

test("buildRestorePayload: SessionStart with source compact and the manager's session id", () => {
  assert.deepEqual(JSON.parse(buildRestorePayload(ctx())), { hook_event_name: "SessionStart", session_id: "seat-lintel-1789498192-31073", cwd: "/work", source: "compact" });
});

test("budgets: each spawn outlives the hook runner's deadline by a start-up margin and both finish well inside OMP's handler timeout", () => {
  assert.equal(OMP_HANDLER_BUDGET_MS, 30_000, "pi-coding-agent extensibility/extensions/runner.ts EXTENSION_HANDLER_TIMEOUT_MS");
  assert.equal(DEADLINE_MS, 4_000, "lib/hook-runner.mjs DEADLINE_MS, the hook's own answer-by time");
  for (const [name, ms] of [["PRE_COMPACT_TIMEOUT_MS", PRE_COMPACT_TIMEOUT_MS], ["RESTORE_TIMEOUT_MS", RESTORE_TIMEOUT_MS]]) {
    assert.ok(ms >= DEADLINE_MS + 2_000, `${name}=${ms} leaves the runner's ${DEADLINE_MS} ms plus node start-up and the stdout drain`);
    assert.ok(ms * 2 <= OMP_HANDLER_BUDGET_MS, `${name}=${ms} is at most half of OMP's ${OMP_HANDLER_BUDGET_MS} ms: the kill fires long before OMP abandons the handler`);
  }
});

test("defaultStateDir: XDG_STATE_HOME, else HOME/.local/state, under continuity", () => {
  assert.equal(defaultStateDir({ XDG_STATE_HOME: "/x" }), "/x/continuity");
  assert.equal(defaultStateDir({ XDG_STATE_HOME: "  ", HOME: "/h" }), "/h/.local/state/continuity");
  assert.equal(defaultStateDir({ HOME: "/h" }), "/h/.local/state/continuity");
});

test("resolveNode: CONTINUITY_NODE wins; under node the host binary; under bun the first node on PATH, then the usual places; else an error naming them", () => {
  const exe = new Set(["/custom/node", "/opt/homebrew/bin/node", "/p2/node"]);
  const isExecutable = (p) => exe.has(p);
  assert.deepEqual(resolveNode({ env: { CONTINUITY_NODE: "/custom/node" }, execPath: "/bun", underBun: true, home: "/h", isExecutable }), { path: "/custom/node" });
  assert.match(resolveNode({ env: { CONTINUITY_NODE: "/missing" }, execPath: "/bun", underBun: true, home: "/h", isExecutable }).error, /CONTINUITY_NODE=\/missing is not an executable file/);
  assert.deepEqual(resolveNode({ env: {}, execPath: "/usr/bin/node24", underBun: false, home: "/h", isExecutable }), { path: "/usr/bin/node24" });
  assert.deepEqual(resolveNode({ env: { PATH: "/p1:/p2" }, execPath: "/bun", underBun: true, home: "/h", isExecutable }), { path: "/p2/node" });
  assert.deepEqual(resolveNode({ env: { PATH: "/nowhere" }, execPath: "/bun", underBun: true, home: "/h", isExecutable }), { path: "/opt/homebrew/bin/node" });
  assert.match(resolveNode({ env: { PATH: "/nowhere" }, execPath: "/bun", underBun: true, home: "/h", isExecutable: () => false }).error, /no usable node on PATH \(\/nowhere\).*set CONTINUITY_NODE/);
});

test("beforeCompactHandler: spawns the save with the trigger, resolves undefined every time, shows the systemMessage, logs a throw", async () => {
  const b = box();
  try {
    const calls = [];
    const notices = [];
    const c = ctx({ ui: { notify: (t, type) => notices.push([t, type]) } });
    const runCli = async (hook, payload, cwd, ms) => {
      calls.push({ hook, payload: JSON.parse(payload), cwd, ms });
      return { systemMessage: "continuity: auto-compaction fired with no handoff written" };
    };
    assert.equal(await beforeCompactHandler({ preparation: preparation() }, c, "auto", { runCli, stateDir: b.stateDir, env: b.env }), undefined);
    assert.equal(calls[0].hook, PRE_COMPACT_HOOK);
    assert.equal(calls[0].payload.trigger, "auto");
    assert.equal(calls[0].payload.token_count, 181_000);
    assert.equal(calls[0].cwd, "/work");
    assert.equal(calls[0].ms, PRE_COMPACT_TIMEOUT_MS);
    assert.deepEqual(notices, [["continuity: auto-compaction fired with no handoff written", "warning"]]);
    notices.length = 0;
    assert.equal(await beforeCompactHandler({}, c, "manual", { runCli: async () => undefined, stateDir: b.stateDir, env: b.env }), undefined);
    assert.deepEqual(notices, []);
    assert.equal(await beforeCompactHandler({}, c, "manual", { runCli: async () => { throw new Error("pre-compact.mjs timed out after 8000ms"); }, stateDir: b.stateDir, env: b.env }), undefined);
    assert.match(readFileSync(join(b.stateDir, "errors.log"), "utf8"), /omp-adapter pre-compact\.mjs: pre-compact\.mjs timed out after 8000ms\n$/);
    // A UI that is absent or throws never reaches the host.
    assert.equal(await beforeCompactHandler({}, ctx({ hasUI: false }), "auto", { runCli: async () => ({ systemMessage: "x" }), stateDir: b.stateDir, env: b.env }), undefined);
    assert.equal(await beforeCompactHandler({}, ctx({ ui: { notify: () => { throw new Error("ui gone"); } } }), "auto", { runCli: async () => ({ systemMessage: "x" }), stateDir: b.stateDir, env: b.env }), undefined);
  } finally {
    b.release();
  }
});

test("sessionCompactHandler: the restore's additionalContext goes to send; a quiet hook sends nothing; no send is logged; a throw is logged; systemMessage shown", async () => {
  const b = box();
  try {
    const sent = [];
    const notices = [];
    const c = ctx({ ui: { notify: (t, type) => notices.push([t, type]) } });
    const calls = [];
    const runCli = async (hook, payload, cwd, ms) => {
      calls.push({ hook, payload: JSON.parse(payload), cwd, ms });
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "## Continuity snapshot\n…" }, systemMessage: "continuity: the session mark could not be written" };
    };
    await sessionCompactHandler(c, (t) => sent.push(t), { runCli, stateDir: b.stateDir, env: b.env });
    assert.deepEqual(sent, ["## Continuity snapshot\n…"]);
    assert.deepEqual(calls[0], { hook: RESTORE_HOOK, payload: { hook_event_name: "SessionStart", session_id: "seat-lintel-1789498192-31073", cwd: "/work", source: "compact" }, cwd: "/work", ms: RESTORE_TIMEOUT_MS });
    assert.deepEqual(notices, [["continuity: the session mark could not be written", "warning"]]);
    sent.length = 0;
    await sessionCompactHandler(c, (t) => sent.push(t), { runCli: async () => undefined, stateDir: b.stateDir, env: b.env });
    await sessionCompactHandler(c, (t) => sent.push(t), { runCli: async () => ({ hookSpecificOutput: { hookEventName: "SessionStart" } }), stateDir: b.stateDir, env: b.env });
    assert.deepEqual(sent, []);
    await sessionCompactHandler(c, undefined, { runCli, stateDir: b.stateDir, env: b.env });
    assert.match(readFileSync(join(b.stateDir, "errors.log"), "utf8"), /omp-adapter session-start\.mjs: the host has no sendMessage; the restore was not delivered\n$/);
    await sessionCompactHandler(c, (t) => sent.push(t), { runCli: async () => { throw new Error("exited 1"); }, stateDir: b.stateDir, env: b.env });
    assert.match(readFileSync(join(b.stateDir, "errors.log"), "utf8"), /omp-adapter session-start\.mjs: exited 1\n$/);
    assert.deepEqual(sent, []);
  } finally {
    b.release();
  }
});

test("registration: four events; auto_compaction_start marks the next compaction auto and _end clears it; the restore is a hidden custom message", async () => {
  const b = box();
  try {
    const handlers = {};
    const sent = [];
    const triggers = [];
    const runCli = async (hook, payload) => {
      if (hook === PRE_COMPACT_HOOK) {
        triggers.push(JSON.parse(payload).trigger);
        return undefined;
      }
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "restored" } };
    };
    continuityOmp({ on: (name, h) => (handlers[name] = h), sendMessage: (m) => sent.push(m) }, { runCli, stateDir: b.stateDir, env: b.env });
    assert.deepEqual(Object.keys(handlers).sort(), ["auto_compaction_end", "auto_compaction_start", "session_before_compact", "session_compact"]);
    assert.equal(await handlers.session_before_compact({ preparation: preparation() }, ctx()), undefined, "a /compact with no auto start in flight");
    handlers.auto_compaction_start({ reason: "threshold" }, ctx());
    assert.equal(await handlers.session_before_compact({ preparation: preparation() }, ctx()), undefined);
    handlers.auto_compaction_end({ result: "success" }, ctx());
    assert.equal(await handlers.session_before_compact({ preparation: preparation() }, ctx()), undefined);
    assert.deepEqual(triggers, ["manual", "auto", "manual"]);
    await handlers.session_compact({ compactionEntry: {} }, ctx());
    assert.deepEqual(sent, [{ customType: RESTORE_MESSAGE_TYPE, content: "restored", display: false }]);
    // A host without sendMessage registers the same four events; the restore then logs instead of throwing.
    const handlers2 = {};
    continuityOmp({ on: (name, h) => (handlers2[name] = h) }, { runCli, stateDir: b.stateDir, env: b.env });
    await handlers2.session_before_compact({ preparation: preparation() }, ctx());
    await handlers2.session_compact({}, ctx());
    assert.match(readFileSync(join(b.stateDir, "errors.log"), "utf8"), /the host has no sendMessage/);
  } finally {
    b.release();
  }
});

test("compactionEntryId: the entry's string id, else undefined", () => {
  assert.equal(compactionEntryId({ compactionEntry: { id: "e1" } }), "e1");
  for (const e of [undefined, null, {}, { compactionEntry: null }, { compactionEntry: {} }, { compactionEntry: { id: 7 } }, { compactionEntry: { id: "" } }]) assert.equal(compactionEntryId(e), undefined);
});

test("once per compaction entry: a repeated session_compact for the same entry, sequential or concurrent, sends one restore; a new entry sends another", async () => {
  const b = box();
  try {
    const handlers = {};
    const sent = [];
    const restores = [];
    const runCli = async (hook) => {
      if (hook === PRE_COMPACT_HOOK) return undefined;
      restores.push(hook);
      await new Promise((r) => setTimeout(r, 20));
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `restore ${restores.length}` } };
    };
    continuityOmp({ on: (name, h) => (handlers[name] = h), sendMessage: (m) => sent.push(m.content) }, { runCli, stateDir: b.stateDir, env: b.env });
    // A truncated restore keeps its snapshot on disk, so the unpaired guard alone would not stop a repeat.
    mkdirSync(b.stateDir, { recursive: true });
    writeFileSync(join(b.stateDir, "seat-lintel-1789498192-31073.json"), "{}");
    await handlers.session_before_compact({ preparation: preparation() }, ctx());
    const e1 = { type: "session_compact", compactionEntry: { id: "entry-1" }, fromExtension: false };
    await Promise.all([handlers.session_compact(e1, ctx()), handlers.session_compact(e1, ctx())]);
    await handlers.session_compact(e1, ctx());
    assert.deepEqual(sent, ["restore 1"], "one message for entry-1 however often it is announced");
    assert.equal(restores.length, 1, "the restore hook ran once for entry-1");
    await handlers.session_before_compact({ preparation: preparation() }, ctx());
    await handlers.session_compact({ ...e1, compactionEntry: { id: "entry-2" } }, ctx());
    await handlers.session_compact({ ...e1, compactionEntry: { id: "entry-2" } }, ctx());
    assert.deepEqual(sent, ["restore 1", "restore 2"], "a new entry restores once more");
    // The same entry id in another session is another pair.
    const other = ctx({ sessionManager: { getSessionId: () => "another-session" } });
    await handlers.session_before_compact({ preparation: preparation() }, other);
    await handlers.session_compact(e1, other);
    assert.equal(sent.length, 3);
  } finally {
    b.release();
  }
});

test("unpaired session_compact (manual handoff, snapcompact rescue): no save attempted and no snapshot sends nothing; a snapshot on disk is restored; a paired one restores even after a failed save", async () => {
  const b = box();
  try {
    const handlers = {};
    const sent = [];
    const restores = [];
    const runCli = async (hook) => {
      if (hook === PRE_COMPACT_HOOK) throw new Error("exited 1");
      restores.push(hook);
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "continuity: **this compaction's state was not restored**" } };
    };
    continuityOmp({ on: (name, h) => (handlers[name] = h), sendMessage: (m) => sent.push(m.content) }, { runCli, stateDir: b.stateDir, env: b.env });
    await handlers.session_compact({ compactionEntry: { id: "handoff-1" }, fromExtension: false }, ctx());
    assert.deepEqual(restores, [], "no restore spawned for a host-only compaction with nothing saved");
    assert.deepEqual(sent, []);
    // A snapshot left on disk (an earlier restore kept it, or its restore never ran) is restored.
    mkdirSync(b.stateDir, { recursive: true });
    writeFileSync(join(b.stateDir, "seat-lintel-1789498192-31073.json"), "{}");
    await handlers.session_compact({ compactionEntry: { id: "handoff-2" } }, ctx());
    assert.equal(restores.length, 1);
    assert.equal(sent.length, 1);
    rmSync(join(b.stateDir, "seat-lintel-1789498192-31073.json"));
    // A save attempted (and failed) pairs the next session_compact: its not-restored line is sent.
    await handlers.session_before_compact({ preparation: preparation() }, ctx());
    await handlers.session_compact({ compactionEntry: { id: "auto-1" } }, ctx());
    assert.equal(restores.length, 2);
    assert.match(sent[1], /was not restored/);
    // The pairing is consumed: a handoff right after sends nothing again.
    await handlers.session_compact({ compactionEntry: { id: "handoff-3" } }, ctx());
    assert.equal(restores.length, 2);
  } finally {
    b.release();
  }
});

test("rules walk under OMP: at the launch directory CLAUDE.md is named as host-loaded and CLAUDE.local.md, which OMP does not load, is inlined", async () => {
  const b = box();
  try {
    writeFileSync(join(b.work, "CLAUDE.md"), "# Project rules\n\nShared rule body.\n");
    writeFileSync(join(b.work, "CLAUDE.local.md"), "# Local rules\n\nLocal-only rule body 7f3a.\n");
    const sent = [];
    await sessionCompactHandler({ cwd: b.work, sessionManager: { getSessionId: () => "omp-local-rules" }, hasUI: false }, (t) => sent.push(t), { env: b.env, stateDir: b.stateDir });
    assert.equal(sent.length, 1, existsSync(join(b.stateDir, "errors.log")) ? readFileSync(join(b.stateDir, "errors.log"), "utf8") : "");
    const content = sent[0];
    assert.ok(content.includes(`skipped \`${join(b.work, "CLAUDE.md")}\`: loaded by the host at launch`), content);
    assert.doesNotMatch(content, /Shared rule body\./);
    assert.match(content, /Local-only rule body 7f3a\./, "the local file's body is restored");
    assert.ok(!content.includes(`skipped \`${join(b.work, "CLAUDE.local.md")}\``), "and it is not named as host-loaded");
    // Claude Code sets no CONTINUITY_HOST_RULES and loads both at launch: both stay skipped there.
    const cc = walkRules(b.work, { ...b.env, CLAUDE_PROJECT_DIR: b.work });
    assert.deepEqual(cc.files, []);
    assert.equal(cc.skipped.length, 2);
    const omp = walkRules(b.work, { ...b.env, CLAUDE_PROJECT_DIR: b.work, CONTINUITY_HOST_RULES: OMP_HOST_RULES });
    assert.deepEqual(omp.files.map((f) => f.path.split("/").pop()), ["CLAUDE.local.md"]);
    assert.deepEqual(omp.skipped.map((s) => s.path.split("/").pop()), ["CLAUDE.md"]);
  } finally {
    b.release();
  }
});

test("spawnHook: a hook that prints junk, exits non-zero, or outruns its budget rejects with the hook name and stderr tail", async () => {
  const b = box();
  const root = join(b.root, "fake-plugin");
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "junk.mjs"), "process.stdout.write('not json');\n");
  writeFileSync(join(root, "hooks", "fails.mjs"), "process.stderr.write('kaboom'); process.exit(3);\n");
  writeFileSync(join(root, "hooks", "quiet.mjs"), "process.exit(0);\n");
  writeFileSync(join(root, "hooks", "hangs.mjs"), "setInterval(() => {}, 1000);\n");
  writeFileSync(join(root, "hooks", "echo.mjs"), "let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ got: JSON.parse(s), cwd: process.cwd(), projectDir: process.env.CLAUDE_PROJECT_DIR })));\n");
  const env = { ...b.env, CONTINUITY_PLUGIN_ROOT: root };
  try {
    await assert.rejects(spawnHook("junk.mjs", "{}", b.work, 5_000, env), /junk\.mjs printed something other than JSON/);
    await assert.rejects(spawnHook("fails.mjs", "{}", b.work, 5_000, env), /fails\.mjs exited 3; stderr: kaboom/);
    assert.equal(await spawnHook("quiet.mjs", "{}", b.work, 5_000, env), undefined);
    const started = Date.now();
    await assert.rejects(spawnHook("hangs.mjs", "{}", b.work, 300, env), /hangs\.mjs timed out after 300ms/);
    assert.ok(Date.now() - started < 2_000, "the kill fires at the budget, not at the child's leisure");
    assert.deepEqual(await spawnHook("echo.mjs", JSON.stringify({ a: 1 }), b.work, 5_000, env), { got: { a: 1 }, cwd: b.work, projectDir: b.work });
  } finally {
    b.release();
  }
});

test("round trip through the real hooks: the save from a fake OMP event lands in the state dir; the restore after it hands the snapshot, the rules and the liveness line to sendMessage", async () => {
  const b = box();
  try {
    writeFileSync(join(b.work, "AGENTS.md"), "# Repo rules\n\nAlways run the tests.\n");
    writeFileSync(join(b.work, "a.ts"), "export const a = 1;\n");
    b.git("add", "-A");
    b.git("commit", "-q", "-m", "init");
    writeFileSync(join(b.work, "a.ts"), "export const a = 2;\n");
    const env = { ...b.env };
    const handlers = {};
    const sent = [];
    const notices = [];
    const sessionId = "seat-lintel-1789498192-31073";
    const c = { cwd: b.work, sessionManager: { getSessionId: () => sessionId }, hasUI: true, ui: { notify: (t, type) => notices.push([t, type]) } };
    continuityOmp({ on: (name, h) => (handlers[name] = h), sendMessage: (m) => sent.push(m) }, { env, stateDir: b.stateDir });
    handlers.auto_compaction_start({ reason: "threshold" }, c);
    const started = Date.now();
    const fileOps = { read: new Set([join(b.work, "a.ts")]), written: new Set(), edited: new Set([join(b.work, "a.ts")]) };
    assert.equal(await handlers.session_before_compact({ preparation: preparation({ fileOps }) }, c), undefined);
    assert.ok(Date.now() - started < PRE_COMPACT_TIMEOUT_MS, "the save answered inside the spawn budget");
    const snapshotPath = join(b.stateDir, `${sessionId}.json`);
    assert.ok(existsSync(snapshotPath), `snapshot written at ${snapshotPath}`);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    assert.equal(snapshot.trigger, "auto");
    assert.deepEqual(snapshot.recentIntent.lines, ["fix the flaky test", "then bump the version", "last ask before the cut"]);
    assert.match(snapshot.recentIntent.source, /host-supplied `intents`/);
    assert.match(snapshot.hostFileOps ?? JSON.stringify(snapshot), /\*\*edited\*\* \(1\)/);
    assert.match(JSON.stringify(snapshot), /a\.ts/, "the dirty file is in the git capture");
    assert.ok(notices.some(([t]) => /auto-compaction fired with no handoff written/.test(t)), `the no-handoff systemMessage reached the UI: ${JSON.stringify(notices)}`);
    assert.equal(existsSync(join(b.stateDir, "errors.log")), false, "no adapter or hook fault logged");
    handlers.auto_compaction_end({ result: "success" }, c);
    const event = { type: "session_compact", compactionEntry: { id: "entry-1" }, fromExtension: false };
    await handlers.session_compact(event, c);
    // OMP announcing the same entry again must not add a "not restored" message after the restore.
    await handlers.session_compact(event, c);
    assert.equal(sent.length, 1, `one restore message: ${JSON.stringify(sent)}`);
    assert.equal(sent[0].customType, RESTORE_MESSAGE_TYPE);
    assert.equal(sent[0].display, false);
    const content = sent[0].content;
    assert.match(content, /fix the flaky test/, "the saved intent came back");
    assert.match(content, /\*\*edited\*\* \(1\)/, "the host's file operations came back");
    // OMP holds every rules file from cwd to the repo root in the system prompt's <repo-rules>
    // block, which a compaction keeps (omp docs: context-files.md), so the walk names each one as
    // kept instead of spending the restore budget on a copy; CLAUDE_PROJECT_DIR=cwd is what tells it.
    assert.match(content, /## Repo rules re-inlined/);
    assert.ok(content.includes(`skipped \`${join(b.work, "AGENTS.md")}\`: loaded by the host at launch`), `the launch-directory rules file is named as kept by the host:\n${content}`);
    assert.doesNotMatch(content, /Always run the tests\./, "and its body is not inlined a second time");
    assert.match(content, /## Durable notes/);
    assert.match(content, /continuity, pre-compaction save liveness: last successful save less than a minute ago/, "the liveness line reports the save that just ran");
    assert.equal(existsSync(snapshotPath), false, "a complete restore consumes the snapshot");
    assert.equal(existsSync(join(b.stateDir, "errors.log")), false, `no adapter or hook fault logged: ${existsSync(join(b.stateDir, "errors.log")) ? readFileSync(join(b.stateDir, "errors.log"), "utf8") : ""}`);
  } finally {
    b.release();
  }
});
