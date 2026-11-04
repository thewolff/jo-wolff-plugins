// prune-template.test.mjs — templates/scripts/prune.mjs, the retention verb every plugin copies
// (README "What it does", `scripts/prune.mjs`): files older than --days go, errors.log stays,
// every `*.log` / `*.jsonl` past 256 KiB rotates to `<name>.1` (an earlier `.1` is replaced and
// its bytes count as freed), the last line is the contract line, --dry-run changes nothing and
// prints the same count, a bad --days is usage with exit 1. Then the drift guard: every
// `plugins/*/scripts/prune.mjs` in this repository carries the contract line and the rotation.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KIT_ROOT } from "../scripts/new-plugin.mjs";

const TEMPLATE = readFileSync(join(KIT_ROOT, "templates", "scripts", "prune.mjs"), "utf8");
const D = 24 * 3_600_000;

/** The template rendered for `name` into a temp dir, with an XDG_STATE_HOME beside it. */
function render(name = "trial") {
  const base = mkdtempSync(join(tmpdir(), "kit-prune-"));
  const script = join(base, "prune.mjs");
  writeFileSync(script, TEMPLATE.replaceAll("{{name}}", name));
  const xdg = join(base, "state");
  const dir = join(xdg, name);
  mkdirSync(dir, { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: xdg } });
  return { base, script, xdg, dir, run };
}

const aged = (path, days) => {
  const t = new Date(Date.now() - days * D);
  utimesSync(path, t, t);
};

test("template prune: old files go, errors.log stays, empty directories go, dry run plans the same and removes nothing, bad --days is usage", () => {
  const { dir, run } = render();
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "old.json"), "12345");
  aged(join(dir, "sub", "old.json"), 40);
  writeFileSync(join(dir, "fresh.json"), "x");
  writeFileSync(join(dir, "errors.log"), "fault\n");
  aged(join(dir, "errors.log"), 400);
  const dry = run("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout, "pruned: 1 file(s), 5 bytes freed (dry run); kept 2\n");
  assert.equal(existsSync(join(dir, "sub", "old.json")), true, "a dry run removes nothing");
  const real = run();
  assert.equal(real.status, 0, real.stderr);
  assert.equal(real.stdout, "pruned: 1 file(s), 5 bytes freed; kept 2\n");
  assert.deepEqual(readdirSync(dir).sort(), ["errors.log", "fresh.json"], "the emptied directory goes with its file; errors.log stays at any age");
  const bad = run("--days", "soon");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^usage: prune\.mjs \[--days N\] \[--dry-run\]/);
  assert.equal(run("--bogus").status, 1);
  const none = render("never-written");
  const r = spawnSync(process.execPath, [none.script], { encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: join(none.base, "elsewhere") } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "pruned: 0 file(s), 0 bytes freed; kept 0\n", "no state directory is an empty prune, exit 0");
});

test("template prune: a *.log or *.jsonl past 256 KiB rotates to <name>.1 (errors.log included), a replaced .1 counts as freed, a .1 ages out later, a small or non-log file never rotates", () => {
  const { dir, run } = render();
  const big = "x".repeat(256 * 1024 + 1);
  mkdirSync(join(dir, "judge"), { recursive: true });
  writeFileSync(join(dir, "errors.log"), big);
  writeFileSync(join(dir, "errors.log.1"), "old rotation");
  writeFileSync(join(dir, "warnings.log"), big);
  writeFileSync(join(dir, "judge", "usage.jsonl"), big);
  writeFileSync(join(dir, "judge", "usage.json"), big); // a .json is data, not a log
  writeFileSync(join(dir, "small.log"), "x".repeat(256 * 1024)); // exactly the cap does not rotate
  const dry = run("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  const dryLines = dry.stdout.trim().split("\n");
  assert.equal(dryLines.at(-1), "pruned: 1 file(s), 12 bytes freed (dry run); kept 6", "the .1 that would be replaced is the one file freed");
  assert.deepEqual(
    dryLines.slice(0, -1).sort(),
    [`would rotate ${join(dir, "errors.log")} to ${join(dir, "errors.log")}.1`, `would rotate ${join(dir, "judge", "usage.jsonl")} to ${join(dir, "judge", "usage.jsonl")}.1`, `would rotate ${join(dir, "warnings.log")} to ${join(dir, "warnings.log")}.1`],
  );
  assert.equal(readFileSync(join(dir, "errors.log.1"), "utf8"), "old rotation", "a dry run renames nothing");
  const real = run();
  assert.equal(real.status, 0, real.stderr);
  assert.equal(real.stdout.trim().split("\n").at(-1), "pruned: 1 file(s), 12 bytes freed; kept 6");
  assert.deepEqual(readdirSync(dir).sort(), ["errors.log.1", "judge", "small.log", "warnings.log.1"]);
  assert.equal(statSync(join(dir, "errors.log.1")).size, big.length, "the big log is now the .1; the old .1 is gone");
  assert.deepEqual(readdirSync(join(dir, "judge")).sort(), ["usage.json", "usage.jsonl.1"]);
  // The .1 is an ordinary file from here: it ages out, and it never rotates again.
  aged(join(dir, "errors.log.1"), 40);
  const later = run();
  assert.equal(later.stdout, `pruned: 1 file(s), ${big.length} bytes freed; kept 4\n`, "the three other logs and usage.json stay");
  assert.equal(existsSync(join(dir, "errors.log.1")), false);
});

/** A big log that is a symlink to an outside file, beside a real `.1`: the prune leaves both alone. */
function symlinkFixture(dir) {
  const outside = mkdtempSync(join(tmpdir(), "kit-prune-outside-"));
  const target = join(outside, "target.log");
  writeFileSync(target, "x".repeat(300 * 1024));
  symlinkSync(target, join(dir, "x.log"));
  writeFileSync(join(dir, "x.log.1"), "previous rotation");
  return target;
}

function assertSymlinkUntouched(dir, target, label) {
  assert.equal(lstatSync(join(dir, "x.log")).isSymbolicLink(), true, `${label}: the linked x.log is still a symlink`);
  assert.equal(lstatSync(join(dir, "x.log.1")).isFile(), true, `${label}: x.log.1 is still a regular file`);
  assert.equal(readFileSync(join(dir, "x.log.1"), "utf8"), "previous rotation", `${label}: the previous rotation is kept`);
  assert.equal(statSync(target).size, 300 * 1024, `${label}: the link's target is untouched`);
}

/** A fresh big log beside a `.1` already past --days: the age walk removes the `.1`, the rotation must not count it again. */
function expiredPredecessorFixture(dir) {
  writeFileSync(join(dir, "x.log"), "x".repeat(300 * 1024));
  writeFileSync(join(dir, "x.log.1"), "abc");
  aged(join(dir, "x.log.1"), 31);
}

test("template prune: a symlinked x.log is skipped: not rotated, its regular x.log.1 kept, nothing counted", () => {
  const linked = render();
  const target = symlinkFixture(linked.dir);
  const r = linked.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "pruned: 0 file(s), 0 bytes freed; kept 1\n", "the symlink is neither rotated nor counted");
  assertSymlinkUntouched(linked.dir, target, "template");
});

