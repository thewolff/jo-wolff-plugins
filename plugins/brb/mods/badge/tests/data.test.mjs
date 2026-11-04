// data.test.mjs — mods/badge/data.mjs: the snapshot read back from query.mjs, the badge line
// (home → null; away → `away since <clock> (<elapsed>) · [note ·] N held · say back`), the clock
// and duration formats, and the away.json path the mod probes, checked against lib/state.mjs.
// node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { AWAY_MAX_BYTES, NOTE_CAP, awayPath, badgeText, clockTime, elapsed, emptySnapshot, queryArgv, readSnapshot, sessionKey as badgeKey } from "../data.mjs";
import { sessionDir, sessionKey } from "../../../lib/state.mjs";
import { awayFor } from "../../../lib/text.mjs";

const SINCE = "2026-11-04T18:42:00.000Z"; // 10:42 AM in America/Los_Angeles (PST)
const AWAY = { ok: true, away: true, since: SINCE, note: "", held: 12, onFire: 0 };
const minutes = (n) => Date.parse(SINCE) + n * 60_000;
const LA = { timeZone: "America/Los_Angeles" };

test("readSnapshot: home, away and error shapes come back typed; junk is an error, never a throw", () => {
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: true, away: false }) + "\n"), { ok: true, away: false });
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: true, away: true, since: SINCE, note: "lunch", held: 3, onFire: 1 })), { ok: true, away: true, since: SINCE, note: "lunch", held: 3, onFire: 1 });
  // Missing or mis-typed fields take their zero values; a negative or fractional count is 0.
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: true, away: true, since: SINCE, held: -1, onFire: 1.5, note: 7 })), { ok: true, away: true, since: SINCE, note: "", held: 0, onFire: 0 });
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: false, error: "boom" })), { ok: false, error: "boom" });
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: true, away: true })), { ok: false, error: "query printed an away record with no since" });
  assert.deepEqual(readSnapshot(""), { ok: false, error: "query printed no JSON" });
  assert.deepEqual(readSnapshot("not json"), { ok: false, error: "query printed no JSON" });
  assert.deepEqual(readSnapshot("42"), { ok: false, error: "query printed no object" });
  assert.deepEqual(readSnapshot(undefined), { ok: false, error: "query printed no JSON" });
  assert.deepEqual(emptySnapshot(), { ok: true, away: false });
});

test("badgeText: away shows the clock, the elapsed time, the count and the word; home and a failed query show nothing", () => {
  assert.equal(badgeText(AWAY, { now: minutes(40), ...LA }), "away since 10:42 AM (40m) · 12 held · say back");
  assert.equal(badgeText({ ...AWAY, held: 1 }, { now: minutes(0), ...LA }), "away since 10:42 AM (0m) · 1 held · say back");
  assert.equal(badgeText({ ...AWAY, held: 0 }, { now: minutes(125), ...LA }), "away since 10:42 AM (2h 5m) · 0 held · say back");
  assert.equal(badgeText({ ok: true, away: false }), null);
  assert.equal(badgeText(emptySnapshot()), null);
  assert.equal(badgeText({ ok: false, error: "boom" }), null);
});

test("badgeText: the note rides between the time and the count, whitespace collapsed, cut at NOTE_CAP with an ellipsis", () => {
  assert.equal(badgeText({ ...AWAY, note: "lunch" }, { now: minutes(5), ...LA }), "away since 10:42 AM (5m) · lunch · 12 held · say back");
  assert.equal(badgeText({ ...AWAY, note: "  two\n words  " }, { now: minutes(5), ...LA }), "away since 10:42 AM (5m) · two words · 12 held · say back");
  const long = "x".repeat(NOTE_CAP + 10);
  const text = badgeText({ ...AWAY, note: long }, { now: minutes(5), ...LA });
  assert.equal(text, `away since 10:42 AM (5m) · ${"x".repeat(NOTE_CAP - 1)}… · 12 held · say back`);
  assert.equal(badgeText({ ...AWAY, note: "x".repeat(NOTE_CAP) }, { now: minutes(5), ...LA }), `away since 10:42 AM (5m) · ${"x".repeat(NOTE_CAP)} · 12 held · say back`);
});

test("elapsed: minutes under an hour, hours and minutes under a day, days and hours past it, as lib/text.mjs awayFor prints them; the future and junk are 0m", () => {
  assert.equal(elapsed(SINCE, minutes(0)), "0m");
  assert.equal(elapsed(SINCE, minutes(0) + 59_000), "0m");
  assert.equal(elapsed(SINCE, minutes(1)), "1m");
  assert.equal(elapsed(SINCE, minutes(59)), "59m");
  assert.equal(elapsed(SINCE, minutes(60)), "1h 0m");
  assert.equal(elapsed(SINCE, minutes(65)), "1h 5m");
  assert.equal(elapsed(SINCE, minutes(23 * 60 + 59)), "23h 59m");
  assert.equal(elapsed(SINCE, minutes(24 * 60)), "1d 0h");
  assert.equal(elapsed(SINCE, minutes(27 * 60 + 30)), "1d 3h");
  for (const n of [0, 1, 59, 60, 65, 1439, 1440, 1650, 3000]) assert.equal(elapsed(SINCE, minutes(n)), awayFor(SINCE, new Date(minutes(n)).toISOString()), `${n} minutes`);
  assert.equal(elapsed(SINCE, minutes(-10)), "0m");
  assert.equal(elapsed("not a date", minutes(10)), "0m");
});

test("clockTime: hour and two-digit minute with AM/PM in the given zone; an unparsable since is shown as typed", () => {
  assert.equal(clockTime(SINCE, "America/Los_Angeles"), "10:42 AM");
  assert.equal(clockTime(SINCE, "UTC"), "6:42 PM");
  assert.equal(clockTime("2026-11-04T00:05:00.000Z", "UTC"), "12:05 AM");
  assert.equal(clockTime("yesterday-ish"), "yesterday-ish");
});

test("queryArgv names the script and the session; a missing id is an empty string, which query.mjs refuses", () => {
  assert.deepEqual(queryArgv("/p/mods/badge/query.mjs", "s1"), ["/p/mods/badge/query.mjs", "--session", "s1"]);
  assert.deepEqual(queryArgv("/p/mods/badge/query.mjs", undefined), ["/p/mods/badge/query.mjs", "--session", ""]);
});

test("awayPath places away.json where lib/state.mjs does, for XDG_STATE_HOME, for HOME alone, and for odd session ids", () => {
  for (const id of ["s1", "a b/c", "", "..", "x".repeat(200), "ab.cd-ef_gh"]) {
    assert.equal(badgeKey(id), sessionKey(id), `sessionKey(${JSON.stringify(id)})`);
    assert.equal(awayPath({ xdgStateHome: "/tmp/state", home: "/Users/example", sessionId: id }), join(sessionDir(id, { XDG_STATE_HOME: "/tmp/state", HOME: "/Users/example" }), "away.json"));
    assert.equal(awayPath({ xdgStateHome: undefined, home: "/Users/example", sessionId: id }), join(sessionDir(id, { HOME: "/Users/example" }), "away.json"));
    assert.equal(awayPath({ xdgStateHome: "  ", home: "/Users/example/", sessionId: id }), join(sessionDir(id, { XDG_STATE_HOME: "  ", HOME: "/Users/example/" }), "away.json"));
  }
  assert.equal(awayPath({ xdgStateHome: undefined, home: undefined, sessionId: "s1" }), null);
  assert.equal(awayPath({ xdgStateHome: "", home: "", sessionId: "s1" }), null);
  assert.ok(AWAY_MAX_BYTES >= 4096);
});
