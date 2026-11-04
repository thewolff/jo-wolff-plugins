// hook.test.mjs — hooks/output-types-inject.mjs as a spawned process, fed what Claude Code sends.
// Every case: exit 0 inside the 5-second budget, and either the core or one warning line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POINTER, WARN_LOAD, WARN_MARKERS } from "../lib/core.mjs";
import { BUDGET_MS, CONTRACT_REL, PLUGIN_ROOT, runHook, runHookStdinOpen, sandbox, spanByLines } from "./helpers.mjs";

const SHIPPED_CORE = spanByLines(readFileSync(join(PLUGIN_ROOT, CONTRACT_REL), "utf8")) + POINTER;
const skipRoot = process.getuid?.() === 0 ? "root ignores modes" : false;

function assertCore(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: SHIPPED_CORE } });
  assert.ok(r.ms < BUDGET_MS, `took ${r.ms} ms`);
}

/** A fault reply: exit 0, one warning line to the person and the model, nothing that blocks. */
function assertWarning(r, warning) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(r.json.systemMessage, r.json.hookSpecificOutput.additionalContext);
  assert.ok(r.json.systemMessage.startsWith(warning), r.json.systemMessage);
  assert.ok(!r.json.systemMessage.includes("\n"), "one line");
  assert.equal(r.json.decision, undefined, "never blocks");
  assert.equal(r.json.continue, undefined, "never stops the session");
  assert.ok(r.ms < BUDGET_MS, `took ${r.ms} ms`);
}

function oneErrorLine(box, ...needles) {
  const lines = box.readErrors().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, box.readErrors());
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\S+Z hooks\/output-types-inject\.mjs /);
  for (const n of needles) assert.ok(lines[0].includes(n), `${n} in ${lines[0]}`);
  return lines[0];
}

// ─── the event payload ─────────────────────────────────────────────────────────────────

for (const source of ["startup", "resume", "clear", "compact"]) {
  test(`SessionStart source=${source}: replies with the contract's core as additionalContext; no errors.log`, () => {
    const box = sandbox();
    assertCore(runHook(box, { input: JSON.stringify({ session_id: "s1", cwd: box.work, source }) }));
    assert.equal(box.readErrors(), "");
  });
}

// ─── fault inputs: each exits 0 and allows ─────────────────────────────────────────────

test("empty stdin → the core (the payload is unused)", () => {
  assertCore(runHook(sandbox(), { input: "" }));
});

test("malformed JSON on stdin → the core", () => {
  assertCore(runHook(sandbox(), { input: "{not json" }));
});

// The hook promises to stop reading after 1 s; 1.5 s leaves room for a slow scheduler while still
// failing if the grace period grows, which the 5 s kill budget alone would not catch.
const STDIN_DEADLINE_MS = 1500;

test("stdin left open by the caller → the core within the 1 s grace (was a hang before 0.2.1)", async () => {
  const r = await runHookStdinOpen(sandbox());
  assert.equal(r.timedOut, false, "hook hung on an open stdin");
  assertCore(r);
  assert.ok(r.ms < STDIN_DEADLINE_MS, `took ${r.ms} ms with stdin open`);
});

test("a partial payload, then stdin left open → the same core within the grace (the payload is unused)", async () => {
  for (const source of ["startup", "resume"]) {
    const r = await runHookStdinOpen(sandbox(), { initial: `{"session_id":"s1","source":"${source}"` });
    assert.equal(r.timedOut, false);
    assertCore(r);
    assert.ok(r.ms < STDIN_DEADLINE_MS, `took ${r.ms} ms`);
  }
});

test("unwritable state dir, healthy contract → the core, nothing logged", { skip: skipRoot }, () => {
  const box = sandbox();
  mkdirSync(box.env.XDG_STATE_HOME, { recursive: true });
  chmodSync(box.env.XDG_STATE_HOME, 0o500);
  try {
    assertCore(runHook(box));
  } finally {
    chmodSync(box.env.XDG_STATE_HOME, 0o700);
  }
});

test("config: OUTPUT_TYPES_INJECT=off in any case → exit 0, no output", () => {
  for (const value of ["off", "OFF", "Off"]) {
    const box = sandbox();
    const r = runHook(box, { env: { OUTPUT_TYPES_INJECT: value } });
    assert.equal(r.status, 0, value);
    assert.equal(r.stdout, "", value);
    assert.equal(box.readErrors(), "");
  }
});

test("config: a malformed or near-miss OUTPUT_TYPES_INJECT value → treated as on; the core", () => {
  for (const value of ['{"off":', " off", "off ", "0", "false", ""]) {
    assertCore(runHook(sandbox(), { env: { OUTPUT_TYPES_INJECT: value } }));
  }
});

