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

// The env flip is read per invocation, so scrubbing it here (after the hoisted imports) is
// enough to keep the outer environment from leaking into every test below.
delete process.env.COMMUNICATION_RULES_OMP_MODE;

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

// ─── host loop guard ──────────────────────────────────────────────────────────────────

test("stop_hook_active short-circuits and the CLI is never invoked", async () => {
  const dir = mkstate();
  let calls = 0;
  const out = await sessionStopHandler(event({ stop_hook_active: true }), ctx, {
    stateDir: dir,
    runCli: async () => {
      calls += 1;
      return blockVerdict;
    },
    timeoutMs: 1_000,
  });
  assert.equal(out, undefined);
  assert.equal(calls, 0, "the fake CLI must not run");
  assert.equal(readLog(dir, "warnings.log"), "");
  assert.equal(readLog(dir, "errors.log"), "");
});

// ─── warn-only downgrade (the default) ────────────────────────────────────────────────

test("CLI block verdict downgrades to exactly one warnings.log line in warn mode", async () => {
  const dir = mkstate();
  const out = await sessionStopHandler(event(), ctx, {
    stateDir: dir,
    runCli: async () => blockVerdict,
    timeoutMs: 1_000,
  });
  assert.equal(out, undefined, "warn mode never gates");
  const warn = readLog(dir, "warnings.log");
  assert.equal(lines(warn).length, 1);
  assert.match(warn, /^\d{4}-\d{2}-\d{2}T[^\s]+ rule=omp-adapter mode=warn-only reason=/);
  assert.ok(warn.includes("Name the artifact"), "the reason rides the line");
  assert.ok(warn.endsWith("\n"), "appendLog shape: trailing newline");
  assert.equal(readLog(dir, "errors.log"), "", "a downgrade is not a failure");
});

test("warn reason collapses whitespace and caps at 300 chars", async () => {
  const dir = mkstate();
  const noisy = `line one\n\n\tline two ${"x".repeat(400)}`;
  await sessionStopHandler(event(), ctx, {
    stateDir: dir,
    runCli: async () => ({ decision: "block", reason: noisy }),
    timeoutMs: 1_000,
  });
  const m = readLog(dir, "warnings.log").match(/reason=(.*)\n$/);
  assert.ok(m, "a reason= field is present");
  assert.ok(m[1].length <= 300);
  assert.ok(!m[1].includes("\n"), "whitespace collapsed");
  assert.match(m[1], /^line one line two x+$/);
});

test("re-run safety: identical verdicts produce one warn line per call, no cross-state", async () => {
  const dir = mkstate();
  const deps = { stateDir: dir, runCli: async () => ({ ...blockVerdict }), timeoutMs: 1_000 };
  await sessionStopHandler(event(), ctx, deps);
  await sessionStopHandler(event({ session_id: "seat-canary-456" }), ctx, deps);
  const warn = readLog(dir, "warnings.log");
  assert.equal(lines(warn).length, 2);
  assert.ok(lines(warn).every((l) => l.includes("rule=omp-adapter mode=warn-only")));
});

// ─── the mode flip ─────────────────────────────────────────────────────────────────────

test("env COMMUNICATION_RULES_OMP_MODE=block returns the verdict verbatim", async () => {
  const dir = mkstate();
  process.env.COMMUNICATION_RULES_OMP_MODE = "block";
  try {
    const out = await sessionStopHandler(event(), ctx, {
      stateDir: dir,
      runCli: async () => ({ ...blockVerdict }),
      timeoutMs: 1_000,
    });
    assert.deepEqual(out, { decision: "block", reason: blockVerdict.reason });
    assert.equal(readLog(dir, "warnings.log"), "", "block mode gates; the block is the visibility");
  } finally {
    delete process.env.COMMUNICATION_RULES_OMP_MODE;
  }
});

test("env values other than exactly 'block' read as warn", async () => {
  const dir = mkstate();
  process.env.COMMUNICATION_RULES_OMP_MODE = "blocked";
  try {
    const out = await sessionStopHandler(event(), ctx, {
      stateDir: dir,
      runCli: async () => blockVerdict,
      timeoutMs: 1_000,
    });
    assert.equal(out, undefined);
    assert.ok(readLog(dir, "warnings.log").includes("mode=warn-only"));
  } finally {
    delete process.env.COMMUNICATION_RULES_OMP_MODE;
  }
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

test("integration: real spawn + real core, temp HOME, no profile → undefined and the core's own warn line", async () => {
  const home = mkdtempSync(join(tmpdir(), "omp-adapter-home-"));
  const stateDir = join(home, ".claude", ".communication-rules-state"); // the core's own state dir under HOME
  const out = await withEnv(
    {
      HOME: home,
      COMMUNICATION_RULES_PLUGIN_ROOT: PLUGIN_ROOT,
      COMMUNICATION_RULES_PROFILE: undefined,
      COMMUNICATION_RULES_ENFORCE: undefined,
    },
    () =>
      sessionStopHandler(
        event({ session_file: join(home, "absent.jsonl"), last_assistant_message: { content: misordered } }),
        { cwd: home },
        { stateDir, timeoutMs: 10_000 },
      ),
  );
  assert.equal(out, undefined, "no profile: every rule warns, so no block reaches the host");
  assert.equal(readLog(stateDir, "errors.log"), "", "the spawn did not fail open");
  const warn = readLog(stateDir, "warnings.log");
  assert.match(warn, /rule=needs-you-first/, "the real core ran under the temp HOME and logged its own finding");
  assert.ok(!warn.includes("rule=omp-adapter"), "a warn verdict is the core's line, not an adapter downgrade");
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
