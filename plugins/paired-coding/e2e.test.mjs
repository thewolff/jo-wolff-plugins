// End to end through the real processes Claude Code runs: the hook script for every event and
// the bundled MCP server over stdio, in a temp worktree with a temp state directory. This test
// plays Claude Code: it spawns the hook with each event's JSON, sends tools/call to the server
// only after the hook let the call through, and appends each typed prompt's transcript entry
// after UserPromptSubmit returns, as Claude Code does. Every spawn has a 5 s budget.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SERVER_NAME, TOOL_PREFIX } from "./server/binding.mjs";
import { sandboxProblem } from "./lib/host-io.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "hooks", "paired-coding-hook.mjs");
const SERVER = join(HERE, "server", "pair-server.mjs");
const BUDGET_MS = 5000;
const hasSandbox = sandboxProblem() === null;

/** Whether this process may apply a sandbox at all (not true inside another Seatbelt sandbox). */
function sandboxApplies() {
  if (!hasSandbox) return false;
  if (process.platform !== "darwin") return true;
  return spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: BUDGET_MS }).status === 0;
}

// Captured transcript entry for a prompt typed in the terminal CLI (hooks/fixtures).
const TYPED = readFileSync(join(HERE, "hooks", "fixtures", "prompt-entries.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.entrypoint === "cli");

const FIXTURES = realpathSync(mkdtempSync(join(homedir(), ".pc-e2e-")));
after(() => rmSync(FIXTURES, { recursive: true, force: true }));

function world() {
  const top = mkdtempSync(join(FIXTURES, "w-"));
  const root = join(top, "repo");
  mkdirSync(root);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root, timeout: BUDGET_MS }).status, 0);
  writeFileSync(join(root, "a.txt"), "alpha\n");
  const base = join(top, "state");
  const transcript = join(top, "projects", "p", "sess-1.jsonl");
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, "");
  const env = { ...process.env, PAIRED_CODING_STATE_DIR: base, TMPDIR: process.env.TMPDIR ?? tmpdir() };
  return { top, root, base, transcript, env, common: { session_id: "sess-1", cwd: root, transcript_path: transcript } };
}

