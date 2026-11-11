// data.test.mjs — mods/band/data.mjs: the snapshot read back from query.mjs (away with its items,
// home with its checklist, faults), the action result, the fallback status line (home → null;
// away → `away <elapsed> · [note ·] N held · say back`, never over STATUS_MAX; after back with
// open rows → `back · N to act on`), the prompt-box suggestion, the duration format, and the
// away.json path the mod probes, checked against lib/state.mjs (the parity test for the sessionKey copy).
// node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { MAX_BYTES, STATUS_MAX, actArgv, awayPath, elapsed, emptySnapshot, queryArgv, readResult, readSnapshot, sessionKey as bandKey, statusText, suggestionText } from "../data.mjs";
import { sessionDir, sessionKey } from "../../../lib/state.mjs";
import { awayFor } from "../../../lib/text.mjs";

const SINCE = "2026-11-04T18:42:00.000Z";
const AWAY = { ok: true, away: true, since: SINCE, note: "", held: 12, onFire: 0, items: [] };
const minutes = (n) => Date.parse(SINCE) + n * 60_000;

test("readSnapshot: away, home and error shapes come back typed; junk is an error, never a throw", () => {
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: true, away: false, checklist: null }) + "\n"), { ok: true, away: false, checklist: null });
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: true, away: false })), { ok: true, away: false, checklist: null });
  assert.deepEqual(
    readSnapshot(JSON.stringify({ ok: true, away: true, since: SINCE, note: "lunch", held: 3, onFire: 1, items: ["a", 7, "b"], backRequested: true })),
    { ok: true, away: true, since: SINCE, note: "lunch", held: 3, onFire: 1, items: ["a", "b"] },
  );
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: true, away: true, since: SINCE, held: -1, onFire: 1.5, note: 7 })), { ok: true, away: true, since: SINCE, note: "", held: 0, onFire: 0, items: [] });
  assert.deepEqual(
    readSnapshot(JSON.stringify({ ok: true, away: false, checklist: { at: "t", since: SINCE, note: "n", items: [{ text: "a", done: true }, { text: "b" }, { nope: 1 }, "c"] } })),
    { ok: true, away: false, checklist: { at: "t", since: SINCE, note: "n", items: [{ text: "a", done: true }, { text: "b", done: false }] } },
  );
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: true, away: false, checklist: { items: "nope" } })), { ok: true, away: false, checklist: null });
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: false, error: "boom" })), { ok: false, error: "boom" });
  assert.deepEqual(readSnapshot(JSON.stringify({ ok: true, away: true })), { ok: false, error: "query printed an away record with no since" });
  assert.deepEqual(readSnapshot(""), { ok: false, error: "query printed no JSON" });
  assert.deepEqual(readSnapshot("42"), { ok: false, error: "query printed no object" });
  assert.deepEqual(readSnapshot(undefined), { ok: false, error: "query printed no JSON" });
  assert.deepEqual(emptySnapshot(), { ok: true, away: false, checklist: null });
});

test("readResult: ok (with `away` when the action printed one), a named error, and junk", () => {
  assert.deepEqual(readResult('{"ok":true,"checklist":null}\n'), { ok: true });
  assert.deepEqual(readResult('{"ok":true,"away":true}\n'), { ok: true, away: true });
  assert.deepEqual(readResult('{"ok":true,"away":false}'), { ok: true, away: false });
  assert.deepEqual(readResult('{"ok":true,"away":"yes"}'), { ok: true });
  assert.deepEqual(readResult('{"ok":false,"error":"no"}'), { ok: false, error: "no" });
  assert.deepEqual(readResult("garbage"), { ok: false, error: "action printed no JSON" });
  assert.deepEqual(readResult("null"), { ok: false, error: "action printed no object" });
});

