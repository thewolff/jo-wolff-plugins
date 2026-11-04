// manifest.test.mjs — the manifests point at files that exist, and the versions agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./helpers.mjs";

const read = (...p) => JSON.parse(readFileSync(join(PLUGIN_ROOT, ...p), "utf8"));

test("plugin.json and package.json agree on name and version", () => {
  const plugin = read(".claude-plugin", "plugin.json");
  const pkg = read("package.json");
  assert.equal(plugin.name, "output-types");
  assert.equal(pkg.name, plugin.name);
  assert.equal(pkg.version, plugin.version);
});

// Spelling and quoting of the command are exercised by e2e.test.mjs, which runs it through sh -c;
// this only checks that the one registered command names a hook file that exists.
test("hooks.json registers exactly one SessionStart command, and it resolves to a hook script that exists", () => {
  const hooks = read("hooks", "hooks.json").hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart"]);
  const entries = hooks.SessionStart.flatMap((h) => h.hooks);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "command");
  const target = entries[0].command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?\.mjs)/)?.[1];
  assert.ok(target, `no plugin-relative .mjs in ${entries[0].command}`);
  assert.ok(existsSync(join(PLUGIN_ROOT, target)), target);
});

test("every hooks/*.mjs is registered in hooks.json (no unregistered, untested hook)", () => {
  const registered = JSON.stringify(read("hooks", "hooks.json"));
  for (const f of readdirSync(join(PLUGIN_ROOT, "hooks")).filter((f) => f.endsWith(".mjs"))) {
    assert.ok(registered.includes(`/hooks/${f}`), f);
  }
});

test("the skill points at a reference.md that exists", () => {
  const skill = readFileSync(join(PLUGIN_ROOT, "skills", "output-types", "SKILL.md"), "utf8");
  assert.ok(skill.includes("${CLAUDE_SKILL_DIR}/reference.md"));
  assert.ok(existsSync(join(PLUGIN_ROOT, "skills", "output-types", "reference.md")));
});
