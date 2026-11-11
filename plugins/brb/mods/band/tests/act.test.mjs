// act.test.mjs — mods/band/act.mjs, as the subprocess the band's buttons run: `back` reports
// whether the session is away and `open` which returned digest is open, both writing nothing;
// the old `done` and `clear` verbs are gone (the band sends prompts; the prompt hook writes); a
// missing session and an unknown verb are `{ ok: false, error }`; every run exits 0 and prints
// JSON. node --test.

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

test("back: reports home, or away with the hold's `since`, and writes nothing; the hold stays until `back` arrives as a prompt", () => {
  const b = box();
  try {
    assert.deepEqual(act(b, "--session", "s1", "back"), { ok: true, away: false });
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    hold(b, "Pick the cache");
    const before = readdirSync(b.stateDir("s1")).sort();
    assert.deepEqual(act(b, "--session", "s1", "back"), { ok: true, away: true, since: readAway("s1", b.env).since });
    assert.deepEqual(readdirSync(b.stateDir("s1")).sort(), before, "no file written or removed");
    assert.notEqual(readAway("s1", b.env), null, "still away");
  } finally {
    b.release();
  }
});

test("open: reports no list, or the open one's `at`, and writes nothing; done and clear are no longer verbs here", () => {
  const b = box();
  try {
    assert.deepEqual(act(b, "--session", "s1", "open"), { ok: true, open: false });
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    hold(b, "First");
    hold(b, "Second");
    runHook(b, "user-prompt-submit", promptInput(b, "back"));
    const before = readdirSync(b.stateDir("s1")).sort();
    assert.deepEqual(act(b, "--session", "s1", "open"), { ok: true, open: true, at: readChecklist("s1", b.env).at });
    for (const verb of ["done", "clear"]) assert.match(act(b, "--session", "s1", verb, "0").error, /^unknown verb/, verb);
    assert.deepEqual(readdirSync(b.stateDir("s1")).sort(), before, "no file written or removed");
    assert.ok(existsSync(join(b.stateDir("s1"), "checklist.json")));
    assert.deepEqual(readChecklist("s1", b.env).items.map((i) => i.done), [false, false]);
  } finally {
    b.release();
  }
});

test("faults: no session, an unknown verb", () => {
  const b = box();
  try {
    assert.deepEqual(act(b, "back"), { ok: false, error: "act needs --session <id>" });
    assert.match(act(b, "--session", "s1", "nope").error, /^unknown verb "nope"/);
  } finally {
    b.release();
  }
});
