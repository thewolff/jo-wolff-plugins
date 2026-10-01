// paired-coding-omp.test.mjs — node --test, run from plugins/paired-coding/.
//
// The OMP adapter driven through a fake `pi`: the fake records the handlers and tools the
// adapter registers, and the tests fire OMP's events at them the way the host does (tool_call
// before a tool, input on a typed turn, execute with the tool's final arguments,
// session_shutdown at exit). Nothing below the adapter is faked: the shared session layer, the
// gate core, the file store and the real macOS sandbox all run, against a temp worktree and a
// temp state base, so the real ~/.local/state is never touched. Sandbox cases skip where
// sandbox-exec does not exist.
//
// Importing the .ts subject directly is itself a test: node strips the erasable types and loads
// the module without Bun.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { PAIR_TOOLS } from "../core/gate.mjs";
import pairedCodingOmp from "./paired-coding-omp.ts";

const HAS_SANDBOX = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const sandboxOnly = HAS_SANDBOX ? test : test.skip;

// A schema builder with the chain the adapter uses; the host's real one is checked live.
const node = () => {
  const n = { describe: () => n, optional: () => n };
  return n;
};
const zod = { object: () => node(), string: node, number: node, boolean: node, array: () => node() };

function setup({ otherTools = [], env = {} } = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "pc-omp-repo-")));
  mkdirSync(join(repo, ".git"));
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pc-omp-state-")));
  const current = { id: randomUUID() };
  const sessionId = current.id;
  const handlers = {};
  const tools = new Map();
  const notes = [];
  // The session's entries, as OMP's ReadonlySessionManager.getEntries() returns them.
  const entries = [{ type: "message", id: "e0" }];
  const pi = {
    zod,
    on(event, h) { (handlers[event] ??= []).push(h); },
    registerTool(t) { tools.set(t.name, t); },
    getAllTools() { return [...otherTools, ...[...tools.keys()].map((name) => ({ name }))]; },
  };
  const ctx = {
    cwd: repo,
    hasUI: true,
    sessionManager: { getSessionId: () => current.id, getEntries: () => [...entries] },
    ui: { notify: (m, level) => notes.push({ m, level }) },
  };
  pairedCodingOmp(pi, { env: { PAIRED_CODING_STATE_DIR: base, ...env } });
  /** A fresh adapter instance on the same session, as an extension reload gives. */
  const reload = () => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    pairedCodingOmp(pi, { env: { PAIRED_CODING_STATE_DIR: base, ...env } });
  };
  let n = 0;
  const emit = async (event, payload) => {
    let last;
    for (const h of handlers[event] ?? []) last = await h(payload, ctx);
    return last;
  };
  const call = async (name, params = {}, signal) => {
    // The host fires tool_call first and runs execute only when nothing blocked.
    const block = await emit("tool_call", { toolName: name, input: params });
    if (block?.block) return { blocked: block.reason };
    const r = await tools.get(name).execute(`call-${++n}`, params, signal, undefined, ctx);
    return { ok: !r.isError, text: r.content[0].text, details: r.details };
  };
  const dir = join(base, sessionId);
  const journal = (d = dir) => (existsSync(join(d, "journal.jsonl")) ? readFileSync(join(d, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const type = (text, source = "interactive") => emit("input", { type: "input", text, source });
  /** As OMP does for /new, /fork and /resume: before_switch with the old id, then switch with the new. */
  const switchTo = async (id, reason = "new") => {
    await emit("session_before_switch", { type: "session_before_switch", reason });
    current.id = id;
    await emit("session_switch", { type: "session_switch", reason });
    return join(base, id);
  };
  /** As OMP's /branch does: session_before_branch with the old id, then session_branch with a new one. */
  const branchTo = async (id) => {
    await emit("session_before_branch", { type: "session_before_branch", entryId: "e0" });
    current.id = id;
    await emit("session_branch", { type: "session_branch", previousSessionFile: "/x/old.jsonl" });
    return join(base, id);
  };
  /** A new session entry of `type`, as the host appends them. */
  const append = (type) => entries.push({ type, id: `${type}-${entries.length}` });
  /** As OMP's /clear does: same session id, a reset_boundary entry appended, no extension event. */
  const clear = () => append("reset_boundary");
  return { repo, base, dir, sessionId, ctx, tools, notes, emit, call, journal, type, switchTo, branchTo, clear, append, reload };
}

/** Start pairing, propose a card over `boundary`, have the user agree, open the change set. */
async function openChangeSet(s, boundary) {
  assert.equal((await s.call("pair_start")).ok, true);
  const card = await s.call("pair_propose", { boundary });
  assert.equal(card.ok, true, card.text);
  await s.type("yes, go ahead with that");
  const begun = await s.call("pair_begin", { cardId: "card-1", quote: "go ahead" });
  assert.equal(begun.ok, true, begun.text);
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code !== "ESRCH"; }
};

describe("inert until pair_start", () => {
  test("host tools pass and no file is created, for every event the adapter handles", async () => {
    const s = setup();
    for (const tool of ["write", "edit", "bash", "eval", "task", "some_unknown_tool"]) {
      assert.equal(await s.emit("tool_call", { toolName: tool, input: {} }), undefined, tool);
    }
    await s.type("hello");
    await s.emit("session_shutdown", { type: "session_shutdown" });
    const r = await s.call("pair_note", { text: "x" });
    assert.equal(r.ok, false);
    assert.match(r.text, /not active/);
    assert.equal(existsSync(s.dir), false, "no session directory before pair_start");
  });
});

describe("tool_call refusal while pairing", () => {
  test("host mutating, code-running, dispatch and unknown tools are blocked; read-only tools pass", async () => {
    const s = setup();
    assert.equal((await s.call("pair_start")).ok, true);
    for (const tool of ["write", "edit", "ast_edit", "bash", "eval", "python", "task", "ask", "some_unknown_tool"]) {
      const r = await s.emit("tool_call", { toolName: tool, input: {} });
      assert.equal(r?.block, true, `${tool} must be blocked`);
      assert.match(r.reason, /^paired coding: /);
    }
    for (const tool of ["read", "grep", "glob", "find"]) {
      assert.equal(await s.emit("tool_call", { toolName: tool, input: {} }), undefined, tool);
    }
    assert.match((await s.call("pair_write", { path: "a.txt", content: "x" })).blocked, /no change set is open/);
    assert.equal(existsSync(join(s.repo, "a.txt")), false);
  });
});

describe("trusted input comes only from the interactive input event", () => {
  test("an rpc- or extension-sourced turn cannot carry agreement; a typed one can", async () => {
    const s = setup();
    await s.call("pair_start");
    await s.call("pair_propose", { boundary: ["a.txt"] });
    for (const source of ["rpc", "extension"]) {
      await s.emit("input", { type: "input", text: "yes, go ahead", source });
      const r = await s.call("pair_begin", { cardId: "card-1", quote: "go ahead" });
      assert.equal(r.ok, false, source);
      assert.match(r.text, /has not typed a turn since the card/);
    }
    await s.type("yes, go ahead");
    assert.equal((await s.call("pair_begin", { cardId: "card-1", quote: "go ahead" })).ok, true);
    assert.deepEqual(s.journal().filter((e) => e.type === "untrusted-input").map((e) => e.source), ["rpc", "extension"]);
  });

  test("the input handler never revises the user's text", async () => {
    const s = setup();
    await s.call("pair_start");
    assert.equal(await s.type("anything at all"), undefined);
  });
});

describe("pair_write and pair_edit check their final arguments", () => {
  test("a path outside the boundary is refused at execute, inside it is written", async () => {
    const s = setup();
    await openChangeSet(s, ["a.txt"]);
    // What execute receives is whatever the last tool_call revision left, e.g. a rewritten path.
    const out = await s.call("pair_write", { path: "outside.txt", content: "x" });
    assert.equal(out.ok, false);
    assert.match(out.text, /outside the agreed boundary/);
    assert.equal(existsSync(join(s.repo, "outside.txt")), false);
    const escape = await s.call("pair_write", { path: join(s.dir, "state.json"), content: "{}" });
    assert.equal(escape.ok, false);
    assert.equal((await s.call("pair_write", { path: "a.txt", content: "one\n" })).ok, true);
    assert.equal((await s.call("pair_edit", { path: "a.txt", oldString: "one", newString: "two" })).ok, true);
    assert.equal(readFileSync(join(s.repo, "a.txt"), "utf8"), "two\n");
    const done = await s.call("pair_done", { cardId: "card-1" });
    assert.equal(done.ok, true);
    assert.match(done.text, /\+two/);
  });

  test("a corrupted state file reads as closed: writes refused, host tools still blocked", async () => {
    const s = setup();
    await openChangeSet(s, ["a.txt"]);
    writeFileSync(join(s.dir, "state.json"), "{ not json");
    const w = await s.call("pair_write", { path: "a.txt", content: "x" });
    assert.ok(w.blocked || w.ok === false, "write refused");
    assert.equal(existsSync(join(s.repo, "a.txt")), false);
    assert.equal((await s.emit("tool_call", { toolName: "write", input: {} }))?.block, true);
  });
});

describe("pair_start refusals", () => {
  test("refused when a tool listed in PAIRED_CODING_CONFLICTING_TOOLS is registered", async () => {
    const s = setup({ otherTools: [{ name: "other_gate_tool" }], env: { PAIRED_CODING_CONFLICTING_TOOLS: "other_gate_tool" } });
    const r = await s.call("pair_start");
    assert.equal(r.ok, false);
    assert.match(r.text, /its tool other_gate_tool is listed/);
    assert.equal(await s.emit("tool_call", { toolName: "write", input: {} }), undefined, "still inert");
  });

  sandboxOnly("activates when the list is unset, even with that tool present", async () => {
    const s = setup({ otherTools: [{ name: "other_gate_tool" }] });
    assert.equal((await s.call("pair_start")).ok, true);
  });

  sandboxOnly("list entries are trimmed, empty entries ignored, and an absent listed tool does not refuse", async () => {
    const listed = { PAIRED_CODING_CONFLICTING_TOOLS: " ,  not_loaded ,, other_gate_tool  , " };
    const hit = setup({ otherTools: [{ name: "other_gate_tool" }], env: listed });
    assert.match((await hit.call("pair_start")).text, /its tool other_gate_tool is listed/);
    const miss = setup({ env: listed });
    assert.equal((await miss.call("pair_start")).ok, true, "no listed tool loaded");
    const blanks = setup({ otherTools: [{ name: "other_gate_tool" }], env: { PAIRED_CODING_CONFLICTING_TOOLS: " , ,," } });
    assert.equal((await blanks.call("pair_start")).ok, true, "only empty entries: check skipped");
  });

  test("refused on a platform without sandbox-exec, and the session stays inert", async () => {
    const s = setup();
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const r = await s.call("pair_start");
      assert.equal(r.ok, false);
      assert.match(r.text, /sandbox-exec/);
    } finally {
      Object.defineProperty(process, "platform", real);
    }
    assert.equal(await s.emit("tool_call", { toolName: "write", input: {} }), undefined);
  });
});

