import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import patternCheckOmp, { assistantText, toPreToolUse, turnOpener } from "./pattern-check-omp.ts";
import { handle as hookPreToolUse } from "../hooks/pattern-check-pretooluse.mjs";
import { paths, sessionKey, stateDir } from "../scripts/lib/state.mjs";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN, "scripts", "pattern-check.mjs");
const SESSION = "019a4b2c-7d1e-7f00-8a11-3c5d6e7f8091";
const PLAN = "## Plan\n\n1. add the cache\n2. wire it\n3. test it";

// A temp HOME with its own XDG state and config, a git-looking repo, a fake pi that keeps every
// handler it is given, and a ctx whose session id and notifications the test controls.
function fixture(t, { deps = {}, sessionId = SESSION } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pattern-check-omp-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  const env = { XDG_STATE_HOME: join(base, "state"), XDG_CONFIG_HOME: join(base, "config") };
  const sd = stateDir(env, base);
  const handlers = {};
  const calls = { on: 0 };
  const pi = { on: (event, h) => { calls.on++; (handlers[event] ??= []).push(h); } };
  patternCheckOmp(pi, { env, home: base, ...deps });
  const notes = [];
  const ctx = { cwd: repo, sessionManager: { getSessionId: () => sessionId }, ui: { notify: (m, type) => notes.push({ m, type }) } };
  const emit = (event, payload, c = ctx) => {
    let out;
    for (const h of handlers[event] ?? []) out = h(payload, c) ?? out;
    return out;
  };
  const file = (name) => join(repo, "src", name);
  const edit = (name) => emit("tool_call", { type: "tool_call", toolCallId: "c", toolName: "edit", input: { path: file(name), input: "patch" } });
  const write = (name) => emit("tool_call", { type: "tool_call", toolCallId: "c", toolName: "write", input: { path: file(name), content: "x" } });
  const bash = (command) => emit("tool_call", { type: "tool_call", toolCallId: "c", toolName: "bash", input: { command } });
  const user = (ts) => ({ role: "user", content: "go", timestamp: ts });
  const stop = (text, messages = [user(1)]) =>
    emit("session_stop", { type: "session_stop", messages, turn_id: 0, session_id: "provider-id", stop_hook_active: false, last_assistant_message: { role: "assistant", content: [{ type: "text", text }] } });
  const counted = (key = SESSION) => JSON.parse(readFileSync(paths.session(sd, key), "utf8")).files;
  const record = (key = SESSION) => spawnSync(process.execPath, [CLI, "record", "--session", key, "--cwd", repo, "--no-new-pieces", "test"], { env: { ...process.env, HOME: base, ...env }, encoding: "utf8" });
  const setRepo = (obj) => writeFileSync(join(repo, ".pattern-check.json"), JSON.stringify(obj));
  return { base, repo, env, sd, pi, handlers, calls, ctx, notes, emit, file, edit, write, bash, stop, user, counted, record, setRepo };
}

test("registers tool_call, session_stop, session_start and session_switch once; a second call with the same pi adds nothing", (t) => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.handlers).sort(), ["session_start", "session_stop", "session_switch", "tool_call"]);
  const before = f.calls.on;
  patternCheckOmp(f.pi, { env: f.env, home: f.base });
  assert.equal(f.calls.on, before);
  // A repeated session_start registers nothing either.
  f.emit("session_start", { type: "session_start" });
  f.emit("session_start", { type: "session_start" });
  assert.equal(f.calls.on, before);
});

test("files 1 and 2 are allowed and counted; the 3rd distinct file is blocked with the exact record command", (t) => {
  const f = fixture(t);
  assert.equal(f.edit("a.ts"), undefined);
  assert.equal(f.write("b.ts"), undefined);
  assert.equal(f.edit("a.ts"), undefined);
  const third = f.edit("c.ts");
  assert.equal(third.block, true);
  assert.match(third.reason, /touched 2 distinct files and the threshold is 3/);
  assert.ok(third.reason.includes(`node "${join(PLUGIN, "scripts", "pattern-check.mjs")}" record --session ${SESSION}`), third.reason);
  assert.deepEqual(f.counted(), [f.file("a.ts"), f.file("b.ts")]);
  assert.equal(f.notes.length, 0);
});

test("one counter per session: a Claude Code hook call and the OMP adapter share the state file and key", (t) => {
  const f = fixture(t);
  const hookOut = hookPreToolUse({ session_id: SESSION, cwd: f.repo, tool_name: "Edit", tool_input: { file_path: f.file("a.ts") } }, { env: f.env, home: f.base });
  assert.equal(hookOut, null);
  assert.equal(f.write("b.ts"), undefined);
  assert.deepEqual(f.counted(), [f.file("a.ts"), f.file("b.ts")]);
  assert.equal(f.edit("c.ts").block, true);
  // And the hook sees the session the adapter held.
  const after = hookPreToolUse({ session_id: SESSION, cwd: f.repo, tool_name: "Bash", tool_input: { command: "git commit -m x" } }, { env: f.env, home: f.base });
  assert.equal(after.hookSpecificOutput.permissionDecision, "deny");
});

