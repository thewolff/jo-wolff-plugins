#!/usr/bin/env node
// check-omp-install.mjs — does OMP load the same version of each jo-wolff-plugins plugin that
// Claude Code has installed?
//
// OMP reads Claude Code's plugin registry, but its own registry (`omp plugin install`) is
// authoritative: an OMP entry replaces Claude Code's entry for the same plugin id (OMP
// discovery/helpers.ts listClaudePluginRoots, "OMP is authoritative"). So after
// `claude plugin update`, OMP sessions keep running the older OMP install until it is upgraded
// too, and `omp plugin upgrade` alone reinstalls whatever OMP's cached marketplace catalog
// lists: the catalog has to be refreshed first with `omp plugin marketplace update`.
// ask-graham 0.2.1 fixed the OMP nudge pile-up but never reached OMP this way: OMP kept
// loading 0.2.0, whose adapter parked one nudge per mid-turn message.
//
// Usage: node scripts/check-omp-install.mjs
// Runs `omp plugin list --json` (the active OMP profile) and `claude plugin list --json`.
// Exit 0: every plugin installed in both carries the same version. Exit 1: at least one
// differs; each is printed with the commands that fix it. Exit 2: a list could not be read.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MARKETPLACE = "jo-wolff-plugins";

/**
 * Plugins whose OMP install and Claude Code install carry different versions.
 * @param {{ marketplace?: Array<{ id: string, entries?: Array<{ version?: string, enabled?: boolean }> }> }} omp
 *   parsed `omp plugin list --json`
 * @param {Array<{ id: string, version?: string, enabled?: boolean }>} claude parsed `claude plugin list --json`
 * @returns {Array<{ id: string, omp: string[], claude: string }>}
 */
export function findSkew(omp, claude, marketplace = MARKETPLACE) {
  const suffix = `@${marketplace}`;
  const claudeVersions = new Map();
  for (const p of claude ?? []) {
    if (p?.id?.endsWith(suffix) && p.enabled !== false && p.version) claudeVersions.set(p.id, p.version);
  }
  const skew = [];
  for (const p of omp?.marketplace ?? []) {
    if (!p?.id?.endsWith(suffix) || !claudeVersions.has(p.id)) continue;
    const ompVersions = [...new Set((p.entries ?? []).filter((e) => e.enabled !== false).map((e) => e.version))];
    const want = claudeVersions.get(p.id);
    if (ompVersions.length > 0 && ompVersions.some((v) => v !== want)) {
      skew.push({ id: p.id, omp: ompVersions, claude: want });
    }
  }
  return skew;
}

/** The report for a skew list, one block per plugin, ending with the fix. */
export function describe(skew, marketplace = MARKETPLACE) {
  if (skew.length === 0) return "OMP and Claude Code load the same version of every plugin installed in both.";
  const lines = skew.map(
    (s) => `${s.id}: OMP loads ${s.omp.join(", ")}, Claude Code has ${s.claude}. OMP sessions run the OMP copy.`,
  );
  lines.push(
    "",
    "Fix, in the OMP profile you use:",
    `  omp plugin marketplace update ${marketplace}`,
    ...skew.map((s) => `  omp plugin upgrade ${s.id}`),
    "then relaunch the OMP sessions: a running session keeps the extension it loaded at start.",
  );
  return lines.join("\n");
}

function listJson(cmd) {
  return JSON.parse(execFileSync(cmd, ["plugin", "list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

function main() {
  let omp;
  let claude;
  try {
    omp = listJson("omp");
    claude = listJson("claude");
  } catch (error) {
    console.error(`check-omp-install: could not read a plugin list: ${error.message}`);
    process.exit(2);
  }
  const skew = findSkew(omp, claude);
  console.log(describe(skew));
  process.exit(skew.length === 0 ? 0 : 1);
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main();