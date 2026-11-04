// test/retention.test.mjs — prune() on a real temporary directory: a log rotated by this prune
// is never removed by the same prune's age rule (not even with `days: 0`, when the tick that
// launchd started may still be writing to it); a state or popup temp file whose writer is still
// running is left alone; and a dry run plans exactly what the real run then does.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prune, logFiles, MAX_LOG_BYTES } from "../lib/retention.mjs";

const NOW = 1_793_784_000_000;
const DAY = 86_400_000;

/** A pid that has exited (a child that ran and was reaped). */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

function setAge(p, ms) {
  const t = new Date(NOW - ms);
  utimesSync(p, t, t);
}

/** A state directory with an oversized current out log, an old `.1` it will replace, and two old temp files: one whose writer is this (live) process, one whose writer exited. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-retention-"));
  const [errors, out] = logFiles(dir);
  mkdirSync(join(dir, "launchd"), { recursive: true });
  writeFileSync(out, "x".repeat(MAX_LOG_BYTES + 10));
  setAge(out, 40 * DAY);
  writeFileSync(`${out}.1`, "y".repeat(20));
  setAge(`${out}.1`, 40 * DAY);
  writeFileSync(`${errors}.1`, "z".repeat(7));
  setAge(`${errors}.1`, 40 * DAY);
  const live = join(dir, `state.json.${process.pid}.tmp`);
  const dead = join(dir, `state.json.${deadPid()}.tmp`);
  const popupDead = join(dir, `popup.json.${deadPid()}.tmp`);
  for (const p of [live, dead, popupDead]) {
    writeFileSync(p, "{}");
    setAge(p, 40 * DAY);
  }
  writeFileSync(join(dir, "state.json"), "{}");
  setAge(join(dir, "state.json"), 40 * DAY);
  return { dir, out, errors, live, dead, popupDead, release: () => rmSync(dir, { recursive: true, force: true }) };
}

test("prune --days 0 keeps the log it just rotated, however old its mtime; removes everything else past the cutoff", () => {
  const f = fixture();
  try {
    const r = prune(f.dir, { days: 0, now: NOW });
    assert.deepEqual(r.rotated, [f.out]);
    assert.ok(existsSync(`${f.out}.1`), "the just-rotated log survives the same prune");
    assert.equal(statSync(`${f.out}.1`).size, MAX_LOG_BYTES + 10, "and it is the log that was current, not the old .1");
    assert.equal(existsSync(`${f.errors}.1`), false, "an older rotation is past a 0-day cutoff");
    assert.equal(existsSync(f.dead), false);
    assert.equal(existsSync(f.popupDead), false);
    assert.ok(existsSync(f.live), "a temp file whose writer is running is left alone");
    assert.ok(existsSync(join(f.dir, "state.json")), "state.json is never pruned");
    assert.deepEqual([...r.removedPaths].sort(), [`${f.errors}.1`, f.dead, f.popupDead].sort());
    assert.equal(r.removed, 3);
    assert.equal(r.bytes, 7 + 2 + 2);
    assert.equal(r.kept, 2, "the just-rotated log and the live temp file");
    assert.deepEqual(r.problems, []);
  } finally {
    f.release();
  }
});

test("a dry run plans what the real run does on the same directory, and changes nothing", () => {
  for (const days of [0, 30]) {
    const f = fixture();
    try {
      const before = statSync(`${f.out}.1`).size;
      const dry = prune(f.dir, { days, now: NOW, dryRun: true });
      assert.equal(statSync(`${f.out}.1`).size, before, "dry run rotated nothing");
      assert.ok(existsSync(f.out) && existsSync(f.dead) && existsSync(`${f.errors}.1`), "dry run removed nothing");
      const real = prune(f.dir, { days, now: NOW });
      assert.deepEqual(dry, real, `days ${days}`);
    } finally {
      f.release();
    }
  }
});
