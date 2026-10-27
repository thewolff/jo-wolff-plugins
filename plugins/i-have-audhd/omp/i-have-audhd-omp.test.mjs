// i-have-audhd-omp.test.mjs — node --test
//
// Hermetic by construction: every test injects its own temp stateDir or temp HOME, so the
// real plugin state dir is never touched. The loop-guard tests inject a fake runCli to read
// the flag the core is sent. The failure-path and integration tests run the REAL default
// spawn (node:child_process, the same code the omp host runs): a stand-in core under a temp
// plugin root reproduces junk stdout and a hang, and the integration tests spawn this
// checkout's real hooks under a temp HOME. The host-lifecycle tests drive the registered
// handlers in OMP's event order and assert what the session and the core end up with. One
// lifecycle test runs a real hung judge under the production budgets, so it takes ~20s.
//
// Importing the .ts subject directly is itself a test: node v24.13 strips the erasable types
// and loads the module without Bun.
//
// Run, from the repository root: node --test plugins/i-have-audhd/omp/i-have-audhd-omp.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as adapter from "./i-have-audhd-omp.ts";
import iHaveAudhdOmp, {
  assistantText,
  sessionStartHandler,
  sessionStopHandler,
  startSource,
} from "./i-have-audhd-omp.ts";

// Read off the namespace, so a build without them fails these tests one by one, not at import.
const { createAlarm, resolveNode } = adapter;

const mkstate = () => mkdtempSync(join(tmpdir(), "omp-adapter-state-"));

const readLog = (dir, name) => {
  const p = join(dir, name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

const blockVerdict = {
  decision: "block",
  reason: "Name the artifact: say 'the deploy checklist', not 'the checklist'.",
};

const event = (over = {}) => ({
  session_id: "seat-canary-123",
  session_file: "/tmp/session.jsonl",
  stop_hook_active: false,
  last_assistant_message: { content: [{ type: "text", text: "Done." }] },
  ...over,
});

const ctx = { cwd: "/work/canary" };
const lines = (text) => text.split("\n").filter(Boolean);

// ─── real-spawn helpers ───────────────────────────────────────────────────────────────
// The default runCli spawns node "$I_HAVE_AUDHD_PLUGIN_ROOT/hooks/i-have-audhd-stop.mjs"
// with the handler's process.env. PLUGIN_ROOT is this checkout's real core; fakeCore builds a
// stand-in root whose hook runs `source`.
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const spawnCtx = { cwd: tmpdir() }; // the spawn needs a cwd that exists

const fakeCore = (source) => {
  const root = mkdtempSync(join(tmpdir(), "omp-adapter-core-"));
  mkdirSync(join(root, "hooks"));
  writeFileSync(join(root, "hooks", "i-have-audhd-stop.mjs"), source);
  return root;
};

// Sets env vars for the duration of fn (undefined deletes one), then restores them. The
// child inherits process.env at spawn time, so this is how HOME and the root reach it.
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
};

// true once kill(pid, 0) reports ESRCH; polls up to 2s so the kernel can reap the zombie.
const isGone = async (pid) => {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") return true;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

// ─── the loop guard: the flag the core is sent; the harness tag on the child ───────────

// The flag the CLI receives, read off the payload handed to runCli.
const sentFlag = async (over, verdict) => {
  let sent;
  await sessionStopHandler(event(over), ctx, {
    stateDir: mkstate(),
    runCli: async (payload) => {
      sent = JSON.parse(payload).stop_hook_active;
      return verdict;
    },
    timeoutMs: 1_000,
  });
  return sent;
};

test("host flag true after a non-block result (another extension continued) → the core is sent false", async () => {
  assert.equal(await sentFlag({ session_id: "fwd-quiet" }, undefined), false);
  assert.equal(await sentFlag({ session_id: "fwd-quiet", stop_hook_active: true }, undefined), false);
  assert.equal(await sentFlag({ session_id: "fwd-never", stop_hook_active: true }, undefined), false, "no prior call at all");
});

test("host flag true after this handler's own block → the core is sent true, once", async () => {
  assert.equal(await sentFlag({ session_id: "fwd-chain" }, { ...blockVerdict }), false);
  assert.equal(await sentFlag({ session_id: "fwd-chain", stop_hook_active: true }, undefined), true);
  assert.equal(
    await sentFlag({ session_id: "fwd-chain", stop_hook_active: true }, undefined),
    false,
    "the record follows the latest result: a non-block clears it",
  );
});

test("host flag false after this handler's own block → the core is sent false (OMP reset the chain)", async () => {
  await sentFlag({ session_id: "fwd-reset" }, { ...blockVerdict });
  assert.equal(await sentFlag({ session_id: "fwd-reset", stop_hook_active: false }, undefined), false);
});

test("the record is per session: a block in one session does not mark another", async () => {
  await sentFlag({ session_id: "iso-a" }, { ...blockVerdict });
  assert.equal(await sentFlag({ session_id: "iso-b", stop_hook_active: true }, undefined), false);
  assert.equal(await sentFlag({ session_id: "iso-a", stop_hook_active: true }, undefined), true);
});

// ─── failure paths: one errors.log line + undefined ────────────────────────────────────

const assertFailOpen = (dir, out, fragment, hook = "i-have-audhd-stop.mjs") => {
  assert.equal(out, undefined, "every failure path returns undefined");
  const errors = readLog(dir, "errors.log");
  assert.equal(lines(errors).length, 1, "exactly one errors.log line");
  assert.ok(errors.includes(`omp-adapter fail-open (${hook}): `), `the line names the hook: expected "${hook}" in ${errors}`);
  assert.ok(errors.includes(fragment), `the error detail rides the line: expected "${fragment}"`);
};

test("crashing CLI → undefined, one errors.log line", async () => {
  const dir = mkstate();
  const out = await sessionStopHandler(event(), ctx, {
    stateDir: dir,
    runCli: async () => {
      throw new Error("spawn EACCES");
    },
    timeoutMs: 1_000,
  });
  assertFailOpen(dir, out, "spawn EACCES");
  assert.equal(readLog(dir, "warnings.log"), "");
});

test("junk stdout through the real spawn → undefined, one errors.log line with JSON.parse's error", async () => {
  const dir = mkstate();
  const root = fakeCore(`process.stdout.write("<html>");`); // exits 0 with unparseable stdout
  const out = await withEnv({ I_HAVE_AUDHD_PLUGIN_ROOT: root }, () =>
    sessionStopHandler(event(), spawnCtx, { stateDir: dir, timeoutMs: 10_000 }),
  );
  assertFailOpen(dir, out, "JSON"); // node: `… is not valid JSON`; bun: `JSON Parse error: …`
});

test("timeout through the real spawn → undefined, one errors.log line, the CLI and its child both dead", async () => {
  const dir = mkstate();
  const pidFile = join(dir, "pids.json");
  // A stand-in core that hangs, with a child of its own — the shape of a core waiting on a judge.
  const root = fakeCore(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const judge = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ core: process.pid, judge: judge.pid }));
setInterval(() => {}, 1000);
`);
  const out = await withEnv({ I_HAVE_AUDHD_PLUGIN_ROOT: root }, () =>
    sessionStopHandler(event(), spawnCtx, { stateDir: dir, timeoutMs: 1_500 }),
  );
  assertFailOpen(dir, out, "timed out after 1500ms");
  const { core, judge } = JSON.parse(readFileSync(pidFile, "utf8"));
  const coreGone = await isGone(core);
  const judgeGone = await isGone(judge);
  for (const pid of [core, judge]) {
    try {
      process.kill(pid, "SIGKILL"); // a regression must fail this test, not hang the run on a live child
    } catch {
      // already gone: the expected case
    }
  }
  assert.ok(coreGone, `core pid ${core} outlived the timeout`);
  assert.ok(judgeGone, `the core's child pid ${judge} outlived the timeout`);
});

