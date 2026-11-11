// plugin-gate.test.mjs — the six-check push gate (README "The plugin gate"): what counts as a
// repository of plugins, each check's pass and fail on a fixture plugin, the rows `gate check`
// records and replaces, and the PreToolUse deny with its way out (`gate check` or `review waive`).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, cli, hook, openDb } from "./helpers.mjs";
import { PRECOMPACT_TEXT_MAX, spawnHook, checkPlugin, docsCheck, dryRunPrune, evalsCheck, retentionCheck, fixturesWithoutUnavailable, hookCommands, reasonsWithoutCommand, releaseEntry, rootReadmeNames, treePlugins, treeSha, snapshotTree, textsWithoutWhenCant, changedPlugins, CHECKS, FAULT_INPUTS } from "../lib/plugin-gate.mjs";

const SID = "s-gate";

function git(b, ...args) {
  const r = spawnSync("git", args, { cwd: b.work, encoding: "utf8", env: { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function commitAll(b, message) {
  git(b, "add", "-A");
  git(b, "commit", "-qm", message);
  return git(b, "rev-parse", "HEAD");
}
const write = (dir, rel, text) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

// A hook that meets the bar: every fault is one errors.log line plus a systemMessage, exit 0.
const GOOD_HOOK = `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.env.XDG_STATE_HOME, "good");
const fail = (why) => { try { mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, "errors.log"), why + "\\n"); } catch {} process.stdout.write(JSON.stringify({ systemMessage: "good: " + why })); process.exit(0); };
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(raw); } catch { return fail("stdin not JSON"); }
  if (!input || typeof input !== "object") return fail("stdin not an object");
  try { mkdirSync(join(process.env.XDG_DATA_HOME, "good", "store"), { recursive: true }); } catch (e) { return fail("state unwritable: " + e.code); }
  process.exit(0);
});
`;
// A hook that breaks the bar: exit 1 on empty stdin, a deny on malformed JSON, silence otherwise.
const BAD_HOOK = `#!/usr/bin/env node
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  if (!raw) process.exit(1);
  try { JSON.parse(raw); } catch { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "bad: no" } })); }
  process.exit(0);
});
`;
const hooksJson = (name, file) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: [`\${CLAUDE_PLUGIN_ROOT}/hooks/${file}`], timeout: 5 }] }] } });
// The declared outcomes of GOOD_HOOK: a well-formed input is silent, a fault is a systemMessage.
const GOOD_MANIFEST = JSON.stringify({ events: { PreToolUse: ["silent", "systemMessage"] } });
const GOOD_SCENARIOS = {
  "evals/pre-tool-use-ok.scenario.json": JSON.stringify({ event: "PreToolUse", expect: "silent", sibling: "pre-tool-use-fault.scenario.json", stdin: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } }),
  "evals/pre-tool-use-fault.scenario.json": JSON.stringify({ event: "PreToolUse", expect: "systemMessage", stdin: "{not json" }),
};
// The paths GOOD_HOOK writes, kept by design.
const GOOD_STATE = [
  { path: "$XDG_STATE_HOME/good/errors.log", kind: "file", retentionDays: null, prune: null },
  { path: "$XDG_DATA_HOME/good/store", retentionDays: null, prune: null },
];
const GOOD_SKILL = "# Good\n\nDo the thing.\n\n## When this can't run\n\nSay so; evals/pre-tool-use-fault.scenario.json proves the message.\n";

/** Seed a canary pass row certifying `tree` for `plugin` at `at` (the row `evals` wants); returns its id. */
function seedCanaryPass(b, plugin, tree, { at = new Date().toISOString(), status = "pass", writes = null, note = null } = {}) {
  const db = openDb(b);
  try {
    return Number(db.prepare("INSERT INTO cc_canary_runs (plugin, at, status, exit_code, duration_ms, tree_sha, writes, note) VALUES (?, ?, ?, 0, 1, ?, ?, ?)").run(plugin, at, status, tree, writes, note).lastInsertRowid);
  } finally {
    db.close();
  }
}
/** A repository with plugins/good (meets the bar) and plugins/bad (fails every check), committed on main, then a change on `feat`. */
function pluginRepo({ changeBad = true, changeGood = true } = {}) {
  const b = sandbox();
  git(b, "init", "-q", "-b", "main");
  const good = join(b.work, "plugins", "good");
  write(good, ".claude-plugin/plugin.json", JSON.stringify({ name: "good", version: "0.0.1", state: GOOD_STATE }));
  write(good, "hooks/hooks.json", hooksJson("good", "good.mjs"));
  write(good, "hooks/good.mjs", GOOD_HOOK);
  write(good, "skills/good/SKILL.md", GOOD_SKILL);
  write(good, "lib/rules.mjs", "export const deny = () => ({ permissionDecision: \"deny\", permissionDecisionReason: `good: run \\`good fix\\` first` });\n");
  write(good, "test/fixtures/lab.txt", "ok\n");
  write(good, "test/fixtures/lab.unavailable.txt", "lab: unavailable\n");
  write(good, "evals/manifest.json", GOOD_MANIFEST);
  for (const [rel, text] of Object.entries(GOOD_SCENARIOS)) write(good, rel, text);
  const bad = join(b.work, "plugins", "bad");
  write(bad, "hooks/hooks.json", hooksJson("bad", "bad.mjs"));
  write(bad, "hooks/bad.mjs", BAD_HOOK);
  write(bad, "skills/bad/SKILL.md", "# Bad\n\nDo the thing.\n");
  write(bad, "lib/rules.mjs", 'export const deny = () => ({ permissionDecision: "deny", permissionDecisionReason: "bad: no" });\n');
  write(bad, "test/fixtures/lab.txt", "ok\n");
  write(join(b.work, "plugins", "docs-only"), ".claude-plugin/plugin.json", '{"name":"docs-only"}\n');
  write(join(b.work, "plugins", "docs-only"), "README.md", "docs\n");
  commitAll(b, "plugins");
  git(b, "checkout", "-q", "-b", "feat");
  if (changeGood) write(good, "README.md", "changed\n");
  if (changeBad) write(bad, "README.md", "changed\n");
  write(b.work, "README.md", "the repository\n");
  commitAll(b, "change");
  b.writeConfig({ review: { mode: "gate" } });
  cli(b, ["note", "pushing the change"], { env: { LEDGER_SESSION_ID: SID } });
  return b;
}