describe("pair_run process groups (real sandbox)", () => {
  sandboxOnly("closed: a worktree write through pair_run is denied by the sandbox", async () => {
    const s = setup();
    await s.call("pair_start");
    const r = await s.call("pair_run", { command: "echo x > file.txt" });
    assert.equal(r.ok, false);
    assert.match(r.text, /not permitted/i);
    assert.equal(existsSync(join(s.repo, "file.txt")), false);
  });

  sandboxOnly("abort kills and reaps the whole group before execute returns", { timeout: 8000 }, async () => {
    const s = setup();
    await openChangeSet(s, ["pid.txt", "out.txt"]);
    const ac = new AbortController();
    // Bounded (~15s) so a broken abort fails on the test timeout instead of leaking a writer.
    const running = s.call("pair_run", { command: "(i=0; while [ $i -lt 150 ]; do echo tick >> out.txt; i=$((i+1)); sleep 0.1; done) & echo $! > pid.txt; wait" }, ac.signal);
    await new Promise((r) => setTimeout(r, 700));
    // pair_done while the run is live is refused: the run is foreground and tied to the change set.
    const early = await s.call("pair_done", { cardId: "card-1" });
    assert.equal(early.ok, false);
    assert.match(early.text, /still running/);
    ac.abort();
    const r = await running;
    assert.match(r.text, /aborted; its process group was killed/);
    const pid = Number(readFileSync(join(s.repo, "pid.txt"), "utf8"));
    assert.equal(alive(pid), false, `writer ${pid} must be dead`);
    const size = readFileSync(join(s.repo, "out.txt"), "utf8").length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(readFileSync(join(s.repo, "out.txt"), "utf8").length, size, "no write after the abort");
  });

  sandboxOnly("timeout kills and reaps the whole group", async () => {
    const s = setup();
    await openChangeSet(s, ["pid.txt"]);
    const r = await s.call("pair_run", { command: "sleep 30 & echo $! > pid.txt; wait", timeoutSeconds: 1 });
    assert.match(r.text, /timed out after 1s/);
    assert.equal(alive(Number(readFileSync(join(s.repo, "pid.txt"), "utf8"))), false);
  });

  sandboxOnly("pair_done reaps a process a finished run left behind, before its snapshot", async () => {
    const s = setup();
    await openChangeSet(s, ["pid.txt", "late.txt"]);
    const r = await s.call("pair_run", { command: "(sleep 1; echo late > late.txt) > /dev/null 2>&1 & echo $! > pid.txt" });
    assert.equal(r.ok, true, r.text);
    const pid = Number(readFileSync(join(s.repo, "pid.txt"), "utf8"));
    assert.equal(alive(pid), true, "left running by a normal exit");
    const done = await s.call("pair_done", { cardId: "card-1" });
    assert.equal(done.ok, true);
    assert.equal(alive(pid), false);
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(existsSync(join(s.repo, "late.txt")), false, "no write lands after the read-back");
  });

  sandboxOnly("session_shutdown reaps live groups and ends pairing", async () => {
    const s = setup();
    await openChangeSet(s, ["pid.txt"]);
    await s.call("pair_run", { command: "sleep 30 > /dev/null 2>&1 & echo $! > pid.txt" });
    const pid = Number(readFileSync(join(s.repo, "pid.txt"), "utf8"));
    await s.emit("session_shutdown", { type: "session_shutdown" });
    assert.equal(alive(pid), false);
    assert.ok(s.journal().some((e) => e.type === "stop" && e.verb === "session-end"));
    assert.equal(await s.emit("tool_call", { toolName: "write", input: {} }), undefined, "inactive after session end");
  });
});