test("a multi-file hashline edit counts every file it names", (t) => {
  const f = fixture(t);
  const out = f.emit("tool_call", { toolName: "edit", input: { input: "patch", paths: [f.file("a.ts"), f.file("b.ts"), f.file("c.ts")] } });
  assert.equal(out.block, true);
  assert.equal(existsSync(paths.session(f.sd, SESSION)), true);
  assert.deepEqual(f.counted(), []);
});

test("paths with a URL scheme are not counted, and tools other than edit, write and bash pass untouched", (t) => {
  const f = fixture(t);
  for (const p of ["xd://report_issue", "local://notes.md", "skill://x/SKILL.md"]) {
    assert.equal(f.emit("tool_call", { toolName: "write", input: { path: p, content: "x" } }), undefined);
  }
  assert.equal(f.emit("tool_call", { toolName: "read", input: { path: f.file("a.ts") } }), undefined);
  assert.equal(f.emit("tool_call", { toolName: "ast_edit", input: { ops: [] } }), undefined);
  assert.equal(existsSync(paths.session(f.sd, SESSION)), false);
});

test("once held, bash commit, PR and in-repo shell writes are blocked; reads are not", (t) => {
  const f = fixture(t);
  f.edit("a.ts");
  f.edit("b.ts");
  assert.equal(f.bash("git commit -m wip"), undefined, "not held yet: 2 of 3");
  assert.equal(f.edit("c.ts").block, true);
  assert.match(f.bash("git commit -m wip").reason, /matched: git commit/);
  assert.match(f.bash("gh pr create --fill").reason, /matched: gh pr create/);
  assert.match(f.bash(`echo x > ${f.file("d.ts")}`).reason, /matched: redirect/);
  assert.equal(f.bash("git status && ls src"), undefined);
  assert.equal(f.bash("echo x > /tmp/pattern-check-scratch.txt"), undefined, "a write outside the repository is not the work");
});

test("a receipt recorded with the named command lifts every block", (t) => {
  const f = fixture(t);
  f.edit("a.ts");
  f.edit("b.ts");
  assert.equal(f.edit("c.ts").block, true);
  const r = f.record();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.edit("c.ts"), undefined);
  assert.equal(f.bash("git commit -m done"), undefined);
  assert.equal(f.stop(PLAN), undefined);
});

test("hooks.preToolUse false in the repo config turns the counter off; hooks.stop false turns the refusal off", (t) => {
  const f = fixture(t);
  f.setRepo({ hooks: { preToolUse: false, stop: false } });
  for (const n of ["a", "b", "c", "d"]) assert.equal(f.edit(`${n}.ts`), undefined);
  assert.equal(f.stop(PLAN), undefined);
  assert.equal(existsSync(paths.session(f.sd, SESSION)), false);
});

test("the threshold comes from the config the hooks read", (t) => {
  const f = fixture(t);
  f.setRepo({ threshold: 2 });
  assert.equal(f.edit("a.ts"), undefined);
  assert.equal(f.edit("b.ts").block, true);
});

test("an unreadable session id falls back to the per-cwd key with one warning, shown once", (t) => {
  const f = fixture(t);
  const ctx = { ...f.ctx, sessionManager: { getSessionId: () => { throw new Error("gone"); } } };
  const call = (name) => f.emit("tool_call", { toolName: "edit", input: { path: f.file(name) } }, ctx);
  assert.equal(call("a.ts"), undefined);
  assert.equal(call("b.ts"), undefined);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].type, "warning");
  assert.match(f.notes[0].m, /keyed by its working directory/);
  const { key } = sessionKey({ sessionId: undefined, cwd: f.repo });
  assert.deepEqual(f.counted(key), [f.file("a.ts"), f.file("b.ts")]);
  assert.equal(call("c.ts").block, true);
});

test("fails open: a throw inside the handler allows the call and warns once", (t) => {
  const f = fixture(t, { deps: { preToolUse: () => { throw new Error("boom"); }, stopCheck: () => { throw new Error("bang"); } } });
  assert.equal(f.edit("a.ts"), undefined);
  assert.equal(f.edit("b.ts"), undefined);
  assert.equal(f.stop(PLAN), undefined);
  assert.deepEqual(f.notes.map((n) => n.type), ["warning", "warning"]);
  assert.match(f.notes[0].m, /tool_call handler failed \(boom\); this call was allowed/);
  assert.match(f.notes[1].m, /session_stop handler failed \(bang\); the stop was allowed/);
});

test("fails open: a notify that throws, a ctx with no ui and a malformed event change nothing", (t) => {
  const f = fixture(t, { deps: { preToolUse: () => { throw new Error("boom"); } } });
  const bad = { cwd: f.repo, sessionManager: { getSessionId: () => SESSION }, ui: { notify: () => { throw new Error("no ui"); } } };
  assert.equal(f.emit("tool_call", { toolName: "edit", input: { path: f.file("a.ts") } }, bad), undefined);
  assert.equal(f.emit("tool_call", { toolName: "edit", input: { path: f.file("a.ts") } }, { cwd: f.repo }), undefined);
  assert.equal(f.emit("tool_call", null), undefined);
  assert.equal(f.emit("session_stop", null), undefined);
});

