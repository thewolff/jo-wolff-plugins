// test/port.test.mjs — pins the port: the hooks this plugin was ported from carried paths and
// names that belong to the originating workspace, and none of them may survive here. Also pins
// the shape every hook file and the manifest share.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./helpers.mjs";

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

// README.md and CHANGELOG.md are excluded because they are where the stripped lines are listed,
// by name; this file is excluded because it holds the patterns. Everything that runs or is
// loaded into a session (hooks, lib, scripts, skill, evals, fixtures) is scanned.
const EXCLUDED = new Set([join(PLUGIN_ROOT, "README.md"), join(PLUGIN_ROOT, "CHANGELOG.md"), join(PLUGIN_ROOT, "test", "port.test.mjs")]);

test("no originating-workspace string survives in anything the plugin runs or loads", () => {
  const banned = [/shipyard/i, /linear/i, /\.projects/, /newdle-hooks/i, /\/Users\/[a-z]+\//i, /ENG-\d+/];
  for (const file of walk(PLUGIN_ROOT)) {
    if (EXCLUDED.has(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const re of banned) assert.doesNotMatch(text, re, `${file} contains ${re}`);
  }
});

test("hooks.json registers exactly the four hooks, each pointing at a file that runs under the runner", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["PreCompact", "SessionStart", "Stop", "UserPromptSubmit"]);
  for (const [event, groups] of Object.entries(hooks)) {
    const cmd = groups[0].hooks[0].command;
    const file = cmd.match(/hooks\/([\w-]+\.mjs)/)[1];
    const src = readFileSync(join(PLUGIN_ROOT, "hooks", file), "utf8");
    assert.match(src, new RegExp(`runHook\\("${event}", import\\.meta\\.url, \\{ plugin: "continuity"`), `${file} runs under hook-runner for ${event}`);
    assert.match(src, new RegExp(`hook_event_name !== "${event}"`), `${file} rejects other events`);
    assert.equal(groups[0].hooks[0].timeout, 5);
  }
});

test("plugin.json declares the state directory and the prune command the gate reads", () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "continuity");
  assert.equal(manifest.version, "0.1.1");
  const [dir, config] = manifest.state;
  assert.equal(dir.path, "$XDG_STATE_HOME/continuity");
  assert.equal(dir.retentionDays, 30);
  assert.match(dir.prune, /scripts\/prune\.mjs" --days 30$/);
  assert.deepEqual(config, { path: "$XDG_CONFIG_HOME/continuity/config.json", kind: "file", retentionDays: null, prune: null });
});
