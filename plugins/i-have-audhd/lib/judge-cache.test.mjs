// judge-cache.test.mjs — node --test
//
// The judge cache's cap (lib/judge-cache.mjs): at most 2,000 files, none older than 7 days,
// whichever bites first, oldest removed first; the judge enforces it on write when told to
// (options.capCheck); scripts/prune.mjs enforces it on every run, counts its removals in the
// `pruned:` line, ages the rest of the state directory at --days, and rotates the logs past
// 256 KiB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capCache, MAX_FILES, MAX_AGE_DAYS } from "./judge-cache.mjs";
import { askJudge } from "../judge/ask.mjs";

const D = 86_400_000;
const PRUNE = fileURLToPath(new URL("../scripts/prune.mjs", import.meta.url));

const aged = (path, days, now = Date.now()) => {
  const t = new Date(now - days * D);
  utimesSync(path, t, t);
};

/** `n` cache files, the i-th aged `i` hours, so order is deterministic. */
function fill(dir, n, now = Date.now()) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const p = join(dir, `${String(i).padStart(5, "0")}.json`);
    writeFileSync(p, "{}");
    aged(p, i / 24, now);
  }
}

test("capCache: files past 7 days go whatever the count; past 2,000 files the oldest go; both at once; nothing to do is all zeros; dry run removes nothing", () => {
  const now = Date.now();
  const dir = join(mkdtempSync(join(tmpdir(), "audhd-cache-")), "cache");
  assert.deepEqual(capCache(join(dir, "missing"), { now }), { removed: 0, bytes: 0, kept: 0 }, "no directory");
  fill(dir, 10, now);
  aged(join(dir, "00009.json"), MAX_AGE_DAYS + 1, now);
  aged(join(dir, "00008.json"), MAX_AGE_DAYS, now);
  assert.deepEqual(capCache(dir, { now, dryRun: true }), { removed: 2, bytes: 4, kept: 8 });
  assert.equal(readdirSync(dir).length, 10, "a dry run removes nothing");
  assert.deepEqual(capCache(dir, { now }), { removed: 2, bytes: 4, kept: 8 });
  assert.deepEqual(readdirSync(dir).sort().slice(-1), ["00007.json"], "the two past the age are gone, the rest stay");
  // Count: the oldest three go to bring 8 down to 5, regardless of age.
  assert.deepEqual(capCache(dir, { now, maxFiles: 5 }), { removed: 3, bytes: 6, kept: 5 });
  assert.deepEqual(readdirSync(dir).sort(), ["00000.json", "00001.json", "00002.json", "00003.json", "00004.json"]);
  // Both: one past the age and the count cap at 3 remove the two oldest, not three.
  aged(join(dir, "00004.json"), 10, now);
  assert.deepEqual(capCache(dir, { now, maxFiles: 3 }), { removed: 2, bytes: 4, kept: 3 });
  assert.deepEqual(capCache(dir, { now }), { removed: 0, bytes: 0, kept: 3 }, "under both caps nothing happens");
  assert.equal(MAX_FILES, 2000);
  assert.equal(MAX_AGE_DAYS, 7);
});

test("askJudge: a verdict write with capCheck on trims the cache; with capCheck off the cache grows past the cap", async () => {
  const state = mkdtempSync(join(tmpdir(), "audhd-cache-judge-"));
  const dir = join(state, "cache");
  fill(dir, 5);
  aged(join(dir, "00004.json"), 30);
  const judge = `printf '%s' '{"violation":false,"reason":"ok"}'`;
  const env = { ...process.env, HOME: state, XDG_CONFIG_HOME: "", I_HAVE_AUDHD_PROFILE: "", I_HAVE_AUDHD_HARNESS: "" };
  const off = await askJudge("conclusion-first", "q", "message one", { judgeCommand: judge }, { stateDir: state, env, capCheck: false });
  assert.deepEqual(off, { violation: false, reason: "ok", cached: false });
  assert.equal(readdirSync(dir).length, 6, "capCheck false: the stale file stays");
  const on = await askJudge("conclusion-first", "q", "message two", { judgeCommand: judge }, { stateDir: state, env, capCheck: true });
  assert.deepEqual(on, { violation: false, reason: "ok", cached: false });
  const names = readdirSync(dir);
  assert.equal(names.length, 6, "capCheck true: the stale file went, the new verdict stayed");
  assert.equal(names.includes("00004.json"), false);
  // The failure path writes the prompt and is capped the same way.
  aged(join(dir, "00003.json"), 30);
  const failed = await askJudge("conclusion-first", "q", "message three", { judgeCommand: "exit 3" }, { stateDir: state, env, capCheck: true });
  assert.equal(failed.unavailable, true);
  assert.equal(readdirSync(dir).filter((n) => n.endsWith(".prompt.txt")).length, 1, "the replayable prompt is written");
  assert.equal(existsSync(join(dir, "00003.json")), false, "and the cap ran");
});

test("scripts/prune.mjs: ages the state at --days, caps the cache at 7 days and 2,000 files, rotates logs past 256 KiB, prints the contract line; --dry-run counts the same and removes nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "audhd-prune-home-"));
  const state = join(home, ".claude", ".i-have-audhd-state");
  const now = Date.now();
  fill(join(state, "cache"), 3, now);
  aged(join(state, "cache", "00002.json"), 8, now); // past the cache's 7 days, inside --days 30
  writeFileSync(join(state, "resume-old"), "x");
  aged(join(state, "resume-old"), 31, now);
  writeFileSync(join(state, "warnings.log"), "w".repeat(256 * 1024 + 1));
  writeFileSync(join(state, "errors.log"), "e");
  aged(join(state, "errors.log"), 100, now);
  const run = (...args) => spawnSync(process.execPath, [PRUNE, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const dry = run("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.stdout.trim().split("\n"), [`would rotate ${join(state, "warnings.log")} to ${join(state, "warnings.log")}.1`, "pruned: 2 file(s), 3 bytes freed (dry run); kept 4"]);
  assert.equal(readdirSync(join(state, "cache")).length, 3);
  const real = run();
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(real.stdout.trim().split("\n"), [`rotated ${join(state, "warnings.log")} to ${join(state, "warnings.log")}.1`, "pruned: 2 file(s), 3 bytes freed; kept 4"]);
  assert.deepEqual(readdirSync(state).sort(), ["cache", "errors.log", "warnings.log.1"]);
  assert.deepEqual(readdirSync(join(state, "cache")).sort(), ["00000.json", "00001.json"]);
  const bad = run("--days", "-1");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^usage: prune\.mjs/);
});