// ─── integration: the real spawn against the real core ─────────────────────────────────

const body = (n) => "This sentence is ordinary body prose carrying findings and context. ".repeat(n);
// Violates needs-you-first (substantive prose before the marker) — the core's own fixture shape.
const misordered = `${body(6)}\n\n## Needs you\n\nApprove the deploy before Friday.\n\n${body(2)}`;

// The core's own state dir under a temp HOME, plus an optional profile. The harness tag is
// scrubbed from this process: only the adapter may put it on the child. run() is one stop.
const realCore = (enforcement) => {
  const home = mkdtempSync(join(tmpdir(), "omp-adapter-home-"));
  mkdirSync(join(home, ".claude"));
  if (enforcement) writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify({ enforcement }));
  const stateDir = join(home, ".claude", ".i-have-audhd-state");
  const run = (over = {}) =>
    withEnv(
      {
        HOME: home,
        I_HAVE_AUDHD_PLUGIN_ROOT: PLUGIN_ROOT,
        I_HAVE_AUDHD_PROFILE: undefined,
        I_HAVE_AUDHD_ENFORCE: undefined,
        I_HAVE_AUDHD_HARNESS: undefined,
      },
      () =>
        sessionStopHandler(
          event({ session_file: join(home, "absent.jsonl"), last_assistant_message: { content: misordered }, ...over }),
          { cwd: home },
          { stateDir, timeoutMs: 10_000 },
        ),
    );
  return { run, stateDir };
};