test("every pair_* verb of the core is registered as an OMP tool", () => {
  const s = setup();
  assert.deepEqual([...s.tools.keys()].sort(), [...PAIR_TOOLS].sort());
  for (const t of s.tools.values()) assert.equal(t.loadMode, "essential", `${t.name} must be visible without discovery`);
});

const blocked = async (s, toolName = "write") => (await s.emit("tool_call", { toolName, input: {} }))?.block === true;

describe("ending pairing", () => {
  sandboxOnly("a typed 'pair stop' ends pairing before the agent's next tool call", async () => {
    const s = setup();
    assert.equal((await s.call("pair_start")).ok, true);
    assert.equal(await blocked(s), true);
    await s.type("Pair stop");
    assert.equal(await blocked(s), false);
    assert.ok(s.journal().some((e) => e.type === "stop" && e.verb === "typed-stop"));
    assert.ok(s.notes.some((n) => /you typed pair stop/.test(n.m)));
  });

  sandboxOnly("an injected 'pair stop' changes nothing, and there is no stop tool", async () => {
    const s = setup();
    assert.equal((await s.call("pair_start")).ok, true);
    for (const source of ["extension", "rpc"]) await s.type("pair stop", source);
    assert.equal(await blocked(s), true);
    assert.equal(s.tools.has("pair_stop"), false);
    assert.equal(await blocked(s, "pair_stop"), true);
  });

  sandboxOnly("a pair_begin quote of 'y' against a typed 'why?' is refused", async () => {
    const s = setup();
    assert.equal((await s.call("pair_start")).ok, true);
    assert.equal((await s.call("pair_propose", { boundary: ["a.txt"] })).ok, true);
    await s.type("why?");
    const r = await s.call("pair_begin", { cardId: "card-1", quote: "y" });
    assert.equal(r.ok, false);
    assert.match(r.text, /as whole words/);
  });
});