test("statusText: away shows the elapsed time, the count and the word; home shows nothing; after back the open rows", () => {
  assert.equal(statusText(AWAY, { now: minutes(40) }), "away 40m · 12 held · say back");
  assert.equal(statusText({ ...AWAY, held: 0 }, { now: minutes(125) }), "away 2h 5m · 0 held · say back");
  assert.equal(statusText(emptySnapshot()), null);
  assert.equal(statusText({ ok: false, error: "boom" }), null);
  const checklist = { at: "", since: SINCE, note: "", items: [{ text: "a", done: true }, { text: "b", done: false }, { text: "c", done: false }] };
  assert.equal(statusText({ ok: true, away: false, checklist }), "back · 2 to act on");
  assert.equal(statusText({ ok: true, away: false, checklist: { ...checklist, items: [{ text: "a", done: true }] } }), null);
});

test("statusText: the note is dropped whole past STATUS_MAX, then `say back`, then the line is cut; no input passes STATUS_MAX", () => {
  assert.equal(STATUS_MAX, 40);
  assert.equal(statusText({ ...AWAY, note: "lunch" }, { now: minutes(40) }), "away 40m · lunch · 12 held · say back");
  assert.equal(statusText({ ...AWAY, note: "x".repeat(200) }, { now: minutes(40) }), "away 40m · 12 held · say back");
  assert.equal(statusText({ ...AWAY, held: 123456789012, note: "lunch" }, { now: minutes(12 * 1440 + 180) }), "away 12d 3h · 123456789012 held");
  for (const held of [0, 12, 99999, 1e15]) {
    for (const m of [0, 125, 1440 * 9999]) {
      for (const note of ["", "lunch", "x".repeat(200)]) {
        const t = statusText({ ...AWAY, held, note }, { now: minutes(m) });
        assert.ok(t.length <= STATUS_MAX, `${t.length}: ${t}`);
      }
    }
  }
});

test("suggestionText: `away <dur> — type back` while away, nothing home", () => {
  assert.equal(suggestionText(AWAY, { now: minutes(40) }), "away 40m — type back");
  assert.equal(suggestionText(emptySnapshot()), null);
  assert.equal(suggestionText({ ok: false, error: "x" }), null);
});

test("elapsed: as lib/text.mjs awayFor prints it; the future and junk are 0m", () => {
  for (const n of [0, 1, 59, 60, 65, 1439, 1440, 1650, 3000]) assert.equal(elapsed(SINCE, minutes(n)), awayFor(SINCE, new Date(minutes(n)).toISOString()), `${n} minutes`);
  assert.equal(elapsed(SINCE, minutes(-10)), "0m");
  assert.equal(elapsed("not a date", minutes(10)), "0m");
});

test("queryArgv and actArgv name the script, the session, the verb and the row", () => {
  assert.deepEqual(queryArgv("/p/q.mjs", "s1"), ["/p/q.mjs", "--session", "s1"]);
  assert.deepEqual(queryArgv("/p/q.mjs", undefined), ["/p/q.mjs", "--session", ""]);
  assert.deepEqual(actArgv("/p/a.mjs", "s1", "back"), ["/p/a.mjs", "--session", "s1", "back"]);
  assert.deepEqual(actArgv("/p/a.mjs", "s1", "done", 0), ["/p/a.mjs", "--session", "s1", "done", "0"]);
});

test("awayPath places away.json where lib/state.mjs does, for XDG_STATE_HOME, for HOME alone, and for odd session ids", () => {
  for (const id of ["s1", "a b/c", "", "..", "x".repeat(200), "ab.cd-ef_gh"]) {
    assert.equal(bandKey(id), sessionKey(id), `sessionKey(${JSON.stringify(id)})`);
    const xdg = { XDG_STATE_HOME: "/tmp/state", HOME: "/Users/example" };
    assert.equal(awayPath({ xdgStateHome: "/tmp/state", home: "/Users/example", sessionId: id }), join(sessionDir(id, xdg), "away.json"));
    assert.equal(awayPath({ xdgStateHome: undefined, home: "/Users/example", sessionId: id }), join(sessionDir(id, { HOME: "/Users/example" }), "away.json"));
    assert.equal(awayPath({ xdgStateHome: "  ", home: "/Users/example/", sessionId: id }), join(sessionDir(id, { XDG_STATE_HOME: "  ", HOME: "/Users/example/" }), "away.json"));
  }
  assert.equal(awayPath({ xdgStateHome: undefined, home: undefined, sessionId: "s1" }), null);
  assert.ok(MAX_BYTES >= 4096);
});