test("integration: real spawn + real core, temp HOME, no profile → undefined and the core's own warn line", async () => {
  const { run, stateDir } = realCore(null);
  const out = await run();
  assert.equal(out, undefined, "no profile: every rule warns, so no block reaches the host");
  assert.equal(readLog(stateDir, "errors.log"), "", "the spawn did not fail open");
  assert.match(readLog(stateDir, "warnings.log"), /rule=needs-you-first/, "the real core ran under the temp HOME");
});

test("integration: profile blocks the rule but does not arm OMP → undefined, warn line with the real rule id", async () => {
  const { run, stateDir } = realCore({ rules: { "needs-you-first": "block" } });
  const out = await run();
  assert.equal(out, undefined, "the harness tag reached the core and capped the block");
  assert.equal(readLog(stateDir, "errors.log"), "");
  assert.match(readLog(stateDir, "warnings.log"), /rule=needs-you-first /);
  assert.ok(!existsSync(join(stateDir, "last-blocked-seat-canary-123.json")), "no hash recorded for an undelivered block");
});

test("integration: profile blocks the rule and arms OMP → the core's block reaches the host", async () => {
  const { run, stateDir } = realCore({ rules: { "needs-you-first": "block" }, armOmp: true });
  const out = await run({ session_id: "armed-1" });
  assert.equal(out?.decision, "block");
  assert.equal(readLog(stateDir, "warnings.log"), "");
});

// Another violating text: substantive prose still precedes the needs-you marker.
const revisedText = `${body(7)}\n\n## Needs you\n\nApprove now.`;

test("integration, armed: another extension's continuation does not spend the block; this plugin's own revision only warns", async () => {
  const { run, stateDir } = realCore({ rules: { "needs-you-first": "block" }, armOmp: true });
  // OMP's flag is already true (another extension continued), but this handler never blocked here.
  const first = await run({ session_id: "chain-1", stop_hook_active: true });
  assert.equal(first?.decision, "block", "the first block of the chain is this plugin's to give");
  const revision = await run({
    session_id: "chain-1",
    stop_hook_active: true,
    last_assistant_message: { content: revisedText },
  });
  assert.equal(revision, undefined, "re-checked after its own block, never blocked twice");
  assert.match(readLog(stateDir, "warnings.log"), /rule=needs-you-first/);
});

// ─── pure helpers ──────────────────────────────────────────────────────────────────────

test("assistantText: string content passes through", () => {
  assert.equal(assistantText({ content: "plain text" }), "plain text");
});

test("assistantText: block-array content joins text parts with newlines", () => {
  const message = {
    content: [
      { type: "text", text: "first" },
      { type: "tool_call", id: "t1" },
      { type: "text", text: "second" },
    ],
  };
  assert.equal(assistantText(message), "first\nsecond");
});

test("assistantText: empty, absent, and textless shapes are undefined", () => {
  assert.equal(assistantText({ content: "" }), undefined);
  assert.equal(assistantText({}), undefined);
  assert.equal(assistantText(undefined), undefined);
  assert.equal(assistantText("bare string"), undefined);
  assert.equal(assistantText({ content: [{ type: "tool_call" }] }), undefined);
});

// ─── session start: the inject hook through the adapter ────────────────────────────────

const startCtx = (over = {}) => ({
  cwd: tmpdir(),
  agent: { kind: "main" },
  sessionManager: { getSessionId: () => "start-1", getEntries: () => [] },
  ...over,
});

test("startSource: a loaded session holding messages is a resume; an empty one is a startup", () => {
  assert.equal(startSource(startCtx()), "startup");
  const resumed = startCtx({ sessionManager: { getEntries: () => [{ type: "session" }, { type: "message" }] } });
  assert.equal(startSource(resumed), "resume");
  const broken = startCtx({ sessionManager: { getEntries: () => { throw new Error("x"); } } });
  assert.equal(startSource(broken), "startup");
});

test("an inject CLI printing no additionalContext fails open with one errors.log line", async () => {
  const dir = mkstate();
  const out = await sessionStartHandler("startup", startCtx(), { stateDir: dir, runCli: async () => ({ decision: "block" }) });
  assertFailOpen(dir, out, "no additionalContext", "i-have-audhd-inject.mjs");
});

// The inject hook's state dir under a temp HOME; run() is one session-start crossing through
// the real spawn of this checkout's hooks/i-have-audhd-inject.mjs.
const realInject = () => {
  const home = mkdtempSync(join(tmpdir(), "omp-adapter-inject-home-"));
  const stateDir = join(home, ".claude", ".i-have-audhd-state");
  const run = (source, ctx = startCtx(), env = {}) =>
    withEnv(
      { HOME: home, I_HAVE_AUDHD_PLUGIN_ROOT: PLUGIN_ROOT, I_HAVE_AUDHD_PROFILE: undefined, I_HAVE_AUDHD_INJECT: undefined, ...env },
      () => sessionStartHandler(source, ctx, { stateDir, timeoutMs: 10_000 }),
    );
  return { run, stateDir };
};