test("fails open: a corrupt state file allows the call and the hook's warning reaches the UI", (t) => {
  const f = fixture(t);
  mkdirSync(dirname(paths.session(f.sd, SESSION)), { recursive: true });
  writeFileSync(paths.session(f.sd, SESSION), "{not json");
  assert.equal(f.edit("a.ts"), undefined);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].m, /is not valid JSON/);
});

test("CLAUDE_PLUGIN_ROOT from an outer host does not redirect the record command", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pattern-check-omp-root-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "repo", ".git"), { recursive: true });
  const handlers = {};
  patternCheckOmp({ on: (e, h) => { handlers[e] = h; } }, { env: { XDG_STATE_HOME: join(base, "s"), XDG_CONFIG_HOME: join(base, "c"), CLAUDE_PLUGIN_ROOT: "/elsewhere" }, home: base });
  const ctx = { cwd: join(base, "repo"), sessionManager: { getSessionId: () => SESSION } };
  for (const n of ["a", "b"]) handlers.tool_call({ toolName: "write", input: { path: join(base, "repo", n) } }, ctx);
  const out = handlers.tool_call({ toolName: "write", input: { path: join(base, "repo", "c") } }, ctx);
  assert.ok(out.reason.includes(`node "${CLI}" record --session ${SESSION}`), out.reason);
  assert.ok(!out.reason.includes("/elsewhere"));
});

// --- session_stop --------------------------------------------------------------------------------

test("a plan-proposing final message with no receipt is refused with the record command", (t) => {
  const f = fixture(t);
  const out = f.stop(PLAN);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /proposes a plan or design/);
  assert.ok(out.reason.includes(`record --session ${SESSION}`));
});

test("refused once per turn: a later stop in the same turn passes, a new user message is checked again", (t) => {
  const f = fixture(t);
  assert.equal(f.stop(PLAN).decision, "block");
  // OMP's continuation is a custom message; the turn's opener is unchanged.
  const continued = [f.user(1), { role: "custom", customType: "session-stop-continuation", content: "..." }];
  assert.equal(f.stop(`${PLAN}\n4. and more`, continued), undefined);
  assert.equal(f.stop(`${PLAN}\n5. more still`, [f.user(1), f.user(2)]).decision, "block");
});

test("a reply that proposes nothing, has no text, or ends a turn with no user message passes", (t) => {
  const f = fixture(t);
  assert.equal(f.stop("Fixed the typo in README.md."), undefined);
  assert.equal(f.emit("session_stop", { messages: [f.user(1)], last_assistant_message: { role: "assistant", content: [] } }), undefined);
  assert.equal(f.stop(PLAN, []), undefined);
});

test("session_start and session_switch forget the refused turn; the hook's hash guard still passes the same text", (t) => {
  const f = fixture(t);
  assert.equal(f.stop(PLAN).decision, "block");
  f.emit("session_switch", { type: "session_switch", reason: "resume" });
  assert.equal(f.stop(PLAN), undefined, "same text: the stop/<key> hash guard");
  assert.equal(f.stop(`${PLAN}\n4. again`).decision, "block");
  f.emit("session_start", { type: "session_start" });
  assert.equal(f.stop(`${PLAN}\n5. again`).decision, "block");
});

// --- pure mappings -------------------------------------------------------------------------------

test("toPreToolUse maps edit, write and bash to the hook payload, and nothing else", () => {
  assert.deepEqual(toPreToolUse({ toolName: "edit", input: { path: "/r/a" } }, "/r", "s"), { hook_event_name: "PreToolUse", cwd: "/r", session_id: "s", tool_name: "Edit", tool_input: { file_path: "/r/a" } });
  assert.deepEqual(toPreToolUse({ toolName: "edit", input: { path: "/r/a", paths: ["/r/a", "/r/b"] } }, "/r", undefined), { hook_event_name: "PreToolUse", cwd: "/r", tool_name: "Edit", tool_input: { file_path: "/r/a", edits: [{ file_path: "/r/b" }] } });
  assert.deepEqual(toPreToolUse({ toolName: "write", input: { path: "b" } }, "/r", "s").tool_input, { file_path: "b" });
  assert.deepEqual(toPreToolUse({ toolName: "bash", input: { command: "ls" } }, "/r", "s").tool_input, { command: "ls" });
  assert.equal(toPreToolUse({ toolName: "edit", input: { input: "no headers" } }, "/r", "s"), null);
  assert.equal(toPreToolUse({ toolName: "grep", input: { pattern: "x" } }, "/r", "s"), null);
});

test("assistantText and turnOpener read OMP's message shapes", () => {
  assert.equal(assistantText({ content: "plain" }), "plain");
  assert.equal(assistantText({ content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(assistantText(undefined), undefined);
  assert.equal(turnOpener([{ role: "user", timestamp: 5 }, { role: "assistant" }]), "t5");
  assert.equal(turnOpener([{ role: "user" }, { role: "custom" }]), "i0");
  assert.equal(turnOpener([{ role: "assistant" }]), null);
  assert.equal(turnOpener(undefined), null);
});
