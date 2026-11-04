// plugin-gate.test.mjs — the three-check push gate (README "The plugin gate"): what counts as a
// repository of plugins, each check's pass and fail on a fixture plugin, the rows `gate check`
// records and replaces, and the PreToolUse deny with its way out (`gate check` or `review waive`).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, cli, hook, openDb } from "./helpers.mjs";
import { checkPlugin, fixturesWithoutUnavailable, hookCommands, reasonsWithoutCommand, treePlugins, treeSha, snapshotTree, textsWithoutWhenCant, changedPlugins, CHECKS, FAULT_INPUTS } from "../lib/plugin-gate.mjs";

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

/** A repository with plugins/good (meets the bar) and plugins/bad (fails every check), committed on main, then a change on `feat`. */
function pluginRepo({ changeBad = true, changeGood = true } = {}) {
  const b = sandbox();
  git(b, "init", "-q", "-b", "main");
  const good = join(b.work, "plugins", "good");
  write(good, "hooks/hooks.json", hooksJson("good", "good.mjs"));
  write(good, "hooks/good.mjs", GOOD_HOOK);
  write(good, "skills/good/SKILL.md", "# Good\n\nDo the thing.\n\n## When this can't run\n\nSay so.\n");
  write(good, "lib/rules.mjs", "export const deny = () => ({ permissionDecision: \"deny\", permissionDecisionReason: `good: run \\`good fix\\` first` });\n");
  write(good, "test/fixtures/lab.txt", "ok\n");
  write(good, "test/fixtures/lab.unavailable.txt", "lab: unavailable\n");
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

test("checkPlugin: a plugin that meets the bar passes all three checks", () => {
  const b = pluginRepo();
  const rows = checkPlugin({ name: "good", dir: join(b.work, "plugins", "good"), prefix: "plugins/good/" });
  assert.deepEqual(
    rows.map((r) => [r.name, r.status]),
    CHECKS.map((c) => [c, "pass"]),
  );
  assert.equal(rows[0].detail, `1 hook(s) × ${FAULT_INPUTS.length} fault inputs`);
});

test("checkPlugin: the failing plugin fails each check, naming the hook and input, the missing fixture, the SKILL.md and the reason literal", () => {
  const b = pluginRepo();
  const rows = checkPlugin({ name: "bad", dir: join(b.work, "plugins", "bad"), prefix: "plugins/bad/" });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.survives.status, "fail");
  assert.match(by.survives.detail, /PreToolUse hook on empty stdin: exit 1/);
  assert.match(by.survives.detail, /PreToolUse hook on malformed JSON: denied/);
  assert.equal(by.visible.status, "fail");
  assert.match(by.visible.detail, /test\/fixtures\/lab\.txt has no lab\.unavailable\.txt/);
  assert.equal(by.says.status, "fail");
  assert.match(by.says.detail, /skills\/bad\/SKILL\.md has no "When this can't" heading/);
  assert.match(by.says.detail, /lib\/rules\.mjs:1 "bad: no" names no command/);
});