const push = (b, command = "git push origin feat") => hook(b, "pre-tool-use", { session_id: SID, cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? "allow";
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";
const gateRows = (b) => {
  const db = openDb(b);
  try {
    return db.prepare("SELECT plugin, name, status, detail, head_sha, tree_sha FROM cc_gate_checks ORDER BY plugin, name").all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
/** A codex stub that passes, so the review gate is satisfied by one `review`. */
function passReview(b) {
  const path = join(b.root, "stub-codex");
  writeFileSync(path, "#!/bin/sh\ncat > /dev/null\necho PASS\n");
  chmodSync(path, 0o755);
  return cli(b, ["review", "--labs", "codex"], { env: { LEDGER_SESSION_ID: SID, LEDGER_REVIEW_BIN_CODEX: path } });
}

test("treePlugins: plugins/* with hooks.json or plugin.json in the commit count, a root plugin.json counts alone, a plain repo holds none; the checkout is not consulted", () => {
  const b = pluginRepo();
  const head = git(b, "rev-parse", "HEAD");
  assert.deepEqual(
    treePlugins(b.work, head).map((p) => p.name),
    ["bad", "docs-only", "good"],
  );
  // Committed discovery files removed from the checkout, an uncommitted plugin added to it: the commit's set stands.
  rmSync(join(b.work, "plugins", "bad", "hooks", "hooks.json"));
  write(join(b.work, "plugins", "extra"), "hooks/hooks.json", hooksJson("extra", "x.mjs"));
  assert.deepEqual(treePlugins(b.work, head).map((p) => p.name), ["bad", "docs-only", "good"]);
  const single = sandbox();
  git(single, "init", "-q");
  write(single.work, ".claude-plugin/plugin.json", '{"name":"solo"}');
  const sha = commitAll(single, "solo");
  assert.deepEqual(treePlugins(single.work, sha), [{ name: "solo", prefix: "" }]);
  assert.equal(treeSha(single.work, sha, ""), git(single, "rev-parse", `${sha}^{tree}`));
  const plain = sandbox();
  git(plain, "init", "-q");
  write(plain.work, "a.txt", "a");
  assert.deepEqual(treePlugins(plain.work, commitAll(plain, "a")), []);
});

test("snapshotTree: the plugin's committed files land in a scratch directory with their modes; the checkout and the index stay as they were", () => {
  const b = pluginRepo();
  const head = git(b, "rev-parse", "HEAD");
  write(join(b.work, "plugins", "good"), "skills/good/SKILL.md", "# Good (uncommitted)\n");
  const snap = snapshotTree(b.work, head, "plugins/good/");
  try {
    assert.equal(snap.tree, git(b, "rev-parse", `${head}:plugins/good`));
    assert.ok(existsSync(join(snap.dir, "hooks", "hooks.json")));
    assert.match(spawnSync("cat", [join(snap.dir, "skills", "good", "SKILL.md")], { encoding: "utf8" }).stdout, /## When this can't run/, "the committed text, not the checkout's");
    assert.ok(!existsSync(join(snap.dir, "plugins")), "the plugin's tree is the root of the snapshot");
  } finally {
    snap.release();
  }
  assert.ok(!existsSync(snap.dir));
  // A failure after the scratch root is made (a prefix naming a file, so read-tree gets a blob)
  // removes the root with it: nothing is left under the temporary directory.
  const scratch = join(b.root, "scratch-tmp");
  mkdirSync(scratch);
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    assert.throws(() => snapshotTree(b.work, head, "plugins/good/hooks/hooks.json"), /^Error: git read-tree /);
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  }
  assert.deepEqual(readdirSync(scratch), [], "no ledger-gate-tree-* root left behind");
  assert.equal(git(b, "diff", "--cached", "--name-only"), "", "the repository's index is untouched");
  assert.equal(git(b, "diff", "--name-only"), "plugins/good/skills/good/SKILL.md", "the checkout is untouched");
});

test("changedPlugins: only plugins with a file in base..head; every plugin when there is no base", () => {
  const b = pluginRepo({ changeBad: false });
  const head = git(b, "rev-parse", "HEAD");
  const base = git(b, "rev-parse", "main");
  assert.deepEqual(changedPlugins(b.work, base, head).map((p) => p.name), ["good"]);
  assert.deepEqual(changedPlugins(b.work, null, head).map((p) => p.name), ["bad", "docs-only", "good"]);
});

test("hookCommands: every command of hooks.json with ${CLAUDE_PLUGIN_ROOT} resolved; null without the file", () => {
  const b = pluginRepo();
  const good = join(b.work, "plugins", "good");
  assert.deepEqual(hookCommands(good), [{ event: "PreToolUse", command: "node", args: [join(good, "hooks", "good.mjs")] }]);
  assert.equal(hookCommands(join(b.work, "plugins", "docs-only")), null);
});

/** The committed tree of plugins/good in HEAD, and a db handle for checkPlugin. */
function goodTree(b) {
  return git(b, "rev-parse", "HEAD:plugins/good");
}
function withDb(b, fn) {
  const db = openDb(b);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test("checkPlugin: a plugin that meets the bar passes all six checks once a canary pass certifies its committed tree; docs is skipped while the version is unchanged", () => {
  const b = pluginRepo();
  const tree = goodTree(b);
  const id = seedCanaryPass(b, "good", tree, { writes: JSON.stringify(["$XDG_STATE_HOME/good/errors.log", "$XDG_DATA_HOME/good/store"]) });
  const rows = withDb(b, (db) => checkPlugin({ name: "good", dir: join(b.work, "plugins", "good"), prefix: "plugins/good/" }, { db, tree, docs: { baseVersion: "0.0.1", rootReadme: "the repository\n" } }));
  assert.deepEqual(
    rows.map((r) => [r.name, r.status]),
    CHECKS.map((c) => [c, c === "docs" ? "skipped" : "pass"]),
    JSON.stringify(rows),
  );
  assert.equal(rows[0].detail, `1 hook(s) × ${FAULT_INPUTS.length} fault inputs`);
  assert.equal(rows[2].detail, "every skill and agent text has the section and names a scenario; every deny reason names a command");
  assert.equal(rows[3].detail, `2 scenario(s) cover 1 event(s); canary #${id} at ${withDb(b, (db) => db.prepare("SELECT at FROM cc_canary_runs WHERE id = ?").get(id).at)}: live pass`);
  assert.equal(rows[4].detail, "2 state path(s) declared (0 with a prune, 2 kept by design); 0 prune command(s) ran dry; 3 write site(s) in source");
  assert.equal(rows[5].detail, "version 0.0.1 unchanged since the base");
  // Without the repository context the row cannot compare and says so.
  const cold = withDb(b, (db) => checkPlugin({ name: "good", dir: join(b.work, "plugins", "good"), prefix: "plugins/good/" }, { db, tree }));
  assert.deepEqual(cold[5], { name: "docs", status: "skipped", detail: "not given a base to compare the version with" });
});

test("checkPlugin: the failing plugin fails each check, naming the hook and input, the missing fixture, the SKILL.md, the reason literal and the missing manifest", () => {
  const b = pluginRepo();
  const rows = checkPlugin({ name: "bad", dir: join(b.work, "plugins", "bad"), prefix: "plugins/bad/" }, { docs: { baseVersion: null, rootReadme: "" } });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.survives.status, "fail");
  assert.match(by.survives.detail, /PreToolUse hook on empty stdin: exit 1/);
  assert.match(by.survives.detail, /PreToolUse hook on malformed JSON: denied/);
  assert.equal(by.visible.status, "fail");
  assert.match(by.visible.detail, /test\/fixtures\/lab\.txt has no lab\.unavailable\.txt/);
  assert.equal(by.says.status, "fail");
  assert.match(by.says.detail, /skills\/bad\/SKILL\.md has no "How it fails" or "When this can't" heading/);
  assert.match(by.says.detail, /lib\/rules\.mjs:1 "bad: no" names no command/);
  assert.equal(by.evals.status, "fail");
  assert.equal(by.evals.detail, "evals/manifest.json missing; PreToolUse has no declared outcomes");
  assert.equal(by.retention.status, "pass", "a hook that writes nothing needs no state declaration");
  assert.equal(by.retention.detail, "no `state` field; no source site writes outside the worktree");
  assert.deepEqual(by.docs, { name: "docs", status: "skipped", detail: "no `version` in .claude-plugin/plugin.json" }, "no manifest, no version to compare");
});

test("checkPlugin: no hooks.json → survives and evals are skipped, the other four still run", () => {
  const b = pluginRepo();
  const rows = checkPlugin({ name: "docs-only", dir: join(b.work, "plugins", "docs-only"), prefix: "plugins/docs-only/" }, { docs: { baseVersion: null, rootReadme: "" } });
  assert.deepEqual(
    rows.map((r) => [r.name, r.status]),
    [
      ["survives", "skipped"],
      ["visible", "pass"],
      ["says", "pass"],
      ["evals", "skipped"],
      ["retention", "pass"],
      ["docs", "skipped"],
    ],
  );
  assert.equal(rows[0].detail, "no hooks/hooks.json");
  assert.equal(rows[3].detail, "no hooks/hooks.json and no evals/");
  assert.equal(rows[5].detail, "no `version` in .claude-plugin/plugin.json");
});

test("evals row: a scenario missing for a declared outcome, a stub, a scenario for an undeclared outcome, a judge needing a fresh pass, and no canary row each fail naming the gap; coverage plus a canary pass for the tree passes", () => {
  const b = pluginRepo();
  const good = join(b.work, "plugins", "good");
  const run = (opts = {}) => withDb(b, (db) => evalsCheck({ name: "good", dir: good }, { db, ...opts }));
  // Coverage first, before any canary row is consulted.
  assert.deepEqual(run(), { status: "fail", detail: "2 scenario(s) cover the manifest; no committed tree to look a canary row up for" });
  const tree = goodTree(b);
  assert.deepEqual(run({ tree }), { status: "fail", detail: `2 scenario(s) cover the manifest; no canary row for tree ${tree.slice(0, 8)}: run \`ledger canary run --plugins good\` on this commit` });
  rmSync(join(good, "evals", "pre-tool-use-ok.scenario.json"));
  assert.deepEqual(run({ tree }), { status: "fail", detail: "no scenario for PreToolUse × silent" });
  write(good, "evals/pre-tool-use-ok.scenario.json", JSON.stringify({ stub: true, event: "PreToolUse", expect: "silent", sibling: "pre-tool-use-fault.scenario.json", stdin: {} }));
  assert.deepEqual(run({ tree }), { status: "fail", detail: 'no scenario for PreToolUse × silent; evals/pre-tool-use-ok.scenario.json is an unfilled stub (remove "stub": true once its stdin and expect are real)' });
  write(good, "evals/pre-tool-use-ok.scenario.json", GOOD_SCENARIOS["evals/pre-tool-use-ok.scenario.json"]);
  write(good, "evals/pre-tool-use-deny.scenario.json", JSON.stringify({ event: "PreToolUse", expect: "deny", stdin: {} }));
  assert.deepEqual(run({ tree }), { status: "fail", detail: "evals/pre-tool-use-deny.scenario.json expects deny, which the manifest does not declare for PreToolUse" });
  rmSync(join(good, "evals", "pre-tool-use-deny.scenario.json"));
  write(good, "evals/manifest.json", JSON.stringify({ events: { PreToolUse: ["silent", "systemMessage"], Stop: ["silent"] } }));
  assert.deepEqual(run({ tree }), { status: "fail", detail: "evals/manifest.json declares Stop, which hooks/hooks.json does not register; no scenario for Stop × silent" });
  write(good, "evals/manifest.json", GOOD_MANIFEST);
  // A failed canary run for the tree fails naming it; a pass passes.
  const failed = seedCanaryPass(b, "good", tree, { status: "fail", note: "exit 1", at: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(run({ tree }), { status: "fail", detail: `canary run #${failed} at 2026-01-01T00:00:00.000Z failed for tree ${tree.slice(0, 8)} (exit 1)` });
  const passed = seedCanaryPass(b, "good", tree, { at: "2026-01-02T00:00:00.000Z" });
  assert.deepEqual(run({ tree }), { status: "pass", detail: `2 scenario(s) cover 1 event(s); canary #${passed} at 2026-01-02T00:00:00.000Z: live pass` });
  // An unavailable run (no claude) passes on the hook scenarios alone, unless a judge rubric is in play.
  const unavailable = seedCanaryPass(b, "good", tree, { status: "unavailable", note: "claude not found on PATH", at: "2026-01-03T00:00:00.000Z" });
  assert.deepEqual(run({ tree }), { status: "pass", detail: `2 scenario(s) cover 1 event(s); canary #${unavailable} at 2026-01-03T00:00:00.000Z: live unavailable (claude not found on PATH); hook scenarios passed offline` });
  write(good, "evals/judged.scenario.json", JSON.stringify({ event: "session", session: { prompt: "do it" }, judge: "PASS if it did" }));
  assert.deepEqual(run({ tree }), { status: "fail", detail: `a judge-backed scenario needs a passing canary run; #${unavailable} at 2026-01-03T00:00:00.000Z is unavailable (claude not found on PATH)` });
  const stale = seedCanaryPass(b, "good", tree, { at: "2026-01-04T00:00:00.000Z" });
  const now = Date.parse("2026-01-20T00:00:00.000Z");
  assert.match(run({ tree, now }).detail, new RegExp(`^a judge-backed scenario needs a canary pass within \\d+ days; #${stale} is 16\\.0 days old: run \`ledger canary run --plugins good\`$`));
  assert.equal(run({ tree, now: Date.parse("2026-01-05T00:00:00.000Z") }).status, "pass");
});

test("retention row: a write site with no `state`, an empty `state`, a retention with no prune, a malformed entry, and a canary-observed write under no declared path each fail; a declaration covering the writes passes; every prune runs dry and must exit 0 with the contract line last", () => {
  const b = pluginRepo();
  const good = join(b.work, "plugins", "good");
  const manifest = (state) => write(good, ".claude-plugin/plugin.json", JSON.stringify({ name: "good", version: "0.0.1", ...(state === undefined ? {} : { state }) }));
  const run = () => withDb(b, (db) => retentionCheck({ name: "good", dir: good }, { db, env: b.env }));
  assert.deepEqual(run(), { status: "pass", detail: "2 state path(s) declared (0 with a prune, 2 kept by design); 0 prune command(s) ran dry; 3 write site(s) in source" });
  manifest(undefined);
  assert.deepEqual(run(), { status: "fail", detail: "no `state` field in .claude-plugin/plugin.json, yet 3 source site(s) write or resolve paths outside the worktree: hooks/good.mjs:4, hooks/good.mjs:5, hooks/good.mjs:12" });
  manifest([]);
  assert.deepEqual(run(), { status: "fail", detail: "`state` is empty, yet 3 source site(s) write or resolve paths outside the worktree: hooks/good.mjs:4, hooks/good.mjs:5, hooks/good.mjs:12" });
  manifest([{ path: "$XDG_STATE_HOME/good", retentionDays: 30 }]);
  assert.deepEqual(run(), { status: "fail", detail: ".claude-plugin/plugin.json state[0] ($XDG_STATE_HOME/good): retentionDays 30 with no prune command" });
  manifest([{ path: "$XDG_STATE_HOME/good", retentionDays: "soon" }, { retentionDays: null }]);
  assert.deepEqual(run(), { status: "fail", detail: ".claude-plugin/plugin.json state[0] ($XDG_STATE_HOME/good): retentionDays must be a whole number of days or null (kept by design); .claude-plugin/plugin.json state[1] has no path" });
  // The prune runs dry, from the plugin directory with CLAUDE_PLUGIN_ROOT, and must end with the contract line.
  const ok = 'sh "$CLAUDE_PLUGIN_ROOT/prune.sh" --days 30';
  write(good, "prune.sh", '#!/bin/sh\ncase "$*" in *--dry-run*) ;; *) echo "not a dry run" >&2; exit 9;; esac\necho "pruned: 2 file(s), 100 bytes freed (dry run); kept 1"\n');
  manifest([{ path: "$XDG_STATE_HOME/good", retentionDays: 30, prune: ok }, { path: "$XDG_DATA_HOME/good", retentionDays: null }]);
  assert.deepEqual(run(), { status: "pass", detail: "2 state path(s) declared (1 with a prune, 1 kept by design); 1 prune command(s) ran dry; 3 write site(s) in source" });
  write(good, "fail.sh", '#!/bin/sh\necho nope >&2\nexit 4\n');
  manifest([{ path: "$XDG_STATE_HOME/good", retentionDays: 30, prune: 'sh "$CLAUDE_PLUGIN_ROOT/fail.sh"' }, { path: "$XDG_DATA_HOME/good", retentionDays: null }]);
  assert.deepEqual(run(), { status: "fail", detail: 'prune `sh "$CLAUDE_PLUGIN_ROOT/fail.sh"` --dry-run exited 4: nope' });
  write(good, "json.sh", '#!/bin/sh\necho \'{"removed":1}\'\n');
  manifest([{ path: "$XDG_STATE_HOME/good", retentionDays: 30, prune: 'sh "$CLAUDE_PLUGIN_ROOT/json.sh"' }, { path: "$XDG_DATA_HOME/good", retentionDays: null }]);
  assert.deepEqual(run(), { status: "fail", detail: 'prune `sh "$CLAUDE_PLUGIN_ROOT/json.sh"` --dry-run: last line is "{"removed":1}", not `pruned: <n> file(s), <bytes> bytes freed`' });
  manifest([{ path: "$XDG_STATE_HOME/good", retentionDays: 30, prune: "/nonexistent/prune" }, { path: "$XDG_DATA_HOME/good", retentionDays: null }]);
  assert.match(run().detail, /^prune `\/nonexistent\/prune` --dry-run exited 127: /);
  assert.equal(run().status, "fail");
  // One command declared for two paths runs once.
  manifest([{ path: "$XDG_STATE_HOME/good", retentionDays: 30, prune: ok }, { path: "$XDG_STATE_HOME/good/sub", retentionDays: 7, prune: ok }, { path: "$XDG_DATA_HOME/good", retentionDays: null }]);
  assert.deepEqual(run(), { status: "pass", detail: "3 state path(s) declared (2 with a prune, 1 kept by design); 1 prune command(s) ran dry; 3 write site(s) in source" });
  // The canary saw a write the declaration does not cover: the newest row with writes decides.
  manifest([{ path: "$XDG_STATE_HOME/good", retentionDays: 30, prune: ok }, { path: "$XDG_DATA_HOME/good", retentionDays: null }]);
  seedCanaryPass(b, "good", goodTree(b), { writes: JSON.stringify(["$XDG_STATE_HOME/good/errors.log", "$XDG_CACHE_HOME/good/blob"]) });
  assert.deepEqual(run(), { status: "fail", detail: "the canary saw a write at $XDG_CACHE_HOME/good/blob under no declared state path (declared: $XDG_STATE_HOME/good, $XDG_DATA_HOME/good)" });
  manifest([{ path: "$XDG_STATE_HOME/good", retentionDays: 30, prune: ok }, { path: "$XDG_DATA_HOME/good", retentionDays: null }, { path: "$XDG_CACHE_HOME/good", retentionDays: 0 }]);
  assert.deepEqual(run(), { status: "pass", detail: "3 state path(s) declared (1 with a prune, 1 kept by design); 1 prune command(s) ran dry; 3 write site(s) in source" });
  // dryRunPrune alone: a hung prune is named with its budget.
  assert.equal(dryRunPrune(good, "sleep 5 #", { timeoutMs: 200 }), "prune `sleep 5 #` --dry-run: no exit within 200 ms");
});

test("retention row: each prune runs dry in its own throwaway HOME, XDG roots and TMPDIR, with no LEDGER_DB or *_STATE_DIR / *_DB override, so a prune that ignores --dry-run cannot touch the caller's state", () => {
  const b = pluginRepo();
  const good = join(b.work, "plugins", "good");
  const real = join(b.root, "real");
  const roots = { HOME: "home", XDG_STATE_HOME: "state", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", TMPDIR: "tmp", PAIRED_CODING_STATE_DIR: "pc" };
  const env = { PATH: process.env.PATH, LEDGER_DB: join(real, "ledger.db"), SOME_DB: join(real, "some.db") };
  const kept = [env.LEDGER_DB, env.SOME_DB];
  mkdirSync(real, { recursive: true });
  for (const [key, dir] of Object.entries(roots)) {
    env[key] = join(real, dir);
    mkdirSync(env[key], { recursive: true });
    kept.push(join(env[key], "keep"));
  }
  for (const f of kept) writeFileSync(f, "keep");
  // A buggy prune: it ignores --dry-run, deletes from every root it is given, and refuses a root it already wrote to.
  const keeps = Object.keys(roots).map((k) => `"$${k}/keep"`).join(" ");
  write(good, "buggy.sh", `#!/bin/sh\nfor d in "$HOME" "$XDG_STATE_HOME" "$TMPDIR"; do [ -e "$d/seen" ] && { echo "$d reused" >&2; exit 3; }; touch "$d/seen"; done\nrm -f ${keeps} "$LEDGER_DB" "$SOME_DB"\necho "pruned: 9 file(s), 36 bytes freed; kept 0"\n`);
  const cmd = 'sh "$CLAUDE_PLUGIN_ROOT/buggy.sh"';
  assert.equal(dryRunPrune(good, cmd, { env }), null);
  assert.equal(dryRunPrune(good, cmd, { env }), null, "a second prune gets fresh roots of its own");
  for (const f of kept) assert.equal(existsSync(f), true, `${f} survives a prune that ignored --dry-run`);
  for (const dir of Object.values(roots)) assert.equal(existsSync(join(real, dir, "seen")), false, `nothing written under the caller's ${dir}`);
});

test("docs row: a changed version needs a CHANGELOG.md entry, a README release heading and a root README row naming the plugin (never its version), each failure naming the file and the heading; every documented heading shape passes; unchanged or absent versions are skipped; a root plugin is not asked for a root README", () => {
  const b = pluginRepo();
  const dir = join(b.work, "plugins", "good");
  const manifest = (version) => write(dir, ".claude-plugin/plugin.json", JSON.stringify({ name: "good", version, state: GOOD_STATE }));
  const run = (docs) => docsCheck({ name: "good", dir, prefix: "plugins/good/" }, docs);
  const ROOT = "| Plugin | What it does |\n|---|---|\n| other | the other thing |\n\n## other\n\nText.\n";
  // Skipped: the same version as the base, or no version at the base or the head.
  assert.deepEqual(run({ baseVersion: "0.0.1", rootReadme: ROOT }), { status: "skipped", detail: "version 0.0.1 unchanged since the base" });
  write(dir, ".claude-plugin/plugin.json", JSON.stringify({ name: "good" }));
  assert.deepEqual(run({ baseVersion: null, rootReadme: ROOT }), { status: "skipped", detail: "no `version` in .claude-plugin/plugin.json" });
  // Bumped with nothing written: three failures, each naming the file and the heading it wants.
  manifest("0.3.0");
  rmSync(join(dir, "README.md"), { force: true });
  assert.deepEqual(run({ baseVersion: "0.0.1", rootReadme: ROOT }), {
    status: "fail",
    detail:
      'version 0.0.1 → 0.3.0: CHANGELOG.md is missing: add it with a "## [0.3.0]" (or "## 0.3.0") entry; README.md is missing: add it with a "## Changes in 0.3.0" (or "### 0.3.0", "### <date> — 0.3.0") entry; the repository README.md does not name good: add its row to the plugin table ("| good | …"), or a bullet starting with "good", or a "## good" heading (the root README never names a version)',
  });
  // Files present without the heading, or with an empty section under it.
  write(dir, "CHANGELOG.md", "# Changelog\n\n## [0.2.0] - 2026-01-01\n\n- old\n");
  write(dir, "README.md", "# Good\n\n## Changes in 0.3.0\n\n## Changes in 0.2.0\n\nold\n");
  assert.deepEqual(run({ baseVersion: "0.0.1", rootReadme: null }), {
    status: "fail",
    detail: 'version 0.0.1 → 0.3.0: CHANGELOG.md has no "## [0.3.0]" (or "## 0.3.0") heading; README.md has nothing under its 0.3.0 heading; the repository README.md is not in the commit, so nothing names good',
  });
  // A longer version is not this one: 0.3.0 is not found in 10.3.0, 0.3.01 or 0.3.0.1.
  write(dir, "CHANGELOG.md", "# Changelog\n\n## [10.3.0]\n\n- x\n\n## 0.3.01\n\n- y\n\n## 0.3.0.1\n\n- z\n");
  assert.match(run({ baseVersion: "0.0.1", rootReadme: ROOT }).detail, /CHANGELOG\.md has no "## \[0\.3\.0\]"/);
  // Nor a pre-release, an unbalanced bracket, or a heading inside a fenced code block.
  for (const md of ["## 0.3.0-rc.1\n\n- x\n", "## [0.3.0\n\n- x\n", "## 0.3.0]\n\n- x\n", "# x\n\n```sh\n## 0.3.0\nls\n```\n", "# x\n\n~~~\n## 0.3.0\n~~~\n"]) assert.equal(releaseEntry(md, "0.3.0"), "missing", md);
  // A fenced line that looks like a heading does not end a section.
  assert.equal(releaseEntry("## 0.3.0\n\n```\n# not a heading\n```\n", "0.3.0"), "ok");
  assert.equal(releaseEntry("## 0.3.0\n\n```\n## 0.2.0\n```\n## 0.2.0\n", "0.3.0"), "ok");
  // Four or more spaces of indent is an indented code block, not a fence opener, so the heading after it counts.
  assert.equal(releaseEntry("# x\n\n    ```\n## 0.3.6\n\nbody\n", "0.3.6"), "ok", "a four-space ``` does not open a fence");
  // Every documented heading shape passes, in either file; the root README names the plugin in a table row, with no version anywhere.
  write(dir, "CHANGELOG.md", "# Changelog\n\n## [0.3.0] - 2026-11-04\n\n### Added\n\n- the thing\n");
  write(dir, "README.md", "# Good\n\n## Changes in 0.3.0\n\nThe thing.\n");
  const rootBullet = "| Plugin | What it does |\n|---|---|\n| good | does the thing |\n";
  assert.deepEqual(run({ baseVersion: "0.0.1", rootReadme: rootBullet }), { status: "pass", detail: "version 0.0.1 → 0.3.0: CHANGELOG.md has its 0.3.0 entry; README.md has its 0.3.0 entry; the repository README names it" });
  for (const heading of ["## 0.3.0", "### 0.3.0", "## [0.3.0]", "### 2026-11-04 — 0.3.0", "### 2026-11-04 - 0.3.0", "## Changes in 0.3.0"]) {
    write(dir, "CHANGELOG.md", `# Changelog\n\n${heading}\n\n- the thing\n`);
    write(dir, "README.md", `# Good\n\n## Changes\n\n${heading}\n\nThe thing.\n`);
    assert.equal(run({ baseVersion: "0.0.1", rootReadme: rootBullet }).status, "pass", heading);
  }
  // A new plugin (no base manifest) is checked against its first version.
  assert.equal(run({ baseVersion: null, rootReadme: rootBullet }).detail, "version 0.3.0, new since the base: CHANGELOG.md has its 0.3.0 entry; README.md has its 0.3.0 entry; the repository README names it");
  // The root README: a table row whose first cell is the name (in code or not), a bullet starting with the name, or a heading that is the name; a version is never required and never counted; another plugin's row, bullet or section does not count.
  assert.equal(rootReadmeNames("| good | does the thing |\n", "good"), true);
  assert.equal(rootReadmeNames("|`good`| does the thing |\n", "good"), true, "a code-span name in the first cell");
  assert.equal(rootReadmeNames("- **[good](plugins/good/README.md)** — does\n  the thing.\n", "good"), true);
  assert.equal(rootReadmeNames("- good: does the thing\n", "good"), true, "a plain bullet");
  assert.equal(rootReadmeNames("Intro.\n\n## good\n\nText.\n\n### Install\n", "good"), true, "a heading that is the name");
  assert.equal(rootReadmeNames("| other | 0.3.0 |\n- **[other](#other)** — good things.\n\n## other\n\ngood 0.3.0.\n", "good"), false, "the name inside another plugin's row, bullet or section does not count");
  assert.equal(rootReadmeNames("| good-two | x |\n- **[good-two](#good-two)** — x.\n\n## good-two\n", "good"), false, "another plugin whose name starts the same");
  assert.equal(rootReadmeNames("## Layout\n- the good store\n\n| Plugin |\n|---|\n| good |\n", "good"), true, "every line is read, not only the first candidate");
  assert.equal(rootReadmeNames("```\n| good | x |\n- **[good](y)** x\n## good\n```\n", "good"), false, "a row, bullet or heading inside a fenced code block does not count");
  // The whole first cell is compared, not a prefix of it: a longer label is another item's row.
  for (const row of ["| good archive | x |", "| good.foo | x |", "| good-foo | x |", "| **good** badge | x |", "| [good](y) extra | x |"]) {
    assert.equal(rootReadmeNames(`${row}\n`, "good"), false, `a longer first cell: ${row}`);
  }
  assert.equal(rootReadmeNames("| **[`good`](plugins/good/README.md)** | x |\n", "good"), true, "bold, link and code wrappers are removed in any nesting");
  // Up to three spaces of indent is still a table row; four is an indented code block.
  assert.equal(rootReadmeNames("   | good | x |\n", "good"), true, "a row indented by three spaces");
  assert.equal(rootReadmeNames("  | good | x |\n", "good"), true, "a row indented by two spaces");
  assert.equal(rootReadmeNames("    | good | x |\n", "good"), false, "four spaces is code, not a row");
  // A version the base had and the head dropped fails.
  manifest(undefined);
  assert.deepEqual(run({ baseVersion: "0.0.1", rootReadme: rootBullet }), { status: "fail", detail: 'manifest version missing at head: the base has 0.0.1; put a "version" back in .claude-plugin/plugin.json' });
  assert.deepEqual(run({ baseVersion: null, rootReadme: rootBullet }), { status: "skipped", detail: "no `version` in .claude-plugin/plugin.json" });
  // releaseEntry: the section runs to the next heading of the same or a higher level.
  assert.equal(releaseEntry("## [0.3.0]\n\n### Added\n\n- x\n\n## [0.2.0]\n", "0.3.0"), "ok");
  assert.equal(releaseEntry("## [0.3.0]\n\n\n## [0.2.0]\n\n- old\n", "0.3.0"), "empty");
  assert.equal(releaseEntry("## [0.2.0]\n\n- old\n", "0.3.0"), "missing");
  // A root plugin's README is the repository's: the root README is not asked for.
  const rootPlugin = sandbox();
  write(rootPlugin.work, ".claude-plugin/plugin.json", JSON.stringify({ name: "solo", version: "1.0.0" }));
  write(rootPlugin.work, "CHANGELOG.md", "## [1.0.0]\n\n- first\n");
  write(rootPlugin.work, "README.md", "# Solo\n\n## Changes in 1.0.0\n\nFirst.\n");
  assert.deepEqual(docsCheck({ name: "solo", dir: rootPlugin.work, prefix: "" }, { baseVersion: null, rootReadme: null }), { status: "pass", detail: "version 1.0.0, new since the base: CHANGELOG.md has its 1.0.0 entry; README.md has its 1.0.0 entry; a root plugin: README.md is the repository's" });
});

test("gate check: the docs row reads the base commit's manifest and the head commit's root README, not the checkout; a bump written down in the commit passes, one missing its entries fails naming them", () => {
  const b = pluginRepo({ changeBad: false });
  const good = join(b.work, "plugins", "good");
  const tree0 = goodTree(b);
  seedCanaryPass(b, "good", tree0);
  // Bump the version in a commit with no entries: docs fails, naming all three.
  write(good, ".claude-plugin/plugin.json", JSON.stringify({ name: "good", version: "0.0.2", state: GOOD_STATE }));
  commitAll(b, "bump");
  seedCanaryPass(b, "good", goodTree(b));
  const r1 = cli(b, ["gate", "check", "--base", "main"], { env: { LEDGER_SESSION_ID: SID } });
  assert.equal(r1.code, 1, r1.out + r1.err);
  assert.match(r1.out, /good\s+docs\s+fail\s+version 0\.0\.1 → 0\.0\.2: CHANGELOG\.md is missing: add it with a "## \[0\.0\.2\]" \(or "## 0\.0\.2"\) entry; README\.md has no "## Changes in 0\.0\.2" \(or "### 0\.0\.2", "### <date> — 0\.0\.2"\) heading; the repository README\.md does not name good: add its row to the plugin table/);
  // Written in the checkout only: the commit is what is checked, so the row still fails.
  write(good, "CHANGELOG.md", "# Changelog\n\n## [0.0.2]\n\n- the thing\n");
  write(good, "README.md", "# Good\n\n## Changes in 0.0.2\n\nThe thing.\n");
  write(b.work, "README.md", "- **[good](#good)** — does the thing. Changes in good 0.0.2: the thing.\n");
  const r2 = cli(b, ["gate", "check", "--base", "main"], { env: { LEDGER_SESSION_ID: SID } });
  assert.match(r2.out, /good\s+docs\s+fail\s+version 0\.0\.1 → 0\.0\.2: CHANGELOG\.md is missing/);
  assert.match(r2.out, /uncommitted changes under plugins\/good\/ were not checked/);
  // Committed: the row passes, with and without --plugins (the base is found either way).
  commitAll(b, "write it down");
  seedCanaryPass(b, "good", goodTree(b));
  for (const args of [["gate", "check", "--base", "main"], ["gate", "check", "--plugins", "good"]]) {
    const r3 = cli(b, args, { env: { LEDGER_SESSION_ID: SID } });
    assert.equal(r3.code, 0, r3.out + r3.err);
    assert.match(r3.out, /good\s+docs\s+pass\s+version 0\.0\.1 → 0\.0\.2: CHANGELOG\.md has its 0\.0\.2 entry; README\.md has its 0\.0\.2 entry; the repository README names it/);
  }
  // Against a base that already has 0.0.2 the row is skipped.
  const r4 = cli(b, ["gate", "check", "--base", "HEAD~1", "--plugins", "good"], { env: { LEDGER_SESSION_ID: SID } });
  assert.match(r4.out, /good\s+docs\s+skipped\s+version 0\.0\.2 unchanged since the base/);
  // A --base that names no commit is an exit 1 naming it, in both modes, before the plugin names are read.
  for (const args of [["gate", "check", "--plugins", "good", "--base", "bogus"], ["gate", "check", "--plugins", "typo", "--base", "bogus"], ["gate", "check", "--base", "bogus"]]) {
    const r5 = cli(b, args, { env: { LEDGER_SESSION_ID: SID } });
    assert.equal(r5.code, 1, r5.out + r5.err);
    assert.match(r5.out + r5.err, /gate check: --base bogus is not a commit/);
    assert.doesNotMatch(r5.out + r5.err, /\bat \w+ \(/, "no stack trace");
  }
});

test("checkPlugin: past the run cap every check records fail with timeout", () => {
  const b = pluginRepo();
  const rows = checkPlugin({ name: "good", dir: join(b.work, "plugins", "good"), prefix: "plugins/good/" }, { deadline: Date.now() - 1 });
  assert.deepEqual(
    rows.map((r) => [r.name, r.status, r.detail]),
    CHECKS.map((c) => [c, "fail", "timeout"]),
  );
});

test("reasonsWithoutCommand: a deny reason needs a backtick command; comments, non-deny reasons and variables are not literals", () => {
  const src = [
    "// a comment about reason: \"none\" is skipped",
    " * reason: 'in a doc comment' too",
    'const row = { verdict: "pass", reason: `empty diff ${range}` };', // no deny or block near: not a deny reason
    'return { rule: "x", reason: `ledger: run \\`ledger note\\` first` };', // rule: context, has a command
    'return { rule: "y", reason: "ledger: no" };', // rule: context, no command → reported
    'out = { permissionDecision: "deny", permissionDecisionReason: "blocked" };', // reported
    'out = { permissionDecision: "deny", permissionDecisionReason: reasonText };', // a variable: not a literal
    "deny({",
    "  reason: `multi",
    "  line \\`cmd\\``,",
    "});",
  ].join("\n");
  assert.deepEqual(
    reasonsWithoutCommand(src).map((r) => r.line),
    [5, 6],
  );
});

test("textsWithoutWhenCant and fixturesWithoutUnavailable: curly apostrophe and 'cannot' count; the sibling rule is per .txt", () => {
  const b = sandbox();
  const dir = join(b.work, "p");
  write(dir, "skills/a/SKILL.md", "# A\n\n## When this can’t be done\n");
  write(dir, "skills/b/SKILL.md", "# B\n\n### When it cannot run\n");
  write(dir, "skills/c/SKILL.md", "# C\n\nwhen this can't (not a heading)\n");
  write(dir, "agents/d.md", "# D\n");
  assert.deepEqual(textsWithoutWhenCant(dir), ["skills/c/SKILL.md", "agents/d.md"]);
  write(dir, "test/fixtures/x.txt", "");
  write(dir, "test/fixtures/x.unavailable.txt", "");
  write(dir, "test/fixtures/y.txt", "");
  write(dir, "test/fixtures/z.unavailable.txt", "");
  write(dir, "test/fixtures/README.md", "");
  assert.deepEqual(fixturesWithoutUnavailable(dir), ["y.txt"]);
});

test("gate check: records one row per changed plugin and check for HEAD, exits 1 on a failure, replaces rows on rerun; --plugins names them; a plain repo is exit 2; evals wants a canary pass for the committed tree", () => {
  const b = pluginRepo();
  const head = git(b, "rev-parse", "HEAD");
  const tree = goodTree(b);
  // Before any canary run, good's evals row fails and names the command.
  const r0 = cli(b, ["gate", "check", "--plugins", "good"], { env: { LEDGER_SESSION_ID: SID } });
  assert.equal(r0.code, 1, r0.out + r0.err);
  assert.match(r0.out, new RegExp(`good\\s+evals\\s+fail\\s+2 scenario\\(s\\) cover the manifest; no canary row for tree ${tree.slice(0, 8)}: run \`ledger canary run --plugins good\` on this commit`));
  seedCanaryPass(b, "good", tree);
  const r = cli(b, ["gate", "check"], { env: { LEDGER_SESSION_ID: SID } });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^gate check [0-9a-f]{8}\n/);
  assert.match(r.out, /bad\s+survives\s+fail/);
  assert.match(r.out, /bad\s+evals\s+fail\s+evals\/manifest\.json missing; PreToolUse has no declared outcomes/);
  assert.match(r.out, /good\s+says\s+pass/);
  assert.match(r.out, /good\s+evals\s+pass\s+2 scenario\(s\) cover 1 event\(s\); canary #\d+ at \S+: live pass/);
  assert.match(r.out, /good\s+retention\s+pass\s+2 state path\(s\) declared/);
  assert.match(r.out, /fix and rerun `ledger gate check`, or `ledger review waive "<why>"` to push anyway/);
  const rows = gateRows(b);
  assert.deepEqual(
    rows.map((x) => [x.plugin, x.name, x.status]),
    [
      ["bad", "docs", "skipped"],
      ["bad", "evals", "fail"],
      ["bad", "retention", "pass"],
      ["bad", "says", "fail"],
      ["bad", "survives", "fail"],
      ["bad", "visible", "fail"],
      ["good", "docs", "skipped"],
      ["good", "evals", "pass"],
      ["good", "retention", "pass"],
      ["good", "says", "pass"],
      ["good", "survives", "pass"],
      ["good", "visible", "pass"],
    ],
  );
  assert.ok(rows.every((x) => x.head_sha === head));
  assert.ok(rows.filter((x) => x.plugin === "good").every((x) => x.tree_sha === tree), "each row certifies the plugin's tree in HEAD");
  // Fix the bad plugin's text without committing and rerun for it alone: the commit is what is
  // checked, so the findings stand and the run says the repair was not checked.
  write(join(b.work, "plugins", "bad"), "skills/bad/SKILL.md", "# Bad\n\n## When this can't run\n\nSay so; evals/pre-tool-use-deny.scenario.json proves it.\n");
  write(join(b.work, "plugins", "bad"), "evals/pre-tool-use-deny.scenario.json", JSON.stringify({ event: "PreToolUse", expect: "deny", stdin: "{not json" }));
  write(join(b.work, "plugins", "bad"), "lib/rules.mjs", 'export const deny = () => ({ permissionDecision: "deny", permissionDecisionReason: "bad: run `bad fix`" });\n');
  const r2 = cli(b, ["gate", "check", "--plugins", "bad"], { env: { LEDGER_SESSION_ID: SID } });
  assert.equal(r2.code, 1);
  assert.match(r2.out, /bad\s+\(uncommitted changes under plugins\/bad\/ were not checked; commit them and rerun\)/);
  assert.match(gateRows(b).find((x) => x.plugin === "bad" && x.name === "says").detail, /skills\/bad\/SKILL\.md has no "How it fails" or "When this can't" heading/);
  // Committed, the repair counts: bad's rows move to the new commit, good's stay on the old one.
  const head2 = commitAll(b, "repair bad");
  const r2b = cli(b, ["gate", "check", "--plugins", "bad"], { env: { LEDGER_SESSION_ID: SID } });
  assert.equal(r2b.code, 1);
  assert.doesNotMatch(r2b.out, /uncommitted changes/);
  assert.equal(gateRows(b).length, 18);
  const says = gateRows(b).find((x) => x.plugin === "bad" && x.name === "says" && x.head_sha === head2);
  assert.equal(says.detail, 'hooks/bad.mjs:6 "bad: no" names no command', "the SKILL.md and lib/rules.mjs findings are gone; the hook's own literal remains");
  assert.equal(cli(b, ["gate", "check", "--plugins", "nope"]).code, 1);
  const plain = sandbox();
  git(plain, "init", "-q");
  writeFileSync(join(plain.work, "a.txt"), "a");
  commitAll(plain, "a");
  const r3 = cli(plain, ["gate", "check"]);
  assert.equal(r3.code, 2);
  assert.match(r3.out, /holds no plugin/);
});

test("gate check: no plugin changed since the base → exit 0 and nothing recorded; inside a batch the verb is refused", () => {
  const b = pluginRepo({ changeBad: false, changeGood: false });
  const r = cli(b, ["gate", "check"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no plugin changed in [0-9a-f]{8}\.\.[0-9a-f]{8}; nothing to check/);
  assert.deepEqual(gateRows(b), []);
  const batch = cli(b, [], { input: "note x\ngate check\n" });
  assert.match(batch.out, /refused gate runs on its own line: `ledger gate …`, not inside a batch/);
});

test("PreToolUse: a push from a repository of plugins is denied without check rows, naming `gate check` and `review waive`; a failed check denies naming it; passing rows allow", () => {
  const b = pluginRepo({ changeBad: false });
  passReview(b);
  const r1 = push(b);
  assert.equal(decision(r1), "deny");
  assert.match(reason(r1), /^ledger: plugin gate: good has no check rows for [0-9a-f]{8}; run `[^`]*ledger\.mjs gate check`, fix, or `[^`]*ledger\.mjs review waive "<why>"`$/);
  // Break good's text and commit it, record the failure: the deny names the check and its detail.
  write(join(b.work, "plugins", "good"), "skills/good/SKILL.md", "# Good\n");
  commitAll(b, "break good");
  passReview(b);
  seedCanaryPass(b, "good", goodTree(b));
  assert.equal(cli(b, ["gate", "check"]).code, 1);
  const r2 = push(b);
  assert.equal(decision(r2), "deny");
  assert.match(reason(r2), /^ledger: plugin gate: good failed says: skills\/good\/SKILL\.md has no "How it fails" or "When this can't" heading; run `/);
  // Repaired in the checkout only: the committed text is what is pushed, so the deny stands.
  write(join(b.work, "plugins", "good"), "skills/good/SKILL.md", GOOD_SKILL);
  assert.equal(cli(b, ["gate", "check"]).code, 1);
  assert.equal(decision(push(b)), "deny");
  // Committed: the pass is for the repaired commit, once the canary has passed on its tree.
  commitAll(b, "repair good");
  passReview(b);
  assert.equal(cli(b, ["gate", "check"]).code, 1, "the repaired tree has no canary pass yet");
  const r2b = push(b);
  assert.equal(decision(r2b), "deny");
  assert.match(reason(r2b), /^ledger: plugin gate: good failed evals: 2 scenario\(s\) cover the manifest; no canary row for tree [0-9a-f]{8}: run `ledger canary run --plugins good` on this commit; run `/);
  seedCanaryPass(b, "good", goodTree(b));
  assert.equal(cli(b, ["gate", "check"]).code, 0);
  const r3 = push(b);
  assert.equal(decision(r3), "allow", r3.out);
  assert.equal(r3.json?.systemMessage, undefined, r3.out);
  // The bounce rows: four denies, then satisfied by the allow.
  const db = openDb(b);
  try {
    assert.deepEqual(
      db.prepare("SELECT rule, outcome FROM cc_bounces WHERE rule = 'pluginGate' ORDER BY id").all().map((x) => [x.rule, x.outcome]),
      [
        ["pluginGate", "satisfied"],
        ["pluginGate", "satisfied"],
        ["pluginGate", "satisfied"],
        ["pluginGate", "satisfied"],
      ],
    );
  } finally {
    db.close();
  }
});

test("PreToolUse: the gate reads the pushed commit, not the checkout: a passed commit stays passed after its checkout is broken; a plugin whose discovery file was removed from the checkout is still gated; a push of another commit needs rows for that commit; rows certifying another tree are no pass", () => {
  const b = pluginRepo({ changeBad: false });
  passReview(b);
  seedCanaryPass(b, "good", goodTree(b));
  assert.equal(cli(b, ["gate", "check"]).code, 0);
  // Break the checkout after the pass: the push carries the committed, passing text.
  write(join(b.work, "plugins", "good"), "skills/good/SKILL.md", "# Good\n");
  rmSync(join(b.work, "plugins", "good", "hooks", "hooks.json"));
  assert.equal(decision(push(b)), "allow");
  // A new commit on top (even one that leaves the plugin as it was): rows are per commit.
  git(b, "checkout", "-q", "--", "plugins/good");
  write(b.work, "README.md", "the repository, again\n");
  write(join(b.work, "plugins", "good"), "README.md", "changed again\n");
  const head = commitAll(b, "again");
  passReview(b);
  const r = push(b);
  assert.equal(decision(r), "deny");
  assert.match(reason(r), /^ledger: plugin gate: good has no check rows for [0-9a-f]{8}; run `/);
  seedCanaryPass(b, "good", goodTree(b));
  assert.equal(cli(b, ["gate", "check"]).code, 0);
  assert.equal(decision(push(b)), "allow");
  // Rows for HEAD that certify another tree (a hand-edited row): no pass.
  const db = openDb(b);
  try {
    db.prepare("UPDATE cc_gate_checks SET tree_sha = ? WHERE head_sha = ? AND plugin = 'good' AND name = 'says'").run("0123456789abcdef0123456789abcdef01234567", head);
  } finally {
    db.close();
  }
  const r2 = push(b);
  assert.equal(decision(r2), "deny");
  assert.match(reason(r2), /^ledger: plugin gate: good's rows for [0-9a-f]{8} certify tree 01234567, not its tree [0-9a-f]{8}; run `/);
  // Rows recorded before a check existed (an older ledger, no docs row): the push names the missing row.
  const db2 = openDb(b);
  try {
    db2.prepare("UPDATE cc_gate_checks SET tree_sha = (SELECT tree_sha FROM cc_gate_checks WHERE head_sha = ? AND plugin = 'good' AND name = 'survives') WHERE head_sha = ? AND plugin = 'good'").run(head, head);
    db2.prepare("DELETE FROM cc_gate_checks WHERE head_sha = ? AND plugin = 'good' AND name = 'docs'").run(head);
  } finally {
    db2.close();
  }
  const r3 = push(b);
  assert.equal(decision(r3), "deny");
  assert.match(reason(r3), /^ledger: plugin gate: good's rows for [0-9a-f]{8} have no docs row \(recorded by an older ledger\); run `[^`]*gate check` again/);
});

test("PreToolUse: the three gates deny together as one numbered list; `review waive` lifts the plugin gate; advise mode turns the deny into a notice", () => {
  const b = pluginRepo({ changeBad: false });
  const fresh = hook(b, "pre-tool-use", { session_id: "s-other", cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin feat" } });
  assert.equal(decision(fresh), "deny");
  assert.match(reason(fresh), /^ledger: this push needs 3 things first, and all are missing:\n1\. record what this push is[^\n]*\n2\. [^\n]*\n3\. plugin gate: good has no check rows/);
  cli(b, ["review", "waive", "not shipping hooks"], { env: { LEDGER_SESSION_ID: SID } });
  const waived = push(b);
  assert.equal(decision(waived), "allow", waived.out);
  // Advise mode on another repository: the deny becomes a notice.
  const w = pluginRepo({ changeBad: false });
  w.writeConfig({ review: { mode: "advise" } });
  const r = push(w);
  assert.equal(decision(r), "allow", r.out);
  assert.match(r.json.systemMessage, /ledger: plugin gate \(advise\): good has no check rows/);
});

test("PreToolUse: a push from a repository that holds no plugin never sees the plugin gate", () => {
  const b = sandbox();
  git(b, "init", "-q", "-b", "main");
  writeFileSync(join(b.work, "a.txt"), "a");
  commitAll(b, "a");
  git(b, "checkout", "-q", "-b", "feat");
  writeFileSync(join(b.work, "b.txt"), "b");
  commitAll(b, "b");
  b.writeConfig({ review: { mode: "gate" } });
  cli(b, ["note", "pushing"], { env: { LEDGER_SESSION_ID: SID } });
  cli(b, ["review", "waive", "plain repo"], { env: { LEDGER_SESSION_ID: SID } });
  const r = push(b);
  assert.equal(decision(r), "allow", r.out);
  const db = openDb(b);
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM cc_bounces WHERE rule = 'pluginGate'").get().n, 0);
  } finally {
    db.close();
  }
});

test("the ledger plugin itself passes its own gate: the five static rows on the checkout (docs against the repository README, as a first release), and evals once a canary pass certifies its committed tree", () => {
  const dir = join(import.meta.dirname, "..");
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const tree = treeSha(top, "HEAD", "plugins/ledger/");
  const b = sandbox();
  // The canary row the real `canary run` would record for this tree; the live run itself is
  // the canary's job (test/canary-report-digest.test.mjs), not this suite's.
  const id = seedCanaryPass(b, "ledger", tree);
  // No base version: the row checks the checkout's own version is written down in all three places.
  const docs = { baseVersion: null, rootReadme: readFileSync(join(top, "README.md"), "utf8") };
  const rows = withDb(b, (db) => checkPlugin({ name: "ledger", dir, prefix: "plugins/ledger/" }, { db, tree, docs }));
  assert.deepEqual(
    rows.map((r) => [r.name, r.status]),
    CHECKS.map((c) => [c, "pass"]),
    JSON.stringify(rows),
  );
  assert.match(rows[3].detail, new RegExp(`^\\d+ scenario\\(s\\) cover 5 event\\(s\\); canary #${id} at \\S+: live pass$`));
  assert.match(rows[4].detail, /^6 state path\(s\) declared \(1 with a prune, 4 kept by design\); 1 prune command\(s\) ran dry; \d+ write site\(s\) in source$/);
  const version = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).version;
  assert.equal(rows[5].detail, `version ${version}, new since the base: CHANGELOG.md has its ${version} entry; README.md has its ${version} entry; the repository README names it`);
  // Without the canary row the same checkout fails evals alone, naming the command.
  const cold = withDb(sandbox(), (db) => checkPlugin({ name: "ledger", dir, prefix: "plugins/ledger/" }, { db, tree, docs }));
  assert.deepEqual(cold.map((r) => [r.name, r.status]), CHECKS.map((c) => [c, c === "evals" ? "fail" : "pass"]));
  assert.equal(cold[3].detail, `${rows[3].detail.match(/^\d+/)[0]} scenario(s) cover the manifest; no canary row for tree ${tree.slice(0, 8)}: run \`ledger canary run --plugins ledger\` on this commit`);
});

test("survives: plain-text stdout is an answer from a PreCompact hook (summary instructions, exit 0, under 10,000 characters) and a crash from any other event; JSON stays valid; 10,000 characters or more fails", () => {
  const b = sandbox();
  const dir = join(b.root, "plugins", "text");
  // Each prints the same stdout on every input, like a PreCompact hook giving the summary its instructions.
  const prints = (file, text) => write(dir, `hooks/${file}`, `process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(${JSON.stringify(text)}); process.exit(0); });\n`);
  prints("text.mjs", "End the summary with a section headed ## Handoff.");
  prints("json.mjs", JSON.stringify({ systemMessage: "ok" }));
  prints("longest.mjs", "x".repeat(PRECOMPACT_TEXT_MAX - 1));
  prints("over.mjs", "x".repeat(PRECOMPACT_TEXT_MAX));
  const plugin = { name: "text", dir };
  const run = (event, file) => FAULT_INPUTS.map((input) => spawnHook(plugin, { event, command: process.execPath, args: [join(dir, "hooks", file)] }, input));
  assert.equal(PRECOMPACT_TEXT_MAX, 10000);
  for (const file of ["text.mjs", "json.mjs", "longest.mjs"]) for (const r of run("PreCompact", file)) assert.equal(r.ok, true, `${file}: ${r.why}`);
  for (const r of run("PreCompact", "over.mjs")) assert.match(r.why ?? "", /^PreCompact hook on .*: plain-text stdout is 10000 characters; Claude Code takes PreCompact summary instructions under 10000$/);
  for (const event of ["Stop", "UserPromptSubmit", "SessionStart"]) for (const r of run(event, "text.mjs")) assert.match(r.why ?? "", new RegExp(`^${event} hook on .*: stdout is not JSON \\(End the summary`));
  for (const r of run("Stop", "json.mjs")) assert.equal(r.ok, true, r.why);
});
