// test/stop-hook.test.mjs — hooks/stop.mjs as a spawned process with fixture stdin and a fixture
// transcript: home passthrough; away + asks → digest grows + keep working (additionalContext on
// Claude Code, decision block under BRB_HARNESS=omp); on fire → surfaced, not in the digest, cap
// noted, re-notified on a later turn; idle line → no keep-working answer; stop_hook_active guard
// (tool-less only); two tool-less stops → released (transcript counting in both transcript
// shapes, and with no transcript); an unwritable state dir still surfaces the fire; a `back`
// mid-stop is not undone; malformed input → exit 0, one errors.log line, no block. Plus the pure
// helpers of lib/stop-core.mjs. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appleScript, countToolUses, decideStop, osc9 } from "../lib/stop-core.mjs";
import { clearAway, freshAway, writeAway } from "../lib/state.mjs";
import { keepWorkingReason } from "../lib/text.mjs";
import { box, promptInput, row, runHook, stopInput } from "./helpers.mjs";

const goAway = (b, note = "") => runHook(b, "user-prompt-submit", promptInput(b, note ? `brb ${note}` : "brb"));
const awayRecord = (b) => JSON.parse(b.read(join(b.stateDir("s1"), "away.json")));
const digest = (b) => (existsSync(join(b.stateDir("s1"), "digest.md")) ? b.read(join(b.stateDir("s1"), "digest.md")) : "");
/** The Claude Code keep-working answer: Stop hook feedback, not a block. */
const keepWorking = (held) => ({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: keepWorkingReason(held) } });
const kept = (r) => r?.hookSpecificOutput?.additionalContext !== undefined || r?.decision === "block";

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

test("away + asks: the digest grows by the held lines with the closing ask, the agent is kept working, fires are absent", () => {
  const b = box();
  try {
    goAway(b);
    b.writeTranscript([row.user(), row.tool(), row.text()]);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: ASKS }));
    assert.equal(r.status, 0);
    assert.deepEqual(r.json, keepWorking(2));
    assert.match(digest(b), /^## \d{4}-.*\n- Pick Redis or in-process for the cache\n- Approve the schema change\nclosing ask: Redis or in-process\?\n\n$/);
    assert.equal(awayRecord(b).held, 2);
    // A later message with one new ask and one repeat: only the new one lands.
    b.writeTranscript([row.user(), row.tool(), row.text(), row.tool(), row.text()]);
    const r2 = runHook(b, "stop", stopInput(b, { stop_hook_active: true, last_assistant_message: "## Needs you\n- Approve the schema change\n- Name the feature flag" }));
    assert.deepEqual(r2.json, keepWorking(3));
    assert.match(digest(b), /- Name the feature flag\n\n$/);
    assert.equal((digest(b).match(/Approve the schema change/g) ?? []).length, 1, "a restated ask is held once");
    assert.equal(awayRecord(b).held, 3);
  } finally {
    b.release();
  }
});

test("under BRB_HARNESS=omp the keep-working answer is decision block (OMP's session_stop shape)", () => {
  const b = box();
  try {
    goAway(b);
    b.writeTranscript([row.user(), row.tool()]);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: ASKS }), { env: { BRB_HARNESS: "omp" } });
    assert.deepEqual(r.json, { decision: "block", reason: keepWorkingReason(2) });
  } finally {
    b.release();
  }
});

