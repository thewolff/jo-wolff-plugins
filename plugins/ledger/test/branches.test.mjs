// branches.test.mjs — an unlanded branch is owed work: a commit records it (PostToolUse and
// PostToolUseFailure, spawned), `pending` and the Stop rule show it, a rebase merge on the remote
// closes it, `drop` with a reason closes it, and the config switches turn the recording off.
// Every repository is a real temporary git repository with a bare origin.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, hook, cli, openDb, row } from "./helpers.mjs";
import { commitDirs, committedRefs, mayCommit, refreshBranches, unlandedCommits } from "../lib/branches.mjs";

const SID = "s-branches";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_NOSYSTEM: "1" };

function git(b, cwd, ...args) {
  return execFileSync("git", args, { cwd, env: { ...b.env, ...GIT_ENV }, encoding: "utf8" }).trim();
}

/** A bare origin with one commit on main, a clone of it in b.work, and a second clone (`other`) that plays the merging teammate. */
function repos(b) {
  const origin = join(b.root, "origin.git");
  const seed = join(b.root, "seed");
  mkdirSync(seed);
  git(b, b.root, "init", "-q", "--bare", "-b", "main", origin);
  git(b, seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "a\n");
  git(b, seed, "add", ".");
  git(b, seed, "commit", "-q", "-m", "first");
  git(b, seed, "remote", "add", "origin", origin);
  git(b, seed, "push", "-q", "origin", "main");
  const work = join(b.work, "repo");
  git(b, b.work, "clone", "-q", origin, work);
  const other = join(b.root, "other");
  git(b, b.root, "clone", "-q", origin, other);
  return { origin, work, other };
}

function commitOn(b, dir, branch, file = "f.txt") {
  if (branch) git(b, dir, "switch", "-q", "-c", branch);
  writeFileSync(join(dir, file), `${file} ${Math.random()}\n`);
  git(b, dir, "add", ".");
  git(b, dir, "commit", "-q", "-m", `change ${file}`);
  return git(b, dir, "rev-parse", "HEAD");
}

function post(b, command, { cwd = b.work, event = "PostToolUse", extra = {} } = {}) {
  return hook(b, "post-tool-use", { session_id: SID, cwd, hook_event_name: event, tool_name: "Bash", tool_input: { command }, ...extra }, { env: GIT_ENV });
}

const pending = (b, cwd = b.work) => cli(b, ["pending"], { cwd, env: { LEDGER_SESSION_ID: SID } });
const branchRows = (b) => {
  const db = openDb(b);
  try {
    return db.prepare("SELECT id, state, branch, repo, head_sha, branch_state, ref, reason, made_by, session_id FROM cc_owed WHERE branch IS NOT NULL ORDER BY made_at").all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};

test("commitDirs follows cd and -C in their shell scope and leaves out what it cannot name", () => {
  assert.deepEqual(commitDirs("git commit -m x", "/w"), ["/w"]);
  assert.deepEqual(commitDirs("cd /r && git add . && git commit -m 'x y'", "/w"), ["/r"]);
  assert.deepEqual(commitDirs("git -C sub commit -m x", "/w"), ["/w/sub"]);
  assert.deepEqual(commitDirs("cd /r && git -C ../s commit -m x", "/w"), ["/s"]);
  assert.deepEqual(commitDirs("(cd /r && git commit -m x); git commit -m y", "/w"), ["/r", "/w"]);
  assert.deepEqual(commitDirs("GIT_EDITOR=true git -c user.name=x commit --amend", "/w"), ["/w"]);
  assert.deepEqual(commitDirs("cd $REPO && git commit -m x", "/w"), []);
  assert.deepEqual(commitDirs("git --git-dir=/x/.git commit -m x", "/w"), []);
  assert.deepEqual(commitDirs("git log --grep commit", "/w"), []);
  assert.deepEqual(commitDirs("echo git commit", "/w"), []);
  assert.equal(mayCommit("ls -la"), false);
  assert.equal(mayCommit(undefined), false);
});

test("unlandedCommits reads the + lines of real git cherry output", () => {
  const b = sandbox();
  const { work } = repos(b);
  const sha = commitOn(b, work, "feature");
  const out = git(b, work, "cherry", "origin/main", "feature");
  assert.deepEqual(unlandedCommits(out), [sha]);
  assert.deepEqual(unlandedCommits(""), []);
  assert.deepEqual(unlandedCommits("- abc\n"), []);
});

test("a commit on a branch is recorded once, shows as not pushed, then pushed; a later commit updates the same item", () => {
  const b = sandbox();
  const { work } = repos(b);
  const sha = commitOn(b, work, "feature");
  const r = post(b, "git commit -m 'change f.txt'", { cwd: work });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "", "the hook prints nothing");
  let rows = branchRows(b);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "owed");
  assert.equal(rows[0].branch, "feature");
  assert.equal(rows[0].repo, work);
  assert.equal(rows[0].head_sha, sha);
  assert.equal(rows[0].branch_state, "unpushed");
  assert.equal(rows[0].session_id, SID);
  assert.match(pending(b, work).out, new RegExp(`^owed ow-[a-z0-9]+  # land branch feature in ${work} · ${sha.slice(0, 8)} · not pushed$`, "m"));

  git(b, work, "push", "-q", "-u", "origin", "feature");
  assert.match(pending(b, work).out, / · pushed, not landed$/m);

  const sha2 = commitOn(b, work, null, "g.txt");
  post(b, `git -C ${work} commit -m g`);
  rows = branchRows(b);
  assert.equal(rows.length, 1, "one open item per branch");
  assert.equal(rows[0].head_sha, sha2);
  assert.equal(rows[0].branch_state, "unpushed");
});

