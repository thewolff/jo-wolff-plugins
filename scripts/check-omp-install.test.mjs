import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, findSkew } from "./check-omp-install.mjs";

// The shapes of `omp plugin list --json` and `claude plugin list --json`, with the versions
// one machine had on 2026-10-14: Claude Code updated to ask-graham 0.2.1, OMP still on 0.2.0.
const omp = (askGraham, audhd = "1.1.0") => ({
  npm: [],
  marketplace: [
    { id: "i-have-audhd@jo-wolff-plugins", scope: "user", entries: [{ scope: "user", version: audhd }] },
    { id: "ask-graham@jo-wolff-plugins", scope: "user", entries: [{ scope: "user", version: askGraham }] },
  ],
});
const claude = [
  { id: "ask-graham@jo-wolff-plugins", version: "0.2.1", scope: "user", enabled: true },
  { id: "i-have-audhd@jo-wolff-plugins", version: "1.1.0", scope: "user", enabled: true },
  { id: "paired-coding@jo-wolff-plugins", version: "1.2.0", scope: "user", enabled: true },
];

test("an OMP install older than Claude Code's is reported", () => {
  assert.deepEqual(findSkew(omp("0.2.0"), claude), [
    { id: "ask-graham@jo-wolff-plugins", omp: ["0.2.0"], claude: "0.2.1" },
  ]);
});

test("matching versions report nothing", () => {
  assert.deepEqual(findSkew(omp("0.2.1"), claude), []);
});

test("a plugin installed only in Claude Code is not skew: OMP falls back to Claude Code's copy", () => {
  // paired-coding is in the Claude Code list and absent from OMP's.
  assert.deepEqual(findSkew(omp("0.2.1"), claude), []);
});

test("a disabled Claude Code install and other marketplaces are ignored", () => {
  const disabled = claude.map((p) => (p.id.startsWith("ask-graham@") ? { ...p, enabled: false } : p));
  assert.deepEqual(findSkew(omp("0.2.0"), disabled), []);
  const other = { marketplace: [{ id: "ask-graham@elsewhere", entries: [{ version: "0.1.0" }] }] };
  assert.deepEqual(findSkew(other, claude), []);
});

test("the report names both versions and the refresh-then-upgrade fix", () => {
  const text = describe(findSkew(omp("0.2.0", "1.0.0"), claude));
  assert.match(text, /ask-graham@jo-wolff-plugins: OMP loads 0\.2\.0, Claude Code has 0\.2\.1/);
  assert.match(text, /i-have-audhd@jo-wolff-plugins: OMP loads 1\.0\.0, Claude Code has 1\.1\.0/);
  const refresh = text.indexOf("omp plugin marketplace update jo-wolff-plugins");
  const upgrade = text.indexOf("omp plugin upgrade ask-graham@jo-wolff-plugins");
  assert.ok(refresh !== -1 && upgrade > refresh, "the catalog refresh comes before the upgrade");
  assert.match(text, /relaunch/);
});