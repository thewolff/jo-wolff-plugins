// omp/delegation-omp.test.mjs — the OMP adapter on a structural `pi`: the task-call gate, the
// task-result stop warning, and the agent:// write twin. Node strips the adapter's types.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import delegationOmp, { judgeAgentWrite, judgeTaskCall, judgeTaskResult } from "./delegation-omp.ts";
import { box, gitRepo, setConfig, skippedLog, GOOD_BRIEF, HOW_ONLY } from "../test/helpers.mjs";
import { NOT_DELIVERED } from "../lib/brief.mjs";

function fakePi() {
  const handlers = {};
  return { on: (event, h) => { handlers[event] = h; }, handlers };
}

function ctxFor(cwd, id = "omp-session-1") {
  return { cwd, sessionManager: { getSessionId: () => id } };
}

function receipt(repo, id = "omp-session-1") {
  mkdirSync(join(repo, ".pattern-check"), { recursive: true });
  writeFileSync(join(repo, ".pattern-check", `${id}.md`), "# r\n");
}

test("tool_call task: every entry is judged; the first failing one blocks with its index", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env);
  receipt(repo);
  const deps = { env, home: env.HOME };
  const pi = fakePi();
  delegationOmp(pi, deps);
  const ok = pi.handlers.tool_call({ toolName: "task", input: { tasks: [{ task: HOW_ONLY, agent: "reader" }, { task: GOOD_BRIEF, agent: "builder" }, { task: GOOD_BRIEF }] } }, ctxFor(repo));
  assert.equal(ok, undefined);
  const bad = pi.handlers.tool_call({ toolName: "task", input: { tasks: [{ task: HOW_ONLY, agent: "reader" }, { task: HOW_ONLY, agent: "builder" }] } }, ctxFor(repo));
  assert.equal(bad.block, true);
  assert.match(bad.reason, /^tasks\[1\]: Spawn refused: builder-class "builder" needs a "## Spiral bound" heading too/);
  const none = pi.handlers.tool_call({ toolName: "task", input: { tasks: [{ task: "do it", agent: "scout" }] } }, ctxFor(repo));
  assert.match(none.reason, /^tasks\[0\]: Spawn refused: the prompt has no "## How it fails" heading/);
  assert.equal(pi.handlers.tool_call({ toolName: "bash", input: { command: "rm" } }, ctxFor(repo)), undefined, "other tools");
});

test("tool_call task: the shared context counts for every entry, the single-task form is judged, a parenthetical heading matches, and read-only agents need How-it-fails only", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env);
  receipt(repo);
  const deps = { env, home: env.HOME };
  const plumbContext = "# Goal\nx\n\n## Spiral bound (builder)\n- one retry\n\n## How it fails (both tasks)\n- it breaks\n";
  assert.equal(judgeTaskCall({ context: plumbContext, tasks: [{ task: "# Target\ndo it", agent: "builder" }] }, ctxFor(repo), deps), undefined, "sections in context");
  assert.equal(judgeTaskCall({ context: "# Goal\nx", tasks: [{ task: GOOD_BRIEF, agent: "builder" }] }, ctxFor(repo), deps), undefined, "sections in the task");
  assert.match(judgeTaskCall({ context: "# Goal\nx", tasks: [{ task: "do it", agent: "builder" }] }, ctxFor(repo), deps).reason, /^tasks\[0\]: Spawn refused/);
  assert.equal(judgeTaskCall({ context: "# Goal\n\n## How it fails\n- x\n", tasks: [{ task: "review the diff", agent: "reviewer-codex" }] }, ctxFor(repo, "no-receipt-session"), deps), undefined, "read-only: no Spiral bound, no receipt");
  assert.match(judgeTaskCall({ tasks: [{ task: "review the diff", agent: "reviewer-codex" }] }, ctxFor(repo), deps).reason, /^tasks\[0\]: Spawn refused: the prompt has no "## How it fails" heading\./);
  assert.match(judgeTaskCall({ agent: "builder", task: "do it" }, ctxFor(repo), deps).reason, /^task: Spawn refused: the prompt has no "## How it fails" or "## Spiral bound" heading/, "single-task form");
  assert.equal(judgeTaskCall({ agent: "builder", task: "do it", context: plumbContext }, ctxFor(repo), deps), undefined, "single-task form with context");
  assert.equal(judgeTaskCall({ agent: "scout", tasks: [{ task: HOW_ONLY }] }, ctxFor(repo), deps), undefined, "a top-level agent applies to entries without one");
});

