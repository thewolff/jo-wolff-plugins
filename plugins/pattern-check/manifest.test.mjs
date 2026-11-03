// The plugin ships two manifests: Claude Code's plugin.json and package.json (the test runner).
// A release that bumps one and not the other reports a version that is not the one on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

test("plugin.json and package.json carry the same name and version", () => {
  const claude = read("./.claude-plugin/plugin.json");
  const pkg = read("./package.json");
  assert.equal(pkg.name, claude.name);
  assert.equal(pkg.version, claude.version);
  assert.equal(claude.name, "pattern-check");
});

test("hooks.json names scripts that exist, through CLAUDE_PLUGIN_ROOT", () => {
  const hooks = read("./hooks/hooks.json").hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["PreToolUse", "Stop"]);
  assert.equal(hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit|Bash");
  for (const group of [...hooks.PreToolUse, ...hooks.Stop]) {
    for (const h of group.hooks) {
      const m = h.command.match(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(.+)"$/);
      assert.ok(m, h.command);
      assert.ok(existsSync(new URL(`./${m[1]}`, import.meta.url)), m[1]);
    }
  }
});
