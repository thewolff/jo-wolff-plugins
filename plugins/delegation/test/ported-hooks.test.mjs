// test/ported-hooks.test.mjs — delegation-guard, worktree-spawn-guard and repo-rules-inject,
// each spawned end-to-end through lib/hook-runner.mjs: the warn default, the block mode, off,
// and the states that keep each silent.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { box, gitRepo, runHook, setConfig } from "./helpers.mjs";
import { lineCount } from "../hooks/delegation-guard.mjs";

const pre = (tool_name, tool_input, { cwd, session_id = "s-ported", agent_type, agent_id } = {}) => ({ session_id, cwd, hook_event_name: "PreToolUse", tool_name, tool_input, ...(agent_type ? { agent_type } : {}), ...(agent_id ? { agent_id } : {}) });
const context = (r) => r.out?.hookSpecificOutput?.additionalContext ?? null;
const deny = (r) => r.out?.hookSpecificOutput?.permissionDecision === "deny" ? r.out.hookSpecificOutput.permissionDecisionReason : null;

// ---- delegation-guard ----

function bigFile(dir, lines = 1200) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "big.ts");
  writeFileSync(p, Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n");
  return p;
}

test("delegation-guard check 1: an oversized Read warns by default, blocks in block mode, and a bounded slice passes", (t) => {
  const { env } = box(t);
  const p = bigFile(join(env.HOME, "w"));
  const r = runHook("delegation-guard", pre("Read", { file_path: p }, { cwd: env.HOME }), env);
  assert.match(context(r), /`.*big\.ts` is over the 1000-line threshold.*`reader` subagent/);
  assert.equal(deny(r), null);
  assert.equal(runHook("delegation-guard", pre("Read", { file_path: p, offset: 10, limit: 50 }, { cwd: env.HOME }), env).out, null, "a bounded slice");
  assert.equal(runHook("delegation-guard", pre("Read", { file_path: p }, { cwd: env.HOME, agent_type: "plugin:reader" }), env).out, null, "inside a reader");
  setConfig(env, { checks: { "delegation-guard": "block" } });
  const d = runHook("delegation-guard", pre("Read", { file_path: p }, { cwd: env.HOME }), env);
  assert.match(deny(d), /over the 1000-line threshold.*Refused\. Read a bounded slice instead/);
  setConfig(env, { readLineThreshold: 2000 });
  assert.equal(runHook("delegation-guard", pre("Read", { file_path: p }, { cwd: env.HOME }), env).out, null, "threshold raised");
  setConfig(env, { checks: { "delegation-guard": "off" } });
  assert.equal(runHook("delegation-guard", pre("Read", { file_path: p }, { cwd: env.HOME }), env).out, null, "off");
});

test("delegation-guard check 1: counting stops at the threshold plus one line, and a limit under the threshold is never counted", (t) => {
  const { env } = box(t);
  const p = bigFile(join(env.HOME, "w"), 5000);
  assert.equal(lineCount(p), 5000);
  assert.equal(lineCount(p, 1000), 1001);
  assert.equal(lineCount(p, 10_000), 5000);
  assert.equal(runHook("delegation-guard", pre("Read", { file_path: p, limit: 1000 }, { cwd: env.HOME }), env).out, null, "a limit at the threshold");
  assert.match(context(runHook("delegation-guard", pre("Read", { file_path: p, limit: 4000 }, { cwd: env.HOME }), env)), /over the 1000-line threshold/, "a limit over the threshold");
});

