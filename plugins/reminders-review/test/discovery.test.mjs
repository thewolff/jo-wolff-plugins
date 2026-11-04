// What a bare `node --test` runs. Every file it discovers runs as a test with the developer's real
// environment, so a discovered hook would write to the real state dir (it did, once:
// big-answer-hook.mjs under test/fixtures/). Executable fixtures live in test-fixtures/, outside
// discovery, and run only when their sandboxed caller sets REMINDERS_REVIEW_FIXTURE=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_DIR, sandbox } from "./helpers.mjs";

// node --test's default patterns, from https://nodejs.org/api/test.html#running-tests-from-the-command-line
const DEFAULT_PATTERNS = ["**/*.test.{cjs,mjs,js}", "**/*-test.{cjs,mjs,js}", "**/*_test.{cjs,mjs,js}", "**/test-*.{cjs,mjs,js}", "**/test.{cjs,mjs,js}", "**/test/**/*.{cjs,mjs,js}"];
/** Discovered but only imported: constants and functions, nothing at top level that runs. */
const IMPORT_ONLY = ["test/helpers.mjs"];

test("node --test discovers only *.test.mjs files and the import-only helpers", () => {
  const found = [...new Set(DEFAULT_PATTERNS.flatMap((p) => globSync(p, { cwd: PLUGIN_DIR, exclude: (f) => f === "node_modules" })))].sort();
  const stray = found.filter((f) => !f.endsWith(".test.mjs") && !IMPORT_ONLY.includes(f));
  assert.deepEqual(stray, [], `node --test would run these as tests: ${stray.join(", ")}`);
  assert.ok(found.includes("test/discovery.test.mjs"), `the pattern list is stale: found ${found.join(", ")}`);
});

test("every executable fixture is outside discovery and silent without REMINDERS_REVIEW_FIXTURE=1", () => {
  const dir = join(PLUGIN_DIR, "test-fixtures");
  const hooks = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  assert.ok(hooks.includes("big-answer-hook.mjs"));
  for (const f of hooks) {
    const box = sandbox();
    try {
      const r = spawnSync(process.execPath, [join(dir, f)], { env: box.env, input: JSON.stringify({ bytes: 10 }), encoding: "utf8", timeout: 2_000 });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
      assert.equal(r.stdout, "", `${f} answered without the flag`);
      assert.equal(existsSync(box.stateDir), false, `${f} wrote state without the flag`);
    } finally {
      box.release();
    }
  }
});