test("on fire: surfaces at once (systemMessage + OSC 9) without the marker twice, is not written to the digest, still keeps working", () => {
  const b = box();
  try {
    goAway(b);
    b.writeTranscript([row.user(), row.tool()]);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: "Pushed.\n\n## Needs you\n- **on fire:** main is red after my push\n- Pick a cache" }));
    assert.equal(r.status, 0);
    assert.deepEqual(r.json.hookSpecificOutput, keepWorking(1).hookSpecificOutput);
    assert.equal(r.json.decision, undefined);
    assert.equal(r.json.systemMessage, "brb on fire: main is red after my push");
    assert.equal(r.json.terminalSequence, "\u001b]9;brb on fire: main is red after my push\u0007");
    assert.ok(!digest(b).includes("main is red"), "the fire is not in the digest");
    assert.ok(digest(b).includes("- Pick a cache"));
    assert.equal(awayRecord(b).onFire, 1);
    assert.equal(awayRecord(b).held, 1);
    // The same fire restated on a tool-less continuation with nothing new: silent release (guard), no second alert.
    const again = runHook(b, "stop", stopInput(b, { stop_hook_active: true, last_assistant_message: "## Needs you\n- on fire: main is red after my push" }));
    assert.equal(again.stdout.trim(), "", again.stdout);
  } finally {
    b.release();
  }
});

test("on fire that recurs on a later turn (stop_hook_active false) notifies again", () => {
  const b = box();
  try {
    goAway(b);
    b.writeTranscript([row.user(), row.tool()]);
    assert.equal(runHook(b, "stop", stopInput(b, { last_assistant_message: "on fire: main is red" })).json.systemMessage, "brb on fire: main is red");
    b.writeTranscript([row.user(), row.tool(), row.user(), row.tool()]);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: "Fixed main earlier; it broke again after the 2pm merge.\n\non fire: main is red" }));
    assert.equal(r.json.systemMessage, "brb on fire: main is red");
    assert.equal(awayRecord(b).onFire, 2);
  } finally {
    b.release();
  }
});

test("on fire under BRB_HARNESS=omp: no terminalSequence (the adapter notifies)", () => {
  const b = box();
  try {
    goAway(b);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: "on fire: data loss in the migration" }), { env: { BRB_HARNESS: "omp" } });
    assert.equal(r.json.systemMessage, "brb on fire: data loss in the migration");
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
    assert.equal(first.json.systemMessage, "brb on fire: main is red");
    b.writeTranscript([row.user(), row.tool(), row.tool()]);
    const second = runHook(b, "stop", stopInput(b, { last_assistant_message: "on fire: spend at 95% of the ceiling" }));
    assert.equal(second.json.systemMessage, "brb on fire: spend at 95% of the ceiling (on-fire cap of 1 passed this hold: 2 so far; check the tagging)");
    assert.ok(second.json.terminalSequence);
    assert.ok(kept(second.json));
  } finally {
    b.release();
  }
});

test("idle line: the turn ends with a line for the person; asks in the same message are still held; a closing ask may follow it", () => {
  const b = box();
  try {
    goAway(b, "lunch");
    b.writeTranscript([row.user(), row.tool()]);
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- Pick a cache\n\nidle: every open item waits on the cache choice\n\nClosing ask: Redis or in-process?" }));
    assert.equal(r.status, 0);
    assert.ok(!kept(r.json), r.stdout);
    assert.equal(r.json.systemMessage, "brb: the agent is idle (every open item waits on the cache choice); 1 held; type `back` to read them.");
    assert.ok(digest(b).includes("- Pick a cache"));
    assert.ok(existsSync(join(b.stateDir("s1"), "away.json")), "idle does not end the hold");
  } finally {
    b.release();
  }
});

