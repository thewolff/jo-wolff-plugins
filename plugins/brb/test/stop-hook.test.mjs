// test/stop-hook.test.mjs — hooks/stop.mjs as a spawned process with fixture stdin and a fixture
// transcript: home passthrough; away + asks → digest grows + block; on fire → surfaced, not in
// the digest, cap noted; idle line → no block; stop_hook_active guard; two tool-less stops → no
// block (transcript counting, and the message-compare fallback with no transcript); malformed
// input → exit 0, one errors.log line, no block. Plus the pure helpers of lib/stop-core.mjs.
// node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appleScript, countToolUses, osc9 } from "../lib/stop-core.mjs";
import { keepWorkingReason } from "../lib/text.mjs";
import { box, promptInput, row, runHook, stopInput } from "./helpers.mjs";

const goAway = (b, note = "") => runHook(b, "user-prompt-submit", promptInput(b, note ? `brb ${note}` : "brb"));
const awayRecord = (b) => JSON.parse(b.read(join(b.stateDir("s1"), "away.json")));
const digest = (b) => (existsSync(join(b.stateDir("s1"), "digest.md")) ? b.read(join(b.stateDir("s1"), "digest.md")) : "");

const ASKS = "Wired the cache.\n\n## Needs you\n- Pick Redis or in-process for the cache\n- Approve the schema change\n\nClosing ask: Redis or in-process?";

test("home: passthrough, nothing printed, nothing written", () => {
  const b = box();
  try {
    b.writeTranscript([row.user(), row.tool()]);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: ASKS }));
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim() === "" || r.stdout.trim() === "{}", r.stdout);
    assert.ok(!existsSync(b.stateDir("s1")));
  } finally {
    b.release();
  }
});

test("away + asks: the digest grows by the held lines with the closing ask, the turn is blocked, fires are absent", () => {
  const b = box();
  try {
    goAway(b);
    b.writeTranscript([row.user(), row.tool(), row.text()]);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: ASKS }));
    assert.equal(r.status, 0);
    assert.deepEqual(r.json, { decision: "block", reason: keepWorkingReason(2) });
    assert.match(digest(b), /^## \d{4}-.*\n- Pick Redis or in-process for the cache\n- Approve the schema change\nclosing ask: Redis or in-process\?\n\n$/);
    assert.equal(awayRecord(b).held, 2);
    // A later message with one new ask and one repeat: only the new one lands.
    b.writeTranscript([row.user(), row.tool(), row.text(), row.tool(), row.text()]);
    const r2 = runHook(b, "stop", stopInput(b, { stop_hook_active: true, last_assistant_message: "## Needs you\n- Approve the schema change\n- Name the feature flag" }));
    assert.deepEqual(r2.json, { decision: "block", reason: keepWorkingReason(3) });
    assert.match(digest(b), /- Name the feature flag\n\n$/);
    assert.equal((digest(b).match(/Approve the schema change/g) ?? []).length, 1, "a restated ask is held once");
    assert.equal(awayRecord(b).held, 3);
  } finally {
    b.release();
  }
});

test("on fire: surfaces at once (systemMessage + OSC 9), is not written to the digest, still blocks", () => {
  const b = box();
  try {
    goAway(b);
    b.writeTranscript([row.user(), row.tool()]);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: "Pushed.\n\n## Needs you\n- **on fire:** main is red after my push\n- Pick a cache" }));
    assert.equal(r.status, 0);
    assert.equal(r.json.decision, "block");
    assert.equal(r.json.systemMessage, "brb on fire: on fire: main is red after my push");
    assert.equal(r.json.terminalSequence, "\u001b]9;brb on fire: on fire: main is red after my push\u0007");
    assert.equal(digest(b), digest(b).replace(/on fire/g, "on fire"), "sanity");
    assert.ok(!digest(b).includes("main is red"), "the fire is not in the digest");
    assert.ok(digest(b).includes("- Pick a cache"));
    assert.equal(awayRecord(b).onFire, 1);
    assert.equal(awayRecord(b).held, 1);
    // The same fire again on a continuation with nothing new: silent release (guard), no second alert.
    const again = runHook(b, "stop", stopInput(b, { stop_hook_active: true, last_assistant_message: "## Needs you\n- on fire: main is red after my push" }));
    assert.equal(again.stdout.trim(), "", again.stdout);
  } finally {
    b.release();
  }
});