describe("session switch inside the running process", () => {
  sandboxOnly("switching away while pairing ends the old session and starts the new one closed", async () => {
    const s = setup();
    assert.equal((await s.call("pair_start")).ok, true);
    const next = await s.switchTo(randomUUID(), "new");
    assert.ok(s.journal().some((e) => e.type === "stop" && e.verb === "session-end"));
    assert.equal(await blocked(s), true, "the new session refuses host writes");
    assert.ok(s.journal(next).some((e) => e.type === "carried-after-clear" && e.reason === "omp:new"));
    assert.equal((await s.call("pair_propose", { boundary: ["a.txt"] })).ok, false);
    assert.equal((await s.call("pair_start")).ok, true, "pair_start restarts pairing");
    assert.equal((await s.call("pair_propose", { boundary: ["a.txt"] })).ok, true);
  });

  sandboxOnly("a typed stop ends a carried session", async () => {
    const s = setup();
    assert.equal((await s.call("pair_start")).ok, true);
    await s.switchTo(randomUUID(), "resume");
    await s.type("pair stop");
    assert.equal(await blocked(s), false);
  });

  test("switching from a session that never paired leaves the new one inert", async () => {
    const s = setup();
    const next = await s.switchTo(randomUUID(), "new");
    assert.equal(await blocked(s), false);
    assert.equal(existsSync(next), false);
  });

  sandboxOnly("branching while pairing ends the old session and starts the branch closed", async () => {
    const s = setup();
    await openChangeSet(s, ["a.txt"]);
    const next = await s.branchTo(randomUUID());
    assert.ok(s.journal().some((e) => e.type === "stop" && e.verb === "session-end"));
    assert.equal(await blocked(s), true, "the branch refuses host writes");
    assert.ok(s.journal(next).some((e) => e.type === "carried-after-clear" && e.reason === "omp:branch"));
    const w = await s.call("pair_write", { path: "a.txt", content: "x" });
    assert.ok(w.blocked || w.ok === false, "no change set carries over");
  });
});

