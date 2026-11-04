// core.test.mjs — every branch of lib/core.mjs, in-process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  END,
  POINTER,
  START,
  WARN_LOAD,
  WARN_MARKERS,
  errorsLogPath,
  extractCore,
  failureReply,
  isOff,
  logError,
  stateDir,
  successReply,
} from "../lib/core.mjs";
import { CONTRACT_REL, PLUGIN_ROOT, sandbox, spanByLines } from "./helpers.mjs";

const doc = (body) => `# Title\nprose naming \`<!-- inject:start -->\` inline${START}${body}${END}\n\ntail\n`;

// ─── isOff ─────────────────────────────────────────────────────────────────────────────

test("isOff: `off` in any case turns the injection off", () => {
  for (const v of ["off", "OFF", "Off"]) assert.equal(isOff({ OUTPUT_TYPES_INJECT: v }), true, v);
});

test("isOff: unset, empty, or any other value leaves it on (malformed values do not silence it)", () => {
  for (const v of [undefined, "", "on", "0", "false", " off", "off ", "{bad json"]) {
    assert.equal(isOff(v === undefined ? {} : { OUTPUT_TYPES_INJECT: v }), false, String(v));
  }
});

// ─── extractCore ───────────────────────────────────────────────────────────────────────

test("extractCore: returns the trimmed span plus the pointer", () => {
  assert.equal(extractCore(doc("\n  line one\nline two  \n")), `line one\nline two${POINTER}`);
});

test("extractCore: inline mentions of the markers in prose do not match; only line-anchored markers do", () => {
  const md = "the `<!-- inject:start -->` marker and `<!-- inject:end -->` marker\n";
  assert.equal(extractCore(md), null);
});

test("extractCore: missing start marker → null", () => {
  assert.equal(extractCore(`no start here${END}\n`), null);
});

test("extractCore: missing end marker → null", () => {
  assert.equal(extractCore(`intro${START}body without an end\n`), null);
});

test("extractCore: end marker before start marker → null", () => {
  assert.equal(extractCore(`x${END}\ny${START}z\n`), null);
});

test("extractCore: an empty span yields the pointer alone", () => {
  assert.equal(extractCore(`x${START}${END}\n`), POINTER);
});

test("extractCore: non-string input is coerced, never thrown on", () => {
  assert.equal(extractCore(undefined), null);
  assert.equal(extractCore(42), null);
});

test("extractCore over the shipped contract equals the span between its marker lines, plus the pointer", () => {
  const md = readFileSync(join(PLUGIN_ROOT, CONTRACT_REL), "utf8");
  const core = extractCore(md);
  assert.ok(core, "the shipped contract has both markers");
  assert.equal(core, spanByLines(md) + POINTER);
  assert.ok(core.includes("CLAIM") && core.includes("CITE"), "the core names both labels");
});

// ─── stateDir / errorsLogPath ──────────────────────────────────────────────────────────

test("stateDir: XDG_STATE_HOME wins", () => {
  assert.equal(stateDir({ XDG_STATE_HOME: "/x/state", HOME: "/h" }), "/x/state/output-types");
  assert.equal(errorsLogPath({ XDG_STATE_HOME: "/x/state" }), "/x/state/output-types/errors.log");
});

test("stateDir: blank XDG_STATE_HOME falls back to $HOME/.local/state", () => {
  assert.equal(stateDir({ XDG_STATE_HOME: "  ", HOME: "/h" }), "/h/.local/state/output-types");
  assert.equal(stateDir({ HOME: "/h" }), "/h/.local/state/output-types");
});

// ─── logError ──────────────────────────────────────────────────────────────────────────

test("logError: appends one `<iso> <file> <reason>` line, whitespace collapsed, and returns the path", () => {
  const box = sandbox();
  const at = new Date("2026-11-03T12:00:00.000Z");
  const path = logError("hooks/x.mjs", "first\n  reason", box.env, at);
  assert.equal(path, box.errorsLog);
  logError("hooks/x.mjs", "second", box.env, at);
  assert.equal(box.readErrors(), "2026-11-03T12:00:00.000Z hooks/x.mjs first reason\n2026-11-03T12:00:00.000Z hooks/x.mjs second\n");
});

test("logError: an unwritable state dir returns null and never throws", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const box = sandbox();
  mkdirSync(box.env.XDG_STATE_HOME, { recursive: true });
  chmodSync(box.env.XDG_STATE_HOME, 0o500);
  try {
    assert.equal(logError("hooks/x.mjs", "why", box.env), null);
  } finally {
    chmodSync(box.env.XDG_STATE_HOME, 0o700);
  }
  assert.equal(box.readErrors(), "");
});

// ─── replies ───────────────────────────────────────────────────────────────────────────

test("successReply: SessionStart additionalContext, nothing else", () => {
  assert.deepEqual(successReply("core"), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "core" } });
});

test("failureReply with a log path: one warning line naming the log, to the person and the model", () => {
  const r = failureReply(WARN_MARKERS, "markers gone", "/s/errors.log");
  const line = `${WARN_MARKERS} Reason logged to /s/errors.log.`;
  assert.deepEqual(r, { systemMessage: line, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line } });
  assert.ok(!line.includes("\n"));
});

test("failureReply without a log path: the warning carries the reason itself, on one line", () => {
  const r = failureReply(WARN_LOAD, "cannot read\n /x: EACCES", null);
  assert.equal(r.systemMessage, `${WARN_LOAD} Reason: cannot read /x: EACCES`);
  assert.equal(r.hookSpecificOutput.additionalContext, r.systemMessage);
});