test("on fire under BRB_HARNESS=omp: no terminalSequence (the adapter notifies)", () => {
  const b = box();
  try {
    goAway(b);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: "on fire: data loss in the migration" }), { env: { BRB_HARNESS: "omp" } });
    assert.equal(r.json.systemMessage, "brb on fire: on fire: data loss in the migration");
    assert.equal(r.json.terminalSequence, undefined);
    assert.equal(r.json.decision, "block");
  } finally {
    b.release();
  }
});

test("on-fire cap: past onFireCap the line still surfaces and the message says the cap is passed", () => {
  const b = box();
  try {
    mkdirSync(join(b.env.XDG_CONFIG_HOME, "brb"), { recursive: true });
    writeFileSync(join(b.env.XDG_CONFIG_HOME, "brb", "config.json"), JSON.stringify({ onFireCap: 1 }));
    goAway(b);
    b.writeTranscript([row.user(), row.tool()]);
    const first = runHook(b, "stop", stopInput(b, { last_assistant_message: "on fire: main is red" }));
    assert.equal(first.json.systemMessage, "brb on fire: on fire: main is red");
    b.writeTranscript([row.user(), row.tool(), row.tool()]);
    const second = runHook(b, "stop", stopInput(b, { last_assistant_message: "on fire: spend at 95% of the ceiling" }));
    assert.equal(second.json.systemMessage, "brb on fire: on fire: spend at 95% of the ceiling (on-fire cap of 1 passed this hold: 2 so far; check the tagging)");
    assert.ok(second.json.terminalSequence);
    assert.equal(second.json.decision, "block");
  } finally {
    b.release();
  }
});

test("idle line: the turn ends with a line for the person; asks in the same message are still held", () => {
  const b = box();
  try {
    goAway(b, "lunch");
    b.writeTranscript([row.user(), row.tool()]);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- Pick a cache\n\nidle: every open item waits on the cache choice" }));
    assert.equal(r.status, 0);
    assert.equal(r.json.decision, undefined, r.stdout);
    assert.equal(r.json.systemMessage, "brb: the agent is idle (every open item waits on the cache choice); 1 held; type `back` to read them.");
    assert.ok(digest(b).includes("- Pick a cache"));
    assert.ok(existsSync(join(b.stateDir("s1"), "away.json")), "idle does not end the hold");
  } finally {
    b.release();
  }
});

test("stop_hook_active guard: a continuation that brings no new Needs-you is let through silently", () => {
  const b = box();
  try {
    goAway(b);
    b.writeTranscript([row.user(), row.tool()]);
    const first = runHook(b, "stop", stopInput(b, { last_assistant_message: ASKS }));
    assert.equal(first.json.decision, "block");
    const second = runHook(b, "stop", stopInput(b, { stop_hook_active: true, last_assistant_message: "Carried on; the flag is named and the tests pass." }));
    assert.equal(second.status, 0);
    assert.equal(second.stdout.trim(), "", second.stdout);
    // Not a continuation (stop_hook_active false) with nothing new: still blocked, the agent is to keep working.
    b.writeTranscript([row.user(), row.tool(), row.tool()]);
    const third = runHook(b, "stop", stopInput(b, { stop_hook_active: false, last_assistant_message: "Carried on; the flag is named and the tests pass." }));
    assert.equal(third.json.decision, "block");
  } finally {
    b.release();
  }
});

test("two tool-less stops (transcript counting): the second stop with no tool_use since the previous one ends the turn", () => {
  const b = box();
  try {
    goAway(b);
    b.writeTranscript([row.user(), row.tool(), row.text()]);
    const s1 = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- a" }));
    assert.equal(s1.json.decision, "block");
    assert.equal(awayRecord(b).toolLessStops, 0);
    assert.equal(awayRecord(b).lastStop.line, 3);
    // One more assistant text row, no tool_use: tool-less stop number one.
    b.writeTranscript([row.user(), row.tool(), row.text(), row.text("## Needs you\n- b")]);
    const s2 = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- b" }));
    assert.equal(s2.json.decision, "block", "one tool-less stop still blocks");
    assert.equal(awayRecord(b).toolLessStops, 1);
    // Again, no tool_use: tool-less stop number two → release.
    b.writeTranscript([row.user(), row.tool(), row.text(), row.text("## Needs you\n- b"), row.text("## Needs you\n- c")]);
    const s3 = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- c" }));
    assert.equal(s3.status, 0);
    assert.equal(s3.json.decision, undefined, s3.stdout);
    assert.equal(s3.json.systemMessage, "brb: 2 stops with no tool calls between them; letting the agent stop. 3 held; type `back` to read them.");
    assert.equal(awayRecord(b).toolLessStops, 2);
    // A tool call resets the count.
    b.writeTranscript([row.user(), row.tool(), row.text(), row.text(), row.text(), row.tool(), row.text()]);
    const s4 = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- d" }));
    assert.equal(s4.json.decision, "block");
    assert.equal(awayRecord(b).toolLessStops, 0);
  } finally {
    b.release();
  }
});

