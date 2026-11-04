// test/state.test.mjs — the episode state machine (strike, down, popup once, re-arm), the file
// (atomic write, missing/invalid → EMPTY), and the dead-man's rule.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY, step, readState, writeState, statePath, stateDir, timerOverdue, STRIKES_TO_DOWN, DEFAULT_INTERVAL_S } from "../lib/state.mjs";

const T0 = 1_793_784_000_000;
const pass = { ok: true, reason: null, healed: null };
const fail = { ok: false, reason: "the ctx daemon is not running (.daemon.running = false, .daemon.status = \"stale_lock\")", healed: { attempted: true, ok: false, detail: "`ctx index mode auto --format json`: daemon running = false, supervisor \"fallback\"" } };

test("paths follow XDG_STATE_HOME, then HOME", () => {
  assert.equal(stateDir({ XDG_STATE_HOME: "/Users/example/state" }), "/Users/example/state/ctx-watch");
  assert.equal(statePath({ HOME: "/Users/example" }), "/Users/example/.local/state/ctx-watch/state.json");
});

test("a passing tick from EMPTY stays up and stamps", () => {
  const { state, popup } = step(EMPTY, pass, T0);
  assert.equal(popup, false);
  assert.equal(state.episode, "up");
  assert.equal(state.strikes, 0);
  assert.equal(state.lastTickAt, T0);
  assert.deepEqual(state.lastProbe, { at: T0, ok: true, reason: null, healed: null });
});

test("one failing tick strikes; the second goes down and asks for the popup once; a third stays down with no popup", () => {
  assert.equal(STRIKES_TO_DOWN, 2);
  const one = step(EMPTY, fail, T0);
  assert.equal(one.popup, false);
  assert.equal(one.state.episode, "strike");
  assert.equal(one.state.strikes, 1);
  assert.equal(one.state.downSince, null);
  assert.equal(one.state.lastProbe.healed, fail.healed.detail);

  const two = step(one.state, fail, T0 + 300_000);
  assert.equal(two.popup, true);
  assert.equal(two.state.episode, "down");
  assert.equal(two.state.strikes, 2);
  assert.equal(two.state.downSince, T0 + 300_000);
  assert.equal(two.state.popupShown, true);
  assert.equal(two.state.lastPopupAt, T0 + 300_000);

  const three = step(two.state, fail, T0 + 600_000);
  assert.equal(three.popup, false, "one popup per episode");
  assert.equal(three.state.episode, "down");
  assert.equal(three.state.strikes, 3);
  assert.equal(three.state.downSince, T0 + 300_000, "downSince is the tick that opened the down");
  assert.equal(three.state.lastPopupAt, T0 + 300_000);
});

test("a passing tick closes the episode and re-arms the popup; the next down pops again", () => {
  let s = step(step(EMPTY, fail, T0).state, fail, T0 + 1).state;
  assert.equal(s.episode, "down");
  const up = step(s, pass, T0 + 2);
  assert.equal(up.popup, false);
  assert.deepEqual({ episode: up.state.episode, strikes: up.state.strikes, popupShown: up.state.popupShown, downSince: up.state.downSince }, { episode: "up", strikes: 0, popupShown: false, downSince: null });
  assert.equal(up.state.lastPopupAt, T0 + 1, "the history of the last popup is kept");
  s = step(up.state, fail, T0 + 3).state;
  assert.equal(s.episode, "strike");
  const again = step(s, fail, T0 + 4);
  assert.equal(again.popup, true, "a new episode gets its own popup");
  assert.equal(again.state.downSince, T0 + 4);
});

test("a strike followed by a pass is not a down", () => {
  const s = step(step(EMPTY, fail, T0).state, pass, T0 + 1).state;
  assert.equal(s.episode, "up");
  assert.equal(s.strikes, 0);
  const r = step(s, fail, T0 + 2);
  assert.equal(r.state.episode, "strike", "the count starts over");
  assert.equal(r.popup, false);
});

test("step keeps the fields it does not own (intervalS, firstSeenAt)", () => {
  const s = step({ ...EMPTY, intervalS: 120, firstSeenAt: 5 }, pass, T0).state;
  assert.equal(s.intervalS, 120);
  assert.equal(s.firstSeenAt, 5);
});

test("readState: missing, invalid, or non-object → EMPTY; partial → filled with EMPTY", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-state-"));
  try {
    const file = join(dir, "state.json");
    assert.deepEqual(readState(file), EMPTY);
    writeFileSync(file, "{not json");
    assert.deepEqual(readState(file), EMPTY);
    writeFileSync(file, "[1,2]");
    assert.deepEqual(readState(file), EMPTY);
    writeFileSync(file, '{"episode":"down","strikes":4}');
    assert.deepEqual(readState(file), { ...EMPTY, episode: "down", strikes: 4 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeState creates the directory, writes atomically, and reports an unwritable path without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-state-"));
  try {
    const file = join(dir, "deep", "er", "state.json");
    assert.equal(writeState(file, { ...EMPTY, strikes: 1 }), true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).strikes, 1);
    assert.deepEqual(readdirSync(join(dir, "deep", "er")), ["state.json"], "no temp file left behind");
    assert.ok(readFileSync(file, "utf8").endsWith("\n"));
    const blocked = join(file, "under-a-file", "state.json");
    assert.equal(writeState(blocked, EMPTY), false);
    assert.ok(writeState.lastError instanceof Error);
    assert.equal(existsSync(blocked), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timerOverdue: nothing known → not overdue; last tick older than 2× interval → overdue; firstSeenAt counts when never ticked", () => {
  assert.deepEqual(timerOverdue(EMPTY, T0), { overdue: false, since: null, intervalS: DEFAULT_INTERVAL_S });
  const fresh = { ...EMPTY, lastTickAt: T0 - 599_000, intervalS: 300 };
  assert.equal(timerOverdue(fresh, T0).overdue, false);
  const edge = { ...EMPTY, lastTickAt: T0 - 600_000, intervalS: 300 };
  assert.equal(timerOverdue(edge, T0).overdue, false, "exactly 2× is not over");
  const late = { ...EMPTY, lastTickAt: T0 - 600_001, intervalS: 300 };
  assert.deepEqual(timerOverdue(late, T0), { overdue: true, since: T0 - 600_001, intervalS: 300 });
  const never = { ...EMPTY, firstSeenAt: T0 - 3_600_000 };
  assert.deepEqual(timerOverdue(never, T0), { overdue: true, since: T0 - 3_600_000, intervalS: DEFAULT_INTERVAL_S });
  const custom = { ...EMPTY, lastTickAt: T0 - 150_000, intervalS: 60 };
  assert.equal(timerOverdue(custom, T0).overdue, true, "a 60 s interval is overdue after 120 s");
  const ticked = { ...EMPTY, lastTickAt: T0 - 1_000, firstSeenAt: T0 - 3_600_000 };
  assert.equal(timerOverdue(ticked, T0).overdue, false, "lastTickAt wins over firstSeenAt");
});