test("delegation-guard check 2: the sixth distinct file warns once per streak; a spawn resets it; subagents are exempt", (t) => {
  const { env } = box(t);
  const dir = join(env.HOME, "w");
  mkdirSync(dir);
  const files = Array.from({ length: 8 }, (_, i) => {
    const p = join(dir, `f${i}.ts`);
    writeFileSync(p, "x\n");
    return p;
  });
  for (let i = 0; i < 5; i++) assert.equal(runHook("delegation-guard", pre("Read", { file_path: files[i] }, { cwd: dir }), env).out, null, `file ${i}`);
  assert.equal(runHook("delegation-guard", pre("Read", { file_path: files[0] }, { cwd: dir }), env).out, null, "a re-read is not a new file");
  const sixth = runHook("delegation-guard", pre("Read", { file_path: files[5] }, { cwd: dir }), env);
  assert.match(context(sixth), /touched 6 distinct files directly this streak \(.*f0\.ts.*f5\.ts\).*`builder` subagent/);
  assert.equal(runHook("delegation-guard", pre("Read", { file_path: files[6] }, { cwd: dir }), env).out, null, "once per streak");
  const guardLog = () => readFileSync(join(env.XDG_STATE_HOME, "delegation", "guard", "s-ported.jsonl"), "utf8");
  assert.equal(runHook("delegation-guard", pre("Agent", { prompt: "x" }, { cwd: dir }), env).out, null, "the PreToolUse spawn is silent");
  assert.doesNotMatch(guardLog(), /"reset"/, "a PreToolUse spawn (which the spawn gate may deny) does not reset the streak");
  assert.equal(runHook("delegation-guard", { ...pre("Agent", { prompt: "x" }, { cwd: dir }), hook_event_name: "PostToolUse", tool_response: {} }, env).out, null, "the PostToolUse spawn is silent");
  assert.match(guardLog(), /"reset"/, "a spawn that ran resets the streak");
  for (let i = 0; i < 5; i++) assert.equal(runHook("delegation-guard", pre("Read", { file_path: files[i] }, { cwd: dir }), env).out, null, `after reset ${i}`);
  assert.match(context(runHook("delegation-guard", pre("Read", { file_path: files[7] }, { cwd: dir }), env)), /touched 6 distinct files/);
  const sub = box(t);
  for (let i = 0; i < 8; i++) assert.equal(runHook("delegation-guard", pre("Read", { file_path: files[i] }, { cwd: dir, agent_id: "a9", agent_type: "builder" }), sub.env).out, null, "subagent");
  setConfig(env, { streakThreshold: 3 });
  const fresh = box(t, { config: { streakThreshold: 3 } });
  for (let i = 0; i < 2; i++) runHook("delegation-guard", pre("Read", { file_path: files[i] }, { cwd: dir }), fresh.env);
  assert.match(context(runHook("delegation-guard", pre("Read", { file_path: files[2] }, { cwd: dir }), fresh.env)), /touched 3 distinct files/);
});

test("delegation-guard check 3: whole-tree Bash searches and unscoped Greps warn; scoped ones and a scout pass", (t) => {
  const { env } = box(t);
  const cwd = env.HOME;
  for (const command of ["rg TODO", "grep -rn foo", "find . -name '*.ts'", "rg TODO # in src", "cd x && grep -R foo", "rg -t ts TODO ."]) {
    assert.match(context(runHook("delegation-guard", pre("Bash", { command }, { cwd }), env)) ?? "", /whole-tree search.*`scout` subagent/, command);
  }
  for (const command of ["rg TODO src/", "grep -rn foo lib/x", "find src -name '*.ts'", "find . -maxdepth 1 -name x", "grep foo file.txt", "ls -la", 'rg "foo|bar" src/']) {
    assert.equal(runHook("delegation-guard", pre("Bash", { command }, { cwd }), env).out, null, command);
  }
  assert.equal(runHook("delegation-guard", pre("Bash", { command: "rg TODO" }, { cwd, agent_type: "scout" }), env).out, null, "a scout");
  assert.match(context(runHook("delegation-guard", pre("Grep", { pattern: "x" }, { cwd }), env)), /no subdirectory scoping it/);
  assert.match(context(runHook("delegation-guard", pre("Grep", { pattern: "x", path: "." }, { cwd }), env)), /no subdirectory scoping it/);
  assert.match(context(runHook("delegation-guard", pre("Grep", { pattern: "x", path: cwd }, { cwd }), env)), /no subdirectory scoping it/);
  assert.equal(runHook("delegation-guard", pre("Grep", { pattern: "x", path: "src" }, { cwd }), env).out, null, "scoped grep");
  setConfig(env, { checks: { "delegation-guard": "block" } });
  assert.match(deny(runHook("delegation-guard", pre("Bash", { command: "rg TODO" }, { cwd }), env)), /Refused\. Re-run it scoped to a single directory/);
  assert.match(deny(runHook("delegation-guard", pre("Grep", { pattern: "x" }, { cwd }), env)), /Refused\. Re-issue it with a `path`/);
});