function hook(w, event, input) {
  const r = spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(input), env: w.env, encoding: "utf8", timeout: BUDGET_MS });
  assert.equal(r.signal, null, `${event} hung past ${BUDGET_MS} ms`);
  assert.equal(r.status, 0, `${event}: ${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

/** The bundled MCP server over stdio. Every request and the shutdown have a 5 s deadline; a hung child is killed. */
function server(w) {
  const child = spawn(process.execPath, [SERVER], { env: w.env, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  let gone = null;
  const exited = new Promise((resolve) => {
    const end = (why) => {
      if (gone) return;
      gone = why;
      for (const [, w8] of waiting) w8.fail(new Error(`server ${why} before replying`));
      waiting.clear();
      resolve();
    };
    child.on("exit", (code, signal) => end(`exited (${signal ?? code})`));
    child.on("error", (err) => end(`failed to start (${err.code ?? err.message})`));
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.ok(msg);
    waiting.delete(msg.id);
  });
  let next = 0;
  const request = (method, params) => {
    if (gone) return Promise.reject(new Error(`server ${gone}`));
    const id = ++next;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} took over ${BUDGET_MS} ms`)); }, BUDGET_MS);
      waiting.set(id, { ok: (m) => { clearTimeout(t); resolve(m); }, fail: (e) => { clearTimeout(t); reject(e); } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const close = async () => {
    if (!gone) child.stdin.end();
    let t;
    const late = await Promise.race([exited.then(() => false), new Promise((r) => { t = setTimeout(() => r(true), BUDGET_MS); })]);
    clearTimeout(t);
    if (late) {
      child.kill("SIGKILL");
      await exited;
      throw new Error(`server did not exit within ${BUDGET_MS} ms of stdin closing; killed`);
    }
  };
  return { request, close };
}

let seq = 0;

/** One tool call as Claude Code makes it: PreToolUse hook, then (if allowed) the tool itself. */
async function tool(w, srv, name, args) {
  const own = name.startsWith("pair_");
  const id = `toolu_e2e${++seq}`;
  const pre = hook(w, "pre-tool-use", {
    ...w.common, hook_event_name: "PreToolUse", tool_use_id: id, tool_input: args,
    tool_name: own ? `${TOOL_PREFIX}${name}` : name,
    ...(own ? { mcp_server: { name: SERVER_NAME, source: "plugin" } } : {}),
  });
  if (pre?.hookSpecificOutput?.permissionDecision === "deny") return { denied: pre.hookSpecificOutput.permissionDecisionReason, pre };
  if (!own) return { allowed: true, pre };
  const res = await srv.request("tools/call", { name, arguments: args, _meta: { "claudecode/toolUseId": id } });
  return { ok: !res.result.isError, text: res.result.content[0].text, pre };
}

/** A prompt the partner typed: UserPromptSubmit, then Claude Code writes the transcript entry. */
function typed(w, text) {
  const id = `prompt-${++seq}`;
  const out = hook(w, "user-prompt-submit", { ...w.common, hook_event_name: "UserPromptSubmit", prompt: text, prompt_id: id });
  appendFileSync(w.transcript, `${JSON.stringify({ ...TYPED, promptId: id, message: { role: "user", content: text }, sessionId: w.common.session_id, cwd: w.root })}\n`);
  return out;
}

async function mainPath({ write }) {
  const w = world();
  const srv = server(w);
  try {
    assert.equal((await srv.request("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "paired-coding");
    assert.equal(hook(w, "session-start", { ...w.common, hook_event_name: "SessionStart", source: "startup" }), null);
    // Before pair_start the gate is inert: Write goes through and no state exists.
    assert.equal((await tool(w, srv, "Write", { file_path: join(w.root, "a.txt"), content: "x" })).allowed, true);
    assert.equal(existsSync(join(w.base, "sess-1")), false);
    typed(w, "pair with me on a.txt");
    const started = await tool(w, srv, "pair_start", {});
    assert.equal(started.ok, true, started.text);
    // Pairing: the host's own write and shell tools are refused, reads are not.
    const denied = await tool(w, srv, "Write", { file_path: join(w.root, "a.txt"), content: "x" });
    assert.match(denied.denied, /^paired-coding: Write is the host's own mutating tool; while pairing, write with pair_write or pair_edit/);
    assert.match((await tool(w, srv, "Bash", { command: "echo x > a.txt" })).denied, /Bash is the host's own mutating tool/);
    assert.equal((await tool(w, srv, "Read", { file_path: join(w.root, "a.txt") })).allowed, true);
    // A card, the partner's typed agreement after it, and the change set opens.
    const card = await tool(w, srv, "pair_propose", { boundary: ["a.txt"], decision: "replace alpha", effect: "a.txt reads beta" });
    assert.equal(card.ok, true, card.text);
    assert.equal((await tool(w, srv, "pair_begin", { cardId: "card-1", quote: "go ahead" })).ok, false, "no typed turn after the card yet");
    typed(w, "yes, go ahead");
    const begun = await tool(w, srv, "pair_begin", { cardId: "card-1", quote: "go ahead" });
    assert.equal(begun.ok, true, begun.text);
    if (write) {
      const wrote = await tool(w, srv, "pair_write", { path: "a.txt", content: "beta\n" });
      assert.equal(wrote.ok, true, wrote.text);
      assert.equal((await tool(w, srv, "pair_write", { path: "b.txt", content: "nope\n" })).ok, false, "outside the boundary");
    }
    const done = await tool(w, srv, "pair_done", { cardId: "card-1" });
    assert.equal(done.ok, true, done.text);
    if (write) assert.match(done.text, /\+beta/);
    assert.equal(readFileSync(join(w.root, "a.txt"), "utf8"), write ? "beta\n" : "alpha\n");
    // The partner types pair stop in a turn with no tool call: Stop ends pairing and writes the receipt.
    assert.match(typed(w, "pair stop").hookSpecificOutput.additionalContext, /asks to end pairing/);
    assert.equal(hook(w, "stop", { ...w.common, hook_event_name: "Stop", stop_hook_active: false }), null);
    const receipt = JSON.parse(readFileSync(join(w.base, "sess-1", "pair-accepted.json"), "utf8"));
    assert.equal(receipt.stoppedBy, "typed-stop");
    assert.equal(receipt.accepted.length, 1);
    // The next turn hears the outcome; the gate is open again.
    assert.match(typed(w, "thanks").hookSpecificOutput.additionalContext, /pairing has ended: your partner typed pair stop/);
    assert.equal((await tool(w, srv, "Write", { file_path: join(w.root, "a.txt"), content: "x" })).allowed, true);
    assert.equal(hook(w, "session-end", { ...w.common, hook_event_name: "SessionEnd", reason: "other" }), null);
    assert.equal(existsSync(join(w.base, "errors.log")), false, "no fault on the main path");
  } finally {
    await srv.close();
  }
}

test("main path through the real hook and server processes: start, refuse host writes, card, typed agreement, done, typed stop, receipt", { skip: !hasSandbox }, () => mainPath({ write: false }));

test("the same path with a sandboxed pair_write inside the boundary and one refused outside it", { skip: !sandboxApplies() && "sandbox-exec cannot apply a profile here (this process already runs inside a Seatbelt sandbox)" }, () => mainPath({ write: true }));
