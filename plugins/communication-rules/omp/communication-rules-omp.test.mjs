// communication-rules-omp.test.mjs — node --test
//
// Hermetic by construction: every handler test injects its own temp stateDir and a fake
// runCli, so the real HOME, the real plugin state dir, and the real CLI are never touched.
// The default runCli is Bun-only (it lives for the omp host), so its failure semantics —
// throw on crash, throw on non-zero exit, throw on unparseable stdout — are reproduced by
// the fakes; what these tests prove is the handler's contract around them.
//
// Importing the .ts subject directly is itself a test: node v24.13 strips the erasable types
// and loads the module without Bun.
//
// Run: node --test plugins/communication-rules/omp/

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";



import communicationRulesOmp, {
  assistantText,
  buildStopPayload,
  makeFailOpenCounter,
  sessionStopHandler,
} from "./communication-rules-omp.ts";

// The env flip is read per invocation, so scrubbing it here (after the hoisted imports) is
// enough to keep the outer environment from leaking into every test below.
delete process.env.COMMUNICATION_RULES_OMP_MODE;

const mkstate = () => mkdtempSync(join(tmpdir(), "omp-adapter-state-"));
const counterFile = (dir) => join(dir, "omp-adapter-failures.json");
const readCount = (dir) => JSON.parse(readFileSync(counterFile(dir), "utf8")).count;

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
  assert.ok(!existsSync(counterFile(dir)), "short-circuit is not a failure; counter untouched");
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
  assert.ok(!existsSync(counterFile(dir)), "counter untouched on the warn path");
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
  assert.ok(!existsSync(counterFile(dir)));
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
    assert.ok(!existsSync(counterFile(dir)));
  }
});

// ─── failure paths: counter + one errors.log line + undefined ──────────────────────────

const assertFailOpen = (dir, out, fragment) => {
  assert.equal(out, undefined, "every failure path returns undefined");
  assert.equal(readCount(dir), 1, "counter incremented exactly once");
  const errors = readLog(dir, "errors.log");
  assert.equal(lines(errors).length, 1, "exactly one errors.log line");
  assert.match(errors, /omp-adapter fail-open: /);
  assert.ok(errors.includes(fragment), `the error detail rides the line: expected "${fragment}"`);
};

test("crashing CLI → undefined, counter 1, one errors.log line", async () => {
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

test("junk stdout → undefined, counter 1, one errors.log line", async () => {
  const dir = mkstate();
  // the default spawn throws on unparseable stdout (deliberately, unlike the live
  // runCommand); the fake reproduces that throw
  const out = await sessionStopHandler(event(), ctx, {
    stateDir: dir,
    runCli: async () => {
      throw new Error("omp-adapter: CLI stdout unparseable: <html>");
    },
    timeoutMs: 1_000,
  });
  assertFailOpen(dir, out, "unparseable");
});

test("timeout → undefined, counter 1, one errors.log line", async () => {
  const dir = mkstate();
  const out = await sessionStopHandler(event(), ctx, {
    stateDir: dir,
    runCli: () => new Promise(() => {}), // never resolves
    timeoutMs: 20,
  });
  assertFailOpen(dir, out, "timed out after 20ms");
});

// ─── the fail-open counter ─────────────────────────────────────────────────────────────

test("counter persists across makeFailOpenCounter instances", () => {
  const dir = mkstate();
  const a = makeFailOpenCounter(dir);
  assert.equal(a.record(new Error("one")), 1);
  const b = makeFailOpenCounter(dir);
  assert.equal(b.record(new Error("two")), 2);
  assert.equal(a.record(new Error("three")), 3, "a stale instance still sees fresh state");
  const state = JSON.parse(readFileSync(counterFile(dir), "utf8"));
  assert.equal(state.count, 3);
  assert.equal(state.lastError, "Error: three");
  assert.ok(typeof state.at === "string" && state.at, "an ISO timestamp is recorded");
});

test("corrupt counter file resets to 0 and recovers on the next record", () => {
  const dir = mkstate();
  writeFileSync(counterFile(dir), "{not json", "utf8");
  assert.equal(makeFailOpenCounter(dir).record(new Error("x")), 1, "corrupt reads as 0, then increments");
  assert.equal(readCount(dir), 1, "the file is valid JSON again after the record");
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