test("checkPlugin: no hooks.json → survives is skipped, the other two still run", () => {
  const b = pluginRepo();
  const rows = checkPlugin({ name: "docs-only", dir: join(b.work, "plugins", "docs-only"), prefix: "plugins/docs-only/" });
  assert.deepEqual(
    rows.map((r) => [r.name, r.status]),
    [
      ["survives", "skipped"],
      ["visible", "pass"],
      ["says", "pass"],
    ],
  );
  assert.equal(rows[0].detail, "no hooks/hooks.json");
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

test("gate check: records one row per changed plugin and check for HEAD, exits 1 on a failure, replaces rows on rerun; --plugins names them; a plain repo is exit 2", () => {
  const b = pluginRepo();
  const head = git(b, "rev-parse", "HEAD");
  const r = cli(b, ["gate", "check"], { env: { LEDGER_SESSION_ID: SID } });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^gate check [0-9a-f]{8}\n/);
  assert.match(r.out, /bad\s+survives\s+fail/);
  assert.match(r.out, /good\s+says\s+pass/);
  assert.match(r.out, /fix and rerun `ledger gate check`, or `ledger review waive "<why>"` to push anyway/);
  const rows = gateRows(b);
  assert.deepEqual(
    rows.map((x) => [x.plugin, x.name, x.status]),
    [
      ["bad", "says", "fail"],
      ["bad", "survives", "fail"],
      ["bad", "visible", "fail"],
      ["good", "says", "pass"],
      ["good", "survives", "pass"],
      ["good", "visible", "pass"],
    ],
  );
  assert.ok(rows.every((x) => x.head_sha === head));
  assert.ok(rows.filter((x) => x.plugin === "good").every((x) => x.tree_sha === git(b, "rev-parse", `${head}:plugins/good`)), "each row certifies the plugin's tree in HEAD");
  // Fix the bad plugin's text without committing and rerun for it alone: the commit is what is
  // checked, so the findings stand and the run says the repair was not checked.
  write(join(b.work, "plugins", "bad"), "skills/bad/SKILL.md", "# Bad\n\n## When this can't run\n\nSay so.\n");
  write(join(b.work, "plugins", "bad"), "lib/rules.mjs", 'export const deny = () => ({ permissionDecision: "deny", permissionDecisionReason: "bad: run `bad fix`" });\n');
  const r2 = cli(b, ["gate", "check", "--plugins", "bad"], { env: { LEDGER_SESSION_ID: SID } });
  assert.equal(r2.code, 1);
  assert.match(r2.out, /bad\s+\(uncommitted changes under plugins\/bad\/ were not checked; commit them and rerun\)/);
  assert.match(gateRows(b).find((x) => x.plugin === "bad" && x.name === "says").detail, /skills\/bad\/SKILL\.md has no "When this can't" heading/);
  // Committed, the repair counts: bad's rows move to the new commit, good's stay on the old one.
  const head2 = commitAll(b, "repair bad");
  const r2b = cli(b, ["gate", "check", "--plugins", "bad"], { env: { LEDGER_SESSION_ID: SID } });
  assert.equal(r2b.code, 1);
  assert.doesNotMatch(r2b.out, /uncommitted changes/);
  assert.equal(gateRows(b).length, 9);
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
  assert.equal(cli(b, ["gate", "check"]).code, 1);
  const r2 = push(b);
  assert.equal(decision(r2), "deny");
  assert.match(reason(r2), /^ledger: plugin gate: good failed says: skills\/good\/SKILL\.md has no "When this can't" heading; run `/);
  // Repaired in the checkout only: the committed text is what is pushed, so the deny stands.
  write(join(b.work, "plugins", "good"), "skills/good/SKILL.md", "# Good\n\n## When this can't run\n\nSay so.\n");
  assert.equal(cli(b, ["gate", "check"]).code, 1);
  assert.equal(decision(push(b)), "deny");
  // Committed: the pass is for the repaired commit.
  commitAll(b, "repair good");
  passReview(b);
  assert.equal(cli(b, ["gate", "check"]).code, 0);
  const r3 = push(b);
  assert.equal(decision(r3), "allow", r3.out);
  assert.equal(r3.json?.systemMessage, undefined, r3.out);
  // The bounce rows: three denies, then satisfied by the allow.
  const db = openDb(b);
  try {
    assert.deepEqual(
      db.prepare("SELECT rule, outcome FROM cc_bounces WHERE rule = 'pluginGate' ORDER BY id").all().map((x) => [x.rule, x.outcome]),
      [
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

test("the ledger plugin itself passes its own gate", () => {
  const rows = checkPlugin({ name: "ledger", dir: join(import.meta.dirname, ".."), prefix: "plugins/ledger/" });
  assert.deepEqual(
    rows.map((r) => [r.name, r.status]),
    CHECKS.map((c) => [c, "pass"]),
    JSON.stringify(rows),
  );
});