test("integration: startup writes no resume marker and no errors", async () => {
  const { run, stateDir } = realInject();
  await run("startup");
  assert.equal(readLog(stateDir, "errors.log"), "");
  assert.ok(!existsSync(join(stateDir, "resume-start-1")));
});

test("integration: compact writes the resume marker under the session manager's id", async () => {
  const { run, stateDir } = realInject();
  await run("compact");
  assert.ok(existsSync(join(stateDir, "resume-start-1")));
});

test("integration: I_HAVE_AUDHD_INJECT=off delivers nothing and logs nothing", async () => {
  const { run, stateDir } = realInject();
  assert.equal(await run("startup", startCtx(), { I_HAVE_AUDHD_INJECT: "off" }), undefined);
  assert.equal(readLog(stateDir, "errors.log"), "");
});

test("integration: with no judge chosen, the first main session shows the setup notice once as a UI warning", async () => {
  const { run } = realInject();
  const notices = [];
  const ctx = startCtx({ hasUI: true, ui: { notify: (message, type) => notices.push({ message, type }) } });
  const context = await run("startup", ctx);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "warning");
  assert.match(notices[0].message, /no judge is configured, so 5 of its 9 checks are off/);
  assert.ok(notices[0].message.includes(join(PLUGIN_ROOT, "tools", "setup.mjs")));
  assert.ok(context.includes(notices[0].message), "the agent gets the same text");
  await run("startup", ctx);
  assert.equal(notices.length, 1, "shown once");
});

test("integration: a subagent session never shows the setup notice", async () => {
  const { run } = realInject();
  const notices = [];
  await run("startup", startCtx({ agent: { kind: "sub" }, hasUI: true, ui: { notify: (m) => notices.push(m) } }));
  assert.deepEqual(notices, []);
});

// ─── host lifecycle: what the session and the core end up with ─────────────────────────

// One OMP session: the adapter's registered handlers, fired in the host's event order, with
// the real inject and stop hooks spawned under a temp HOME (plus an optional profile).
// fire(name, event, ctx) is one host event; ctx defaults to the main session "start-1".
const hostSession = (enforcement) => {
  const handlers = {};
  iHaveAudhdOmp({ on: (name, handler) => (handlers[name] = handler) });
  const home = mkdtempSync(join(tmpdir(), "omp-adapter-host-home-"));
  mkdirSync(join(home, ".claude"));
  if (enforcement) writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify({ enforcement }));
  const stateDir = join(home, ".claude", ".i-have-audhd-state");
  const fire = (name, hostEvent = {}, hostCtx = startCtx({ cwd: home })) =>
    withEnv(
      {
        HOME: home,
        I_HAVE_AUDHD_PLUGIN_ROOT: PLUGIN_ROOT,
        I_HAVE_AUDHD_PROFILE: undefined,
        I_HAVE_AUDHD_INJECT: undefined,
        I_HAVE_AUDHD_ENFORCE: undefined,
        I_HAVE_AUDHD_HARNESS: undefined,
      },
      async () => handlers[name](hostEvent, hostCtx),
    );
  return { fire, home, stateDir };
};

// A main session whose manager id stays put while OMP's provider id may rotate under it.
const managedCtx = (home, managerId) =>
  startCtx({ cwd: home, sessionManager: { getSessionId: () => managerId, getEntries: () => [] } });

test("lifecycle: session-start context survives before_agent_start re-entry and stops once a request carries it", async () => {
  const { fire } = hostSession();
  await fire("session_start");
  const first = await fire("before_agent_start");
  assert.equal(first?.message?.display, false, "hidden from the transcript view");
  assert.deepEqual(await fire("before_agent_start"), first, "a re-run of the chain for the same submission gets it again");

  await fire("context", { messages: [{ role: "user", content: "hello" }] });
  const lookalike = { role: "custom", customType: first.message.customType, content: first.message.content };
  await fire("context", { messages: [lookalike] });
  assert.deepEqual(await fire("before_agent_start"), first, "requests without this delivery leave it pending");

  await fire("context", { messages: [{ role: "user", content: "hello" }, { role: "custom", ...first.message }] });
  assert.equal(await fire("before_agent_start"), undefined, "accepted context is not offered on a later prompt");
});

test("lifecycle: an earlier crossing's message still in history does not consume a newer crossing's context", async () => {
  const { fire } = hostSession();
  await fire("session_start");
  const startup = (await fire("before_agent_start")).message;
  await fire("context", { messages: [{ role: "custom", ...startup }] });
  await fire("session_compact");
  const compact = await fire("before_agent_start");
  assert.ok(compact?.message, "the compaction crossing offers context again");

  await fire("context", { messages: [{ role: "custom", ...startup }] });
  assert.deepEqual(await fire("before_agent_start"), compact, "the old delivery does not stand in for the new one");

  await fire("context", { messages: [{ role: "custom", ...startup }, { role: "custom", ...compact.message }] });
  assert.equal(await fire("before_agent_start"), undefined);
});