test("stop_hook_active guard: a tool-less continuation with nothing new is let through silently; a working one is kept working", () => {
  const b = box();
  try {
    goAway(b);
    b.writeTranscript([row.user(), row.tool()]);
    const first = runHook(b, "stop", stopInput(b, { last_assistant_message: ASKS }));
    assert.ok(kept(first.json));
    // Tools ran since the last stop, nothing new: the agent is working, keep it working.
    b.writeTranscript([row.user(), row.tool(), row.tool(), row.tool(), row.tool()]);
    const working = runHook(b, "stop", stopInput(b, { stop_hook_active: true, last_assistant_message: "Finished item 2: migrated the config loader, tests green." }));
    assert.deepEqual(working.json, keepWorking(2));
    // No tool since, nothing new, a continuation: release silently.
    const idle = runHook(b, "stop", stopInput(b, { stop_hook_active: true, last_assistant_message: "Carried on; the flag is named and the tests pass." }));
    assert.equal(idle.status, 0);
    assert.equal(idle.stdout.trim(), "", idle.stdout);
    // Not a continuation (stop_hook_active false) with nothing new: still kept working.
    b.writeTranscript([row.user(), row.tool(), row.tool(), row.tool(), row.tool(), row.tool()]);
    const third = runHook(b, "stop", stopInput(b, { stop_hook_active: false, last_assistant_message: "Carried on; the flag is named and the tests pass." }));
    assert.ok(kept(third.json));
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
    assert.ok(kept(s1.json));
    assert.equal(awayRecord(b).toolLessStops, 0);
    assert.equal(awayRecord(b).lastStop.line, 3);
    // One more assistant text row, no tool_use: tool-less stop number one.
    b.writeTranscript([row.user(), row.tool(), row.text(), row.text("## Needs you\n- b")]);
    const s2 = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- b" }));
    assert.ok(kept(s2.json), "one tool-less stop still keeps working");
    assert.equal(awayRecord(b).toolLessStops, 1);
    // Again, no tool_use: tool-less stop number two → release.
    b.writeTranscript([row.user(), row.tool(), row.text(), row.text("## Needs you\n- b"), row.text("## Needs you\n- c")]);
    const s3 = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- c" }));
    assert.equal(s3.status, 0);
    assert.ok(!kept(s3.json), s3.stdout);
    assert.equal(s3.json.systemMessage, "brb: 2 stops with no tool calls between them; letting the agent stop. 3 held; type `back` to read them.");
    assert.equal(awayRecord(b).toolLessStops, 2);
    // A tool call resets the count.
    b.writeTranscript([row.user(), row.tool(), row.text(), row.text(), row.text(), row.tool(), row.text()]);
    const s4 = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- d" }));
    assert.ok(kept(s4.json));
    assert.equal(awayRecord(b).toolLessStops, 0);
  } finally {
    b.release();
  }
});

test("OMP transcript shape: toolCall blocks in message rows count, so a working OMP agent is kept working", () => {
  const b = box();
  try {
    const omp = (id) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: {} }] } });
    const rows = [{ type: "session", id: "x" }, { type: "message", message: { role: "user", content: "go" } }, omp("a"), omp("b")];
    b.writeTranscript(rows);
    assert.deepEqual(countToolUses(b.transcript, 0), { count: 2, lines: 4 });
    goAway(b);
    for (let i = 0; i < 4; i++) {
      rows.push(omp(`c${i}`));
      b.writeTranscript(rows);
      const r = runHook(b, "stop", stopInput(b, { stop_hook_active: i > 0, last_assistant_message: `Did step ${i}.\n\n## Needs you\n- Ask number ${i}` }), { env: { BRB_HARNESS: "omp" } });
      assert.equal(r.json?.decision, "block", `stop ${i}: ${r.stdout}`);
    }
    assert.equal(awayRecord(b).toolLessStops, 0);
  } finally {
    b.release();
  }
});

test("no readable transcript: a repeated message counts as tool-less on a first stop", () => {
  const b = box();
  try {
    goAway(b);
    const input = (msg) => stopInput(b, { transcript_path: join(b.root, "missing.jsonl"), last_assistant_message: msg });
    assert.ok(kept(runHook(b, "stop", input("## Needs you\n- a")).json));
    assert.equal(awayRecord(b).lastStop.transcript, false);
    assert.ok(kept(runHook(b, "stop", input("## Needs you\n- a")).json), "first repeat: one tool-less stop");
    assert.equal(awayRecord(b).toolLessStops, 1);
    const third = runHook(b, "stop", input("## Needs you\n- a"));
    assert.ok(!kept(third.json), third.stdout);
    assert.match(third.json.systemMessage, /^brb: 2 stops with no tool calls between them/);
    // A changed message resets it.
    assert.ok(kept(runHook(b, "stop", input("## Needs you\n- b")).json));
    assert.equal(awayRecord(b).toolLessStops, 0);
  } finally {
    b.release();
  }
});