test("delegation-guard: a missing or binary file, an unknown tool, and a keyless payload are silent", (t) => {
  const { env } = box(t);
  const bin = join(env.HOME, "bin.dat");
  writeFileSync(bin, Buffer.concat([Buffer.alloc(3000, 10), Buffer.from([0])]));
  assert.equal(runHook("delegation-guard", pre("Read", { file_path: bin }, { cwd: env.HOME }), env).out, null, "binary");
  assert.equal(runHook("delegation-guard", pre("Read", { file_path: join(env.HOME, "nope.ts") }, { cwd: env.HOME }), env).out, null, "missing");
  assert.equal(runHook("delegation-guard", pre("Edit", { file_path: bin }, { cwd: env.HOME }), env).out, null, "other tool");
  const keyless = pre("Read", { file_path: bin }, { cwd: env.HOME });
  delete keyless.session_id;
  assert.equal(runHook("delegation-guard", keyless, env).out, null, "no session");
});

// ---- worktree-spawn-guard ----

const wt = (cwd, isolation = "worktree", tool_name = "Agent") => pre(tool_name, { prompt: "x", isolation }, { cwd });

test("worktree-spawn-guard: a dirty tree warns by default and denies in block mode; a clean tree, no isolation, or no repo is silent", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env);
  assert.equal(runHook("worktree-spawn-guard", wt(repo), env).out, null, "clean tree");
  writeFileSync(join(repo, "new.txt"), "untracked\n");
  const r = runHook("worktree-spawn-guard", wt(repo), env);
  assert.match(context(r), /isolation: "worktree" but the tree at .*repo is dirty.*\n\ngit status --porcelain \(first 10\):\n\?\? new\.txt\n\n.*Commit the working tree first/s);
  assert.equal(deny(r), null);
  assert.equal(runHook("worktree-spawn-guard", wt(repo, "none"), env).out, null, "no isolation asked");
  assert.equal(runHook("worktree-spawn-guard", wt(repo, "worktree", "Bash"), env).out, null, "not a spawn");
  const loose = join(env.HOME, "loose");
  mkdirSync(loose);
  assert.equal(runHook("worktree-spawn-guard", wt(loose), env).out, null, "not a repository");
  assert.equal(runHook("worktree-spawn-guard", wt(join(env.HOME, "missing")), env).out, null, "cwd does not exist");
  setConfig(env, { checks: { "worktree-spawn-guard": "block" } });
  assert.match(deny(runHook("worktree-spawn-guard", wt(repo), env)), /is dirty.*Refused\. Commit the working tree first/s);
  setConfig(env, { checks: { "worktree-spawn-guard": "off" } });
  assert.equal(runHook("worktree-spawn-guard", wt(repo), env).out, null, "off");
});

test("worktree-spawn-guard: a workspace root whose repos/ holds git repositories is named, even when its own tree is clean", (t) => {
  const { env } = box(t);
  const ws = gitRepo(join(env.HOME, "ws"), env);
  gitRepo(join(ws, "repos", "child"), env);
  writeFileSync(join(ws, ".gitignore"), "repos/\n");
  const r = runHook("worktree-spawn-guard", wt(ws), env);
  assert.match(context(r), /working directory is a workspace root \(.*ws\)\. Every directory under repos\/ there is its own git repository/);
  assert.equal(runHook("worktree-spawn-guard", wt(join(ws, "repos", "child")), env).out, null, "the child itself is fine");
});

// ---- repo-rules-inject ----

function tree(env) {
  const ws = join(env.HOME, "ws");
  const repo = join(ws, "repos", "api");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# Workspace rules\n\nBe kind.\n");
  writeFileSync(join(repo, "CLAUDE.md"), "# api rules\n\nUse the @docs/style.md guide.\n");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "style.md"), "Two spaces.\n");
  writeFileSync(join(repo, "src", "x.ts"), "x\n");
  return { ws, repo, file: join(repo, "src", "x.ts") };
}

