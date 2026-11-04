// test/state.test.mjs — the episode state machine (strike, down, popup once per episode once
// delivered, re-arm), the file (atomic write with its temp file cleaned up; missing, invalid, or
// out-of-shape → EMPTY with one errors.log line), the state lock every read-modify-write of
// state.json holds, and the dead-man's rule.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realFs from "node:fs";
import { EMPTY, step, popupDelivered, popupSettled, readState, writeState, validateState, statePath, stateDir, timerOverdue, withStateLock, lockPath, STRIKES_TO_DOWN, DEFAULT_INTERVAL_S, MAX_STRIKES, INTERVAL_BOUNDS, PENDING_STALE_MS, LOCK_STALE_MS, LOCK_WAIT_MS } from "../lib/state.mjs";
import { HOOK_LOCK_WAIT_MS } from "../hooks/session-start.mjs";

const T0 = 1_793_784_000_000;
const pass = { ok: true, reason: null, healed: null };
const fail = { ok: false, reason: "the ctx daemon is not running (.daemon.running = false, .daemon.status = \"stale_lock\")", healed: { attempted: true, ok: false, detail: "`ctx index mode auto --format json`: daemon running = false, supervisor \"fallback\"" } };
const shown = { started: true, detail: "popup started (test)" };
const notShown = { started: false, detail: "popup not shown: spawn /usr/bin/osascript ENOENT" };

test("paths follow XDG_STATE_HOME, then HOME; a given directory wins", () => {
  assert.equal(stateDir({ XDG_STATE_HOME: "/Users/example/state" }), "/Users/example/state/ctx-watch");
  assert.equal(statePath({ HOME: "/Users/example" }), "/Users/example/.local/state/ctx-watch/state.json");
  assert.equal(statePath({ HOME: "/Users/example" }, "/Volumes/other/ctx-watch"), "/Volumes/other/ctx-watch/state.json");
});

test("a passing tick from EMPTY stays up and stamps", () => {
  const { state, popup } = step(EMPTY, pass, T0);
  assert.equal(popup, false);
  assert.equal(state.episode, "up");
  assert.equal(state.strikes, 0);
  assert.equal(state.lastTickAt, T0);
  assert.deepEqual(state.lastProbe, { at: T0, ok: true, reason: null, healed: null });
});

test("one failing tick strikes; the second goes down and asks for the popup; delivered, a third stays down with no popup", () => {
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
  assert.equal(two.state.popupShown.daemon, false, "step asks; delivery latches");
  const delivered = popupDelivered(two.state, shown, T0 + 300_000);
  assert.deepEqual(delivered.popupShown, { daemon: true, semantic: false });
  assert.equal(delivered.lastPopupAt, T0 + 300_000);
  assert.equal(delivered.popupFailedAt, null);

  const three = step(delivered, fail, T0 + 600_000);
  assert.equal(three.popup, false, "one popup per episode");
  assert.equal(three.state.episode, "down");
  assert.equal(three.state.strikes, 3);
  assert.equal(three.state.downSince, T0 + 300_000, "downSince is the tick that opened the down");
  assert.equal(three.state.lastPopupAt, T0 + 300_000);
});

test("a popup that could not be delivered does not use up the episode: the next failing tick asks again, and a later success latches", () => {
  const down = step(step(EMPTY, fail, T0).state, fail, T0 + 1);
  assert.equal(down.popup, true);
  const failed = popupDelivered(down.state, notShown, T0 + 1);
  assert.equal(failed.popupShown.daemon, false);
  assert.equal(failed.popupFailedAt, T0 + 1);
  assert.equal(failed.popupFailReason, notShown.detail);
  assert.equal(failed.lastPopupAt, null);
  const again = step(failed, fail, T0 + 2);
  assert.equal(again.popup, true, "asked again");
  const ok = popupDelivered(again.state, shown, T0 + 2);
  assert.equal(ok.popupShown.daemon, true);
  assert.equal(ok.lastPopupAt, T0 + 2);
  assert.equal(ok.popupFailedAt, null, "the failure is cleared by a delivery");
  assert.equal(ok.popupFailReason, null);
  assert.equal(step(ok, fail, T0 + 3).popup, false);
  const long = popupDelivered(down.state, { started: false, detail: "x".repeat(500) }, T0);
  assert.equal(long.popupFailReason.length, 200, "the reason is bounded");
});