test("tool_call task: a missing agent is OMP's default `task`, which is builder-class; gate 2 keys on the session id", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env);
  const deps = { env, home: env.HOME };
  const r = judgeTaskCall({ tasks: [{ task: GOOD_BRIEF }] }, ctxFor(repo, "sess-9"), deps);
  assert.equal(r.block, true);
  assert.match(r.reason, /tasks\[0\]: Spawn refused: builder-class "task" needs a pattern-check receipt.*\.pattern-check\/sess-9\.md.*record --session sess-9/s);
  receipt(repo, "sess-9");
  assert.equal(judgeTaskCall({ tasks: [{ task: GOOD_BRIEF }] }, ctxFor(repo, "sess-9"), deps), undefined);
});

test("tool_call task: outside a git repository gate 2 is skipped with a skipped.log line; a malformed input is allowed and logged; off is silent", (t) => {
  const { env } = box(t);
  const loose = join(env.HOME, "loose");
  mkdirSync(loose);
  const deps = { env, home: env.HOME };
  assert.equal(judgeTaskCall({ tasks: [{ task: GOOD_BRIEF, agent: "builder" }] }, ctxFor(loose), deps), undefined);
  assert.match(skippedLog(env, env.HOME), /omp pattern-check receipt not checked: .*loose is in no git repository/);
  assert.equal(judgeTaskCall({ tasks: "nope" }, ctxFor(loose), deps), undefined);
  assert.match(skippedLog(env), /omp task call: neither a tasks array nor a task string/);
  assert.equal(judgeTaskCall({ tasks: [{ agent: "builder" }] }, ctxFor(loose), deps), undefined);
  assert.match(skippedLog(env), /omp task call: tasks\[0\]\.task is not a string/);
  assert.equal(judgeTaskCall({ tasks: [{ task: GOOD_BRIEF }] }, { sessionManager: { getSessionId: () => { throw new Error("x"); } }, cwd: loose }, deps), undefined, "a throwing session manager");
  setConfig(env, { off: true });
  assert.equal(judgeTaskCall({ tasks: [{ task: "x" }] }, ctxFor(loose), deps), undefined);
});

test("tool_result task: a builder-class result without Stopped because warns as additionalContext; valid lines and other agents are silent", (t) => {
  const { env } = box(t);
  const deps = { env, home: env.HOME };
  const pi = fakePi();
  delegationOmp(pi, deps);
  const details = { results: [
    { agent: "builder", id: "b1", output: "done\nStopped because: acceptance met" },
    { agent: "reader", id: "r1", output: "map" },
    { agent: "task", id: "t1", output: "finished, no line" },
    { agent: "beefy-builder", id: "b2", output: "Stopped because: whatever" },
  ] };
  const r = pi.handlers.tool_result({ toolName: "task", details }, undefined);
  const lines = r.additionalContext.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /builder-class agent "task" \(t1\) ended without a "Stopped because:" line/);
  assert.match(lines[1], /builder-class agent "beefy-builder" \(b2\) ended with "Stopped because: whatever", which is not one of the three values/);
  assert.equal(judgeTaskResult({ results: [{ agent: "builder", output: "x\nStopped because: bound hit" }] }, deps), undefined);
  assert.equal(judgeTaskResult({ results: "nope" }, deps), undefined);
  assert.equal(judgeTaskResult(null, deps), undefined);
  assert.equal(pi.handlers.tool_result({ toolName: "bash", details }, undefined), undefined);
});

