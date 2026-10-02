// The plugin ships three manifests: Claude Code's, OMP's package.json, and OMP's plugin.json.
// OMP names an installed copy by version and upgrades by it, so a release that bumps one
// manifest and not the others installs a copy that disagrees with what Claude Code reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

test("all three manifests carry the same name and version", () => {
  const claude = read("./.claude-plugin/plugin.json");
  const pkg = read("./package.json");
  const omp = read("./.omp-plugin/plugin.json");
  for (const m of [pkg, omp]) {
    assert.equal(m.name, claude.name);
    assert.equal(m.version, claude.version);
  }
});

test("every OMP extension path in package.json exists", () => {
  const exts = read("./package.json").omp.extensions;
  assert.ok(exts.length > 0);
  for (const e of exts) assert.ok(existsSync(new URL(e, import.meta.url)), e);
});
