// omp/brb-omp.test.mjs — the OMP adapter under node --test with no OMP: the pure helpers
// (surfaceWord, assistantText, payload builders, resolveNode), the three handlers with a fake
// runCli (what they show, what they return, fail-open on a throw with one errors.log line), the
// registration shape (input returns { handled: true } synchronously for a word, undefined
// otherwise; ordinary text while away runs the prompt hook in the background for its new-turn
// reset), and one real spawn through spawnHook against the plugin's own hooks. The live OMP
// path (an actual omp session delivering these events) is not run here.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import brbOmp, {
  assistantText,
  beforeAgentStartHandler,
  buildPromptPayload,
  buildStartPayload,
  buildStopPayload,
  defaultStateDir,
  displayChannel,
  inputWordHandler,
  newTurnHandler,
  isAway,
  resolveNode,
  sessionStopHandler,
  spawnHook,
  surfaceWord,
} from "./brb-omp.ts";

const ctx = (over = {}) => ({ cwd: "/work", sessionManager: { getSessionId: () => "omp-session-1" }, hasUI: true, ui: { notify() {} }, isIdle: () => true, ...over });
const markAway = (stateDir, key = "omp-session-1") => {
  mkdirSync(join(stateDir, key), { recursive: true });
  writeFileSync(join(stateDir, key, "away.json"), JSON.stringify({ since: "t0" }));
};
const tick = () => new Promise((r) => setTimeout(r, 0));

function box() {
  const root = mkdtempSync(join(tmpdir(), "brb-omp-"));
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), BRB_DESKTOP_NOTIFY: "off" };
  return { root, env, stateDir: join(root, "state", "brb"), release: () => rmSync(root, { recursive: true, force: true }) };
}

test("ordinary text while away: not handled, and the prompt hook runs in the background with the text (the new-turn reset); home → no spawn; a throw is logged", async () => {
  const b = box();
  try {
    const calls = [];
    const handlers = {};
    brbOmp({ on: (name, h) => (handlers[name] = h) }, { runCli: async (hook, payload) => { calls.push({ hook, payload: JSON.parse(payload) }); return undefined; }, stateDir: b.stateDir, env: b.env });
    assert.equal(handlers.input({ text: "use Redis" }, ctx()), undefined);
    await tick();
    assert.deepEqual(calls, [], "home: nothing spawned");
    markAway(b.stateDir);
    assert.equal(handlers.input({ text: "use Redis" }, ctx()), undefined, "the prompt proceeds to the agent");
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hook, "user-prompt-submit.mjs");
    assert.equal(calls[0].payload.prompt, "use Redis");
    assert.equal(calls[0].payload.session_id, "omp-session-1");
    await newTurnHandler("x", ctx(), { runCli: async () => { throw new Error("boom"); }, stateDir: b.stateDir, env: b.env });
    assert.match(readFileSync(join(b.stateDir, "errors.log"), "utf8"), / omp-adapter user-prompt-submit\.mjs: boom\n$/);
  } finally {
    b.release();
  }
});

test("surfaceWord mirrors lib/text.mjs: brb with a note, back, pending; sentences are not words", () => {
  assert.equal(surfaceWord("brb"), "brb");
  assert.equal(surfaceWord("BRB lunch"), "brb");
  assert.equal(surfaceWord(" back "), "back");
  assert.equal(surfaceWord("pending"), "pending");
  assert.equal(surfaceWord("back now"), null);
  assert.equal(surfaceWord("brbx"), null);
  assert.equal(surfaceWord(undefined), null);
});

