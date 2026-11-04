import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prune } from "../lib/retention.mjs";
import { PLUGIN_DIR, sandbox } from "./helpers.mjs";

const DAY = 86_400_000;

function seed(box) {
  const s = join(box.stateDir, "sessions");
  mkdirSync(s, { recursive: true });
  const old = (Date.now() - 40 * DAY) / 1000;
  const files = { oldStamp: join(s, "old.json"), newStamp: join(s, "new.json"), oldTmp: join(s, "x.json.1.tmp"), log: join(box.stateDir, "errors.log"), oldRotated: join(box.stateDir, "errors.log.1") };
  for (const p of Object.values(files)) writeFileSync(p, "{}\n");
  for (const p of [files.oldStamp, files.oldTmp, files.oldRotated, files.log]) utimesSync(p, old, old);
  return files;
}

test("prune removes stamps, temp files and rotated logs past their age; never the current errors.log", () => {
  const box = sandbox({ withStub: false });
  try {
    const f = seed(box);
    const r = prune(box.stateDir, { days: 30 });
    assert.equal(r.removed, 3);
    assert.equal(r.kept, 1);
    assert.deepEqual(r.problems, []);
    assert.equal(existsSync(f.oldStamp), false);
    assert.equal(existsSync(f.oldTmp), false);
    assert.equal(existsSync(f.oldRotated), false);
    assert.equal(existsSync(f.newStamp), true);
    assert.equal(existsSync(f.log), true);
  } finally {
    box.release();
  }
});

test("prune rotates an errors.log over the cap; a missing state dir is nothing to do", () => {
  const box = sandbox({ withStub: false });
  try {
    mkdirSync(box.stateDir, { recursive: true });
    writeFileSync(join(box.stateDir, "errors.log"), "x".repeat(100));
    const r = prune(box.stateDir, { maxBytes: 10 });
    assert.deepEqual(r.rotated, [join(box.stateDir, "errors.log")]);
    assert.equal(existsSync(join(box.stateDir, "errors.log.1")), true);
    assert.deepEqual(prune(join(box.root, "nothing-here")), { rotated: [], removed: 0, bytes: 0, kept: 0, problems: [] });
  } finally {
    box.release();
  }
});

test("the CLI's prune verb (the command plugin.json declares) and its dry run", () => {
  const box = sandbox({ withStub: false });
  try {
    const f = seed(box);
    const cli = join(PLUGIN_DIR, "scripts", "reminders-review.mjs");
    const dry = spawnSync(process.execPath, [cli, "prune", "--days", "30", "--dry-run"], { env: box.env, encoding: "utf8" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).removed, 3);
    assert.equal(existsSync(f.oldStamp), true);
    const real = spawnSync(process.execPath, [cli, "prune", "--days", "30"], { env: box.env, encoding: "utf8" });
    assert.equal(real.status, 0, real.stderr);
    assert.equal(JSON.parse(real.stdout).dir, box.stateDir);
    assert.equal(existsSync(f.oldStamp), false);
    assert.equal(spawnSync(process.execPath, [cli, "nope"], { env: box.env, encoding: "utf8" }).status, 2);
  } finally {
    box.release();
  }
});
