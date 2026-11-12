import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, configPath, loadConfig, logSkipped, stateDir, withFault } from "../lib/config.mjs";

function env(text) {
  const root = mkdtempSync(join(tmpdir(), "coordinator-config-"));
  const e = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  if (text !== undefined) {
    mkdirSync(join(e.XDG_CONFIG_HOME, "coordinator"), { recursive: true });
    writeFileSync(configPath(e), text);
  }
  return { e, release: () => rmSync(root, { recursive: true, force: true }) };
}

test("paths follow XDG, then HOME", () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: "/x" }), "/x/coordinator/config.json");
  assert.equal(configPath({ HOME: "/h" }), "/h/.config/coordinator/config.json");
  assert.equal(stateDir({ HOME: "/h" }), "/h/.local/state/coordinator");
});

test("no file gives the defaults and no fault", () => {
  const { e, release } = env();
  try {
    const r = loadConfig(e);
    assert.deepEqual(r.config, { ...DEFAULTS });
    assert.equal(r.fault, null);
    assert.deepEqual(DEFAULTS.folders, []);
    assert.equal(DEFAULTS.expectedModel, "claude-opus-5-5");
    assert.equal(DEFAULTS.clock, true);
  } finally {
    release();
  }
});

test("every field is read when valid", () => {
  const { e, release } = env(JSON.stringify({ off: true, folders: ["/a", "/b/"], expectedModel: " claude-x ", expectedEffort: "high", clock: false }));
  try {
    assert.deepEqual(loadConfig(e), { config: { off: true, folders: ["/a", "/b/"], expectedModel: "claude-x", modelFamilyRank: DEFAULTS.modelFamilyRank, expectedEffort: "high", clock: false }, path: configPath(e), fault: null });
  } finally {
    release();
  }
});

for (const [what, text, why] of [
  ["not JSON", "{", /is not JSON/],
  ["an array", "[]", /is not a JSON object/],
  ["a non-boolean clock", '{"clock":"no"}', /clock must be true or false/],
  ["an empty expectedModel", '{"expectedModel":""}', /expectedModel must be a non-empty string/],
  ["an empty modelFamilyRank", '{"modelFamilyRank":[]}', /modelFamilyRank must be a non-empty array/],
  ["an uppercase family", '{"modelFamilyRank":["Opus"]}', /modelFamilyRank must be a non-empty array/],
  ["a relative folder", '{"folders":["here"]}', /folders must be an array of absolute paths/],
]) {
  test(`${what}: every field is its default, and the fault names why`, () => {
    const { e, release } = env(text);
    try {
      const r = loadConfig(e);
      assert.deepEqual(r.config, { ...DEFAULTS });
      assert.match(r.fault, why);
    } finally {
      release();
    }
  });
}

test("modelFamilyRank is read when valid", () => {
  const { e, release } = env(JSON.stringify({ modelFamilyRank: ["haiku", "newfam"] }));
  try {
    assert.deepEqual(loadConfig(e).config.modelFamilyRank, ["haiku", "newfam"]);
  } finally {
    release();
  }
});

test("logSkipped appends one line, and an unwritable state is swallowed", () => {
  const { e, release } = env();
  try {
    logSkipped("model-notice", "a  b\nc", e);
    assert.match(readFileSync(join(stateDir(e), "skipped.log"), "utf8"), /^\S+ model-notice a b c\n$/);
    writeFileSync(join(e.XDG_STATE_HOME, "blocker"), "");
    assert.doesNotThrow(() => logSkipped("x", "y", { ...e, XDG_STATE_HOME: join(e.XDG_STATE_HOME, "blocker") }));
  } finally {
    release();
  }
});

test("withFault adds a systemMessage, or keeps the answer as is without a fault", () => {
  assert.equal(withFault(null, null, "h"), null);
  assert.deepEqual(withFault(null, "bad", "h"), { systemMessage: "coordinator h: config ignored: bad" });
  assert.deepEqual(withFault({ systemMessage: "a" }, "bad", "h"), { systemMessage: "a\ncoordinator h: config ignored: bad" });
});

test("a config path that cannot be read for a reason other than absence is a fault, not a silent default", () => {
  const { e, release } = env();
  try {
    mkdirSync(join(e.XDG_CONFIG_HOME, "coordinator", "config.json"), { recursive: true });
    const r = loadConfig(e);
    assert.deepEqual(r.config, { ...DEFAULTS });
    assert.match(r.fault, /config\.json could not be read \(EISDIR\); using defaults$/);
  } finally {
    release();
  }
});

test("a missing config is the defaults with no fault", () => {
  const { e, release } = env();
  try {
    assert.equal(loadConfig(e).fault, null);
  } finally {
    release();
  }
});

test("logSkipped returns null on success and names the file and error when the append fails", () => {
  const { e, release } = env();
  try {
    assert.equal(logSkipped("h", "ok", e), null);
    rmSync(join(stateDir(e), "skipped.log"));
    mkdirSync(join(stateDir(e), "skipped.log"));
    assert.match(logSkipped("h", "lost", e), /^could not write .*skipped\.log \(EISDIR\); the skipped-model trace was lost$/);
  } finally {
    release();
  }
});