test("no readable transcript: every stop_hook_active stop is tool-less, so 50 stops with a new ask each are released by the third", () => {
  const b = box();
  try {
    writeAway("s", freshAway({ since: "t0" }), b.env);
    const verdicts = [];
    for (let i = 0; i < 50; i++) {
      const r = decideStop({ session_id: "s", transcript_path: "", stop_hook_active: i > 0, last_assistant_message: `Still blocked.\n\n## Needs you\n- Should I use option ${i}?` }, { env: b.env });
      verdicts.push(kept(r));
    }
    assert.deepEqual(verdicts.slice(0, 3), [true, true, false], "kept, kept, released at stop 3 (idleStops 2)");
    assert.equal(verdicts.filter(Boolean).length, 2);
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
    assert.ok(kept(runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- a" })).json));
    const r = runHook(b, "stop", stopInput(b, { last_assistant_message: "## Needs you\n- b" }));
    assert.ok(!kept(r.json), r.stdout);
    assert.match(r.json.systemMessage, /^brb: 1 stops with no tool calls/);
  } finally {
    b.release();
  }
});

test("unwritable state dir: the fire still surfaces, the write failure is logged and shown, no keep-working answer", () => {
  const b = box();
  const dir = b.stateDir("s");
  try {
    writeAway("s", freshAway({ since: "t0" }), b.env);
    chmodSync(dir, 0o500);
    const r = decideStop({ session_id: "s", transcript_path: "", stop_hook_active: false, last_assistant_message: "on fire: main is red\n\n## Needs you\n- Pick a cache" }, { env: b.env });
    chmodSync(dir, 0o700);
    assert.ok(!kept(r));
    const [fire, note] = r.systemMessage.split("\n");
    assert.equal(fire, "brb on fire: main is red");
    assert.match(note, /^brb Stop could not write its state \(EACCES/);
    assert.ok(r.terminalSequence);
    assert.match(b.read(b.errorsLog), / Stop could not write state: EACCES/);
  } finally {
    chmodSync(dir, 0o700);
    b.release();
  }
});

test("a back that lands while the stop runs is not undone: away.json stays gone, nothing is written", () => {
  const b = box();
  try {
    writeAway("s", freshAway({ since: "t0" }), b.env);
    const now = () => {
      clearAway("s", b.env);
      return "2026-11-04T00:00:00.000Z";
    };
    const r = decideStop({ session_id: "s", transcript_path: "", stop_hook_active: false, last_assistant_message: "## Needs you\n- Pick a cache" }, { env: b.env, now });
    assert.equal(r, null);
    assert.ok(!existsSync(join(b.stateDir("s"), "away.json")));
    assert.ok(!existsSync(join(b.stateDir("s"), "digest.md")));
  } finally {
    b.release();
  }
});

test("malformed input: exit 0, no block, one errors.log line and a systemMessage; a missing message while away is a plain keep-working", () => {
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
    assert.deepEqual(noMessage.json, keepWorking(0), "away with no message text: nothing to hold, keep working");
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
    writeFileSync(b.transcript, "garbage\n" + JSON.stringify(row.tool()) + "\n" + JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "toolCall" }] } }) + "\n");
    assert.deepEqual(countToolUses(b.transcript), { count: 1, lines: 3 }, "a user row's toolCall is not counted");
    assert.equal(osc9("a\u001bb\nc"), "\u001b]9;a b c\u0007");
    assert.equal(osc9("x".repeat(300)).length, 200 + "\u001b]9;".length + 1, "text capped at 200");
    assert.equal(appleScript('t "q"', 'say "hi"\\now\nnext'), 'display notification "say \\"hi\\"\\\\now next" with title "t \\"q\\""');
  } finally {
    b.release();
  }
});