test("lifecycle: a subagent's session_start leaves nothing for before_agent_start", async () => {
  const { fire, home } = hostSession();
  await fire("session_start", {}, startCtx({ cwd: home, agent: { kind: "sub" } }));
  assert.equal(await fire("before_agent_start"), undefined);
});

test("lifecycle: Stop consumes the compaction's resume marker when OMP's provider id differs from the manager id", async () => {
  const { fire, home, stateDir } = hostSession();
  const session = managedCtx(home, "mgr-rotated");
  await fire("session_compact", {}, session);
  assert.ok(existsSync(join(stateDir, "resume-mgr-rotated")), "the injector armed rule 8 for this session");

  const stop = event({
    session_id: "provider-rotated",
    session_file: join(home, "absent.jsonl"),
    last_assistant_message: { content: misordered },
  });
  assert.equal(await fire("session_stop", stop, session), undefined);
  assert.ok(!existsSync(join(stateDir, "resume-mgr-rotated")), "the Stop core consumed the marker");
  assert.match(readLog(stateDir, "skipped.log"), /rule=restate-resumed-thread/, "rule 8 was judged for this resume");
  assert.equal(readLog(stateDir, "errors.log"), "");
});

test("lifecycle, armed: this plugin's own block is tracked across a provider-id rotation", async () => {
  const { fire, home, stateDir } = hostSession({ rules: { "needs-you-first": "block" }, armOmp: true });
  const session = managedCtx(home, "mgr-armed");
  const stop = (over) => event({ session_file: join(home, "absent.jsonl"), last_assistant_message: { content: misordered }, ...over });

  const first = await fire("session_stop", stop({ session_id: "provider-a" }), session);
  assert.equal(first?.decision, "block");
  const revision = await fire(
    "session_stop",
    stop({ session_id: "provider-b", stop_hook_active: true, last_assistant_message: { content: revisedText } }),
    session,
  );
  assert.equal(revision, undefined, "the revision after this plugin's block only warns");
  assert.match(readLog(stateDir, "warnings.log"), /rule=needs-you-first/);
});

test("lifecycle: a hung judge at the production budgets — the stop settles itself before the adapter's kill, keeps its deterministic warning, and reaps the judge", async () => {
  const pidDir = mkstate();
  // Every judge job records the pid of a sleep that outlives it, behind a pipe stage that holds
  // the judge's stdout: the shape of a wrapper whose model call hangs.
  const judgeCommand = `sh -c 'echo $$ >> "$0"; exec sleep 45' '${join(pidDir, "judges.pid")}' | cat`;
  const { fire, home, stateDir } = hostSession({ judgeCommand });
  const stop = event({ session_file: join(home, "absent.jsonl"), last_assistant_message: { content: misordered } });

  const started = Date.now();
  const out = await fire("session_stop", stop, managedCtx(home, "mgr-hung-judge"));
  const elapsed = Date.now() - started;
  const pids = lines(readLog(pidDir, "judges.pid")).map(Number);
  const gone = await Promise.all(pids.map(isGone));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL"); // a regression must fail this test, not leave a live sleep
    } catch {
      // already gone: the expected case
    }
  }

  assert.ok(elapsed < 25_000, `the stop took ${elapsed}ms; the adapter's kill or the host's cutoff decided it`);
  assert.equal(out, undefined, "no profile mode: the deterministic finding warns");
  assert.equal(readLog(stateDir, "errors.log"), "", "the core settled itself; the adapter did not fail open");
  assert.match(readLog(stateDir, "judge-failures.log"), /error=judge-timeout/);
  assert.match(readLog(stateDir, "warnings.log"), /rule=needs-you-first/, "the deterministic warning survived the hung judge");
  assert.ok(pids.length > 0, "a judge job ran");
  assert.ok(gone.every(Boolean), `judge descendants ${pids.join(", ")} outlived the stop`);
});

// ─── warnings: a warn finding reaches the agent's next turn ────────────────────────────
// The core leaves its warn findings pending (lib/pending.mjs); after each stop the adapter
// spawns the prompt CLI to consume them and hands them to the host's sendMessage with
// deliverAs "nextTurn" — the queue OMP prepends to the next prompt.

