// test/hold.test.mjs — scripts/brb.mjs `hold`, as a spawned process and through its exports:
// away → the item lands in the digest, `held N`, exit 0; the same item again (any marker,
// case or spacing) is held once; not away → `not away; say it to Jo`, nothing written, exit 0;
// the session from --session, BRB_SESSION_ID, CLAUDE_CODE_SESSION_ID or the one away session;
// several away and no id → exit 1; no text or a bad verb → usage, exit 1; an item held here
// is not held again by the Stop hook, and `pending` shows both sources; a `back` between hold's
// read and its write leaves the hold ended and nothing appended (the session lock); a live lock
// fails hold after the wait, a stale one is taken over. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hold, parseHoldArgs, resolveSession } from "../scripts/brb.mjs";
import { handle } from "../hooks/user-prompt-submit.mjs";
import { LOCK_STALE_MS, LOCK_WAIT_MS, freshAway, withAwayLock, writeAway } from "../lib/state.mjs";
import { backstopReason } from "../lib/text.mjs";
import { PLUGIN_ROOT, box, promptInput, row, runHook, stopInput } from "./helpers.mjs";

const SCRIPT = join(PLUGIN_ROOT, "scripts", "brb.mjs");
const run = (b, args, env = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: b.work, env: { ...b.env, ...env }, encoding: "utf8", timeout: 10_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const digest = (b, s = "s1") => b.read(join(b.stateDir(s), "digest.md"));
const awayRecord = (b, s = "s1") => JSON.parse(b.read(join(b.stateDir(s), "away.json")));

test("hold while away: the item lands in the digest under a timestamp, the count grows, `held N` is printed", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const r = run(b, ["hold", "--session", "s1", "Pick Redis or in-process for the cache"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "held 1\n");
    assert.match(digest(b), /^## \d{4}-.*\n- Pick Redis or in-process for the cache\n\n$/);
    assert.equal(awayRecord(b).held, 1);
    // Unquoted words join with one space; a second item is a second entry.
    const r2 = run(b, ["hold", "--session=s1", "Approve", "the", "schema", "change"]);
    assert.equal(r2.stdout, "held 2\n");
    assert.match(digest(b), /\n- Approve the schema change\n\n$/);
    assert.equal(awayRecord(b).held, 2);
  } finally {
    b.release();
  }
});

test("hold deduplicates by the Stop hook's rule: a list marker, bold, case and spacing do not make a new item; the count stays", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    assert.equal(run(b, ["hold", "--session", "s1", "Pick a cache"]).stdout, "held 1\n");
    for (const again of ["Pick a cache", "- Pick a cache", "**pick a  cache**", "  PICK A CACHE  "]) {
      const r = run(b, ["hold", "--session", "s1", again]);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "held 1\n", again);
    }
    assert.equal((digest(b).match(/cache/gi) ?? []).length, 1);
    assert.equal(awayRecord(b).held, 1);
    // The Stop hook sees the same item under `## Needs you` as already held: not filed twice, but the shown line is backstopped.
    b.writeTranscript([row.user(), row.tool()]);
    const stop = runHook(b, "stop", stopInput(b, { last_assistant_message: "Wired it.\n\n## Needs you\n- Pick a cache\n- Name the flag" }));
    assert.deepEqual(stop.json, { decision: "block", reason: backstopReason(2) });
    assert.equal((digest(b).match(/Pick a cache/g) ?? []).length, 1, "held once across both sources");
    assert.match(digest(b), /- Name the flag\n\n$/);
    assert.equal(awayRecord(b).held, 2);
    // pending shows both sources, deduplicated.
    const peek = runHook(b, "user-prompt-submit", promptInput(b, "pending")).json.reason;
    assert.match(peek, /2 items\n\n## .*\n- Pick a cache\n\n## .*\n- Name the flag$/);
  } finally {
    b.release();
  }
});

