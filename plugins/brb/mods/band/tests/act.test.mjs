// act.test.mjs — mods/band/act.mjs, as the subprocess the band's buttons run: `back` reports
// whether the session is away and writes nothing; `done <i>` toggles one checklist row and removes the file when every row
// is done; `clear` removes it; a missing session, a missing index and an unknown verb are
// `{ ok: false, error }`; every run exits 0 and prints JSON. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseArgs } from "../act.mjs";
import { readAway, readChecklist } from "../../../lib/state.mjs";
import { PLUGIN_ROOT, box, promptInput, runHook } from "../../../test/helpers.mjs";

const ACT = join(PLUGIN_ROOT, "mods", "band", "act.mjs");
const HOLD = join(PLUGIN_ROOT, "scripts", "brb.mjs");

function act(b, ...args) {
  const r = spawnSync(process.execPath, [ACT, ...args], { cwd: b.work, env: b.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const hold = (b, item) => spawnSync(process.execPath, [HOLD, "hold", "--session", "s1", item], { cwd: b.work, env: b.env, encoding: "utf8", timeout: 10_000 });

test("parseArgs: the session, the verb and a non-negative integer index", () => {
  assert.deepEqual(parseArgs(["--session", "s1", "done", "2"]), { sessionId: "s1", verb: "done", index: 2 });
  assert.deepEqual(parseArgs(["--session=s1", "back"]), { sessionId: "s1", verb: "back", index: null });
  assert.deepEqual(parseArgs(["done", "-1", "--session", " "]), { sessionId: null, verb: "done", index: null });
});

test("back: reports home or away and writes nothing; the hold stays until `back` arrives as a prompt", () => {
  const b = box();
  try {
    assert.deepEqual(act(b, "--session", "s1", "back"), { ok: true, away: false });
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    hold(b, "Pick the cache");
    const before = readdirSync(b.stateDir("s1")).sort();
    assert.deepEqual(act(b, "--session", "s1", "back"), { ok: true, away: true });
    assert.deepEqual(readdirSync(b.stateDir("s1")).sort(), before, "no file written or removed");
    assert.notEqual(readAway("s1", b.env), null, "still away");
  } finally {
    b.release();
  }
});

test("done toggles one row and persists it; the last row done removes checklist.json; clear removes it", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    hold(b, "First");
    hold(b, "Second");
    runHook(b, "user-prompt-submit", promptInput(b, "back"));
    const one = act(b, "--session", "s1", "done", "0");
    assert.deepEqual(one.checklist.items, [{ text: "First", done: true }, { text: "Second", done: false }]);
    assert.deepEqual(readChecklist("s1", b.env).items, one.checklist.items);
    act(b, "--session", "s1", "done", "0");
    assert.equal(readChecklist("s1", b.env).items[0].done, false, "done again is undo");
    act(b, "--session", "s1", "done", "0");
    assert.deepEqual(act(b, "--session", "s1", "done", "1"), { ok: true, checklist: null });
    assert.equal(existsSync(join(b.stateDir("s1"), "checklist.json")), false);

    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    hold(b, "Third");
    runHook(b, "user-prompt-submit", promptInput(b, "back"));
    assert.ok(readChecklist("s1", b.env));
    assert.deepEqual(act(b, "--session", "s1", "clear"), { ok: true, checklist: null });
    assert.equal(readChecklist("s1", b.env), null);
  } finally {
    b.release();
  }
});

test("faults: no session, done with no index, an unknown verb", () => {
  const b = box();
  try {
    assert.deepEqual(act(b, "back"), { ok: false, error: "act needs --session <id>" });
    assert.deepEqual(act(b, "--session", "s1", "done"), { ok: false, error: "done needs a row index" });
    assert.match(act(b, "--session", "s1", "nope").error, /^unknown verb "nope"/);
  } finally {
    b.release();
  }
});
