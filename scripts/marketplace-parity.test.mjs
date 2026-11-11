import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// OMP reads .omp-plugin/marketplace.json in preference to .claude-plugin/marketplace.json, so a
// plugin listed only in the Claude Code file cannot be installed on OMP: `omp plugin install`
// fails with `Plugin "<name>" not found in marketplace`. brb, ctx-watch, ledger and plugin-kit
// shipped that way until the OMP file was brought level. Descriptions may differ; names may not.
const names = (relative) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8"))
    .plugins.map((p) => p.name)
    .sort();

test("both marketplace files list the same plugins", () => {
  const claude = names(".claude-plugin/marketplace.json");
  const omp = names(".omp-plugin/marketplace.json");
  assert.deepEqual(
    { missingFromOmp: claude.filter((n) => !omp.includes(n)), missingFromClaude: omp.filter((n) => !claude.includes(n)) },
    { missingFromOmp: [], missingFromClaude: [] },
    "add each missing plugin's entry to the other marketplace file (README, Adding a plugin, step 3)",
  );
});