test("a warning the core left pending is delivered after the stop, whether or not the stop blocks", async () => {
  const dir = mkstate();
  const delivered = [];
  const deps = {
    stateDir: dir,
    runCli: async () => blockVerdict,
    takeWarning: async (sid) => ({ notice: `notice for ${sid}`, summary: "s" }),
    deliver: (w) => delivered.push(w),
  };
  const out = await sessionStopHandler(event({ session_id: "warn-1" }), ctx, deps);
  assert.equal(out?.decision, "block");
  assert.deepEqual(delivered, [{ notice: "notice for warn-1", summary: "s" }]);
  const quiet = await sessionStopHandler(event({ session_id: "warn-2" }), ctx, { ...deps, runCli: async () => undefined });
  assert.equal(quiet, undefined);
  assert.equal(delivered.length, 2);
  assert.equal(readLog(dir, "errors.log"), "");
});

test("a failing delivery fails open: the verdict stands, one errors.log line names the delivery", async () => {
  const dir = mkstate();
  const out = await sessionStopHandler(event(), ctx, {
    stateDir: dir,
    runCli: async () => blockVerdict,
    takeWarning: async () => ({ notice: "n", summary: "s" }),
    deliver: () => {
      throw new Error("host refused");
    },
  });
  assert.equal(out?.decision, "block");
  assert.match(readLog(dir, "errors.log"), /omp-adapter fail-open \(i-have-audhd-prompt\.mjs, warning delivery\): host refused/);
});

test("a host with no sendMessage gets no delivery attempt and no error", async () => {
  const dir = mkstate();
  let taken = 0;
  await sessionStopHandler(event(), ctx, { stateDir: dir, runCli: async () => undefined, takeWarning: async () => (taken++, undefined) });
  assert.equal(taken, 0, "the pending file is left for the next checked stop to replace");
  assert.equal(readLog(dir, "errors.log"), "");
});

test("lifecycle: a real warn finding reaches sendMessage as a nextTurn message, once, and the person gets a notice", async () => {
  const handlers = {};
  const sent = [];
  const notices = [];
  iHaveAudhdOmp({ on: (name, handler) => (handlers[name] = handler), sendMessage: (m, o) => sent.push({ m, o }) });
  const home = mkdtempSync(join(tmpdir(), "omp-adapter-warn-home-"));
  mkdirSync(join(home, ".claude"));
  const stateDir = join(home, ".claude", ".i-have-audhd-state");
  const hostCtx = {
    ...managedCtx(home, "mgr-warn"),
    hasUI: true,
    ui: { notify: (msg, type) => notices.push({ msg, type }) },
  };
  const fire = (stop) =>
    withEnv(
      { HOME: home, I_HAVE_AUDHD_PLUGIN_ROOT: PLUGIN_ROOT, I_HAVE_AUDHD_PROFILE: undefined, I_HAVE_AUDHD_ENFORCE: undefined, I_HAVE_AUDHD_HARNESS: undefined },
      () => handlers.session_stop(stop, hostCtx),
    );
  const out = await fire(event({ session_file: join(home, "absent.jsonl"), last_assistant_message: { content: misordered } }));
  assert.equal(out, undefined, "no profile: the measured defaults warn");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].o.deliverAs, "nextTurn");
  assert.equal(sent[0].o.triggerTurn, undefined, "the warning waits for the next prompt; it starts no turn");
  assert.equal(sent[0].m.customType, "i-have-audhd-warning");
  assert.match(sent[0].m.content, /^i-have-audhd check of your last message \(warning only/);
  assert.match(sent[0].m.content, /Move what needs the reader above the body\./);
  assert.doesNotMatch(sent[0].m.content, /Paste the corrected/);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "warning");
  assert.match(notices[0].msg, /needs-you-first/);
  assert.equal(readLog(stateDir, "errors.log"), "");
  assert.ok(!existsSync(join(stateDir, "pending-warn-mgr-warn.json")), "consumed on delivery");

  const clean = `## Needs you\n\nApprove the deploy before Friday.\n\n${body(6)}`;
  await fire(event({ session_file: join(home, "absent.jsonl"), last_assistant_message: { content: clean } }));
  assert.equal(sent.length, 1, "a clean stop sends nothing");
});

// ─── loud to operators: a named log line, one notify per error key, hourly re-alert ─────
// Graceful to the user (the handler still returns undefined, the session goes on) and loud to
// the operator: every failure is an errors.log line naming the hook, and the person at the UI
// hears about each failure kind once, then again only after an hour or after it healed.

// An executable standing in for node; `script` is its sh body.
const fakeNode = (script) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-adapter-node-"));
  const path = join(dir, "node");
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
};

// A host context with a UI that records every notify.
const uiCtx = (notes, over = {}) => ({
  cwd: tmpdir(),
  hasUI: true,
  ui: { notify: (msg, type) => notes.push({ msg, type }) },
  ...over,
});

