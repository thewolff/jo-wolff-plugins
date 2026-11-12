import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// OMP reads .omp-plugin/marketplace.json in preference to .claude-plugin/marketplace.json, so a
// plugin listed only in the Claude Code file cannot be installed on OMP: `omp plugin install`
// fails with `Plugin "<name>" not found in marketplace`. brb, ctx-watch, ledger and plugin-kit
// shipped that way until the OMP file was brought level. A description edited in one catalog and
// not the other drifted the same way (brb, ctx-watch and plugin-kit, found 2026-11-12), so the
// descriptions are held equal too: one purpose statement, the same in both catalogs and in every
// manifest the plugin ships (README, "Adding a plugin", step 3).
const at = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const json = (relative) => JSON.parse(readFileSync(at(relative), "utf8"));
const entries = (relative) => json(relative).plugins;
const names = (relative) => entries(relative).map((p) => p.name).sort();

test("both marketplace files list the same plugins", () => {
  const claude = names(".claude-plugin/marketplace.json");
  const omp = names(".omp-plugin/marketplace.json");
  assert.deepEqual(
    { missingFromOmp: claude.filter((n) => !omp.includes(n)), missingFromClaude: omp.filter((n) => !claude.includes(n)) },
    { missingFromOmp: [], missingFromClaude: [] },
    "add each missing plugin's entry to the other marketplace file (README, Adding a plugin, step 3)",
  );
});

test("each plugin has one description: the same in both marketplace files and in its plugin.json, .omp-plugin/plugin.json and package.json", () => {
  const omp = new Map(entries(".omp-plugin/marketplace.json").map((p) => [p.name, p]));
  const drift = [];
  for (const entry of entries(".claude-plugin/marketplace.json")) {
    const want = entry.description;
    const other = omp.get(entry.name);
    if (other && other.description !== want) drift.push(`${entry.name}: .omp-plugin/marketplace.json`);
    if (other && other.source !== entry.source) drift.push(`${entry.name}: .omp-plugin/marketplace.json source ${other.source}, not ${entry.source}`);
    const dir = entry.source.replace(/^\.\//, "");
    for (const manifest of [".claude-plugin/plugin.json", ".omp-plugin/plugin.json", "package.json"]) {
      const path = `${dir}/${manifest}`;
      if (existsSync(at(path)) && json(path).description !== want) drift.push(`${entry.name}: ${path}`);
    }
  }
  assert.deepEqual(drift, [], "copy the .claude-plugin/marketplace.json description into each file named");
});
