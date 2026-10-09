// Tests for the bundled MCP server over its real stdio transport.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { writeBinding } from "./binding.mjs";
import { foregroundCapMs } from "./pair-server.mjs";
import { recordTrustedInput } from "../lib/verbs.mjs";
import { sandboxProblem } from "../lib/host-io.mjs";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "pair-server.mjs");
const hasSandbox = sandboxProblem() === null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fixtures live under $HOME, not /tmp: pair_run may write the temp directories, so a
// worktree inside one is not fenced the way a real one is, and on Linux Landlock cannot express
// that run at all (the temp grant would hold the worktree's .git) and hands it to bubblewrap.
const FIXTURES = realpathSync(mkdtempSync(join(homedir(), ".pc-srv-")));
after(() => rmSync(FIXTURES, { recursive: true, force: true }));

function startServer(env) {
  const child = spawn("node", [SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  let next = 0;
  const request = (method, params) => {
    const id = ++next;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return { id, done: new Promise((r) => waiting.set(id, r)) };
  };
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  return { child, request, notify, close: () => child.stdin.end() };
}

test("initialize, tools/list and unknown methods follow JSON-RPC and MCP", async () => {
  const s = startServer({ PAIRED_CODING_STATE_DIR: mkdtempSync(join(FIXTURES, "state-")) });
  const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }).done;
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.tools);
  const list = await s.request("tools/list", {}).done;
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["pair_begin", "pair_done", "pair_edit", "pair_note", "pair_propose", "pair_run", "pair_start", "pair_write"]);
  assert.ok(list.result.tools.every((t) => t._meta["anthropic/alwaysLoad"] === true && t.inputSchema.type === "object"));
  const unknown = await s.request("server/discover", {}).done;
  assert.equal(unknown.error.code, -32601);
  s.close();
});

test("notifications/cancelled aborts a running pair_run and kills its process group", { skip: !hasSandbox }, async () => {
  const top = mkdtempSync(join(FIXTURES, "f-"));
  const root = join(top, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "alpha\n");
  const base = join(top, "state");
  const s = startServer({ PAIRED_CODING_STATE_DIR: base });
  try {
    await s.request("initialize", { protocolVersion: "2025-06-18" }).done;
    let n = 0;
    const call = (name, args) => {
      const id = `toolu_srv${++n}`;
      writeBinding(base, id, { sessionId: "s1", tool: name, cwd: root });
      return s.request("tools/call", { name, arguments: args, _meta: { "claudecode/toolUseId": id } });
    };
    assert.equal((await call("pair_start", {}).done).result.isError, false);
    assert.equal((await call("pair_propose", { boundary: ["a.txt"] }).done).result.isError, false);
    recordTrustedInput({ sessionDir: join(base, "s1"), text: "go ahead", source: "interactive" });
    assert.equal((await call("pair_begin", { cardId: "card-1", quote: "go ahead" }).done).result.isError, false);
    const run = call("pair_run", { command: "(while :; do echo tick >> a.txt; sleep 0.05; done) & sleep 60" });
    await sleep(700);
    s.notify("notifications/cancelled", { requestId: run.id, reason: "user typed" });
    const res = await run.done;
    assert.match(res.result.content[0].text, /aborted; its process group was killed/);
    const size = statSync(join(root, "a.txt")).size;
    await sleep(400);
    assert.equal(statSync(join(root, "a.txt")).size, size);
    const state = JSON.parse(readFileSync(join(base, "s1", "state.json"), "utf8"));
    assert.deepEqual(state.running, []);
  } finally {
    s.close();
  }
});

test("pair_run's timeout stays under Claude Code's automatic-backgrounding threshold", () => {
  assert.equal(foregroundCapMs({}), 110_000);
  assert.equal(foregroundCapMs({ CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "30000" }), 20_000);
  assert.equal(foregroundCapMs({ CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "5000" }), 1_000);
  assert.equal(foregroundCapMs({ CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" }), undefined);
  assert.equal(foregroundCapMs({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" }), undefined);
  assert.equal(foregroundCapMs({ CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "junk" }), 110_000);
});