test("template prune: a dry run with an already-expired x.log.1 prints the real run's totals (the .1 is not counted twice)", () => {
  const { dir, run } = render();
  expiredPredecessorFixture(dir);
  const dry = run("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  const real = run();
  assert.equal(real.status, 0, real.stderr);
  assert.equal(real.stdout.trim().split("\n").at(-1), "pruned: 1 file(s), 3 bytes freed; kept 1");
  assert.equal(dry.stdout.replaceAll("would rotate", "rotated").replace(" (dry run)", ""), real.stdout, "a dry run's totals are the real run's");
});

test("every template-following plugins/*/scripts/prune.mjs skips symlinks and counts a dry run like the real run", async () => {
  const plugins = join(KIT_ROOT, "..");
  // as2-skills prunes `$TMPDIR/seo-audit-*` directories with its own walk, not the template's.
  const copies = readdirSync(plugins).filter((n) => n !== "as2-skills" && existsSync(join(plugins, n, "scripts", "prune.mjs")));
  assert.ok(copies.length >= 7, `expected the template-following plugins, saw ${copies.join(", ")}`);
  const now = Date.now();
  for (const name of copies) {
    const { prune } = await import(pathToFileURL(join(plugins, name, "scripts", "prune.mjs")).href);
    const linked = mkdtempSync(join(tmpdir(), `kit-prune-${name}-`));
    const target = symlinkFixture(linked);
    const r = prune(linked, { now });
    assert.deepEqual([r.removed, r.bytes, r.rotated], [0, 0, []], `${name}: the symlink is neither rotated nor freed`);
    assertSymlinkUntouched(linked, target, name);

    const dir = mkdtempSync(join(tmpdir(), `kit-prune-${name}-`));
    expiredPredecessorFixture(dir);
    const dry = prune(dir, { now, dryRun: true });
    const real = prune(dir, { now });
    assert.deepEqual(dry, real, `${name}: a dry run's totals are the real run's`);
    assert.deepEqual([real.removed, real.bytes], [1, 3], `${name}: only the expired .1 is freed`);
  }
});

test("drift guard: every plugins/*/scripts/prune.mjs carries the contract line, the usage line and (for a state directory) the 256 KiB rotation", () => {
  const plugins = join(KIT_ROOT, "..");
  const copies = readdirSync(plugins).filter((n) => existsSync(join(plugins, n, "scripts", "prune.mjs")));
  assert.ok(copies.length >= 7, `expected the template-following plugins, saw ${copies.join(", ")}`);
  // as2-skills prunes `$TMPDIR/seo-audit-*` directories: nothing there is an appended log.
  const noLogs = new Set(["as2-skills"]);
  const contract = 'pruned: ${r.removed} file(s), ${r.bytes} bytes freed${dryRun ? " (dry run)" : ""}; kept ${r.kept}';
  for (const name of copies) {
    const text = readFileSync(join(plugins, name, "scripts", "prune.mjs"), "utf8");
    assert.ok(text.includes(contract), `${name}: the pruned: line is the template's`);
    assert.ok(text.includes("usage: prune.mjs [--days N] [--dry-run]"), `${name}: the usage line is the template's`);
    if (noLogs.has(name)) continue;
    assert.ok(text.includes("MAX_LOG_BYTES = 256 * 1024"), `${name}: rotates logs at 256 KiB`);
    assert.ok(text.includes("renameSync(log.path, old)"), `${name}: rotates by rename to <name>.1`);
  }
});
