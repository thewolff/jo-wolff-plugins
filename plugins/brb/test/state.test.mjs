// test/state.test.mjs — lib/state.mjs round-trips under a temp XDG_STATE_HOME: away.json written
// and read back, cleared; the digest appended, read, archived; config over defaults; session ids
// made safe as directory names. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  appendDigest,
  archiveDigest,
  clearAway,
  configPath,
  freshAway,
  loadConfig,
  readAway,
  readDigest,
  renderDigest,
  sessionDir,
  sessionKey,
  stateRoot,
  writeAway,
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
    writeFileSync(join(sessionDir("s1", b.env), "away.json"), JSON.stringify({ since: "t", held: -1, onFire: "3", seen: "no", lastStop: 4 }));
    assert.deepEqual(readAway("s1", b.env), { since: "t", note: "", held: 0, onFire: 0, toolLessStops: 0, seen: [], lastStop: null });
  } finally {
    b.release();
  }
});

test("digest: empty until appended; entries keep order; archive moves it and clears", () => {
  const b = box();
  try {
    assert.equal(readDigest("s1", b.env), "");
    appendDigest("s1", { at: "2026-11-04T10:05:00.000Z", lines: ["Pick Redis or in-process", "- already a bullet"], closingAsk: "Which cache?" }, b.env);
    appendDigest("s1", { at: "2026-11-04T10:09:00.000Z", lines: ["Approve the schema change"] }, b.env);
    const body = readDigest("s1", b.env);
    assert.equal(body, "## 2026-11-04T10:05:00.000Z\n- Pick Redis or in-process\n- already a bullet\nclosing ask: Which cache?\n\n## 2026-11-04T10:09:00.000Z\n- Approve the schema change\n\n");
    const away = { ...freshAway({ since: "2026-11-04T10:00:00.000Z" }), held: 3 };
    const text = renderDigest(away, body);
    assert.match(text, /^brb digest — held since 2026-11-04T10:00:00.000Z, 3 items\n\n## 2026-11-04T10:05/);
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
