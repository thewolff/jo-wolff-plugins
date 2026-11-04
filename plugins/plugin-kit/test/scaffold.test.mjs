// scaffold.test.mjs — `new-plugin.mjs` (README "What it does"): the files it writes and what is
// filled in; the scaffold's own `node --test` is green; ledger's plugin gate passes all three
// checks on it as written; the refusals (existing directory, bad name, unknown event, no events)
// write nothing; the runner it copies is this plugin's, byte for byte.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT_ROOT, EVENTS, parseArgs, scaffold } from "../scripts/new-plugin.mjs";

const SCRIPT = join(KIT_ROOT, "scripts", "new-plugin.mjs");
const LEDGER_GATE = join(KIT_ROOT, "..", "ledger", "lib", "plugin-gate.mjs");
const dest = () => mkdtempSync(join(tmpdir(), "kit-scaffold-"));
const walk = (dir, prefix = "") => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`])).sort();

test("scaffold: the files, with name, title, description and per-hook event, file and quiet filled in; the runner is the kit's copy", () => {
  const d = dest();
  const { root, written } = scaffold({ name: "trial-gate", events: ["PreToolUse", "Stop", "SessionEnd"], description: 'Keeps "trials" honest.', dest: d });
  assert.equal(root, join(d, "trial-gate"));
  assert.deepEqual(walk(root), [
    ".claude-plugin/plugin.json",
    "HOW-IT-FAILS.md",
    "README.md",
    "e2e/live-run.sh",
    "hooks/hooks.json",
    "hooks/pre-tool-use.mjs",
    "hooks/session-end.mjs",
    "hooks/stop.mjs",
    "lib/hook-runner.mjs",
    "package.json",
    "skills/trial-gate/SKILL.md",
    "test/fixtures/README.md",
    "test/hook-contract.test.mjs",
  ]);
  assert.equal(written.length, 13);
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
  assert.equal(manifest.name, "trial-gate");
  assert.equal(manifest.description, 'Keeps "trials" honest.');
  assert.equal(JSON.parse(read("package.json")).name, "trial-gate");
  assert.match(read("README.md"), /^# Trial Gate\n\nKeeps "trials" honest\.\n/);
  const hooks = JSON.parse(read("hooks/hooks.json")).hooks;
  assert.deepEqual(Object.keys(hooks), ["PreToolUse", "Stop", "SessionEnd"]);
  assert.equal(hooks.PreToolUse[0].matcher, EVENTS.PreToolUse.matcher);
  assert.equal(hooks.Stop[0].matcher, undefined);
  assert.equal(hooks.Stop[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop.mjs"');
  assert.equal(hooks.Stop[0].hooks[0].timeout, 5);
  assert.match(read("hooks/stop.mjs"), /runHook\("Stop", handle, \{ plugin: "trial-gate", quiet: false \}\)/);
  assert.match(read("hooks/session-end.mjs"), /runHook\("SessionEnd", handle, \{ plugin: "trial-gate", quiet: true \}\)/);
  assert.match(read("hooks/pre-tool-use.mjs"), /^#!\/usr\/bin\/env node\n\/\/ hooks\/pre-tool-use\.mjs — the trial-gate plugin's PreToolUse hook/);
  assert.ok(statSync(join(root, "hooks/stop.mjs")).mode & 0o100, "handlers are executable");
  assert.ok(statSync(join(root, "e2e/live-run.sh")).mode & 0o100, "the live run is executable");
  assert.equal(read("lib/hook-runner.mjs"), readFileSync(join(KIT_ROOT, "lib", "hook-runner.mjs"), "utf8"));
  assert.match(read("skills/trial-gate/SKILL.md"), /^---\nname: trial-gate\ndescription: Keeps "trials" honest\.\n---\n\n# Trial Gate\n/);
  assert.match(read("skills/trial-gate/SKILL.md"), /\n## When this can't run\n/);
  assert.match(read("e2e/live-run.sh"), /PLUGIN="\$\{CANARY_PLUGIN:-trial-gate\}"/);
  assert.match(read("HOW-IT-FAILS.md"), /^# How trial-gate fails\n/);
  for (const rel of walk(root)) assert.ok(!read(rel).includes("{{"), `${rel} has an unfilled placeholder`);
});

test("scaffold: the generated plugin's own node --test is green and ledger's plugin gate passes all three checks on it as written", async () => {
  const d = dest();
  const { root } = scaffold({ name: "trial-gate", events: ["PreToolUse", "Stop", "SessionStart", "SessionEnd", "UserPromptSubmit"], description: "A trial.", dest: d });
  // NODE_TEST_CONTEXT is what node's runner sets in its own children; without it the child would refuse to run files.
  const env = { ...process.env, HOME: join(d, "home") };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test"], { cwd: root, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ℹ pass 11$/m, r.stdout + r.stderr);
  assert.match(r.stdout, /^ℹ fail 0$/m, r.stdout);
  if (!existsSync(LEDGER_GATE)) return;
  const { checkPlugin } = await import(LEDGER_GATE);
  const rows = checkPlugin({ name: "trial-gate", dir: root, prefix: "" });
  assert.deepEqual(
    rows.map((x) => [x.name, x.status]),
    [
      ["survives", "pass"],
      ["visible", "pass"],
      ["says", "pass"],
    ],
    JSON.stringify(rows),
  );
});

test("refusals: an existing directory, a bad name, an unknown event, no events; nothing written; the CLI says why on stderr with exit 1", () => {
  const d = dest();
  scaffold({ name: "taken", events: ["Stop"], description: "x", dest: d });
  assert.throws(() => scaffold({ name: "taken", events: ["Stop"], description: "x", dest: d }), /taken exists; nothing was written/);
  assert.deepEqual(parseArgs(["Bad_Name", "--events", "Stop"]).error, 'name must be lowercase kebab (a-z, 0-9, hyphens between words), not "Bad_Name"');
  assert.match(parseArgs(["fine", "--events", "Stop,OnFire"]).error, /^unknown event OnFire; the events are PreToolUse, /);
  assert.equal(parseArgs(["fine"]).error, "--events names at least one hook event");
  assert.match(parseArgs([]).error, /^usage:/);
  assert.equal(parseArgs(["fine", "--bogus"]).error, "unknown argument --bogus");
  const ok = parseArgs(["fine", "--events", "Stop", "--dest", d]);
  assert.match(ok.description, /^\(one sentence: what fine does/);
  const cli = spawnSync(process.execPath, [SCRIPT, "taken", "--events", "Stop", "--dest", d], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^new-plugin: .*taken exists; nothing was written\n$/);
  assert.equal(cli.stdout, "");
  const good = spawnSync(process.execPath, [SCRIPT, "second", "--events", "Stop", "--dest", d], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^.*\/second\n  \.claude-plugin\/plugin\.json\n/);
  assert.match(good.stdout, /\nnext: write the rule in hooks\/\*\.mjs/);
  assert.deepEqual(readdirSync(d).sort(), ["second", "taken"]);
});

test("manifests agree; every template placeholder is one the scaffolder fills", () => {
  const claude = JSON.parse(readFileSync(join(KIT_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(KIT_ROOT, "package.json"), "utf8"));
  assert.equal(claude.name, "plugin-kit");
  assert.equal(pkg.name, claude.name);
  assert.equal(pkg.version, claude.version);
  const known = new Set(["name", "title", "description", "event", "file", "quiet"]);
  for (const rel of walk(join(KIT_ROOT, "templates"))) {
    const text = readFileSync(join(KIT_ROOT, "templates", rel), "utf8");
    for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(known.has(m[1]), `${rel}: {{${m[1]}}} is not filled by the scaffolder`);
  }
});
