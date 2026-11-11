// test/state.test.mjs — lib/state.mjs round-trips under a temp XDG_STATE_HOME: away.json written
// and read back, cleared; the digest appended, read, archived; config over defaults; session ids
// made safe as directory names; the times Jo reads in local time, the zone always given (env.TZ
// or an argument), so no assertion depends on the runner's zone. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  appendDigest,
  archiveDigest,
  checklistPath,
  clearAway,
  clearChecklist,
  configPath,
  digestItem,
  digestItems,
  freshAway,
  hideRowsEnabled,
  freshChecklist,
  loadConfig,
  parseChecklist,
  readAway,
  readChecklist,
  readDigest,
  renderDigest,
  sessionDir,
  sessionKey,
  stateRoot,
  localTime,
  toggleChecklistItem,
  writeAway,
  writeChecklist,
} from "../lib/state.mjs";

function box() {
  const root = mkdtempSync(join(tmpdir(), "brb-state-"));
  const env = { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
  return { root, env, release: () => rmSync(root, { recursive: true, force: true }) };
}

test("paths: XDG_STATE_HOME and XDG_CONFIG_HOME win; HOME is the fallback", () => {
  assert.equal(stateRoot({ XDG_STATE_HOME: "/x/state" }), "/x/state/brb");
  assert.equal(stateRoot({ HOME: "/h" }), "/h/.local/state/brb");
  assert.equal(stateRoot({ HOME: "/h", XDG_STATE_HOME: "  " }), "/h/.local/state/brb");
  assert.equal(configPath({ XDG_CONFIG_HOME: "/x/cfg" }), "/x/cfg/brb/config.json");
  assert.equal(configPath({ HOME: "/h" }), "/h/.config/brb/config.json");
});

test("sessionKey: safe directory names; empty, dots and junk handled", () => {
  assert.equal(sessionKey("abc-123_x.y"), "abc-123_x.y");
  assert.equal(sessionKey("a/b c"), "a_b_c");
  assert.equal(sessionKey(""), "no-session");
  assert.equal(sessionKey(undefined), "no-session");
  assert.equal(sessionKey(".."), "no-session");
  assert.equal(sessionDir("s1", { XDG_STATE_HOME: "/x" }), "/x/brb/s1");
});

test("away.json: home by default, round-trips, clears", () => {
  const b = box();
  try {
    assert.equal(readAway("s1", b.env), null);
    const away = freshAway({ since: "2026-11-04T10:00:00.000Z", note: "lunch" });
    writeAway("s1", away, b.env);
    assert.deepEqual(readAway("s1", b.env), away);
    away.held = 3;
    away.seen = ["a", "b"];
    away.lastStop = { at: "t", line: 7, hash: "h", transcript: true };
    writeAway("s1", away, b.env);
    assert.deepEqual(readAway("s1", b.env), away);
    clearAway("s1", b.env);
    assert.equal(readAway("s1", b.env), null);
    clearAway("s1", b.env); // idempotent
  } finally {
    b.release();
  }
});

test("away.json that does not parse, or has no since, reads as home; bad counters read as 0", () => {
  const b = box();
  try {
    mkdirSync(sessionDir("s1", b.env), { recursive: true });
    writeFileSync(join(sessionDir("s1", b.env), "away.json"), "{not json");
    assert.equal(readAway("s1", b.env), null);
    writeFileSync(join(sessionDir("s1", b.env), "away.json"), JSON.stringify({ note: "x" }));
    assert.equal(readAway("s1", b.env), null);
    writeFileSync(join(sessionDir("s1", b.env), "away.json"), JSON.stringify({ since: "t", held: -1, onFire: "3", backstopped: "yes", seen: "no", lastStop: 4 }));
    assert.deepEqual(readAway("s1", b.env), { since: "t", note: "", held: 0, onFire: 0, toolLessStops: 0, nothingNewStops: 0, backstopped: false, seen: [], lastStop: null });
  } finally {
    b.release();
  }
});

test("digest: empty until appended; entries keep order; archive moves it and clears", () => {
  const b = box();
  try {
    assert.equal(readDigest("s1", b.env), "");
    const env = { ...b.env, TZ: "UTC" };
    appendDigest("s1", { at: "2026-11-04T10:05:00.000Z", lines: ["Pick Redis or in-process", "- already a bullet"], closingAsk: "Which cache?" }, env);
    appendDigest("s1", { at: "2026-11-04T10:09:00.000Z", lines: ["Approve the schema change"] }, env);
    const body = readDigest("s1", b.env);
    assert.equal(body, "## 2026-11-04 10:05 AM UTC\n- Pick Redis or in-process\n- already a bullet\nclosing ask: Which cache?\n\n## 2026-11-04 10:09 AM UTC\n- Approve the schema change\n\n");
    const away = { ...freshAway({ since: "2026-11-04T10:00:00.000Z" }), held: 3 };
    assert.equal(away.since, "2026-11-04T10:00:00.000Z", "the record keeps ISO");
    const text = renderDigest(away, body, env);
    assert.match(text, /^brb digest — held since 2026-11-04 10:00 AM UTC, 3 items\n\n## 2026-11-04 10:05 AM UTC/);
    assert.ok(text.endsWith("- Approve the schema change"));
    const archived = archiveDigest("s1", b.env, "2026-11-04T11:00:00.000Z");
    assert.equal(archived, join(sessionDir("s1", b.env), "archive", "2026-11-04T11-00-00-000Z.md"));
    assert.equal(readFileSync(archived, "utf8"), body);
    assert.equal(readDigest("s1", b.env), "");
    assert.equal(archiveDigest("s1", b.env), null);
    // A second archive at the same stamp gets a suffix, never overwrites.
    appendDigest("s1", { at: "t", lines: ["again"] }, b.env);
    const second = archiveDigest("s1", b.env, "2026-11-04T11:00:00.000Z");
    assert.equal(second, join(sessionDir("s1", b.env), "archive", "2026-11-04T11-00-00-000Z-2.md"));
    assert.ok(existsSync(archived));
  } finally {
    b.release();
  }
});

test("renderDigest: nothing held says so, one item is singular, the note rides the header", () => {
  const away = { ...freshAway({ since: "T", note: "lunch" }), held: 1 };
  assert.equal(renderDigest(away, ""), "brb digest — held since T (lunch), 1 item\n\n(nothing held)");
  assert.equal(renderDigest({ ...away, note: "", held: 0 }, "  \n"), "brb digest — held since T, 0 items\n\n(nothing held)");
});

test("localTime: the given zone, 12-hour clock and the zone's short name; standard and daylight time; junk as given", () => {
  const iso = "2026-11-11T01:50:39.219Z";
  assert.equal(localTime(iso, "America/Los_Angeles"), "2026-11-10 5:50 PM PST");
  assert.equal(localTime("2026-07-04T19:05:00.000Z", "America/Los_Angeles"), "2026-07-04 12:05 PM PDT");
  assert.equal(localTime(iso, "UTC"), "2026-11-11 1:50 AM UTC");
  // A zone Intl refuses falls back to the machine's zone: some time, never the raw ISO and never a throw.
  assert.match(localTime(iso, "Not/AZone"), /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} [AP]M \S+$/);
  assert.equal(localTime("t"), "t");
  assert.equal(localTime(""), "");
  // The digest header follows env.TZ; the zone is never the runner's.
  const away = { ...freshAway({ since: iso }), held: 0 };
  assert.equal(renderDigest(away, "", { TZ: "America/Los_Angeles" }), "brb digest — held since 2026-11-10 5:50 PM PST, 0 items\n\n(nothing held)");
  assert.equal(renderDigest(away, "", { TZ: "Asia/Tokyo" }).split("\n")[0], "brb digest — held since 2026-11-11 10:50 AM GMT+9, 0 items");
});

test("config: defaults with no file; integer fields override; junk is ignored", () => {
  const b = box();
  try {
    assert.deepEqual(loadConfig(b.env), DEFAULT_CONFIG);
    mkdirSync(join(b.env.XDG_CONFIG_HOME, "brb"), { recursive: true });
    writeFileSync(configPath(b.env), JSON.stringify({ onFireCap: 5, idleStops: "2", extra: true }));
    assert.deepEqual(loadConfig(b.env), { onFireCap: 5, idleStops: 2 });
    writeFileSync(configPath(b.env), "nope");
    assert.deepEqual(loadConfig(b.env), DEFAULT_CONFIG);
    writeFileSync(configPath(b.env), "[1]");
    assert.deepEqual(loadConfig(b.env), DEFAULT_CONFIG);
    writeFileSync(configPath(b.env), JSON.stringify({ onFireCap: -1, idleStops: 0 }));
    assert.deepEqual(loadConfig(b.env), { onFireCap: 3, idleStops: 0 });
  } finally {
    b.release();
  }
});

test("hideRows: on with no file or no key; off when set off; off when the file cannot be read or parsed", () => {
  const b = box();
  try {
    assert.equal(hideRowsEnabled(b.env), true, "no file: on");
    mkdirSync(join(b.env.XDG_CONFIG_HOME, "brb"), { recursive: true });
    const cases = [
      [JSON.stringify({ onFireCap: 5 }), true],
      [JSON.stringify({ hideRows: "on" }), true],
      [JSON.stringify({ hideRows: true }), true],
      [JSON.stringify({ hideRows: "off" }), false],
      [JSON.stringify({ hideRows: false }), false],
      [JSON.stringify({ hideRows: "Off " }), false],
      ["{ hideRows: off", false],
      ["[1]", false],
      ["", false],
    ];
    for (const [text, want] of cases) {
      writeFileSync(configPath(b.env), text);
      assert.equal(hideRowsEnabled(b.env), want, text);
    }
    rmSync(configPath(b.env));
    mkdirSync(configPath(b.env));
    assert.equal(hideRowsEnabled(b.env), false, "a directory where the file should be: unreadable, off");
    rmSync(configPath(b.env), { recursive: true });
    writeFileSync(configPath(b.env), JSON.stringify({ hideRows: "off" }));
    assert.deepEqual(loadConfig(b.env), DEFAULT_CONFIG, "the other keys are unaffected");
  } finally {
    b.release();
  }
});

test("digestItems: the held lines and closing asks of appendDigest's entries, markers off; headings and blanks are not items", () => {
  const b = box();
  try {
    appendDigest("s1", { at: "2026-11-04T18:42:00.000Z", lines: ["Pick Redis or in-process for the cache"] }, b.env);
    appendDigest("s1", { at: "2026-11-04T18:43:00.000Z", lines: ["- Approve the schema change", "Ship it?"], closingAsk: "ship after the demo?" }, b.env);
    assert.deepEqual(digestItems(readDigest("s1", b.env)), ["Pick Redis or in-process for the cache", "Approve the schema change", "Ship it?", "closing ask: ship after the demo?"]);
  } finally {
    b.release();
  }
  assert.equal(digestItem("## 18:42"), null);
  assert.equal(digestItem(""), null);
  assert.equal(digestItem("3) third   one "), "third one");
  assert.deepEqual(digestItems(undefined), []);
});

test("checklist.json: none by default; written whole and read back; Done toggles and persists; the last row done removes the file; clear removes it", () => {
  const b = box();
  try {
    assert.equal(readChecklist("s1", b.env), null);
    const fresh = freshChecklist({ at: "2026-11-04T19:30:00.000Z", since: "2026-11-04T18:42:00.000Z", note: "lunch", items: ["a", "b"] });
    assert.deepEqual(fresh.items, [{ text: "a", done: false }, { text: "b", done: false }]);
    assert.equal(writeChecklist("s1", fresh, b.env), checklistPath("s1", b.env));
    assert.deepEqual(readChecklist("s1", b.env), fresh);

    assert.deepEqual(toggleChecklistItem("s1", 0, b.env).items, [{ text: "a", done: true }, { text: "b", done: false }]);
    assert.deepEqual(readChecklist("s1", b.env).items[0], { text: "a", done: true });
    assert.equal(toggleChecklistItem("s1", 5, b.env), null, "off the list");
    assert.equal(toggleChecklistItem("s1", -1, b.env), null);
    assert.equal(readChecklist("s1", b.env).items[0].done, true, "an off-list toggle changes nothing");
    assert.equal(toggleChecklistItem("s1", 1, b.env), null, "every row done");
    assert.equal(existsSync(checklistPath("s1", b.env)), false);

    writeChecklist("s1", fresh, b.env);
    clearChecklist("s1", b.env);
    assert.equal(readChecklist("s1", b.env), null);
    clearChecklist("s1", b.env);
  } finally {
    b.release();
  }
});

test("parseChecklist: junk is null; rows with no text are dropped; done is only ever true or false", () => {
  assert.equal(parseChecklist("{nope"), null);
  assert.equal(parseChecklist("[]"), null);
  assert.equal(parseChecklist('{"items":"x"}'), null);
  assert.deepEqual(parseChecklist('{"items":[{"text":"a","done":"yes"},{"done":true},null]}'), { at: "", since: "", note: "", items: [{ text: "a", done: false }] });
});