test("no readable transcript: the fallback compares the message with the previous stop's", () => {
  const b = box();
  try {
    goAway(b);
    const input = (msg) => stopInput(b, { transcript_path: join(b.root, "missing.jsonl"), last_assistant_message: msg });
    assert.equal(runHook(b, "stop", input("## Needs you\n- a")).json.decision, "block");
    assert.equal(awayRecord(b).lastStop.transcript, false);
    assert.equal(runHook(b, "stop", input("## Needs you\n- a")).json.decision, "block", "first repeat: one tool-less stop");
    assert.equal(awayRecord(b).toolLessStops, 1);
    const third = runHook(b, "stop", input("## Needs you\n- a"));
    assert.equal(third.json.decision, undefined, third.stdout);
    assert.match(third.json.systemMessage, /^brb: 2 stops with no tool calls between them/);
    // A changed message resets it.
    assert.equal(runHook(b, "stop", input("## Needs you\n- b")).json.decision, "block");
    assert.equal(awayRecord(b).toolLessStops, 0);
  } finally {
    b.release();
  }
});

test("idleStops from config: 1 means the first tool-less stop releases", () => {
  const b = box();
  try {
    mkdirSync(join(b.env.XDG_CONFIG_HOME, "brb"), { recursive: true });
    writeFileSync(join(b.env.XDG_CONFIG_HOME, "brb", "config.json"), JSON.stringify({ idleStops: 1 }));
    goAway(b);
    b.writeTranscript([row.user(), row.tool()]);
    assert.equal(runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- a" })).json.decision, "block");
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- b" }));
    assert.equal(r.json.decision, undefined, r.stdout);
    assert.match(r.json.systemMessage, /^brb: 1 stops with no tool calls/);
  } finally {
    b.release();
  }
});

test("malformed input: exit 0, no block, one errors.log line and a systemMessage; a missing message while away is a plain block", () => {
  const b = box();
  try {
    const bad = runHook(b, "stop", "{not json");
    assert.equal(bad.status, 0);
    assert.equal(bad.json.decision, undefined);
    assert.match(bad.json.systemMessage, /^brb Stop failed open: stdin not JSON/);
    assert.equal(b.read(b.errorsLog).trim().split("\n").length, 1);
    assert.match(b.read(b.errorsLog), / Stop stdin not JSON/);
    const empty = runHook(b, "stop", "");
    assert.equal(empty.status, 0);
    assert.equal(empty.stdout.trim(), "", "empty stdin is {} → home → nothing");
    goAway(b);
    const noMessage = runHook(b, "stop", { session_id: "s1" });
    assert.equal(noMessage.json.decision, "block", "away with no message text: nothing to hold, keep working");
    assert.equal(noMessage.json.reason, keepWorkingReason(0));
  } finally {
    b.release();
  }
});

test("helpers: countToolUses counts assistant tool_use blocks from a line; osc9 and appleScript escape", () => {
  const b = box();
  try {
    assert.equal(countToolUses(join(b.root, "nope.jsonl")), null);
    assert.equal(countToolUses(""), null);
    b.writeTranscript([row.user(), row.tool(), { type: "assistant", message: { content: [{ type: "tool_use" }, { type: "tool_use" }] } }, row.text()]);
    assert.deepEqual(countToolUses(b.transcript), { count: 3, lines: 4 });
    assert.deepEqual(countToolUses(b.transcript, 2), { count: 2, lines: 4 });
    assert.deepEqual(countToolUses(b.transcript, 3), { count: 0, lines: 4 });
    assert.deepEqual(countToolUses(b.transcript, 99), { count: 3, lines: 4 }, "a marker past the end (a rotated file) counts from the top");
    writeFileSync(b.transcript, "garbage\n" + JSON.stringify(row.tool()) + "\n");
    assert.deepEqual(countToolUses(b.transcript), { count: 1, lines: 2 });
    assert.equal(osc9("a\u001bb\nc"), "\u001b]9;a b c\u0007");
    assert.equal(osc9("x".repeat(300)).length, 200 + "\u001b]9;".length + 1, "text capped at 200");
    assert.equal(appleScript('t "q"', 'say "hi"\\now\nnext'), 'display notification "say \\"hi\\"\\\\now next" with title "t \\"q\\""');
  } finally {
    b.release();
  }
});