test("a popup still up after the grace is pending, not delivered: only a confirmed exit 0 (or an acknowledgement) latches; a late failure or a supervisor that never reports reopens the episode", () => {
  const down = step(step(EMPTY, fail, T0).state, fail, T0 + 1);
  const pending = popupDelivered(down.state, { started: true, pending: true, token: "t1", detail: "popup started (test)" }, T0 + 1);
  assert.equal(pending.popupShown.daemon, false, "surviving the grace is not delivery");
  assert.deepEqual(pending.popupPending, { token: "t1", since: T0 + 1, kind: "daemon" });
  assert.equal(pending.lastPopupAt, null);
  assert.equal(step(pending, fail, T0 + 2).popup, false, "no second dialog while the first may still be up");
  assert.equal(step(pending, pass, T0 + 2).state.popupPending, null, "a pass re-arms and forgets it");

  const outcome = (o) => ({ token: "t1", at: T0 + 5, bin: "/usr/bin/osascript", code: 0, signal: null, error: null, acknowledged: false, ...o });
  assert.deepEqual(popupSettled(pending, null, T0 + 2), { state: pending, line: null }, "no outcome yet: still pending");
  assert.deepEqual(popupSettled(pending, outcome({ token: "t0", code: 7 }), T0 + 2), { state: pending, line: null }, "another popup's outcome is not this one's");
  assert.deepEqual(popupSettled(down.state, outcome({ code: 7 }), T0 + 2), { state: down.state, line: null }, "nothing pending: nothing to settle");

  const late = popupSettled(pending, outcome({ code: 7 }), T0 + 6);
  assert.equal(late.state.popupShown.daemon, false);
  assert.equal(late.state.popupPending, null);
  assert.equal(late.state.popupFailedAt, T0 + 5);
  assert.equal(late.state.popupFailReason, "popup not delivered: /usr/bin/osascript ended with exit 7 after the grace");
  assert.equal(late.line, "popup not delivered: /usr/bin/osascript ended with exit 7 after the grace; the popup is due again");
  assert.equal(step(late.state, fail, T0 + 6).popup, true, "the episode's popup is open again");

  const confirmed = popupSettled(pending, outcome({ code: 0 }), T0 + 6);
  assert.deepEqual({ shown: confirmed.state.popupShown.daemon, pending: confirmed.state.popupPending, at: confirmed.state.lastPopupAt }, { shown: true, pending: null, at: T0 + 1 });
  assert.equal(confirmed.line, "popup delivered: /usr/bin/osascript ended with exit 0");
  assert.equal(step(confirmed.state, fail, T0 + 7).popup, false);
  const acknowledged = popupSettled(pending, outcome({ code: 1, acknowledged: true }), T0 + 6);
  assert.equal(acknowledged.state.popupShown.daemon, true, "a person dismissing the dialog (-128) is an acknowledgement");

  assert.deepEqual(popupSettled(pending, null, T0 + 1 + PENDING_STALE_MS), { state: pending, line: null }, "at the bound: still waiting");
  const lost = popupSettled(pending, null, T0 + 2 + PENDING_STALE_MS);
  assert.equal(lost.state.popupShown.daemon, false);
  assert.equal(lost.state.popupPending, null);
  assert.match(lost.state.popupFailReason, /^popup not confirmed: no outcome from its supervisor within \d+ s$/);
  assert.equal(step(lost.state, fail, T0 + 3 + PENDING_STALE_MS).popup, true);
});