test("assistantText: a string, string content, text blocks joined, junk empty", () => {
  assert.equal(assistantText("plain"), "plain");
  assert.equal(assistantText({ content: "c" }), "c");
  assert.equal(assistantText({ content: [{ type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(assistantText({ content: 3 }), "");
  assert.equal(assistantText(null), "");
});

test("payloads: the manager session id rides every hook; the stop payload maps session_file and the message", () => {
  const c = ctx();
  assert.deepEqual(JSON.parse(buildPromptPayload("brb lunch", c)), { hook_event_name: "UserPromptSubmit", session_id: "omp-session-1", cwd: "/work", prompt: "brb lunch" });
  assert.deepEqual(JSON.parse(buildStartPayload(c)), { hook_event_name: "SessionStart", session_id: "omp-session-1", cwd: "/work", source: "resume" });
  const stop = JSON.parse(buildStopPayload({ session_file: "/s.jsonl", stop_hook_active: 1, last_assistant_message: { content: [{ type: "text", text: "## Needs you\n- a" }] } }, c));
  assert.deepEqual(stop, { hook_event_name: "Stop", session_id: "omp-session-1", cwd: "/work", transcript_path: "/s.jsonl", stop_hook_active: true, last_assistant_message: "## Needs you\n- a" });
  const noManager = JSON.parse(buildStopPayload({ session_id: "evt" }, { cwd: "/w", sessionManager: { getSessionId: () => { throw new Error("x"); } } }));
  assert.equal(noManager.session_id, "evt", "the event id is the fallback");
  assert.equal(noManager.transcript_path, "");
});

test("resolveNode: BRB_NODE wins or errors; execPath outside Bun; a PATH search under Bun", () => {
  const ok = (p) => p === "/x/node" || p === "/pathdir/node";
  assert.deepEqual(resolveNode({ env: { BRB_NODE: "/x/node" }, execPath: "/e", underBun: true, home: "/h", isExecutable: ok }), { path: "/x/node" });
  assert.match(resolveNode({ env: { BRB_NODE: "/nope" }, execPath: "/e", underBun: false, home: "/h", isExecutable: ok }).error, /BRB_NODE=\/nope is not an executable file/);
  assert.deepEqual(resolveNode({ env: {}, execPath: "/e", underBun: false, home: "/h", isExecutable: ok }), { path: "/e" });
  assert.deepEqual(resolveNode({ env: { PATH: "/no:/pathdir" }, execPath: "/bun", underBun: true, home: "/h", isExecutable: ok }), { path: "/pathdir/node" });
  assert.match(resolveNode({ env: { PATH: "/no" }, execPath: "/bun", underBun: true, home: "/h", isExecutable: () => false }).error, /no usable node on PATH/);
  assert.equal(defaultStateDir({ XDG_STATE_HOME: "/x" }), "/x/brb");
  assert.equal(defaultStateDir({ HOME: "/h" }), "/h/.local/state/brb");
});

test("inputWordHandler: shows the block reason; a quiet hook or a throw is shown and logged, never thrown", async () => {
  const b = box();
  try {
    const shown = [];
    const calls = [];
    const runCli = async (hook, payload, cwd, ms) => {
      calls.push({ hook, payload: JSON.parse(payload), cwd, ms });
      return { decision: "block", reason: "brb digest — held since T, 0 items\n\n(nothing held)" };
    };
    await inputWordHandler("pending", ctx(), (t) => shown.push(t), { runCli, stateDir: b.stateDir, env: b.env });
    assert.deepEqual(shown, ["brb digest — held since T, 0 items\n\n(nothing held)"]);
    assert.equal(calls[0].hook, "user-prompt-submit.mjs");
    assert.equal(calls[0].payload.prompt, "pending");
    assert.equal(calls[0].cwd, "/work");
    shown.length = 0;
    await inputWordHandler("back", ctx(), (t) => shown.push(t), { runCli: async () => undefined, stateDir: b.stateDir, env: b.env });
    assert.match(shown[0], /^brb: the back hook answered nothing/);
    shown.length = 0;
    await inputWordHandler("brb", ctx(), (t) => shown.push(t), { runCli: async () => { throw new Error("boom"); }, stateDir: b.stateDir, env: b.env });
    assert.equal(shown[0], "brb: could not run the hook (boom); nothing changed");
    assert.match(readFileSync(join(b.stateDir, "errors.log"), "utf8"), /omp-adapter user-prompt-submit\.mjs: boom\n$/);
  } finally {
    b.release();
  }
});

test("beforeAgentStartHandler: the away context as a hidden message; home → undefined; subagents skipped; a throw is logged", async () => {
  const b = box();
  try {
    const away = await beforeAgentStartHandler(ctx(), { runCli: async () => ({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "brb: Jo is away" } }), stateDir: b.stateDir, env: b.env });
    assert.deepEqual(away, { message: { customType: "brb-away", content: "brb: Jo is away", display: false } });
    assert.equal(await beforeAgentStartHandler(ctx(), { runCli: async () => undefined, stateDir: b.stateDir, env: b.env }), undefined);
    let ran = false;
    assert.equal(await beforeAgentStartHandler(ctx({ agent: { kind: "sub" } }), { runCli: async () => { ran = true; return undefined; }, stateDir: b.stateDir, env: b.env }), undefined);
    assert.equal(ran, false);
    assert.equal(await beforeAgentStartHandler(ctx(), { runCli: async () => { throw new Error("bang"); }, stateDir: b.stateDir, env: b.env }), undefined);
    assert.match(readFileSync(join(b.stateDir, "errors.log"), "utf8"), /omp-adapter session-start\.mjs: bang/);
  } finally {
    b.release();
  }
});

test("sessionStopHandler: returns the block verdict, notifies the systemMessage, allows on a quiet hook or a throw", async () => {
  const b = box();
  try {
    const notices = [];
    const c = ctx({ ui: { notify: (t, type) => notices.push([t, type]) } });
    const verdict = await sessionStopHandler({ session_file: "/s" }, c, { runCli: async () => ({ decision: "block", reason: "keep going", systemMessage: "brb on fire: on fire: main is red" }), stateDir: b.stateDir, env: b.env });
    assert.deepEqual(verdict, { decision: "block", reason: "keep going" });
    assert.deepEqual(notices, [["brb on fire: on fire: main is red", "warning"]]);
    notices.length = 0;
    assert.equal(await sessionStopHandler({}, c, { runCli: async () => ({ systemMessage: "brb: the agent is idle; 2 held" }), stateDir: b.stateDir, env: b.env }), undefined);
    assert.deepEqual(notices, [["brb: the agent is idle; 2 held", "info"]]);
    assert.equal(await sessionStopHandler({}, c, { runCli: async () => undefined, stateDir: b.stateDir, env: b.env }), undefined);
    assert.equal(await sessionStopHandler({}, ctx({ agent: { kind: "sub" } }), { runCli: async () => { throw new Error("never"); }, stateDir: b.stateDir, env: b.env }), undefined);
    assert.equal(await sessionStopHandler({}, c, { runCli: async () => { throw new Error("crash"); }, stateDir: b.stateDir, env: b.env }), undefined);
    assert.match(readFileSync(join(b.stateDir, "errors.log"), "utf8"), /omp-adapter stop\.mjs: crash/);
  } finally {
    b.release();
  }
});

test("registration: input handles a word synchronously and shows via sendMessage when idle; other text is not handled; the three events are registered", async () => {
  const b = box();
  try {
    const handlers = {};
    const sent = [];
    const pi = { on: (name, h) => (handlers[name] = h), sendMessage: (m) => sent.push(m) };
    brbOmp(pi, { runCli: async () => ({ decision: "block", reason: "brb: holding" }), stateDir: b.stateDir, env: b.env });
    assert.deepEqual(Object.keys(handlers).sort(), ["before_agent_start", "input", "session_stop"]);
    assert.deepEqual(handlers.input({ text: "brb", source: "interactive" }, ctx()), { handled: true });
    assert.equal(handlers.input({ text: "fix the tests" }, ctx()), undefined);
    await tick();
    await tick();
    assert.deepEqual(sent, [{ customType: "brb-digest", content: "brb: holding", display: true }]);
    // Without sendMessage the notice goes to ctx.ui.notify.
    markAway(b.stateDir);
    const notices = [];
    const handlers2 = {};
    brbOmp({ on: (name, h) => (handlers2[name] = h) }, { runCli: async () => ({ decision: "block", reason: "brb digest" }), stateDir: b.stateDir, env: b.env });
    handlers2.input({ text: "pending" }, ctx({ ui: { notify: (t, type) => notices.push([t, type]) } }));
    await tick();
    await tick();
    assert.deepEqual(notices, [["brb digest", "info"]]);
    // While the agent streams, the reason goes to notify, never sendMessage (which would steer into context).
    sent.length = 0;
    notices.length = 0;
    handlers.input({ text: "back" }, ctx({ isIdle: () => false, ui: { notify: (t, type) => notices.push([t, type]) } }));
    await tick();
    await tick();
    assert.deepEqual(sent, []);
    assert.deepEqual(notices, [["brb: holding", "info"]]);
  } finally {
    b.release();
  }
});

test("displayChannel: sendMessage only when the host has it and the agent is idle; notify otherwise", () => {
  assert.equal(displayChannel(ctx({ isIdle: () => true }), true), "sendMessage");
  assert.equal(displayChannel(ctx({ isIdle: () => false }), true), "notify");
  assert.equal(displayChannel(ctx({ isIdle: undefined }), true), "notify", "no isIdle: assume streaming");
  assert.equal(displayChannel(ctx({ isIdle: () => { throw new Error("x"); } }), true), "notify");
  assert.equal(displayChannel(ctx({ isIdle: () => true }), false), "notify");
});

test("back and pending while home pass through to the agent; brb is always handled", () => {
  const b = box();
  try {
    const handlers = {};
    let ran = 0;
    brbOmp({ on: (name, h) => (handlers[name] = h), sendMessage() {} }, { runCli: async () => { ran++; return undefined; }, stateDir: b.stateDir, env: b.env });
    assert.equal(isAway(ctx(), b.stateDir), false);
    assert.equal(handlers.input({ text: "back" }, ctx()), undefined);
    assert.equal(handlers.input({ text: "Pending." }, ctx()), undefined);
    assert.equal(ran, 0, "no hook spawned");
    assert.deepEqual(handlers.input({ text: "brb" }, ctx()), { handled: true });
    markAway(b.stateDir);
    assert.equal(isAway(ctx(), b.stateDir), true);
    assert.deepEqual(handlers.input({ text: "back!" }, ctx()), { handled: true });
    assert.equal(isAway(ctx({ sessionManager: { getSessionId: () => "a/b" } }), b.stateDir), false, "the key maps / to _");
    markAway(b.stateDir, "a_b");
    assert.equal(isAway(ctx({ sessionManager: { getSessionId: () => "a/b" } }), b.stateDir), true);
  } finally {
    b.release();
  }
});

test("spawnHook runs the real hooks: brb through the prompt hook, then the stop hook under BRB_HARNESS=omp, then back", async () => {
  const b = box();
  try {
    const c = { cwd: b.root, sessionManager: { getSessionId: () => "omp-live" } };
    const env = b.env;
    const brb = await spawnHook("user-prompt-submit.mjs", buildPromptPayload("brb", c), b.root, 5000, env);
    assert.equal(brb.decision, "block");
    assert.match(brb.reason, /^brb: holding needs-you items/);
    assert.ok(existsSync(join(b.stateDir, "omp-live", "away.json")));
    const start = await spawnHook("session-start.mjs", buildStartPayload(c), b.root, 5000, env);
    assert.match(start.hookSpecificOutput.additionalContext, /^brb: still away since /);
    // A second `brb` while away: no block; the adapter shows the systemMessage (inputWordHandler) and starts no turn.
    const again = await spawnHook("user-prompt-submit.mjs", buildPromptPayload("brb", c), b.root, 5000, env);
    assert.equal(again.decision, undefined);
    assert.match(again.systemMessage, /^brb: still away since .*; 0 held\. Only `back` ends the hold/);
    const stop = await spawnHook("stop.mjs", buildStopPayload({ last_assistant_message: { content: [{ type: "text", text: "## Needs you\n- on fire: main is red\n- Pick a cache" }] } }, c), b.root, 5000, env);
    assert.equal(stop.decision, "block");
    assert.equal(stop.systemMessage, "brb on fire: main is red");
    assert.equal(stop.terminalSequence, undefined, "no OSC under BRB_HARNESS=omp");
    const back = await spawnHook("user-prompt-submit.mjs", buildPromptPayload("back", c), b.root, 5000, env);
    assert.match(back.reason, /^brb: hold cleared; digest archived to .*\n\nbrb digest — .*1 item\n\n## .*\n- Pick a cache$/);
    assert.equal(await spawnHook("stop.mjs", buildStopPayload({ last_assistant_message: "x" }, c), b.root, 5000, env), undefined, "home: a quiet exit");
    await assert.rejects(spawnHook("missing.mjs", "{}", b.root, 5000, env), /missing\.mjs exited 1/);
    await assert.rejects(spawnHook("stop.mjs", "{}", b.root, 5000, { ...env, BRB_NODE: join(b.root, "no-node") }), /BRB_NODE=.* is not an executable file/);
  } finally {
    b.release();
  }
});