test("tool_result write: a failed agent:// write gets the not-delivered instruction; a delivered one or a file write does not", (t) => {
  const { env } = box(t);
  const deps = { env, home: env.HOME };
  const r = judgeAgentWrite({ path: "agent://Worker", content: "hi" }, true, deps);
  assert.equal(r.additionalContext, `delegation: the write to agent://Worker failed; ${NOT_DELIVERED}`);
  assert.equal(judgeAgentWrite({ path: "agent://Worker", content: "hi" }, false, deps), undefined);
  assert.equal(judgeAgentWrite({ path: "/tmp/x.txt", content: "hi" }, true, deps), undefined);
  assert.equal(judgeAgentWrite("nope", true, deps), undefined);
  const pi = fakePi();
  delegationOmp(pi, deps);
  assert.equal(pi.handlers.tool_result({ toolName: "write", input: { path: "agent://X" }, isError: true }, undefined).additionalContext, `delegation: the write to agent://X failed; ${NOT_DELIVERED}`);
});

test("the handlers never throw: a hostile event returns undefined", (t) => {
  const { env } = box(t);
  const pi = fakePi();
  delegationOmp(pi, { env, home: env.HOME });
  assert.equal(pi.handlers.tool_call(null, undefined), undefined);
  assert.equal(pi.handlers.tool_call({ toolName: "task", input: { tasks: [null, 1, "s"] } }, null), undefined);
  assert.equal(pi.handlers.tool_result(null, undefined), undefined);
  assert.equal(pi.handlers.tool_result({ toolName: "task", details: { results: [null, 5] } }, undefined), undefined);
});

test("before_agent_start: the teaching block is offered until a context event shows it was carried, once per session, never to a subagent", (t) => {
  const { env } = box(t);
  const pi = fakePi();
  delegationOmp(pi, { env, home: env.HOME });
  const ctx = ctxFor(env.HOME, "s1");
  const first = pi.handlers.before_agent_start(undefined, ctx);
  assert.equal(first.message.customType, "delegation");
  assert.equal(first.message.display, false);
  assert.match(first.message.content, /^# Delegation: how to brief a subagent/);
  assert.ok(pi.handlers.before_agent_start(undefined, ctx), "offered again until carried");
  pi.handlers.context({ messages: [{ role: "user", content: "hi" }] }, ctx);
  assert.ok(pi.handlers.before_agent_start(undefined, ctx), "an unrelated context event does not count");
  pi.handlers.context({ messages: [{ role: "user", content: "hi" }, { customType: "delegation", content: "…" }] }, ctx);
  assert.equal(pi.handlers.before_agent_start(undefined, ctx), undefined, "carried: silent for the rest of the session");
  pi.handlers.session_compact(undefined, { ...ctx, agent: { kind: "sub" } });
  assert.equal(pi.handlers.before_agent_start(undefined, ctx), undefined, "a subagent's compaction changes nothing");
  pi.handlers.session_compact(undefined, ctx);
  assert.ok(pi.handlers.before_agent_start(undefined, ctx), "offered again after a compaction");
  pi.handlers.context({ messages: [{ customType: "delegation", content: "…" }] }, ctx);
  assert.equal(pi.handlers.before_agent_start(undefined, ctx), undefined, "carried again");
  assert.ok(pi.handlers.before_agent_start(undefined, ctxFor(env.HOME, "s2")), "a new session id starts over");
  assert.equal(pi.handlers.before_agent_start(undefined, { ...ctxFor(env.HOME, "s3"), agent: { kind: "sub" } }), undefined, "a subagent is skipped");
  setConfig(env, { off: true });
  assert.equal(pi.handlers.before_agent_start(undefined, ctxFor(env.HOME, "s4")), undefined, "off");
});
