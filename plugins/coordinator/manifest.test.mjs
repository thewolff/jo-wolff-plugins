// The plugin ships two manifests: Claude Code's and OMP's. OMP names an installed copy by version and
// upgrades by it, so a release that bumps one and not the other installs a copy that disagrees with
// what Claude Code reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

test("both manifests and package.json carry the same name, version and description", () => {
  const claude = read("./.claude-plugin/plugin.json");
  for (const other of [read("./.omp-plugin/plugin.json"), read("./package.json")]) {
    assert.equal(other.name, claude.name);
    assert.equal(other.version, claude.version);
    assert.equal(other.description, claude.description);
  }
});

test("the skill's frontmatter name matches the plugin name", () => {
  const skill = readFileSync(new URL("./skills/coordinator/SKILL.md", import.meta.url), "utf8");
  const name = /^name: (.+)$/m.exec(skill)?.[1];
  assert.equal(name, read("./.claude-plugin/plugin.json").name);
});