test("repo-rules-inject: the first touch of a file under an unloaded rules chain injects it with imports resolved; the second is silent", (t) => {
  const { env } = box(t);
  const { ws, file, repo } = tree(env);
  const r = runHook("repo-rules-inject", pre("Edit", { file_path: file, old_string: "a", new_string: "b" }, { cwd: ws }), env, { extraEnv: { CLAUDE_PROJECT_DIR: ws } });
  const ctx = context(r);
  assert.match(ctx, /^# Rules chain for `api` \(auto-loaded by delegation repo-rules-inject\)/);
  assert.ok(ctx.includes(`## Rules from \`${join(repo, "CLAUDE.md")}\``), ctx);
  assert.match(ctx, /Use the Two spaces\.\n guide\./, "the @import is expanded");
  assert.doesNotMatch(ctx, /Workspace rules/, "the launch dir's own rules are not repeated");
  assert.equal(runHook("repo-rules-inject", pre("Read", { file_path: file }, { cwd: ws }), env, { extraEnv: { CLAUDE_PROJECT_DIR: ws } }).out, null, "second touch");
});

test("repo-rules-inject: re-entering a repository after working elsewhere gets a one-line reminder; other tools, no path, and off are silent", (t) => {
  const { env } = box(t);
  const { ws, file } = tree(env);
  const other = join(ws, "repos", "web");
  mkdirSync(join(other, "src"), { recursive: true });
  writeFileSync(join(other, "AGENTS.md"), "# web rules\n");
  writeFileSync(join(other, "src", "y.ts"), "y\n");
  const opts = { extraEnv: { CLAUDE_PROJECT_DIR: ws } };
  assert.match(context(runHook("repo-rules-inject", pre("Read", { file_path: file }, { cwd: ws }), env, opts)), /# Rules chain for `api`/);
  assert.match(context(runHook("repo-rules-inject", pre("Read", { file_path: join(other, "src", "y.ts") }, { cwd: ws }), env, opts)), /# Rules chain for `web`/);
  assert.match(context(runHook("repo-rules-inject", pre("Read", { file_path: file }, { cwd: ws }), env, opts)), /^# Now editing `api` \(delegation repo-rules-inject\)/);
  assert.equal(runHook("repo-rules-inject", pre("Read", { file_path: file }, { cwd: ws }), env, opts).out, null, "still in api");
  assert.equal(runHook("repo-rules-inject", pre("Bash", { command: "ls" }, { cwd: ws }), env, opts).out, null, "other tool");
  assert.equal(runHook("repo-rules-inject", pre("Write", { content: "x" }, { cwd: ws }), env, opts).out, null, "no path");
  setConfig(env, { checks: { "repo-rules-inject": "off" } });
  const fresh = box(t, { config: { checks: { "repo-rules-inject": "off" } } });
  assert.equal(runHook("repo-rules-inject", pre("Read", { file_path: file }, { cwd: ws }), fresh.env, opts).out, null, "off");
});

test("repo-rules-inject: a section past the budget becomes a pointer with an outline, and the whole stays under the budget", (t) => {
  const { env } = box(t, { config: { rulesBudget: 1500 } });
  const { ws, file, repo } = tree(env);
  writeFileSync(join(repo, "CLAUDE.md"), `# Big rules\n\n## Section one\n${"word ".repeat(400)}\n\n## Section two\nx\n`);
  const ctx = context(runHook("repo-rules-inject", pre("Read", { file_path: file }, { cwd: ws }), env, { extraEnv: { CLAUDE_PROJECT_DIR: ws } }));
  assert.ok(ctx.length <= 1500, `${ctx.length} chars`);
  assert.match(ctx, /past this hook's 1500-character budget, so the text is NOT inlined\.\*\* Read `.*CLAUDE\.md` in full/);
  assert.match(ctx, /- Big rules\n  - Section one\n  - Section two/);
});
