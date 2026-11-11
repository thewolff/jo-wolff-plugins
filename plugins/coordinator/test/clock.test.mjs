import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockLine, handle } from "../hooks/clock.mjs";

const AT = new Date("2026-11-11T22:07:41.123Z");

function env(config) {
  const root = mkdtempSync(join(tmpdir(), "coordinator-clock-"));
  const e = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  if (config !== undefined) {
    mkdirSync(join(e.XDG_CONFIG_HOME, "coordinator"), { recursive: true });
    writeFileSync(join(e.XDG_CONFIG_HOME, "coordinator", "config.json"), config);
  }
  const errors = () => {
    try {
      return readFileSync(join(e.XDG_STATE_HOME, "coordinator", "errors.log"), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { e, errors, release: () => rmSync(root, { recursive: true, force: true }) };
}

test("a fixed instant gives the exact line, local and UTC", () => {
  assert.equal(clockLine(AT, "America/Los_Angeles"), "The system clock reads 2026-11-11 14:07:41 PST (UTC-08:00), which is 2026-11-11T22:07:41Z, as of this prompt.");
  assert.equal(clockLine(AT, "UTC"), "The system clock reads 2026-11-11 22:07:41 UTC (UTC+00:00), which is 2026-11-11T22:07:41Z, as of this prompt.");
});

test("a half-hour zone crosses the date and carries its offset", () => {
  assert.match(clockLine(AT, "Asia/Kolkata"), /^The system clock reads 2026-11-12 03:37:41 \S+ \(UTC\+05:30\), which is 2026-11-11T22:07:41Z,/);
});

test("either side of a DST change reads its own offset", () => {
  assert.match(clockLine(new Date("2026-03-08T09:59:59Z"), "America/Los_Angeles"), /reads 2026-03-08 01:59:59 PST \(UTC-08:00\)/);
  assert.match(clockLine(new Date("2026-03-08T10:00:00Z"), "America/Los_Angeles"), /reads 2026-03-08 03:00:00 PDT \(UTC-07:00\)/);
});

test("an invalid date throws", () => {
  assert.throws(() => clockLine(new Date(Number.NaN)), /invalid date/);
});

test("handle: the line as UserPromptSubmit additionalContext", () => {
  const b = env();
  try {
    assert.deepEqual(handle({ hook_event_name: "UserPromptSubmit" }, { env: b.e, now: () => AT, timeZone: "UTC" }), {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: clockLine(AT, "UTC") },
    });
  } finally {
    b.release();
  }
});

test("handle: an invalid clock gives no line and one errors.log line", () => {
  const b = env();
  try {
    assert.equal(handle({ hook_event_name: "UserPromptSubmit" }, { env: b.e, now: () => new Date(Number.NaN) }), null);
    const lines = b.errors();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\S+ UserPromptSubmit clock: the system clock returned an invalid date$/);
  } finally {
    b.release();
  }
});

test("handle: clock false, off true, or another event is silent", () => {
  for (const config of ['{"clock": false}', '{"off": true}']) {
    const b = env(config);
    try {
      assert.equal(handle({ hook_event_name: "UserPromptSubmit" }, { env: b.e, now: () => AT }), null);
    } finally {
      b.release();
    }
  }
  const b = env();
  try {
    assert.equal(handle({ hook_event_name: "Stop" }, { env: b.e, now: () => AT }), null);
  } finally {
    b.release();
  }
});

test("handle: a malformed config keeps the clock on and names the file", () => {
  const b = env("nope");
  try {
    const out = handle({ hook_event_name: "UserPromptSubmit" }, { env: b.e, now: () => AT, timeZone: "UTC" });
    assert.equal(out.hookSpecificOutput.additionalContext, clockLine(AT, "UTC"));
    assert.match(out.systemMessage, /^coordinator clock: config ignored: .*is not JSON/);
  } finally {
    b.release();
  }
});