test("a passing tick closes the episode and re-arms the popup; the next down pops again", () => {
  let s = popupDelivered(step(step(EMPTY, fail, T0).state, fail, T0 + 1).state, shown, T0 + 1);
  assert.equal(s.episode, "down");
  const up = step(s, pass, T0 + 2);
  assert.equal(up.popup, false);
  assert.deepEqual({ episode: up.state.episode, strikes: up.state.strikes, popupShown: up.state.popupShown, downSince: up.state.downSince, popupFailedAt: up.state.popupFailedAt }, { episode: "up", strikes: 0, popupShown: { daemon: false, semantic: false }, downSince: null, popupFailedAt: null });
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

test("step keeps the fields it does not own (intervalS, firstSeenAt) and caps strikes", () => {
  const s = step({ ...EMPTY, intervalS: 120, firstSeenAt: 5 }, pass, T0).state;
  assert.equal(s.intervalS, 120);
  assert.equal(s.firstSeenAt, 5);
  assert.equal(step({ ...EMPTY, strikes: MAX_STRIKES, episode: "down", popupShown: { daemon: true, semantic: false } }, fail, T0).state.strikes, MAX_STRIKES);
});

const semantic = { ok: false, reason: 'the ctx semantic index is not ready (.daemon.jobs.semantic_index.status = "budget_exhausted", last run "failed")', healable: false, healed: { attempted: false, ok: false, detail: "not attempted: the daemon is running; `ctx index mode auto` does not touch the semantic index" } };

/** Drive `results` through step from `state`, delivering every popup asked for; the kinds popped, in order. */
function drive(results, state = EMPTY) {
  const popped = [];
  let s = state;
  results.forEach((r, i) => {
    const out = step(s, r, T0 + i);
    s = out.state;
    if (out.popup) {
      popped.push(s.episodeKind);
      s = popupDelivered(s, shown, T0 + i);
    }
  });
  return { popped, state: s };
}

test("each failure kind has its own latch: a daemon death after a semantic popup raises its own popup (the review's P4 shape)", () => {
  const { popped, state } = drive([semantic, semantic, fail, fail, fail, fail]);
  assert.deepEqual(popped, ["semantic", "daemon"]);
  assert.deepEqual({ episode: state.episode, strikes: state.strikes, episodeKind: state.episodeKind, kindStrikes: state.kindStrikes, popupShown: state.popupShown }, { episode: "down", strikes: 6, episodeKind: "daemon", kindStrikes: 4, popupShown: { daemon: true, semantic: true } });
  // The daemon comes back while the semantic index is still not ready: no second semantic popup, and the daemon's latch re-arms.
  const back = drive([semantic, semantic], state);
  assert.deepEqual(back.popped, []);
  assert.deepEqual(back.state.popupShown, { daemon: false, semantic: true });
  assert.deepEqual(drive([fail, fail], back.state).popped, ["daemon"], "the next daemon death pops again");
  assert.deepEqual(drive([fail, fail, semantic, semantic]).popped, ["daemon", "semantic"], "the reverse order pops both too");
});

test("a semantic status that flips ready once between not-ready runs pops once; the latch re-arms only after STRIKES_TO_DOWN passing ticks in a row", () => {
  const flip = drive([semantic, semantic, pass, semantic, semantic, pass, semantic, semantic]);
  assert.deepEqual(flip.popped, ["semantic"]);
  assert.equal(flip.state.popupShown.semantic, true);
  const rearmed = drive([pass, pass], flip.state);
  assert.deepEqual({ popupShown: rearmed.state.popupShown, passStreak: rearmed.state.passStreak }, { popupShown: { daemon: false, semantic: false }, passStreak: STRIKES_TO_DOWN });
  assert.deepEqual(drive([semantic, semantic], rearmed.state).popped, ["semantic"], "a real return to not ready after the streak pops again");
  // A daemon popup re-arms on the first pass, as in 0.1.0.
  assert.deepEqual(drive([fail, fail, pass, fail, fail]).popped, ["daemon", "daemon"]);
});

test("a pending popup blocks the other kind's until it settles, and is dropped when its own kind re-arms", () => {
  const down = step(step(EMPTY, semantic, T0).state, semantic, T0 + 1);
  assert.equal(down.popup, true);
  const pending = popupDelivered({ ...down.state, popupPending: { token: "t1", since: T0 + 1, kind: "semantic" } }, { started: true, pending: true, token: "t1", detail: "popup started (test)" }, T0 + 1);
  assert.deepEqual(pending.popupPending, { token: "t1", since: T0 + 1, kind: "semantic" });
  const d2 = step(step(pending, fail, T0 + 2).state, fail, T0 + 3);
  assert.equal(d2.popup, false, "no second dialog while the semantic one may still be up");
  const settled = popupSettled(d2.state, { token: "t1", at: T0 + 4, bin: "/usr/bin/osascript", code: 0, signal: null, error: null, acknowledged: false }, T0 + 4);
  assert.deepEqual(settled.state.popupShown, { daemon: false, semantic: true }, "the delivery latches the claim's kind");
  assert.equal(step(settled.state, fail, T0 + 5).popup, true, "then the daemon's popup is asked for");
  assert.deepEqual(step(pending, pass, T0 + 2).state.popupPending, pending.popupPending, "one ready tick does not end a semantic popup's claim");
  assert.equal(step(step(pending, pass, T0 + 2).state, pass, T0 + 3).state.popupPending, null, "the streak does");
});

test("a state file from before 0.2.0 migrates on read: the one boolean latch is the daemon's, a pending popup with no kind is the daemon's, a strike or down is a daemon episode", () => {
  const old = { episode: "down", strikes: 5, popupShown: true, popupPending: { token: "1793700000000-13", since: 5 }, downSince: 1 };
  const { state } = validateState(old);
  assert.deepEqual({ popupShown: state.popupShown, popupPending: state.popupPending, episodeKind: state.episodeKind, kindStrikes: state.kindStrikes, passStreak: state.passStreak }, { popupShown: { daemon: true, semantic: false }, popupPending: { token: "1793700000000-13", since: 5, kind: "daemon" }, episodeKind: "daemon", kindStrikes: 5, passStreak: 0 });
  assert.deepEqual(validateState({ popupShown: false }).state.popupShown, { daemon: false, semantic: false });
  assert.deepEqual(drive([fail], validateState({ episode: "strike", strikes: 1 }).state).popped, ["daemon"], "an old strike goes down and pops on the next daemon tick, as before");
  assert.equal(validateState({ episode: "strike", strikes: 1, episodeKind: null }).state.episodeKind, null, "a 0.2.0 file is taken as written");
  // Migrated: an old latch held by a semantic popup still lets a later daemon death pop once a semantic tick re-arms it.
  assert.deepEqual(drive([semantic, fail, fail], { ...state, popupPending: null }).popped, ["daemon"]);
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-state-"));
  try {
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify(old));
    assert.deepEqual(readState(file).popupShown, { daemon: true, semantic: false });
    assert.equal(existsSync(join(dir, "errors.log")), false, "a migration is not an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateState: known fields in shape pass (unknown dropped); each field out of shape is named", () => {
  assert.deepEqual(validateState({ episode: "down", strikes: 4, extra: "dropped" }), { state: { ...EMPTY, episode: "down", strikes: 4, episodeKind: "daemon", kindStrikes: 4 } });
  assert.deepEqual(validateState({}), { state: { ...EMPTY } });
  const bad = [
    [{ episode: "DOWN" }, 'episode is "DOWN", not "up" | "strike" | "down"'],
    [{ strikes: -100 }, "strikes is -100, not a whole number 0..1100000"],
    [{ strikes: 1.5 }, "strikes is 1.5, not a whole number 0..1100000"],
    [{ strikes: "3" }, 'strikes is "3", not a whole number 0..1100000'],
    [{ popupShown: "yes" }, 'popupShown is "yes", not { daemon, semantic } of true | false (or one true | false from before 0.2.0)'],
    [{ popupShown: 1 }, "popupShown is 1, not { daemon, semantic } of true | false (or one true | false from before 0.2.0)"],
    [{ popupShown: { daemon: true } }, 'popupShown is {"daemon":true}, not { daemon, semantic } of true | false (or one true | false from before 0.2.0)'],
    [{ episodeKind: "both" }, 'episodeKind is "both", not "daemon" | "semantic" | null'],
    [{ kindStrikes: -1 }, "kindStrikes is -1, not a whole number 0..1100000"],
    [{ passStreak: 0.5 }, "passStreak is 0.5, not a whole number 0..1100000"],
    [{ lastTickAt: "soon" }, 'lastTickAt is "soon", not epoch ms | null'],
    [{ lastTickAt: -1 }, "lastTickAt is -1, not epoch ms | null"],
    [{ lastTickAt: 9e15 }, "lastTickAt is 9000000000000000, not epoch ms | null"],
    [{ intervalS: "300" }, 'intervalS is "300", not a whole number 30..604800 | null'],
    [{ intervalS: 10 }, "intervalS is 10, not a whole number 30..604800 | null"],
    [{ intervalS: 604_801 }, "intervalS is 604801, not a whole number 30..604800 | null"],
    [{ intervalS: INTERVAL_BOUNDS.min - 1 }, "intervalS is 29, not a whole number 30..604800 | null"],
    [{ downSince: {} }, "downSince is {}, not epoch ms | null"],
    [{ firstSeenAt: true }, "firstSeenAt is true, not epoch ms | null"],
    [{ lastPopupAt: [] }, "lastPopupAt is [], not epoch ms | null"],
    [{ popupFailedAt: "x" }, 'popupFailedAt is "x", not epoch ms | null'],
    [{ popupFailReason: 7 }, "popupFailReason is 7, not a string | null"],
    [{ popupPending: { token: "", since: 1 } }, 'popupPending is {"token":"","since":1}, not { token, since, kind? } | null'],
    [{ popupPending: { token: "t", since: -1 } }, 'popupPending is {"token":"t","since":-1}, not { token, since, kind? } | null'],
    [{ popupPending: { token: "../../etc/x", since: 1 } }, 'popupPending is {"token":"../../etc/x","since":1}, not { token, since, kind? } | null'],
    [{ popupPending: { token: "t", since: 1, kind: "other" } }, 'popupPending is {"token":"t","since":1,"kind":"other"}, not { token, since, kind? } | null'],
    [{ lastProbe: "fail" }, 'lastProbe is "fail", not { at, ok, reason, healed } | null'],
    [{ lastProbe: { at: "now", ok: true } }, 'lastProbe is {"at":"now","ok":true}, not { at, ok, reason, healed } | null'],
    [{ lastProbe: { at: 1, ok: "true" } }, 'lastProbe is {"at":1,"ok":"true"}, not { at, ok, reason, healed } | null'],
  ];
  for (const [j, problem] of bad) assert.deepEqual(validateState({ ...EMPTY, ...j }), { problem }, JSON.stringify(j));
  assert.deepEqual(validateState({ lastProbe: { at: 1, ok: false, reason: "r", healed: null, extra: 1 } }).state.lastProbe, { at: 1, ok: false, reason: "r", healed: null }, "lastProbe keeps only its four fields");
  assert.deepEqual(validateState([1]), { problem: "not an object" });
  assert.deepEqual(validateState(null), { problem: "not an object" });
});

test("readState: missing → EMPTY silently; not JSON, non-object, or a field out of shape → EMPTY with one errors.log line beside it naming the file and the field", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-state-"));
  try {
    const file = join(dir, "state.json");
    const log = join(dir, "errors.log");
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
    assert.deepEqual(readState(file), EMPTY);
    assert.equal(existsSync(log), false, "a missing file is normal: nothing logged");
    writeFileSync(file, "{not json");
    assert.deepEqual(readState(file), EMPTY);
    assert.equal(lines().length, 1);
    assert.match(lines()[0], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+Z state\\.json ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not JSON \\(.*\\); treated as absent$`));
    writeFileSync(file, "[1,2]");
    assert.deepEqual(readState(file), EMPTY);
    assert.match(lines()[1], / ignored: not an object; treated as absent$/);
    writeFileSync(file, '{"episode":"down","strikes":4}');
    assert.deepEqual(readState(file), { ...EMPTY, episode: "down", strikes: 4, episodeKind: "daemon", kindStrikes: 4 }, "a file from before 0.2.0: a daemon episode");
    assert.equal(lines().length, 2, "a good file logs nothing");
    // The reviewer's poisoned object: the popup would be held off for the whole outage.
    writeFileSync(file, JSON.stringify({ ...EMPTY, strikes: -100, popupShown: true, lastTickAt: "soon", intervalS: "300" }));
    assert.deepEqual(readState(file), EMPTY, "treated as absent: the next failing tick is strike 1, popup on strike 2");
    assert.match(lines()[2], / ignored: strikes is -100, not a whole number 0\.\.1100000; treated as absent$/);
    assert.deepEqual(timerOverdue(readState(file), T0), { overdue: false, since: null, intervalS: DEFAULT_INTERVAL_S }, "no invalid string survives into the dead-man's arithmetic");
    writeFileSync(file, JSON.stringify({ ...EMPTY, unknownField: { deep: true } }));
    const read = readState(file);
    assert.equal("unknownField" in read, false, "unknown fields are not carried from read to the next write");
    const seen = [];
    writeFileSync(file, "{");
    readState(file, { log: (p, m) => seen.push([p, m]) });
    assert.equal(seen.length, 1, "the log is injectable");
    assert.equal(seen[0][0], file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeState creates the directory, writes atomically, reports an unwritable path without throwing, and leaves no temp file behind a failed write", () => {
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
    // The temp file is written, then the rename fails (the target is a directory): the temp file goes.
    const asDir = join(dir, "isdir", "state.json");
    mkdirSync(asDir, { recursive: true });
    assert.equal(writeState(asDir, EMPTY), false);
    assert.match(writeState.lastError.code, /EISDIR|ENOTDIR|EPERM/);
    assert.deepEqual(readdirSync(join(dir, "isdir")), ["state.json"], "the failed write's temp file was removed");
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

test("withStateLock: runs fn holding <dir>/state.lock and removes it; a lock a running process holds is busy; a dead holder's or an old one is taken over; an unwritable directory is an error naming the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-lock-"));
  try {
    const lock = lockPath(dir);
    assert.equal(lock, join(dir, "state.lock"));
    let inside;
    const r = withStateLock(dir, () => ((inside = readFileSync(lock, "utf8")), 42));
    assert.deepEqual(r, { ok: true, value: 42 });
    assert.match(inside, new RegExp(`^${process.pid} `), "the lock names its holder's pid");
    assert.equal(existsSync(lock), false, "released");

    // Held by a running process (this one, under another nonce): busy until the wait runs out.
    writeFileSync(lock, `${process.pid} someone-else\n`);
    const t = Date.now();
    const busy = withStateLock(dir, () => assert.fail("must not run while another holds the lock"), { waitMs: 120 });
    assert.equal(busy.ok, false);
    assert.ok(Date.now() - t >= 100, "it waited for the holder");
    assert.equal(busy.error.message, `${lock} is held by pid ${process.pid}`);
    assert.equal(readFileSync(lock, "utf8"), `${process.pid} someone-else\n`, "another's lock is left alone");

    // A holder that exited without releasing: taken over at once.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lock, `${dead} crashed\n`);
    assert.deepEqual(withStateLock(dir, () => "ran", { waitMs: 0 }), { ok: true, value: "ran" });
    assert.equal(existsSync(lock), false);

    // An empty lock is a holder between creating it and writing its pid: busy while fresh, taken over once old.
    writeFileSync(lock, "");
    assert.equal(withStateLock(dir, () => "no", { waitMs: 0 }).ok, false);
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    utimesSync(lock, old, old);
    assert.deepEqual(withStateLock(dir, () => "yes", { waitMs: 0 }), { ok: true, value: "yes" });
    // A running pid that has held it past LOCK_STALE_MS (a reused pid, or a hung holder) is taken over too.
    writeFileSync(lock, `${process.pid} hung\n`);
    utimesSync(lock, old, old);
    assert.deepEqual(withStateLock(dir, () => "taken", { waitMs: 0 }), { ok: true, value: "taken" });
    assert.deepEqual(readdirSync(dir), [], "nothing left: no lock, no set-aside copy");

    // fn throwing still releases.
    assert.throws(() => withStateLock(dir, () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(lock), false);

    // A directory that cannot hold the lock (here: under a file) is an error naming it, and fn never runs.
    writeFileSync(join(dir, "a-file"), "");
    const blocked = withStateLock(join(dir, "a-file", "x"), () => assert.fail("no lock, no run"), { waitMs: 0 });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error.message, /^could not lock .*a-file\/x\/state\.lock: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The real fs with the lock path's calls swapped for injected failures; `creates` counts acquisition attempts.
function faultyFs(lock, { read, rename } = {}) {
  const fs = { ...realFs, creates: 0 };
  const fail = (code) => Object.assign(new Error(`${code}: injected`), { code });
  fs.writeFileSync = (p, ...rest) => {
    if (p === lock) fs.creates++;
    return realFs.writeFileSync(p, ...rest);
  };
  fs.readFileSync = (p, ...rest) => {
    if (p === lock && read) throw fail(read);
    return realFs.readFileSync(p, ...rest);
  };
  fs.renameSync = (from, ...rest) => {
    if (from === lock && rename) throw fail(rename);
    return realFs.renameSync(from, ...rest);
  };
  return fs;
}

for (const [budget, waitMs] of [["hook", HOOK_LOCK_WAIT_MS], ["tick", LOCK_WAIT_MS]]) {
  test(`withStateLock inside the ${budget}'s ${waitMs} ms: a persistent EACCES on the lock's read or its stale rename fails at once naming the lock; an ENOENT at every rename retries with backoff and gives up at the deadline`, () => {
    assert.equal(HOOK_LOCK_WAIT_MS, 200);
    assert.equal(LOCK_WAIT_MS, 2_000);
    const dir = mkdtempSync(join(tmpdir(), "ctx-watch-lock-bound-"));
    try {
      const lock = lockPath(dir);
      const dead = spawnSync(process.execPath, ["-e", ""]).pid;
      const named = `^could not lock ${lock.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: `;
      const cases = [
        ["read EACCES", `${process.pid} live\n`, { read: "EACCES" }, new RegExp(`${named}EACCES`), true],
        ["stale-rename EACCES", `${dead} crashed\n`, { rename: "EACCES" }, new RegExp(`${named}EACCES`), true],
        ["rename ENOENT", `${dead} crashed\n`, { rename: "ENOENT" }, new RegExp(`${named}still contended after ${waitMs} ms$`), false],
      ];
      for (const [what, holder, faults, message, atOnce] of cases) {
        writeFileSync(lock, holder);
        const fs = faultyFs(lock, faults);
        const t = performance.now();
        const r = withStateLock(dir, () => assert.fail(`${what}: no lock, no run`), { waitMs, fs });
        const elapsed = performance.now() - t;
        assert.equal(r.ok, false, what);
        assert.match(r.error.message, message, what);
        assert.ok(elapsed < waitMs + 100, `${what}: returned in ${elapsed} ms`);
        if (atOnce) {
          assert.equal(fs.creates, 1, `${what}: a persistent error is not retried`);
          assert.ok(elapsed < 50, `${what}: at once, not after the wait (${elapsed} ms)`);
        } else {
          // Backoff 5, 10, 20, 40, then 50 ms: at most waitMs / 50 + 5 attempts, and it used the wait.
          assert.ok(fs.creates >= 2 && fs.creates <= waitMs / 50 + 5, `${what}: ${fs.creates} attempts`);
          assert.ok(elapsed >= waitMs - 5, `${what}: waited ${elapsed} ms`);
        }
        rmSync(lock, { force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
