// scaffold.test.mjs — `new-plugin.mjs` (README "What it does"): the files it writes and what is
// filled in; the scaffold's own `node --test` is green; ledger's five-row plugin gate on it as
// written passes survives, visible, says and retention and fails evals naming the unfilled stubs
// (the shape the scaffold is meant to have until its scenarios are real); the refusals (existing
// directory, bad name, unknown event, no events) write nothing; the runner and the scenario
// runner it copies are this plugin's, byte for byte; the CLI guard survives a symlinked path.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KIT_ROOT, EVENTS, parseArgs, scaffold } from "../scripts/new-plugin.mjs";

const SCRIPT = join(KIT_ROOT, "scripts", "new-plugin.mjs");
const LEDGER_GATE = join(KIT_ROOT, "..", "ledger", "lib", "plugin-gate.mjs");
const LEDGER_CLI = join(KIT_ROOT, "..", "ledger", "scripts", "ledger.mjs");
const dest = () => realpathSync(mkdtempSync(join(tmpdir(), "kit-scaffold-")));
const walk = (dir, prefix = "") => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`])).sort();

test("scaffold: the files, with name, title, description, scenario and per-hook event, file and quiet filled in; the runners are the kit's copies", () => {
  const d = dest();
  const { root, written } = scaffold({ name: "trial-gate", events: ["PreToolUse", "Stop", "SessionEnd"], description: 'Keeps "trials" honest.', dest: d });
  assert.equal(root, join(d, "trial-gate"));
  assert.deepEqual(walk(root), [
    ".claude-plugin/plugin.json",
    "CHANGELOG.md",
    "HOW-IT-FAILS.md",
    "README.md",
    "e2e/live-run.sh",
    "evals/manifest.json",
    "evals/pre-tool-use.scenario.json",
    "evals/session-end.scenario.json",
    "evals/stop.scenario.json",
    "hooks/hooks.json",
    "hooks/pre-tool-use.mjs",
    "hooks/session-end.mjs",
    "hooks/stop.mjs",
    "lib/hook-runner.mjs",
    "lib/live-run.mjs",
    "package.json",
    "scripts/prune.mjs",
    "skills/trial-gate/SKILL.md",
    "test/fixtures/README.md",
    "test/hook-contract.test.mjs",
  ]);
  assert.equal(written.length, 20);
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
  assert.equal(manifest.name, "trial-gate");
  assert.equal(manifest.description, 'Keeps "trials" honest.');
  assert.equal(JSON.parse(read("package.json")).name, "trial-gate");
  assert.match(read("README.md"), /^# Trial Gate\n\nKeeps "trials" honest\.\n/);
  assert.match(read("README.md"), /\n## Changes in 0\.1\.0\n\nFirst release\.\n/);
  assert.match(read("CHANGELOG.md"), /^# Changelog\n\nAll notable changes to trial-gate are recorded here\./);
  assert.match(read("CHANGELOG.md"), /\n## \[0\.1\.0\]\n\n### Added\n\n- First release: Keeps "trials" honest\.\n/, "the scaffold's CHANGELOG entry is the one ledger's docs row wants (a `## [<ver>]` heading with text under it)");
  assert.equal(JSON.parse(read(".claude-plugin/plugin.json")).version, "0.1.0", "the version the two entries are for");
  const hooks = JSON.parse(read("hooks/hooks.json")).hooks;
  assert.deepEqual(Object.keys(hooks), ["PreToolUse", "Stop", "SessionEnd"]);
  assert.equal(hooks.PreToolUse[0].matcher, EVENTS.PreToolUse.matcher);
  assert.equal(hooks.Stop[0].matcher, undefined);
  assert.equal(hooks.Stop[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop.mjs"');
  assert.equal(hooks.Stop[0].hooks[0].timeout, 5);
  assert.match(read("hooks/stop.mjs"), /runHook\("Stop", import.meta.url, \{ plugin: "trial-gate", quiet: false \}\)/);
  assert.match(read("hooks/session-end.mjs"), /runHook\("SessionEnd", import.meta.url, \{ plugin: "trial-gate", quiet: true \}\)/);
  assert.match(read("hooks/pre-tool-use.mjs"), /^#!\/usr\/bin\/env node\n\/\/ hooks\/pre-tool-use\.mjs — the trial-gate plugin's PreToolUse hook/);
  assert.ok(statSync(join(root, "hooks/stop.mjs")).mode & 0o100, "handlers are executable");
  assert.ok(statSync(join(root, "e2e/live-run.sh")).mode & 0o100, "the live run is executable");
  assert.equal(read("lib/hook-runner.mjs"), readFileSync(join(KIT_ROOT, "lib", "hook-runner.mjs"), "utf8"));
  assert.equal(read("lib/live-run.mjs"), readFileSync(join(KIT_ROOT, "lib", "live-run.mjs"), "utf8"));
  const manifestEvals = JSON.parse(read("evals/manifest.json"));
  assert.deepEqual(manifestEvals.events, { PreToolUse: ["silent"], Stop: ["silent"], SessionEnd: ["silent"] });
  assert.deepEqual(manifestEvals.manual, []);
  const stub = JSON.parse(read("evals/stop.scenario.json"));
  assert.equal(stub.stub, true);
  assert.equal(stub.event, "Stop");
  assert.equal(stub.expect, "silent");
  assert.deepEqual(stub.stdin, { session_id: "${SESSION_ID}", transcript_path: "${TRANSCRIPT}", cwd: "${CWD}", hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(JSON.parse(read("evals/pre-tool-use.scenario.json")).stdin.tool_name, "Write");
  assert.match(read("HOW-IT-FAILS.md"), /evals\/pre-tool-use\.scenario\.json/, "the first event's scenario is the one the table names");
  assert.match(read("skills/trial-gate/SKILL.md"), /evals\/pre-tool-use\.scenario\.json/);
  const state = manifest.state;
  assert.equal(state[0].path, "$XDG_STATE_HOME/trial-gate");
  assert.equal(state[0].retentionDays, 30);
  assert.match(state[0].prune, /scripts\/prune\.mjs/);
  assert.ok(statSync(join(root, "scripts/prune.mjs")).mode & 0o100, "the prune verb is executable");
  assert.match(read("scripts/prune.mjs"), /\.local", "state"\)/);
  assert.match(read("skills/trial-gate/SKILL.md"), /^---\nname: trial-gate\ndescription: Keeps "trials" honest\.\n---\n\n# Trial Gate\n/);
  assert.match(read("skills/trial-gate/SKILL.md"), /\n## When this can't run\n/);
  assert.match(read("e2e/live-run.sh"), /PLUGIN="\$\{CANARY_PLUGIN:-trial-gate\}"/);
  assert.match(read("HOW-IT-FAILS.md"), /^# How trial-gate fails\n/);
  for (const rel of walk(root)) assert.ok(!read(rel).includes("{{"), `${rel} has an unfilled placeholder`);
});

test("scaffold: the generated plugin's own node --test is green; ledger's gate passes survives, visible, says and retention on it as written and fails evals naming every unfilled stub", async () => {
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
      ["evals", "fail"],
      ["retention", "pass"],
      ["docs", "skipped"],
    ],
    JSON.stringify(rows),
  );
  const evals = rows[3].detail;
  for (const [event, file] of [["PreToolUse", "pre-tool-use"], ["Stop", "stop"], ["SessionStart", "session-start"], ["SessionEnd", "session-end"], ["UserPromptSubmit", "user-prompt-submit"]]) {
    assert.ok(evals.includes(`evals/${file}.scenario.json is an unfilled stub`), `${file}: ${evals}`);
    assert.ok(evals.includes(`no scenario for ${event} × silent`), evals);
  }
  assert.match(rows[4].detail, /^2 state path\(s\) declared \(1 with a prune, 1 kept by design\)/, rows[4].detail);
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

// OMP reads .omp-plugin/marketplace.json in preference to .claude-plugin/marketplace.json, so a
// plugin listed only in the Claude Code file fails `omp plugin install` with "not found in
// marketplace" (the repository README, "Adding a plugin", step 3). Every place the kit tells the
// author about the marketplace entry names both files.
const CATALOGS = [".claude-plugin/marketplace.json", ".omp-plugin/marketplace.json"];

test("both marketplace files: the CLI's next-step line, the scaffolder's header, the new-plugin skill and the template README name the OMP catalog beside the Claude Code one", () => {
  const d = dest();
  const cli = spawnSync(process.execPath, [SCRIPT, "two-catalogs", "--events", "Stop", "--dest", d], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const next = cli.stdout.slice(cli.stdout.indexOf("\nnext: "));
  for (const file of CATALOGS) assert.ok(next.includes(`\`${file}\``), `the next-step line names ${file}: ${next}`);
  const header = readFileSync(SCRIPT, "utf8").split("\nimport ")[0];
  for (const file of CATALOGS) assert.ok(header.includes(file), `the scaffolder's header comment names ${file}`);
  const skill = readFileSync(join(KIT_ROOT, "skills", "new-plugin", "SKILL.md"), "utf8");
  for (const file of CATALOGS) assert.ok(skill.includes(`\`${file}\``), `the new-plugin skill names ${file}`);
  const readme = readFileSync(join(d, "two-catalogs", "README.md"), "utf8");
  assert.ok(readme.includes("omp plugin install two-catalogs@jo-wolff-plugins"), "the scaffolded README has the OMP install line");
  assert.ok(readme.includes("/plugin install two-catalogs@jo-wolff-plugins"), "and keeps the Claude Code one");
});

test("--judge: the scaffold also gets lib/judge.mjs, the kit's copy byte for byte; without the flag there is none", () => {
  const d = dest();
  assert.equal(parseArgs(["fine", "--events", "Stop", "--dest", d]).judge, false);
  assert.equal(parseArgs(["fine", "--events", "Stop", "--dest", d, "--judge"]).judge, true);
  const plain = scaffold({ name: "plain", events: ["Stop"], description: "x", dest: d });
  assert.ok(!existsSync(join(plain.root, "lib", "judge.mjs")));
  assert.ok(!plain.written.includes("lib/judge.mjs"));
  const judged = scaffold({ name: "judged", events: ["Stop"], description: "x", dest: d, judge: true });
  assert.ok(judged.written.includes("lib/judge.mjs"));
  assert.ok(readFileSync(join(judged.root, "lib", "judge.mjs")).equals(readFileSync(join(KIT_ROOT, "lib", "judge.mjs"))));
  const cli = spawnSync(process.execPath, [SCRIPT, "third", "--events", "Stop", "--dest", d, "--judge"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /\n  lib\/judge\.mjs\n/);
});

test("the default destination is the cwd's repository, not the kit's: a scaffold from inside another repository lands under that repository's plugins/; a cwd in no repository is refused naming --dest", () => {
  // A repository elsewhere, with the cwd in a subdirectory of it.
  const repo = dest();
  spawnSync("git", ["init", "-q", repo]);
  mkdirSync(join(repo, "deep", "inside"), { recursive: true });
  const r = spawnSync(process.execPath, [SCRIPT, "from-elsewhere", "--events", "Stop"], { cwd: join(repo, "deep", "inside"), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, "plugins", "from-elsewhere", "hooks", "hooks.json")), "under the cwd's repository");
  assert.ok(!existsSync(join(KIT_ROOT, "..", "from-elsewhere")), "not beside the kit");
  assert.ok(r.stdout.startsWith(`${join(repo, "plugins", "from-elsewhere")}\n`), r.stdout);
  assert.deepEqual(parseArgs(["x", "--events", "Stop"], { cwd: join(repo, "deep") }).dest, join(repo, "plugins"));
  // No repository: refused, nothing written, the message names --dest.
  const plain = dest();
  const n = spawnSync(process.execPath, [SCRIPT, "nowhere", "--events", "Stop"], { cwd: plain, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(plain) } });
  assert.equal(n.status, 1);
  assert.match(n.stderr, /^new-plugin: .* is in no git repository; pass --dest <plugins dir>/);
  assert.deepEqual(readdirSync(plain), []);
  // --dest still wins over the cwd's repository.
  const other = dest();
  const d = spawnSync(process.execPath, [SCRIPT, "pointed", "--events", "Stop", "--dest", other], { cwd: join(repo, "deep"), encoding: "utf8" });
  assert.equal(d.status, 0, d.stderr);
  assert.ok(existsSync(join(other, "pointed", "hooks", "hooks.json")));
  assert.ok(!existsSync(join(repo, "plugins", "pointed")));
});

test("the CLI guard compares real paths: the scaffolder reached through a symlink still scaffolds (a raw argv compare was a silent no-op there)", () => {
  const d = dest();
  const link = join(d, "linked-new-plugin.mjs");
  symlinkSync(SCRIPT, link);
  const r = spawnSync(process.execPath, [link, "via-link", "--events", "Stop", "--dest", d], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^.*\/via-link\n/, r.stdout);
  assert.ok(existsSync(join(d, "via-link", "hooks", "hooks.json")), "written through the symlink");
});

test("end to end: a scaffold committed in a fresh repository fails the live run and the gate's evals row on its stub; with the stub filled, the live run passes the hook phase, a canary row is recorded, and every gate row passes", () => {
  if (!existsSync(LEDGER_CLI)) return;
  const root = dest();
  const repo = join(root, "repo");
  mkdirSync(repo);
  // A PATH with node, git and sh and no `claude`: the hook phase runs, the live phase is unavailable.
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: join(root, "tmp"),
    LEDGER_DB: join(root, "ledger.db"),
    LEDGER_ENABLED: "1",
    TZ: "UTC",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "TMPDIR"]) mkdirSync(env[k], { recursive: true });
  const sh = (cmd, args, { cwd = repo, ok = true } = {}) => {
    const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
    if (ok) assert.equal(r.status, 0, `${cmd} ${args.join(" ")}: ${r.stdout}${r.stderr}`);
    return r;
  };
  sh("git", ["init", "-q", "-b", "main"]);
  const { root: plugin } = scaffold({ name: "gated", events: ["Stop"], description: "A gated trial.", dest: join(repo, "plugins") });
  // The repository README's row for the plugin, the third thing the gate's docs row wants for a new version (the name only, never the version).
  writeFileSync(join(repo, "README.md"), "# plugins\n\n| Plugin | What it does |\n|---|---|\n| gated | a gated trial |\n");
  const commit = (m) => { sh("git", ["add", "-A"]); sh("git", ["commit", "-qm", m]); };
  commit("scaffold");
  const ledger = (...args) => spawnSync(process.execPath, [LEDGER_CLI, ...args], { cwd: repo, env, encoding: "utf8" });
  const live = (...args) => spawnSync("bash", [join(plugin, "e2e", "live-run.sh"), ...args], { cwd: plugin, env: { ...env, CANARY_PLUGIN: "gated", CANARY_TRANSCRIPT: join(root, "canary.jsonl"), CANARY_TIMEOUT_S: "60" }, encoding: "utf8" });
  // 1. As scaffolded: the live run fails naming the stub; the gate's evals row fails on it, the other five pass (docs: the first version is written down in the scaffold's CHANGELOG.md and README.md, and in the repository README).
  const stubRun = live();
  assert.equal(stubRun.status, 1, stubRun.stdout + stubRun.stderr);
  assert.match(stubRun.stdout, /^scenario stop: fail — is an unfilled stub/m, stubRun.stdout);
  assert.match(stubRun.stdout, /^fail: 2 problem\(s\); 0 hook scenario\(s\) passed/m, stubRun.stdout);
  const g1 = ledger("gate", "check", "--plugins", "gated");
  assert.equal(g1.status, 1, g1.stdout + g1.stderr);
  const rowsOf = (out) => Object.fromEntries([...out.matchAll(/^ {2}gated {12}(\w+) +(\w+) +(.*)$/gm)].map((m) => [m[1], { status: m[2], detail: m[3] }]));
  const r1 = rowsOf(g1.stdout);
  assert.deepEqual(Object.fromEntries(Object.entries(r1).map(([k, v]) => [k, v.status])), { survives: "pass", visible: "pass", says: "pass", evals: "fail", retention: "pass", docs: "pass" }, g1.stdout);
  assert.equal(r1.docs.detail, "version 0.1.0, new since the base: CHANGELOG.md has its 0.1.0 entry; README.md has its 0.1.0 entry; the repository README names it", g1.stdout);
  assert.match(r1.evals.detail, /evals\/stop\.scenario\.json is an unfilled stub/, g1.stdout);
  // 2. Filled: "stub": true removed; the hook answers the sample input with silence, which is what the scenario expects.
  const file = join(plugin, "evals", "stop.scenario.json");
  const scenario = JSON.parse(readFileSync(file, "utf8"));
  delete scenario.stub;
  delete scenario.$comment;
  writeFileSync(file, `${JSON.stringify(scenario, null, 2)}\n`);
  const filledRun = live();
  assert.equal(filledRun.status, 75, filledRun.stdout + filledRun.stderr);
  assert.match(filledRun.stdout, /^scenario stop: pass — Stop → silent$/m, filledRun.stdout);
  assert.match(filledRun.stdout, /\nunavailable: claude not found on PATH; 1 hook scenario\(s\) passed offline\n$/, filledRun.stdout);
  assert.ok(!filledRun.stdout.includes("wrote:"), `the scaffold's hook writes nothing outside the work directory: ${filledRun.stdout}`);
  // Uncommitted, the gate still checks the committed stub; committed, evals wants a canary row for the new tree.
  const g2 = ledger("gate", "check", "--plugins", "gated");
  assert.equal(g2.status, 1);
  assert.match(g2.stdout, /uncommitted changes under plugins\/gated\/ were not checked/, g2.stdout);
  commit("fill the Stop scenario");
  const g3 = ledger("gate", "check", "--plugins", "gated");
  assert.equal(g3.status, 1, g3.stdout + g3.stderr);
  const r3 = rowsOf(g3.stdout);
  assert.equal(r3.evals.status, "fail");
  assert.match(r3.evals.detail, /^1 scenario\(s\) cover the manifest; no canary row for tree [0-9a-f]{8}: run `ledger canary run --plugins gated` on this commit$/, g3.stdout);
  // 3. The canary records a row for the committed tree (unavailable: no claude on this PATH, which is the canary's finding, not the plugin's); the gate passes every row.
  const c = ledger("canary", "run", "--repo", repo, "--plugins", "gated");
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /^gated +unavailable .*claude not found on PATH/m, c.stdout);
  const g4 = ledger("gate", "check", "--plugins", "gated");
  assert.equal(g4.status, 0, g4.stdout + g4.stderr);
  const r4 = rowsOf(g4.stdout);
  assert.deepEqual(Object.fromEntries(Object.entries(r4).map(([k, v]) => [k, v.status])), { survives: "pass", visible: "pass", says: "pass", evals: "pass", retention: "pass", docs: "skipped" }, g4.stdout);
  assert.equal(r4.docs.detail, "version 0.1.0 unchanged since the base", "the fill commit bumps nothing, so the docs row has nothing to ask");
  assert.match(r4.evals.detail, /^1 scenario\(s\) cover 1 event\(s\); canary #\d+ at .*: live unavailable \(claude not found on PATH\); hook scenarios passed offline$/, g4.stdout);
  assert.match(r4.retention.detail, /^2 state path\(s\) declared \(1 with a prune, 1 kept by design\)/, g4.stdout);
  assert.match(g4.stdout, /\nevery check passed\n$/);
});

test("manifests agree; every template placeholder is one the scaffolder fills", () => {
  const claude = JSON.parse(readFileSync(join(KIT_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(KIT_ROOT, "package.json"), "utf8"));
  assert.equal(claude.name, "plugin-kit");
  assert.equal(pkg.name, claude.name);
  assert.equal(pkg.version, claude.version);
  const known = new Set(["name", "title", "description", "event", "file", "quiet", "scenario", "events", "stdin"]);
  for (const rel of walk(join(KIT_ROOT, "templates"))) {
    const text = readFileSync(join(KIT_ROOT, "templates", rel), "utf8");
    for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(known.has(m[1]), `${rel}: {{${m[1]}}} is not filled by the scaffolder`);
  }
});