// A clock the test moves by hand.
const clock = (start = Date.parse("2026-10-27T08:00:00.000Z")) => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
};
const HOUR = 3_600_000;

// One stop through the real spawn with `node` as the node binary, under a temp HOME.
const stopWithNode = (node, ctxArg, deps) =>
  withEnv(
    {
      HOME: mkdtempSync(join(tmpdir(), "omp-adapter-node-home-")),
      I_HAVE_AUDHD_NODE: node,
      I_HAVE_AUDHD_PLUGIN_ROOT: PLUGIN_ROOT,
      I_HAVE_AUDHD_PROFILE: undefined,
    },
    () => sessionStopHandler(event(), ctxArg, { timeoutMs: 10_000, ...deps }),
  );

const EXIT_127 = `echo "sh: node: command not found" >&2\nexit 127`;

test("node exits 127 → one errors.log line naming the Stop hook with node's stderr, and exactly one notify", async () => {
  const dir = mkstate();
  const notes = [];
  const out = await stopWithNode(fakeNode(EXIT_127), uiCtx(notes), { stateDir: dir, alarm: createAlarm?.({ now: clock().now }) });
  assert.equal(out, undefined, "graceful to the user: the session goes on, unchecked");
  const errs = lines(readLog(dir, "errors.log"));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /omp-adapter fail-open \(i-have-audhd-stop\.mjs\): .*exited 127/);
  assert.match(errs[0], /stderr: sh: node: command not found/, "stderr is kept, not discarded");
  assert.equal(notes.length, 1, "loud to the operator, once");
  assert.equal(notes[0].type, "error");
  assert.match(notes[0].msg, /i-have-audhd-stop\.mjs/, "names what broke");
  assert.match(notes[0].msg, /exited 127/, "carries the evidence");
  assert.ok(notes[0].msg.includes(join(dir, "errors.log")), "names where the log is");
});

test("no usable node → one errors.log line naming the hook and the missing node, and exactly one notify", async () => {
  const dir = mkstate();
  const notes = [];
  const missing = join(mkdtempSync(join(tmpdir(), "omp-adapter-nonode-")), "node");
  const out = await stopWithNode(missing, uiCtx(notes), { stateDir: dir, alarm: createAlarm?.({ now: clock().now }) });
  assert.equal(out, undefined);
  const errs = lines(readLog(dir, "errors.log"));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /omp-adapter fail-open \(i-have-audhd-stop\.mjs\): /);
  assert.ok(errs[0].includes(missing), "names the node path that was not usable");
  assert.match(errs[0], /I_HAVE_AUDHD_NODE/, "names the setting that fixes it");
  assert.equal(notes.length, 1);
  assert.match(notes[0].msg, /I_HAVE_AUDHD_NODE/, "the notify carries the next step");
});

test("the same failure again within the hour is logged every time but notified once; after the hour, once more with since-when", async () => {
  const dir = mkstate();
  const notes = [];
  const c = clock();
  const alarm = createAlarm?.({ now: c.now });
  const node = fakeNode(EXIT_127);
  for (let i = 0; i < 3; i++) {
    await stopWithNode(node, uiCtx(notes), { stateDir: dir, alarm });
    c.advance(10 * 60_000);
  }
  assert.equal(lines(readLog(dir, "errors.log")).length, 3, "every failure is a log line");
  assert.equal(notes.length, 1, "same key inside the hour: no second notify");
  c.advance(HOUR);
  await stopWithNode(node, uiCtx(notes), { stateDir: dir, alarm });
  assert.equal(notes.length, 2, "the hourly re-alert");
  assert.match(notes[1].msg, /still failing since 2026-10-27T08:00:00\.000Z/);
});

test("a different failure kind is a different key and notifies at once; a success heals a key so its next failure notifies", async () => {
  const dir = mkstate();
  const notes = [];
  const alarm = createAlarm?.({ now: clock().now });
  const crash = async () => {
    throw new Error("spawn EACCES");
  };
  await sessionStopHandler(event(), uiCtx(notes), { stateDir: dir, alarm, runCli: crash });
  await sessionStartHandler("startup", uiCtx(notes), { stateDir: dir, alarm, runCli: crash });
  assert.equal(notes.length, 2, "stop and inject are separate keys");
  assert.match(notes[1].msg, /i-have-audhd-inject\.mjs/);
  await sessionStopHandler(event(), uiCtx(notes), { stateDir: dir, alarm, runCli: async () => undefined });
  await sessionStopHandler(event(), uiCtx(notes), { stateDir: dir, alarm, runCli: crash });
  assert.equal(notes.length, 3, "the stop healed, so its next failure is news");
});

