// gh-cache-fill.test.mjs — node --test
//
// `gh api` is never run here: parseGhResult is fed the captured outputs in scripts/fixtures
// (real `gh` runs, see CAPTURED.txt) and fill() takes an injected runGh. The cache file lives
// in a temp directory; errors.log goes to a temp HOME.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const tmpHome = mkdtempSync(join(tmpdir(), "audhd-ghfill-"));
process.env.HOME = tmpHome;
delete process.env.I_HAVE_AUDHD_HARNESS;

const { parseGhResult, fill, lockHeld } = await import("./gh-cache-fill.mjs");
const { readGhCache, lookupGh, ghCacheLockPath } = await import("../lib/gh-cache.mjs");

const fixture = (name) => ({
  status: Number(readFileSync(join(HERE, "fixtures", `gh-api-${name}.exit.txt`), "utf8").trim()),
  stdout: readFileSync(join(HERE, "fixtures", `gh-api-${name}.stdout.txt`), "utf8"),
  stderr: readFileSync(join(HERE, "fixtures", `gh-api-${name}.stderr.txt`), "utf8"),
});

test("parseGhResult: the captured gh outputs for a PR, an issue, a 404 and a no-auth run", () => {
  assert.deepEqual(parseGhResult(fixture("pr")), { kind: "pr", title: readFixtureTitle("pr") });
  assert.deepEqual(parseGhResult(fixture("issue")), { kind: "issue", title: readFixtureTitle("issue") });
  assert.deepEqual(parseGhResult(fixture("404")), { missing: true });
  assert.deepEqual(parseGhResult(fixture("noauth")), { error: "gh-not-logged-in" });
});

function readFixtureTitle(name) {
  return JSON.parse(readFileSync(join(HERE, "fixtures", `gh-api-${name}.stdout.txt`), "utf8")).title;
}

test("parseGhResult: gh missing from PATH, rate limits, and junk stdout are errors, never a kind", () => {
  assert.deepEqual(parseGhResult({ error: { code: "ENOENT" } }), { error: "gh-not-found" });
  assert.deepEqual(parseGhResult({ status: 1, stdout: "", stderr: "gh: API rate limit exceeded for user (HTTP 403)" }), { error: "gh-rate-limited" });
  assert.deepEqual(parseGhResult({ status: 0, stdout: "not json", stderr: "" }), { error: "gh-unparseable" });
  assert.deepEqual(parseGhResult({ status: 0, stdout: '{"number":1}', stderr: "" }), { error: "gh-unparseable" });
  assert.match(parseGhResult({ status: 1, stdout: "", stderr: "dial tcp: no route" }).error, /^gh-exit-1 dial tcp/);
});

const cacheDir = () => mkdtempSync(join(tmpdir(), "audhd-ghcache-"));
const NOW = Date.parse("2026-11-04T12:00:00Z");

test("fill: writes a hit, an issue and a miss for the keys it looked up; a later read sees them", () => {
  const path = join(cacheDir(), "gh-cache.json");
  const answers = { "o/r#1": fixture("pr"), "o/r#2": fixture("issue"), "o/r#3": fixture("404") };
  const r = fill(path, ["o/r#1", "o/r#2", "o/r#3", "o/r#1"], { runGh: (p) => answers[`${p.owner}/${p.repo}#${p.number}`], now: () => NOW });
  assert.equal(r.looked, 3);
  assert.equal(r.error, null);
  const c = readGhCache(path);
  assert.equal(lookupGh(c, "o/r#1", NOW).kind, "pr");
  assert.equal(lookupGh(c, "o/r#2", NOW).kind, "issue");
  assert.equal(lookupGh(c, "o/r#3", NOW).kind, "missing");
  assert.equal(c.helper.error, null);
  assert.equal(existsSync(ghCacheLockPath(path)), false, "lock released");
});

