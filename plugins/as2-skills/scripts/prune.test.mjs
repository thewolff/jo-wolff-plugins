// prune.test.mjs — scripts/prune.mjs, the plugin's prune verb for `$TMPDIR/seo-audit-*`:
// a `seo-audit-*` directory older than --days (default 1) goes with everything in it, a younger
// one and anything not so named stays, the last line is the plugin-kit contract line, --dry-run
// counts the same and removes nothing, a bad --days is usage with exit 1.
//
// Run as `node --test skills.test.mjs scripts/prune.test.mjs` (a bare `node --test` picks up the
// Bun tests under skills/*/test/).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prune } from "./prune.mjs";

const SCRIPT = fileURLToPath(new URL("./prune.mjs", import.meta.url));
const D = 86_400_000;

function seed() {
  const base = mkdtempSync(join(tmpdir(), "as2-prune-test-"));
  const now = Date.now();
  const old = new Date(now - 2 * D);
  const dir = (name, mtime) => {
    const p = join(base, name);
    mkdirSync(join(p, "sub"), { recursive: true });
    writeFileSync(join(p, "a.json"), "12345");
    writeFileSync(join(p, "sub", "b"), "67");
    if (mtime) {
      utimesSync(join(p, "a.json"), mtime, mtime);
      utimesSync(join(p, "sub", "b"), mtime, mtime);
      utimesSync(join(p, "sub"), mtime, mtime);
      utimesSync(p, mtime, mtime);
    }
    return p;
  };
  const stale = dir("seo-audit-lh-abc", old);
  const staleChrome = dir("seo-audit-chrome-def", old);
  const fresh = dir("seo-audit-lh-ghi");
  const other = dir("other-tool-xyz", old);
  writeFileSync(join(base, "seo-audit-file"), "not a directory");
  utimesSync(join(base, "seo-audit-file"), old, old);
  return { base, now, stale, staleChrome, fresh, other };
}

test("prune: stale seo-audit-* directories go with their contents; a fresh one, another tool's and a plain file stay; dry run counts the same and removes nothing; no base is nothing", () => {
  const s = seed();
  assert.deepEqual(prune(s.base, { now: s.now, dryRun: true }), { removed: 4, bytes: 14, kept: 1 });
  assert.equal(existsSync(s.stale), true, "a dry run removes nothing");
  assert.deepEqual(prune(s.base, { now: s.now }), { removed: 4, bytes: 14, kept: 1 });
  assert.deepEqual(readdirSync(s.base).sort(), ["other-tool-xyz", "seo-audit-file", "seo-audit-lh-ghi"]);
  assert.deepEqual(prune(s.base, { now: s.now }), { removed: 0, bytes: 0, kept: 1 });
  assert.deepEqual(prune(s.base, { now: Date.now() + 1000, days: 0 }), { removed: 2, bytes: 7, kept: 0 }, "--days 0 takes the fresh one too");
  assert.deepEqual(prune(join(s.base, "nowhere"), { now: s.now }), { removed: 0, bytes: 0, kept: 0 });
});

test("the CLI (the command plugin.json declares) reads $TMPDIR, ends with the contract line, takes --dry-run, and refuses a bad --days", () => {
  const s = seed();
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, TMPDIR: s.base } });
  const dry = run("--days", "1", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout, "pruned: 4 file(s), 14 bytes freed (dry run); kept 1\n");
  assert.equal(existsSync(s.stale), true);
  const real = run("--days", "1");
  assert.equal(real.status, 0, real.stderr);
  assert.equal(real.stdout, "pruned: 4 file(s), 14 bytes freed; kept 1\n");
  assert.equal(existsSync(s.stale), false);
  assert.equal(existsSync(s.staleChrome), false);
  assert.equal(existsSync(s.fresh), true);
  assert.equal(existsSync(s.other), true);
  const bad = run("--days", "soon");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^usage: prune\.mjs \[--days N\] \[--dry-run\]/);
  assert.equal(run("--bogus").status, 1);
  const declared = JSON.parse(spawnSync("cat", [join(fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url)))], { encoding: "utf8" }).stdout);
  assert.deepEqual(declared.state, [{ path: "$TMPDIR/seo-audit-*", retentionDays: 1, prune: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/prune.mjs" --days 1' }]);
});
