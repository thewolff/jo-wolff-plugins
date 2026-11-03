import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, repoConfigPath, resolveConfig, userConfigPath } from "./config.mjs";

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pattern-check-config-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const config = join(base, "config");
  const repo = join(base, "repo");
  const sub = join(repo, "src", "deep");
  mkdirSync(sub, { recursive: true });
  const env = { XDG_CONFIG_HOME: config };
  const setUser = (text) => { mkdirSync(join(config, "pattern-check"), { recursive: true }); writeFileSync(join(config, "pattern-check", "config.json"), text); };
  const setRepo = (text) => writeFileSync(join(repo, ".pattern-check.json"), text);
  return { base, config, repo, sub, env, setUser, setRepo, resolve: () => resolveConfig({ cwd: sub, env, home: base }) };
}

test("no files: the defaults, no faults", (t) => {
  const f = fixture(t);
  const c = f.resolve();
  assert.equal(c.threshold, DEFAULTS.threshold);
  assert.deepEqual(c.denyCommands, []);
  assert.equal(c.receiptDir, DEFAULTS.receiptDir);
  assert.deepEqual(c.hooks, { preToolUse: true, stop: true });
  assert.deepEqual(c.faults, []);
  assert.deepEqual(c.sources, { user: null, repo: null });
});

test("XDG_CONFIG_HOME counts only when absolute", (t) => {
  const f = fixture(t);
  assert.equal(userConfigPath({ XDG_CONFIG_HOME: "relative" }, f.base), join(f.base, ".config", "pattern-check", "config.json"));
  assert.equal(userConfigPath(f.env, f.base), join(f.config, "pattern-check", "config.json"));
});

test("the repo file is found in any ancestor of cwd", (t) => {
  const f = fixture(t);
  assert.equal(repoConfigPath(f.sub), null);
  f.setRepo("{}");
  assert.equal(repoConfigPath(f.sub), join(f.repo, ".pattern-check.json"));
});

test("repo overrides user per key; denyCommands concatenate", (t) => {
  const f = fixture(t);
  f.setUser(JSON.stringify({ threshold: 5, denyCommands: ["^terraform apply"], receiptDir: "receipts", hooks: { stop: false } }));
  f.setRepo(JSON.stringify({ threshold: 2, denyCommands: ["^kubectl apply"] }));
  const c = f.resolve();
  assert.equal(c.threshold, 2);
  assert.deepEqual(c.denyCommands, ["^terraform apply", "^kubectl apply"]);
  assert.equal(c.receiptDir, "receipts");
  assert.deepEqual(c.hooks, { preToolUse: true, stop: false });
  assert.deepEqual(c.faults, []);
});

test("a file that is not JSON: defaults for that layer plus one fault", (t) => {
  const f = fixture(t);
  f.setUser("{ not json");
  const c = f.resolve();
  assert.equal(c.threshold, DEFAULTS.threshold);
  assert.equal(c.faults.length, 1);
  assert.match(c.faults[0], /not valid JSON/);
});

test("a key of the wrong shape: the default for that key plus one fault, the other keys kept", (t) => {
  const f = fixture(t);
  f.setRepo(JSON.stringify({ threshold: "three", receiptDir: "../escape", hooks: { preToolUse: "no" }, denyCommands: ["(unclosed"] }));
  const c = f.resolve();
  assert.equal(c.threshold, DEFAULTS.threshold);
  assert.equal(c.receiptDir, DEFAULTS.receiptDir);
  assert.equal(c.hooks.preToolUse, true);
  assert.deepEqual(c.denyCommands, []);
  assert.equal(c.faults.length, 4);
  assert.match(c.faults.join("\n"), /threshold must be an integer >= 1/);
  assert.match(c.faults.join("\n"), /receiptDir must be a relative path/);
  assert.match(c.faults.join("\n"), /hooks\.preToolUse must be true or false/);
  assert.match(c.faults.join("\n"), /not a valid regular expression/);
});

test("threshold 0 is rejected, threshold 1 accepted", (t) => {
  const f = fixture(t);
  f.setRepo(JSON.stringify({ threshold: 0 }));
  assert.equal(f.resolve().threshold, DEFAULTS.threshold);
  f.setRepo(JSON.stringify({ threshold: 1 }));
  assert.equal(f.resolve().threshold, 1);
});