test("with no UI attached nothing is notified, and the key stays unspent for the next session that has one", async () => {
  const dir = mkstate();
  const notes = [];
  const alarm = createAlarm?.({ now: clock().now });
  const crash = async () => {
    throw new Error("spawn EACCES");
  };
  await sessionStopHandler(event(), { ...uiCtx(notes), hasUI: false }, { stateDir: dir, alarm, runCli: crash });
  assert.equal(notes.length, 0);
  assert.equal(lines(readLog(dir, "errors.log")).length, 1, "still logged");
  await sessionStopHandler(event(), uiCtx(notes), { stateDir: dir, alarm, runCli: crash });
  assert.equal(notes.length, 1);
});

test("a systemMessage from the stop core (judge unavailable) reaches the person as a UI warning", async () => {
  const notes = [];
  const text = "i-have-audhd: judge unavailable (judge-exit-4); conclusion-first was not checked.";
  const out = await sessionStopHandler(event(), uiCtx(notes), {
    stateDir: mkstate(),
    alarm: createAlarm?.({ now: clock().now }),
    runCli: async () => ({ systemMessage: text }),
  });
  assert.equal(out, undefined, "a systemMessage alone is no block");
  assert.deepEqual(notes, [{ msg: text, type: "warning" }]);
});

test("integration: a failing judge through the real core is one 'judge unavailable' notice, not a pass, and not repeated on the next stop", async () => {
  const home = mkdtempSync(join(tmpdir(), "omp-adapter-judge-home-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { judgeCommand: "echo 'judge-cli: not logged in' >&2; exit 4" } }),
  );
  const stateDir = join(home, ".claude", ".i-have-audhd-state");
  const notes = [];
  const hostCtx = { ...managedCtx(home, "mgr-judge"), ...uiCtx(notes), cwd: home };
  const report = `${body(7)}\n\n${body(7)}`; // conclusion-first dispatches a judge job
  const stop = (text) =>
    withEnv(
      { HOME: home, I_HAVE_AUDHD_PLUGIN_ROOT: PLUGIN_ROOT, I_HAVE_AUDHD_PROFILE: undefined, I_HAVE_AUDHD_ENFORCE: undefined, I_HAVE_AUDHD_HARNESS: undefined },
      () => sessionStopHandler(event({ last_assistant_message: { content: text } }), hostCtx, { alarm: createAlarm?.({ now: clock().now }) }),
    );
  await stop(report);
  const loud = notes.filter((n) => /judge unavailable/i.test(n.msg));
  assert.equal(loud.length, 1, notes.map((n) => n.msg).join("\n"));
  assert.match(loud[0].msg, /conclusion-first/);
  assert.match(readLog(stateDir, "warnings.log"), /rule=conclusion-first .*judge unavailable/i, "recorded as unchecked, not passed");
  await stop(`${report}\n\nOne more sentence.`);
  assert.equal(notes.filter((n) => /judge unavailable/i.test(n.msg)).length, 1, "once per key: the second stop says nothing new");
  assert.equal(readLog(stateDir, "errors.log"), "");
});

// ─── which node: an absolute path, never a login shell's PATH ────────────────────────────

test("resolveNode: under node, the running binary is the node the hooks get", () => {
  const r = resolveNode({ env: { PATH: "" }, execPath: "/runtime/node", underBun: false, home: "/h", isExecutable: () => false });
  assert.deepEqual(r, { path: "/runtime/node" });
});

test("resolveNode: under bun, PATH first, then the fixed fallbacks", () => {
  const onPath = new Set(["/p/node", "/h/.local/bin/node"]);
  const pick = (PATH, exec) =>
    resolveNode({ env: { PATH }, execPath: "/b/bun", underBun: true, home: "/h", isExecutable: (p) => exec.has(p) });
  assert.deepEqual(pick("/q:/p", onPath), { path: "/p/node" });
  assert.deepEqual(pick("/opt/homebrew/bin:/usr/bin:/bin", new Set(["/h/.local/bin/node"])), { path: "/h/.local/bin/node" });
});

test("resolveNode: nothing usable is a loud error naming where it looked and the setting that fixes it", () => {
  const r = resolveNode({ env: { PATH: "/usr/bin:/bin" }, execPath: "/b/bun", underBun: true, home: "/h", isExecutable: () => false });
  assert.equal(r.path, undefined);
  assert.match(r.error, /\/h\/\.local\/bin\/node/);
  assert.match(r.error, /I_HAVE_AUDHD_NODE/);
});

test("resolveNode: an explicit I_HAVE_AUDHD_NODE that is not executable is an error, never a silent fallback", () => {
  const r = resolveNode({
    env: { PATH: "/p", I_HAVE_AUDHD_NODE: "/nope/node" },
    execPath: "/runtime/node",
    underBun: false,
    home: "/h",
    isExecutable: (p) => p === "/p/node",
  });
  assert.equal(r.path, undefined);
  assert.match(r.error, /\/nope\/node/);
});
