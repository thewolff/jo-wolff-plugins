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

// Spelling and quoting of the commands are exercised by e2e.test.mjs, which runs them through sh -c;
// this only checks that each registered command names a hook file that exists.
test("hooks.json registers one SessionStart command and one Stop command (timeout 60, room for the judge), each resolving to a hook script that exists", () => {
  const hooks = read("hooks", "hooks.json").hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart", "Stop"]);
  for (const event of ["SessionStart", "Stop"]) {
    const entries = hooks[event].flatMap((h) => h.hooks);
    assert.equal(entries.length, 1, event);
    assert.equal(entries[0].type, "command");
    const target = entries[0].command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?\.mjs)/)?.[1];
    assert.ok(target, `no plugin-relative .mjs in ${entries[0].command}`);
    assert.ok(existsSync(join(PLUGIN_ROOT, target)), target);
  }
  assert.equal(hooks.Stop[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/output-types-stop.mjs"');
  assert.equal(hooks.Stop[0].hooks[0].timeout, 60);
});

test("the vendored lib/judge.mjs and lib/hook-runner.mjs are plugin-kit's, byte for byte (when the kit is checked out beside this plugin)", () => {
  for (const rel of ["judge.mjs", "hook-runner.mjs"]) {
    const kit = join(PLUGIN_ROOT, "..", "plugin-kit", "lib", rel);
    if (!existsSync(kit)) continue;
    assert.ok(readFileSync(kit).equals(readFileSync(join(PLUGIN_ROOT, "lib", rel))), `lib/${rel} differs from plugin-kit's: copy it again`);
  }
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