test("config: off with the lib broken or missing → still no output, nothing logged", () => {
  for (const breakLib of [(p) => writeFileSync(join(p, "lib", "core.mjs"), "throw new Error('boom');\n"), (p) => rmSync(join(p, "lib"), { recursive: true })]) {
    const box = sandbox();
    const plugin = box.copyPlugin();
    breakLib(plugin);
    const r = runHook(box, { pluginRoot: plugin, env: { OUTPUT_TYPES_INJECT: "off" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    assert.equal(box.readErrors(), "");
  }
});

test("contract file missing → exit 0, one warning, one errors.log line naming the file and the reason", () => {
  const box = sandbox();
  const plugin = box.copyPlugin();
  rmSync(join(plugin, CONTRACT_REL));
  const r = runHook(box, { pluginRoot: plugin });
  assertWarning(r, WARN_LOAD);
  assert.ok(r.json.systemMessage.includes(box.errorsLog), "the warning names where the reason went");
  oneErrorLine(box, "cannot read", join(plugin, CONTRACT_REL), "ENOENT");
});

test("contract file malformed (markers gone) → exit 0, one warning, one errors.log line", () => {
  const box = sandbox();
  const plugin = box.copyPlugin();
  const path = join(plugin, CONTRACT_REL);
  writeFileSync(path, readFileSync(path, "utf8").replace("\n<!-- inject:end -->", "\n"));
  const r = runHook(box, { pluginRoot: plugin });
  assertWarning(r, WARN_MARKERS);
  oneErrorLine(box, "inject markers missing", path);
});

test("contract file unreadable → exit 0, one warning, one errors.log line with EACCES", { skip: skipRoot }, () => {
  const box = sandbox();
  const plugin = box.copyPlugin();
  const path = join(plugin, CONTRACT_REL);
  chmodSync(path, 0o000);
  const r = runHook(box, { pluginRoot: plugin });
  chmodSync(path, 0o600);
  assertWarning(r, WARN_LOAD);
  oneErrorLine(box, "EACCES", path);
});

test("fault + unwritable state dir → exit 0, the warning carries the reason itself", { skip: skipRoot }, () => {
  const box = sandbox();
  const plugin = box.copyPlugin();
  rmSync(join(plugin, CONTRACT_REL));
  mkdirSync(box.env.XDG_STATE_HOME, { recursive: true });
  chmodSync(box.env.XDG_STATE_HOME, 0o500);
  try {
    const r = runHook(box, { pluginRoot: plugin });
    assertWarning(r, WARN_LOAD);
    assert.ok(r.json.systemMessage.includes("Reason: cannot read"), r.json.systemMessage);
    assert.ok(r.json.systemMessage.includes("ENOENT"));
  } finally {
    chmodSync(box.env.XDG_STATE_HOME, 0o700);
  }
  assert.equal(box.readErrors(), "");
});

test("the hook's own module throws on load (lib broken) → exit 0, one warning, one errors.log line", () => {
  const box = sandbox();
  const plugin = box.copyPlugin();
  writeFileSync(join(plugin, "lib", "core.mjs"), "throw new Error('boom from a broken install');\n");
  const r = runHook(box, { pluginRoot: plugin });
  assertWarning(r, WARN_LOAD);
  oneErrorLine(box, "cannot load lib/core.mjs", "boom from a broken install");
});

test("lib missing entirely → exit 0, one warning, one errors.log line", () => {
  const box = sandbox();
  const plugin = box.copyPlugin();
  rmSync(join(plugin, "lib"), { recursive: true });
  const r = runHook(box, { pluginRoot: plugin });
  assertWarning(r, WARN_LOAD);
  oneErrorLine(box, "cannot load lib/core.mjs");
});

test("lib export throws mid-run → exit 0, one warning, one errors.log line (the catch-all path)", () => {
  const box = sandbox();
  const plugin = box.copyPlugin();
  const path = join(plugin, "lib", "core.mjs");
  writeFileSync(path, readFileSync(path, "utf8").replace("export function extractCore(md) {", "export function extractCore(md) {\n  throw new Error('extract exploded');"));
  const r = runHook(box, { pluginRoot: plugin });
  assertWarning(r, WARN_LOAD);
  oneErrorLine(box, "unexpected: extract exploded");
});

// A lib that imports cleanly but whose reporting exports are missing or throw: the reply must come
// from the hook's independent fallback, never from the broken lib, and never be silent.
const INCOMPLETE_LIBS = {
  "exports nothing": "export {};\n",
  "lacks failureReply and logError": 'export const WARN_LOAD = "w"; export const WARN_MARKERS = "m";\nexport const extractCore = () => null;\nexport const successReply = (t) => ({ t });\n',
  "logError throws": 'export const WARN_LOAD = "w"; export const WARN_MARKERS = "m";\nexport const extractCore = () => null;\nexport const successReply = (t) => ({ t });\nexport const failureReply = () => ({});\nexport const logError = () => { throw new Error("logger exploded"); };\n',
  "failureReply throws": 'export const WARN_LOAD = "w"; export const WARN_MARKERS = "m";\nexport const extractCore = () => null;\nexport const successReply = (t) => ({ t });\nexport const logError = () => null;\nexport const failureReply = () => { throw new Error("reply exploded"); };\n',
};

for (const [name, source] of Object.entries(INCOMPLETE_LIBS)) {
  test(`lib imports but ${name} → exit 0, the fallback warning, one errors.log line`, () => {
    const box = sandbox();
    const plugin = box.copyPlugin();
    writeFileSync(join(plugin, "lib", "core.mjs"), source);
    const r = runHook(box, { pluginRoot: plugin });
    assertWarning(r, WARN_LOAD);
    assert.ok(r.json.systemMessage.includes(box.errorsLog), r.json.systemMessage);
    oneErrorLine(box, "unexpected:");
  });
}
