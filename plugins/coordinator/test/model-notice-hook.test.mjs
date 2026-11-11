// The PostModelSwitch hook as a spawned process, fed test/fixtures/post-model-switch.json: the
// field set and the from/to/source values of a real desktop-app switch (claude-opus-5-5 →
// claude-sonnet-5-5, source "sdk", captured from the desktop app on 2026-11-11); ids, paths and
// the cost fields are placeholders, since the capture kept keys and model values only.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "hooks", "model-notice.mjs");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "post-model-switch.json"), "utf8"));

function box(config) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coordinator-hook-")));
  const work = join(root, "work");
  mkdirSync(work);
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
  if (config !== undefined) {
    mkdirSync(join(env.XDG_CONFIG_HOME, "coordinator"), { recursive: true });
    writeFileSync(join(env.XDG_CONFIG_HOME, "coordinator", "config.json"), typeof config === "string" ? config : JSON.stringify(config(work)));
  }
  const run = (overrides = {}) => {
    const r = spawnSync("node", [HOOK], { env, input: JSON.stringify({ ...FIXTURE, cwd: work, ...overrides }), encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const skipped = () => {
    try {
      return readFileSync(join(env.XDG_STATE_HOME, "coordinator", "skipped.log"), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { run, skipped, release: () => rmSync(root, { recursive: true, force: true }) };
}

test("the captured switch, inside a listed folder, gets the model-only notice as additionalContext", () => {
  const b = box((work) => ({ folders: [work] }));
  try {
    const out = b.run();
    assert.equal(out.hookSpecificOutput.hookEventName, "PostModelSwitch");
    assert.match(out.hookSpecificOutput.additionalContext, /^Coordinator notice: this session is running claude-sonnet-5-5 \(effort not visible to hooks here\)\./);
    assert.equal(out.systemMessage, undefined);
  } finally {
    b.release();
  }
});

test("the captured switch back onto the expected model says the earlier notice no longer applies", () => {
  const b = box((work) => ({ folders: [work] }));
  try {
    const out = b.run({ from_model: "claude-sonnet-5-5", to_model: "claude-opus-5-5" });
    assert.equal(out.hookSpecificOutput.additionalContext, "Coordinator notice: this session is now on claude-opus-5-5. The earlier model notice no longer applies.");
  } finally {
    b.release();
  }
});

test("no config: silent (the folder list is empty by default)", () => {
  const b = box();
  try {
    assert.equal(b.run(), null);
  } finally {
    b.release();
  }
});

test("an alias as to_model: silent, with one skipped.log line", () => {
  const b = box((work) => ({ folders: [work] }));
  try {
    assert.equal(b.run({ to_model: "sonnet" }), null);
    const lines = b.skipped();
    assert.equal(lines.length, 1);
    assert.match(lines[0], / model-notice to_model "sonnet" is not a claude- model id; cannot judge$/);
  } finally {
    b.release();
  }
});

test("off: true is silent even on a wrong-model switch", () => {
  const b = box((work) => ({ off: true, folders: [work] }));
  try {
    assert.equal(b.run(), null);
  } finally {
    b.release();
  }
});

test("a malformed config: defaults (silent) plus a systemMessage naming the file", () => {
  const b = box("{ not json");
  try {
    const out = b.run();
    assert.equal(out.hookSpecificOutput, undefined);
    assert.match(out.systemMessage, /^coordinator model-notice: config ignored: .*coordinator\/config\.json is not JSON/);
  } finally {
    b.release();
  }
});

test("a field of the wrong type: defaults plus a systemMessage naming the field", () => {
  const b = box(() => ({ folders: ["relative/path"] }));
  try {
    assert.match(b.run().systemMessage, /folders must be an array of absolute paths; using defaults$/);
  } finally {
    b.release();
  }
});