test("fill: keeps what an earlier run learned, drops entries past the hit TTL", () => {
  const path = join(cacheDir(), "gh-cache.json");
  const old = new Date(NOW - 8 * 24 * 3_600_000).toISOString();
  const fresh = new Date(NOW - 1000).toISOString();
  writeFileSync(path, JSON.stringify({ entries: { "o/r#9": { kind: "issue", title: "old", at: old }, "o/r#8": { kind: "pr", title: "kept", at: fresh } } }));
  fill(path, ["o/r#1"], { runGh: () => fixture("pr"), now: () => NOW });
  const c = readGhCache(path);
  assert.deepEqual(Object.keys(c.entries).sort(), ["o/r#1", "o/r#8"]);
});

test("fill: a lookup failure records nothing for the key, sets helper.error, logs once and then not again inside the hour", () => {
  const path = join(cacheDir(), "gh-cache.json");
  const errorsLog = join(tmpHome, ".claude", ".i-have-audhd-state", "errors.log");
  const lines = () => (existsSync(errorsLog) ? readFileSync(errorsLog, "utf8").split("\n").filter(Boolean).length : 0);
  const before = lines();
  let r = fill(path, ["o/r#1", "o/r#2"], { runGh: () => fixture("noauth"), now: () => NOW });
  assert.equal(r.error, "gh-not-logged-in");
  assert.equal(r.looked, 1, "stops after an auth failure: the rest would fail the same way");
  let c = readGhCache(path);
  assert.deepEqual(c.entries, {});
  assert.equal(c.helper.error, "gh-not-logged-in");
  const afterFirst = lines();
  assert.equal(afterFirst - before, 1);
  assert.match(readFileSync(errorsLog, "utf8"), /gh-not-logged-in.*links-resolve/);
  // Same error ten minutes later: no new line. An hour later: one more.
  fill(path, ["o/r#1"], { runGh: () => fixture("noauth"), now: () => NOW + 600_000 });
  assert.equal(lines(), afterFirst);
  fill(path, ["o/r#1"], { runGh: () => fixture("noauth"), now: () => NOW + 3_700_000 });
  assert.equal(lines(), afterFirst + 1);
  // Recovery clears helper.error.
  fill(path, ["o/r#1"], { runGh: () => fixture("pr"), now: () => NOW + 3_800_000 });
  c = readGhCache(path);
  assert.equal(c.helper.error, null);
  assert.equal(c.entries["o/r#1"].kind, "pr");
});

test("fill: a held lock means another fill is running; nothing is looked up. A stale lock is ignored", () => {
  const path = join(cacheDir(), "gh-cache.json");
  const lock = ghCacheLockPath(path);
  writeFileSync(lock, "99999");
  assert.equal(lockHeld(path), true);
  let calls = 0;
  const r = fill(path, ["o/r#1"], { runGh: () => (calls++, fixture("pr")), now: () => Date.now() });
  assert.equal(r.looked, 0);
  assert.equal(calls, 0);
  assert.equal(existsSync(lock), true, "someone else's lock is left alone");
  const stale = new Date(Date.now() - 600_000);
  utimesSync(lock, stale, stale);
  assert.equal(lockHeld(path), false);
  const r2 = fill(path, ["o/r#1"], { runGh: () => (calls++, fixture("pr")), now: () => Date.now() });
  assert.equal(r2.looked, 1);
});

test("fill: at most FILL_MAX_KEYS keys per run and the budget stops a slow run", () => {
  const path = join(cacheDir(), "gh-cache.json");
  const keys = Array.from({ length: 30 }, (_, i) => `o/r#${i + 1}`);
  const r = fill(path, keys, { runGh: () => fixture("issue"), now: () => NOW, maxKeys: 20 });
  assert.equal(r.looked, 20);
  let t = NOW;
  const slow = fill(join(cacheDir(), "gh-cache.json"), keys, { runGh: () => ((t += 20_000), fixture("issue")), now: () => t, budgetMs: 45_000 });
  assert.ok(slow.looked < 30 && slow.looked >= 2, `looked ${slow.looked}`);
});

test("CLI: no arguments is usage on stderr and exit 2; a malformed cache file reads as empty", () => {
  const r = spawnSync(process.execPath, [join(HERE, "gh-cache-fill.mjs")], { encoding: "utf8", env: { ...process.env, HOME: tmpHome } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
  const path = join(cacheDir(), "gh-cache.json");
  writeFileSync(path, "{not json");
  assert.deepEqual(readGhCache(path).entries, {});
});