test("the Stop owed rule blocks once on an unstarted branch and says how to clear it; SessionStart lists it", () => {
  const b = sandbox();
  const { work } = repos(b);
  hook(b, "session-start", { session_id: SID, cwd: work, hook_event_name: "SessionStart", source: "startup" });
  commitOn(b, work, "feature");
  post(b, "git commit -m x", { cwd: work });
  const transcript_path = join(b.root, "t.jsonl");
  writeFileSync(transcript_path, "");
  const s = hook(b, "stop", { session_id: SID, cwd: work, hook_event_name: "Stop", prompt_id: "p-1", stop_hook_active: false, last_assistant_message: "Committed the change on the feature branch.", transcript_path });
  assert.equal(s.json?.decision, "block", s.out);
  assert.match(s.json.reason, /a branch this session committed to has not landed/);
  assert.match(s.json.reason, /- land branch feature in .* · [0-9a-f]{8} · not pushed \(ow-/);
  assert.match(s.json.reason, /start <ow-id> "<PR url>"/);
  const again = hook(b, "stop", { session_id: SID, cwd: work, hook_event_name: "Stop", prompt_id: "p-1", stop_hook_active: true, last_assistant_message: "ok", transcript_path });
  assert.equal(again.json?.decision, undefined, "once per prompt");
  const ss = hook(b, "session-start", { session_id: SID, cwd: work, hook_event_name: "SessionStart", source: "startup" });
  assert.match(ss.json.hookSpecificOutput.additionalContext, /- land branch feature in .* · [0-9a-f]{8} · not pushed \(ow-/);
});

test("a branch rebase-merged on the remote closes itself after a fetch, even with its worktree removed", () => {
  const b = sandbox();
  const { work, other } = repos(b);
  // The branch lives in a linked worktree that is removed before the check.
  const wt = join(b.root, "wt");
  git(b, work, "worktree", "add", "-q", "-b", "feature", wt);
  commitOn(b, wt, null);
  post(b, "git commit -m x", { cwd: wt });
  git(b, wt, "push", "-q", "origin", "feature");
  assert.equal(branchRows(b)[0].state, "owed");

  // The teammate rebase-merges: main gets the same patch under a new sha.
  git(b, other, "commit", "-q", "--allow-empty", "-m", "unrelated on main");
  git(b, other, "fetch", "-q", "origin");
  git(b, other, "cherry-pick", "origin/feature");
  git(b, other, "push", "-q", "origin", "main");
  const landedSha = git(b, other, "rev-parse", "HEAD");
  assert.notEqual(landedSha, branchRows(b)[0].head_sha, "the rebase merge rewrote the sha");

  // Not fetched yet: still owed (no network from the check).
  pending(b, work);
  assert.equal(branchRows(b)[0].state, "owed");

  git(b, work, "worktree", "remove", "--force", wt);
  git(b, work, "fetch", "-q", "origin");
  const out = pending(b, work).out;
  assert.doesNotMatch(out, /land branch feature/);
  const [r] = branchRows(b);
  assert.equal(r.state, "done");
  assert.equal(r.ref, "landed on origin/main");
});

test("drop with a reason closes a branch item; a commit with nothing unlanded or on a detached HEAD records nothing", () => {
  const b = sandbox();
  const { work } = repos(b);
  commitOn(b, work, "spike");
  post(b, "git commit -m x", { cwd: work });
  const id = branchRows(b)[0].id;
  assert.equal(cli(b, ["drop", id], { cwd: work, env: { LEDGER_SESSION_ID: SID } }).code, 1, "drop needs a reason (refused, exit 1)");
  const d = cli(b, ["drop", id, "spike, not needed"], { cwd: work, env: { LEDGER_SESSION_ID: SID } });
  assert.equal(d.code, 0, d.err);
  assert.deepEqual([branchRows(b)[0].state, branchRows(b)[0].reason], ["dropped", "spike, not needed"]);

  // main at origin/main: nothing unlanded.
  git(b, work, "switch", "-q", "main");
  post(b, "git commit -m nothing", { cwd: work });
  git(b, work, "switch", "-q", "--detach", "HEAD");
  commitOn(b, work, null, "d.txt");
  post(b, "git commit -m detached", { cwd: work });
  assert.equal(branchRows(b).length, 1, "only the dropped spike");
});

test("a failed line that committed reaches PostToolUseFailure and is recorded; a subagent's commit is marked as such", () => {
  const b = sandbox();
  const { work } = repos(b);
  commitOn(b, work, "feature");
  post(b, "git commit -m x && npm test", { cwd: work, event: "PostToolUseFailure", extra: { error: "Exit code 1", agent_id: "a1", agent_type: "builder" } });
  const [r] = branchRows(b);
  assert.equal(r.state, "owed");
  assert.equal(r.made_by, "ledger-branches (subagent builder)");
});

test("config off: branches.enabled false or hooks.postToolUse false records nothing", () => {
  for (const off of [{ branches: { enabled: false } }, { hooks: { postToolUse: false } }]) {
    const b = sandbox();
    const { work } = repos(b);
    b.writeConfig(off);
    commitOn(b, work, "feature");
    const r = post(b, "git commit -m x", { cwd: work });
    assert.equal(r.code, 0, r.err);
    assert.equal(branchRows(b).length, 0, JSON.stringify(off));
  }
});

test("a broken repository in the hook is allowed and records nothing, never a block", () => {
  const b = sandbox();
  const { work } = repos(b);
  commitOn(b, work, "feature");
  rmSync(join(work, ".git", "HEAD"));
  const r = post(b, "git commit -m x", { cwd: work });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json?.decision, undefined);
  assert.equal(branchRows(b).length, 0);
});

// The fail-open rows (README § Fail-open table) that need the store, run on a commit, since only
// a commit on an unlanded branch makes this hook open it.
test("fail-open rows on a commit: corrupt default database moved aside, unparsable config named, unwritable database allowed with a systemMessage", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  {
    const b = sandbox();
    const { work } = repos(b);
    commitOn(b, work, "feature");
    const dataDir = join(b.root, "data", "ledger");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "ledger.db"), "junk ".repeat(2000));
    const r = hook(b, "post-tool-use", { session_id: SID, cwd: work, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git commit -m x" } }, { env: { ...GIT_ENV, LEDGER_DB: "", XDG_DATA_HOME: join(b.root, "data") } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.json.systemMessage, /^ledger: moved corrupt database aside to .*\.corrupt-/);
  }
  {
    const b = sandbox();
    const { work } = repos(b);
    b.writeConfig("{");
    commitOn(b, work, "feature");
    const r = post(b, "git commit -m x", { cwd: work });
    assert.equal(r.code, 0, r.err);
    assert.match(r.json.systemMessage, /^ledger: config .*config\.json ignored: /);
    assert.equal(branchRows(b).length, 1, "defaults still record");
  }
  {
    const b = sandbox();
    const { work } = repos(b);
    commitOn(b, work, "feature");
    const dir = join(b.root, "ro");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      const r = hook(b, "post-tool-use", { session_id: SID, cwd: work, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git commit -m x" } }, { env: { ...GIT_ENV, LEDGER_DB: join(dir, "sub", "ledger.db") } });
      assert.equal(r.code, 0, r.err);
      assert.equal(r.json?.decision, undefined);
      assert.match(r.json.systemMessage, /ledger: database .* at .*; the commit's branch was not recorded|failed open/);
    } finally {
      chmodSync(dir, 0o700);
    }
  }
});

// Round-2 fixes. Each has a negative control recorded in the change report.

/** Commit and return what `git commit` printed (captured from the real command, not hand-written). */
function commitOut(b, dir, file) {
  writeFileSync(join(dir, file), `${file} ${Math.random()}\n`);
  git(b, dir, "add", ".");
  return execFileSync("git", ["commit", "-m", `change ${file}`], { cwd: dir, env: { ...b.env, ...GIT_ENV }, encoding: "utf8" });
}

test("committedRefs reads the branch and sha git commit printed, including root and detached commits", () => {
  const b = sandbox();
  const { work } = repos(b);
  git(b, work, "switch", "-q", "-c", "feature");
  const out = commitOut(b, work, "x.txt");
  assert.deepEqual(committedRefs(out), [{ branch: "feature", sha: git(b, work, "rev-parse", "--short", "HEAD") }]);
  git(b, work, "switch", "-q", "--detach");
  assert.equal(committedRefs(commitOut(b, work, "y.txt"))[0].branch, null);
  const fresh = join(b.root, "fresh");
  mkdirSync(fresh);
  git(b, fresh, "init", "-q", "-b", "trunk");
  assert.equal(committedRefs(commitOut(b, fresh, "z.txt"))[0].branch, "trunk");
  assert.deepEqual(committedRefs(""), []);
});

test("the branch recorded is the one the commit printed, not the one checked out after the line; two branches in one line make two items", () => {
  const b = sandbox();
  const { work } = repos(b);
  git(b, work, "switch", "-q", "-c", "one");
  const first = commitOut(b, work, "a1.txt");
  git(b, work, "switch", "-q", "-c", "two");
  const second = commitOut(b, work, "a2.txt");
  git(b, work, "switch", "-q", "main");
  const r = post(b, "git commit -m a1 && git switch -c two && git commit -m a2 && git switch main", { cwd: work, extra: { tool_response: { stdout: `${first}Switched to a new branch 'two'\n${second}`, stderr: "", interrupted: false } } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(branchRows(b).map((x) => x.branch).sort(), ["one", "two"]);
});

test("a new unpushed head on a started or held branch item moves it back to owed, and the Stop rule reminds again", () => {
  for (const [verb, text] of [["start", "PR https://example.invalid/pr/1"], ["hold", "waiting for the push approval"]]) {
    const b = sandbox();
    const { work } = repos(b);
    commitOn(b, work, "feature");
    post(b, "git commit -m x", { cwd: work });
    const id = branchRows(b)[0].id;
    assert.equal(cli(b, [verb, id, text], { cwd: work, env: { LEDGER_SESSION_ID: SID } }).code, 0);
    commitOn(b, work, null, "more.txt");
    post(b, "git commit -m more", { cwd: work });
    assert.equal(branchRows(b)[0].state, "owed", verb);
    const transcript_path = join(b.root, "t.jsonl");
    writeFileSync(transcript_path, "");
    const s = hook(b, "stop", { session_id: SID, cwd: work, hook_event_name: "Stop", prompt_id: `p-${verb}`, stop_hook_active: false, last_assistant_message: "Committed more work.", transcript_path });
    assert.equal(s.json?.decision, "block", `${verb}: ${s.out}`);
  }
});

test("a git fault during a refresh keeps the last checked state and is reported, never turned into gone", () => {
  const b = sandbox();
  const { work } = repos(b);
  const sha = commitOn(b, work, "feature");
  post(b, "git commit -m x", { cwd: work });
  const db = openDb(b);
  const path = process.env.PATH;
  try {
    process.env.PATH = join(b.root, "no-git-here");
    const res = refreshBranches(db, { dbPath: b.dbPath });
    assert.equal(res.errors.length, 1, JSON.stringify(res));
    assert.match(res.errors[0], /kept as last checked/);
  } finally {
    process.env.PATH = path;
    db.close();
  }
  const [r] = branchRows(b);
  assert.deepEqual([r.state, r.branch_state, r.head_sha], ["owed", "unpushed", sha]);
});

test("the refresh budget holds inside a branch: each git call gets only what is left of it", () => {
  const b = sandbox();
  const { work } = repos(b);
  commitOn(b, work, "feature");
  post(b, "git commit -m x", { cwd: work });
  const bin = join(b.root, "slow-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexec /bin/sleep 2\n", { mode: 0o755 });
  const db = openDb(b);
  const path = process.env.PATH;
  const started = Date.now();
  let res;
  try {
    process.env.PATH = `${bin}:${path}`;
    res = refreshBranches(db, { dbPath: b.dbPath, budgetMs: 300 });
  } finally {
    process.env.PATH = path;
    db.close();
  }
  const ms = Date.now() - started;
  assert.ok(ms < 1500, `took ${ms} ms against a 300 ms budget`);
  assert.equal(res.errors.length, 1, JSON.stringify(res));
  assert.equal(branchRows(b)[0].branch_state, "unpushed", "kept as last checked");
});
