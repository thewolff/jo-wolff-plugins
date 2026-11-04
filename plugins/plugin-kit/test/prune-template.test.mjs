// prune-template.test.mjs — templates/scripts/prune.mjs, the retention verb every plugin copies
// (README "What it does", `scripts/prune.mjs`): files older than --days go, errors.log stays,
// every `*.log` / `*.jsonl` past 256 KiB rotates to `<name>.1` (an earlier `.1` is replaced and
// its bytes count as freed), the last line is the contract line, --dry-run changes nothing and
// prints the same count, a bad --days is usage with exit 1. Then the drift guard: every
// `plugins/*/scripts/prune.mjs` in this repository carries the contract line and the rotation.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