test("hold while not away: `not away; say it to Jo`, exit 0, nothing written", () => {
  const b = box();
  try {
    const r = run(b, ["hold", "--session", "s1", "Pick a cache"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "not away; say it to Jo\n");
    assert.ok(!existsSync(b.stateDir("s1")));
    assert.ok(!existsSync(join(b.env.XDG_STATE_HOME, "brb")), "no state directory is created");
  } finally {
    b.release();
  }
});

test("the session: --session, then BRB_SESSION_ID, then CLAUDE_CODE_SESSION_ID, then the one away session; several away with no id is a refusal", () => {
  const b = box();
  try {
    writeAway("a", freshAway({ since: "t0" }), b.env);
    assert.deepEqual(resolveSession(null, b.env), { session: "a" }, "the one away session");
    assert.deepEqual(resolveSession("x", { ...b.env, BRB_SESSION_ID: "y" }), { session: "x" });
    assert.deepEqual(resolveSession(null, { ...b.env, BRB_SESSION_ID: "y", CLAUDE_CODE_SESSION_ID: "z" }), { session: "y" });
    assert.deepEqual(resolveSession(null, { ...b.env, CLAUDE_CODE_SESSION_ID: "z" }), { session: "z" });
    const one = run(b, ["hold", "Pick a cache"]);
    assert.equal(one.stdout, "held 1\n", one.stderr);
    assert.match(digest(b, "a"), /- Pick a cache/);
    const viaEnv = run(b, ["hold", "Name the flag"], { CLAUDE_CODE_SESSION_ID: "a" });
    assert.equal(viaEnv.stdout, "held 2\n");
    writeAway("b", freshAway({ since: "t1" }), b.env);
    const several = run(b, ["hold", "Pick a cache"]);
    assert.equal(several.status, 1);
    assert.match(several.stderr, /^several holds are away \(a, b\); pass --session <id>/);
    assert.equal(several.stdout, "");
    assert.equal(awayRecord(b, "a").held, 2, "nothing was filed");
    assert.equal(awayRecord(b, "b").held, 0);
    // An env id that names a home session: not away, say it.
    const home = run(b, ["hold", "Pick a cache"], { BRB_SESSION_ID: "nope" });
    assert.equal(home.stdout, "not away; say it to Jo\n");
    assert.equal(home.status, 0);
    // No away session at all and no id: the no-session key, which is home.
    const b2 = box();
    try {
      assert.deepEqual(resolveSession(null, b2.env), { session: "" });
      assert.equal(run(b2, ["hold", "x"]).stdout, "not away; say it to Jo\n");
    } finally {
      b2.release();
    }
  } finally {
    b.release();
  }
});

test("usage: no text, an empty item, a bare --session or an unknown verb → usage on stderr, exit 1, nothing written", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    for (const args of [["hold"], ["hold", "--session", "s1"], ["hold", "--session"], ["hold", "--session", "s1", "   "], ["pending"], []]) {
      const r = run(b, args);
      assert.equal(r.status, 1, JSON.stringify(args));
      assert.match(r.stderr, /usage: brb\.mjs hold \[--session <id>\] "<one item, readable on its own>"/, JSON.stringify(args));
      assert.equal(r.stdout, "");
    }
    assert.equal(awayRecord(b).held, 0);
    assert.ok(!existsSync(join(b.stateDir("s1"), "digest.md")));
    assert.deepEqual(parseHoldArgs(["--", "--session", "x"]), { session: null, text: "--session x" }, "`--` ends the flags");
    assert.deepEqual(parseHoldArgs(["--session", "s", "a", "b"]), { session: "s", text: "a b" });
    assert.throws(() => hold("s1", "- **  **", { env: b.env }), /the item is empty/);
  } finally {
    b.release();
  }
});

test("an unwritable state directory: the error on stderr, exit 1, nothing held", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    chmodSync(b.stateDir("s1"), 0o500);
    const r = run(b, ["hold", "--session", "s1", "Pick a cache"]);
    chmodSync(b.stateDir("s1"), 0o700);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^brb hold: could not write the digest \(EACCES.*; say it to Jo/);
    assert.equal(r.stdout, "");
    assert.equal(awayRecord(b).held, 0);
  } finally {
    chmodSync(b.stateDir("s1"), 0o700);
    b.release();
  }
});

test("a `back` that lands between hold's read and its write: nothing is appended, away.json is not recreated, `not away`", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    // The reviewer's interleaving: hold has read away.json; Jo types `back` (through the prompt hook, which takes the lock) before hold writes.
    let backed = null;
    const now = () => {
      backed = handle(promptInput(b, "back"), { env: b.env });
      return "2026-11-04T00:00:00.000Z";
    };
    assert.deepEqual(hold("s1", "Pick a cache", { env: b.env, now }), { status: "home" });
    assert.match(backed.reason, /^brb: hold cleared/);
    assert.ok(!existsSync(join(b.stateDir("s1"), "away.json")), "the away flag stays gone");
    assert.ok(!existsSync(join(b.stateDir("s1"), "digest.md")), "nothing appended after the return");
    assert.ok(!existsSync(join(b.stateDir("s1"), "away.lock")), "the lock is released");
    // A hold replaced by a new `brb` in the same window is not written to either.
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const replace = () => {
      handle(promptInput(b, "back"), { env: b.env });
      handle(promptInput(b, "brb"), { env: b.env, now: () => "2026-11-04T01:00:00.000Z" });
      return "2026-11-04T00:00:00.000Z";
    };
    assert.deepEqual(hold("s1", "Pick a cache", { env: b.env, now: replace }), { status: "home" });
    assert.equal(awayRecord(b).held, 0);
    assert.ok(!existsSync(join(b.stateDir("s1"), "digest.md")));
  } finally {
    b.release();
  }
});

test("the session lock: a live lock makes hold wait and then fail (nothing held); a stale lock is taken over", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const lock = join(b.stateDir("s1"), "away.lock");
    writeFileSync(lock, "");
    const started = Date.now();
    const r = run(b, ["hold", "--session", "s1", "Pick a cache"]);
    assert.ok(Date.now() - started >= LOCK_WAIT_MS, "waited the bound");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^brb hold: could not write the digest \(brb: the hold is locked \(.*away\.lock\)\); say it to Jo/);
    assert.equal(awayRecord(b).held, 0);
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    utimesSync(lock, old, old);
    assert.equal(run(b, ["hold", "--session", "s1", "Pick a cache"]).stdout, "held 1\n");
    assert.ok(!existsSync(lock));
    assert.equal(withAwayLock("s1", b.env, () => 7), 7);
  } finally {
    b.release();
  }
});
