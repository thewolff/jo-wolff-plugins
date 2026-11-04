// data.test.mjs — mods/badge/data.mjs: the snapshot read back from query.mjs, the badge line
// (home → null; away → `away <elapsed> · [note ·] N held · say back`, never over STATUS_MAX), the
// duration format, and the away.json path the mod probes, checked against lib/state.mjs (the
// parity test for the sessionKey/awayPath copy). node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { AWAY_MAX_BYTES, STATUS_MAX, awayPath, badgeText, elapsed, emptySnapshot, queryArgv, readSnapshot, sessionKey as badgeKey } from "../data.mjs";
import { sessionDir, sessionKey } from "../../../lib/state.mjs";
import { awayFor } from "../../../lib/text.mjs";

const SINCE = "2026-11-04T18:42:00.000Z";
const AWAY = { ok: true, away: true, since: SINCE, note: "", held: 12, onFire: 0 };
const minutes = (n) => Date.parse(SINCE) + n * 60_000;

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

test("badgeText: away shows the elapsed time, the count and the word; home and a failed query show nothing", () => {
  assert.equal(badgeText(AWAY, { now: minutes(40) }), "away 40m · 12 held · say back");
  assert.equal(badgeText({ ...AWAY, held: 1 }, { now: minutes(0) }), "away 0m · 1 held · say back");
  assert.equal(badgeText({ ...AWAY, held: 0 }, { now: minutes(125) }), "away 2h 5m · 0 held · say back");
  assert.equal(badgeText({ ok: true, away: false }), null);
  assert.equal(badgeText(emptySnapshot()), null);
  assert.equal(badgeText({ ok: false, error: "boom" }), null);
});

test("badgeText: the note rides between the time and the count, whitespace collapsed, and is dropped whole when the line would pass STATUS_MAX", () => {
  assert.equal(STATUS_MAX, 40);
  const lunch = badgeText({ ...AWAY, note: "lunch" }, { now: minutes(40) });
  assert.equal(lunch, "away 40m · lunch · 12 held · say back");
  assert.ok(lunch.length <= STATUS_MAX, `${lunch.length}: ${lunch}`);
  assert.equal(badgeText({ ...AWAY, note: "  two\n words  " }, { now: minutes(5) }), "away 5m · two words · 12 held · say back");
  // A 200-character note does not fit: the line is the note-free one, under the cap.
  const long = badgeText({ ...AWAY, note: "x".repeat(200) }, { now: minutes(40) });
  assert.equal(long, "away 40m · 12 held · say back");
  // The longest note that fits is kept; one character more and it is dropped.
  const room = STATUS_MAX - "away 40m ·  · 12 held · say back".length;
  assert.equal(badgeText({ ...AWAY, note: "n".repeat(room) }, { now: minutes(40) }).length, STATUS_MAX);
  assert.equal(badgeText({ ...AWAY, note: "n".repeat(room + 1) }, { now: minutes(40) }), "away 40m · 12 held · say back");
});

test("badgeText: past the note, `say back` is dropped next, then the line is cut with an ellipsis; no input passes STATUS_MAX", () => {
  assert.equal(badgeText({ ...AWAY, held: 123456789012, note: "lunch" }, { now: minutes(12 * 1440 + 180) }), "away 12d 3h · 123456789012 held");
  const absurd = badgeText({ ...AWAY, held: Number.MAX_SAFE_INTEGER * 1000, note: "lunch" }, { now: minutes(99999 * 1440) });
  assert.equal(absurd.length, STATUS_MAX);
  assert.ok(absurd.endsWith("…"), absurd);
  for (const held of [0, 9, 12, 999, 99999, 1e9, 1e15]) {
    for (const m of [0, 59, 125, 1439, 1440 * 30, 1440 * 9999]) {
      for (const note of ["", "lunch", "x".repeat(10), "x".repeat(200), " \t\n "]) {
        const t = badgeText({ ...AWAY, held, note }, { now: minutes(m) });
        assert.ok(t.length <= STATUS_MAX, `${t.length}: ${t}`);
      }
    }
  }
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
