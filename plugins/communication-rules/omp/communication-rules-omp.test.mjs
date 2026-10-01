// communication-rules-omp.test.mjs — node --test
//
// Hermetic by construction: every test injects its own temp stateDir, so the real plugin
// state dir is never touched. Most handler tests inject a fake runCli to pin the handler's
// contract. The failure-path and integration tests run the REAL default spawn
// (node:child_process, the same code the omp host runs): a stand-in core under a temp plugin
// root reproduces junk stdout and a hang, and one test spawns this checkout's real
// hooks/communication-rules-stop.mjs under a temp HOME with no profile.
//
// Importing the .ts subject directly is itself a test: node v24.13 strips the erasable types
// and loads the module without Bun.
//
// Run, from plugins/communication-rules/: node --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import communicationRulesOmp, {
  assistantText,
  buildStopPayload,
  sessionStopHandler,
} from "./communication-rules-omp.ts";

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
// The default runCli spawns node "$COMMUNICATION_RULES_PLUGIN_ROOT/hooks/communication-rules-stop.mjs"
// with the handler's process.env. PLUGIN_ROOT is this checkout's real core; fakeCore builds a
// stand-in root whose hook runs `source`.
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const spawnCtx = { cwd: tmpdir() }; // the spawn needs a cwd that exists

const fakeCore = (source) => {
  const root = mkdtempSync(join(tmpdir(), "omp-adapter-core-"));
  mkdirSync(join(root, "hooks"));
  writeFileSync(join(root, "hooks", "communication-rules-stop.mjs"), source);
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

// ─── the splice: the CLI's verdict as is; flag and harness tag forwarded ───────────────

test("a CLI block verdict is returned as is, with nothing logged by the adapter", async () => {
  const dir = mkstate();
  const out = await sessionStopHandler(event(), ctx, {
    stateDir: dir,
    runCli: async () => ({ ...blockVerdict }),
    timeoutMs: 1_000,
  });
  assert.deepEqual(out, { decision: "block", reason: blockVerdict.reason });
  assert.equal(readLog(dir, "warnings.log"), "");
  assert.equal(readLog(dir, "errors.log"), "");
});

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

test("the real spawn tags the child's env omp and carries the forwarded flag on stdin", async () => {
  const dir = mkstate();
  // A stand-in core that reports what it received instead of judging anything.
  const root = fakeCore(`
import { readFileSync } from "node:fs";
const payload = JSON.parse(readFileSync(0, "utf8"));
const reason = "harness=" + process.env.COMMUNICATION_RULES_HARNESS + " stop_hook_active=" + payload.stop_hook_active;
process.stdout.write(JSON.stringify({ decision: "block", reason }));
`);
  const stop = (stop_hook_active) =>
    withEnv({ COMMUNICATION_RULES_PLUGIN_ROOT: root, COMMUNICATION_RULES_HARNESS: undefined }, () =>
      sessionStopHandler(event({ session_id: "spawn-1", stop_hook_active }), spawnCtx, { stateDir: dir, timeoutMs: 10_000 }),
    );
  assert.deepEqual(await stop(false), { decision: "block", reason: "harness=omp stop_hook_active=false" });
  assert.deepEqual(await stop(true), { decision: "block", reason: "harness=omp stop_hook_active=true" });
});

// ─── quiet and non-block verdicts ──────────────────────────────────────────────────────

test("quiet and non-block verdicts return undefined with nothing logged", async () => {
  const verdicts = [
    undefined, // the CLI's documented quiet path
    { decision: "allow" },
    { reason: "a reason without a decision" },
    { decision: "block" }, // no reason: nothing to show the model, nothing to log
  ];
  for (const verdict of verdicts) {
    const dir = mkstate();
    const out = await sessionStopHandler(event(), ctx, {
      stateDir: dir,
      runCli: async () => verdict,
      timeoutMs: 1_000,
    });
    assert.equal(out, undefined);
    assert.equal(readLog(dir, "warnings.log"), "");
    assert.equal(readLog(dir, "errors.log"), "");
  }
});

// ─── failure paths: one errors.log line + undefined ────────────────────────────────────

const assertFailOpen = (dir, out, fragment) => {
  assert.equal(out, undefined, "every failure path returns undefined");
  const errors = readLog(dir, "errors.log");
  assert.equal(lines(errors).length, 1, "exactly one errors.log line");
  assert.match(errors, /omp-adapter fail-open: /);
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
  const out = await withEnv({ COMMUNICATION_RULES_PLUGIN_ROOT: root }, () =>
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
  const out = await withEnv({ COMMUNICATION_RULES_PLUGIN_ROOT: root }, () =>
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
  if (enforcement) writeFileSync(join(home, ".claude", "communication-rules.json"), JSON.stringify({ enforcement }));
  const stateDir = join(home, ".claude", ".communication-rules-state");
  const run = (over = {}) =>
    withEnv(
      {
        HOME: home,
        COMMUNICATION_RULES_PLUGIN_ROOT: PLUGIN_ROOT,
        COMMUNICATION_RULES_PROFILE: undefined,
        COMMUNICATION_RULES_ENFORCE: undefined,
        COMMUNICATION_RULES_HARNESS: undefined,
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
  assert.match(readLog(stateDir, "warnings.log"), /rule=needs-you-first Needs you first/);
  assert.ok(!existsSync(join(stateDir, "last-blocked-seat-canary-123.json")), "no hash recorded for an undelivered block");
});

test("integration: profile blocks the rule and arms OMP → the core's block reaches the host", async () => {
  const { run, stateDir } = realCore({ rules: { "needs-you-first": "block" }, armOmp: true });
  const out = await run({ session_id: "armed-1" });
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /^Needs you first/);
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

test("buildStopPayload: exact deep-equal shape with a rendered message", () => {
  const payload = JSON.parse(buildStopPayload(event(), "/work/canary"));
  assert.deepEqual(payload, {
    hook_event_name: "Stop",
    session_id: "seat-canary-123",
    cwd: "/work/canary",
    transcript_path: "/tmp/session.jsonl",
    stop_hook_active: false,
    last_assistant_message: "Done.",
  });
});

test("buildStopPayload: absent optionals fall back to \"\"", () => {
  const payload = JSON.parse(buildStopPayload({}, "/work/canary"));
  assert.deepEqual(payload, {
    hook_event_name: "Stop",
    cwd: "/work/canary",
    transcript_path: "",
    stop_hook_active: false,
    last_assistant_message: "",
  });
});

// ─── the registration seam ─────────────────────────────────────────────────────────────

test("default export registers exactly one session_stop handler", () => {
  const registered = [];
  communicationRulesOmp({ on: (name, handler) => registered.push({ name, handler }) });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "session_stop");
  assert.equal(typeof registered[0].handler, "function");
});