describe("/clear keeps the session id but drops the agent's context", () => {
  sandboxOnly("an open change set is finished, unapproved writes journaled, and the session carried closed", async () => {
    const s = setup();
    await openChangeSet(s, ["a.txt"]);
    writeFileSync(join(s.repo, "stray.txt"), "outside the boundary\n");
    s.clear();
    assert.equal(await blocked(s), true, "host writes stay refused");
    const j = s.journal();
    const stop = j.find((e) => e.type === "stop" && e.verb === "session-end");
    assert.ok(stop, "pairing ended as on a session change");
    assert.ok(j.some((e) => e.type === "unapproved-write" && JSON.stringify(e.paths).includes("stray.txt")), "the unapproved write is journaled");
    assert.ok(s.notes.some((n) => /conversation was cleared/.test(n.m)));
    const w = await s.call("pair_write", { path: "a.txt", content: "x" });
    assert.notEqual(w.ok, true, "the change set is gone");
    assert.notEqual((await s.call("pair_begin", { cardId: "card-1", quote: "go ahead" })).ok, true);
    assert.equal((await s.call("pair_start")).ok, true, "pair_start restarts pairing");
    assert.equal(await blocked(s), true);
    await s.type("pair stop");
    assert.equal(await blocked(s), false);
  });

  sandboxOnly("a clear seen at the next input closes pairing before the input is recorded", async () => {
    const s = setup();
    assert.equal((await s.call("pair_start")).ok, true);
    s.clear();
    await s.type("hello again");
    const j = s.journal();
    const carried = j.findIndex((e) => e.type === "carried-after-clear");
    const typed = j.findIndex((e) => e.type === "input" && e.text === "hello again");
    assert.ok(carried !== -1 && carried < typed);
    // A second look with no new boundary changes nothing.
    await s.emit("tool_call", { toolName: "read", input: {} });
    assert.equal(s.journal().filter((e) => e.type === "carried-after-clear").length, 1);
  });

  sandboxOnly("new entries of other kinds are not a clear", async () => {
    const s = setup();
    assert.equal((await s.call("pair_start")).ok, true);
    for (const kind of ["message", "custom", "compaction"]) {
      s.append(kind);
      await s.type(`after a ${kind}`);
    }
    assert.equal(s.journal().some((e) => e.type === "carried-after-clear"), false);
  });

  sandboxOnly("a clear from before this adapter instance first looked is not taken as new", async () => {
    const s = setup();
    s.clear();
    assert.equal((await s.call("pair_start")).ok, true);
    s.reload();
    await s.type("still pairing");
    assert.equal(s.journal().some((e) => e.type === "carried-after-clear"), false);
  });

  test("a clear when not pairing changes nothing and creates no file", async () => {
    const s = setup();
    await s.type("hello");
    s.clear();
    await s.type("hello");
    assert.equal(await blocked(s), false);
    assert.equal(existsSync(s.dir), false);
  });
});
