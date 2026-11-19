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

test("popd unwinds the pushd stack; a popd the line did not pushd leaves the folder unnamed", () => {
  assert.deepEqual(commitDirs("pushd /repo-a && popd && git commit -m x", "/w"), ["/w"]);
  assert.deepEqual(commitDirs("pushd /repo-a; pushd /repo-b; popd; git commit -m x", "/w"), ["/repo-a"]);
  assert.deepEqual(commitDirs("pushd /repo-a && git commit -m x", "/w"), ["/repo-a"]);
  assert.deepEqual(commitDirs("popd && git commit -m x", "/w"), []);
  assert.deepEqual(commitDirs("pushd /repo-a && popd +1 && git commit -m x", "/w"), []);
});

test("a merge commit holding work the base lacks is not landed; one whose tree matches the base is", () => {
  for (const extra of [true, false]) {
    const b = sandbox();
    const { work, other } = repos(b);
    commitOn(b, other, null, "upstream.txt");
    git(b, other, "push", "-q", "origin", "main");
    git(b, work, "fetch", "-q", "origin");
    git(b, work, "switch", "-q", "-c", "feature");
    git(b, work, "merge", "-q", "--no-ff", "--no-commit", "origin/main");
    if (extra) writeFileSync(join(work, "resolution.txt"), "only on the branch\n");
    git(b, work, "add", ".");
    git(b, work, "commit", "-q", "-m", "merge main");
    assert.equal(git(b, work, "cherry", "origin/main", "feature"), "", "git cherry leaves the merge out");
    post(b, "git commit -m 'merge main'", { cwd: work });
    assert.deepEqual(branchRows(b).map((r) => [r.branch, r.branch_state]), extra ? [["feature", "unpushed"]] : [], `extra=${extra}`);
  }
});

test("refresh that finds a new unpushed head on a started or held item moves it back to owed, the same as a commit does", () => {
  for (const [verb, text] of [["start", "PR https://example.invalid/pr/1"], ["hold", "waiting for the push approval"]]) {
    const b = sandbox();
    const { work } = repos(b);
    commitOn(b, work, "feature");
    post(b, "git commit -m x", { cwd: work });
    const id = branchRows(b)[0].id;
    assert.equal(cli(b, [verb, id, text], { cwd: work, env: { LEDGER_SESSION_ID: SID } }).code, 0);
    const head = commitOn(b, work, null, "more.txt");
    const db = openDb(b);
    try {
      assert.deepEqual(refreshBranches(db, { dbPath: b.dbPath }).errors, []);
      const move = db.prepare("SELECT to_state, detail FROM cc_owed_moves WHERE owed_id = ? ORDER BY rowid DESC LIMIT 1").get(id);
      assert.equal(move.to_state, "owed", verb);
      assert.match(move.detail, new RegExp(`new commit ${head.slice(0, 8)}`));
    } finally {
      db.close();
    }
    const [r] = branchRows(b);
    assert.deepEqual([r.state, r.head_sha], ["owed", head], verb);
    post(b, "git commit -m more", { cwd: work });
    assert.equal(branchRows(b)[0].state, "owed", `${verb}: the later hook agrees`);
  }
});

test("a removed repository is a fault: the item keeps its last checked state and the refresh reports it; a missing branch in a present repository is gone", () => {
  const b = sandbox();
  const { work } = repos(b);
  const sha = commitOn(b, work, "feature");
  post(b, "git commit -m x", { cwd: work });
  rmSync(work, { recursive: true, force: true });
  let db = openDb(b);
  try {
    const res = refreshBranches(db, { dbPath: b.dbPath });
    assert.equal(res.errors.length, 1, JSON.stringify(res));
    assert.match(res.errors[0], /is not there; kept as last checked/);
  } finally {
    db.close();
  }
  const [r] = branchRows(b);
  assert.deepEqual([r.state, r.branch_state, r.head_sha], ["owed", "unpushed", sha]);

  const c = sandbox();
  const { work: w2 } = repos(c);
  commitOn(c, w2, "feature");
  post(c, "git commit -m x", { cwd: w2 });
  db = openDb(c);
  try {
    db.prepare("UPDATE cc_owed SET head_sha = ? WHERE branch IS NOT NULL").run("0".repeat(40));
  } finally {
    db.close();
  }
  git(c, w2, "switch", "-q", "main");
  git(c, w2, "branch", "-q", "-D", "feature");
  db = openDb(c);
  try {
    assert.deepEqual(refreshBranches(db, { dbPath: c.dbPath }).errors, []);
  } finally {
    db.close();
  }
  assert.equal(branchRows(c)[0].branch_state, "gone");
});

test("a commit in another session takes the open branch item over, with a move row, and that session's Stop blocks on it", () => {
  const b = sandbox();
  const { work } = repos(b);
  commitOn(b, work, "feature");
  post(b, "git commit -m x", { cwd: work });
  const id = branchRows(b)[0].id;
  assert.equal(branchRows(b)[0].session_id, SID);
  const header = commitOut(b, work, "more.txt");
  const head = git(b, work, "rev-parse", "HEAD");
  const B = "s-branches-b";
  const r = hook(b, "post-tool-use", { session_id: B, cwd: work, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git commit -m more" }, tool_response: { stdout: header, stderr: "", interrupted: false } }, { env: GIT_ENV });
  assert.equal(r.code, 0, r.err);
  const [row2] = branchRows(b);
  assert.deepEqual([row2.id, row2.state, row2.session_id, row2.head_sha], [id, "owed", B, head]);
  const db = openDb(b);
  try {
    const move = db.prepare("SELECT kind, from_state, to_state, session_id, detail FROM cc_owed_moves WHERE owed_id = ? ORDER BY id DESC LIMIT 1").get(id);
    assert.deepEqual([move.kind, move.from_state, move.to_state, move.session_id], ["move", "owed", "owed", B]);
    assert.match(move.detail, new RegExp(`committed ${head.slice(0, 8)}`));
  } finally {
    db.close();
  }
  const transcript_path = join(b.root, "t.jsonl");
  writeFileSync(transcript_path, "");
  const s = hook(b, "stop", { session_id: B, cwd: work, hook_event_name: "Stop", prompt_id: "p-b", stop_hook_active: false, last_assistant_message: "Committed more.", transcript_path });
  assert.equal(s.json?.decision, "block", s.out);
});

test("refresh does not overwrite a row whose head changed while git ran: a landed result for the old head leaves the new head open", () => {
  const b = sandbox();
  const { work } = repos(b);
  commitOn(b, work, "feature");
  post(b, "git commit -m x", { cwd: work });
  git(b, work, "push", "-q", "origin", "feature:main");
  git(b, work, "fetch", "-q", "origin");
  const newer = "f".repeat(40);
  const db = openDb(b);
  try {
    // The clock runs between git calls: a commit hook recording a newer head lands in that window.
    const clock = () => {
      db.prepare("UPDATE cc_owed SET head_sha = ? WHERE branch IS NOT NULL").run(newer);
      return Date.now();
    };
    const res = refreshBranches(db, { dbPath: b.dbPath, clock });
    assert.deepEqual(res.done, []);
  } finally {
    db.close();
  }
  const [r] = branchRows(b);
  assert.deepEqual([r.state, r.head_sha], ["owed", newer]);
});

test("a failed commit with no header neither records nor takes over: the quiet fallback needs a reflog commit since the command began", () => {
  const b = sandbox();
  const { work } = repos(b);
  git(b, work, "switch", "-q", "-c", "feature");
  writeFileSync(join(work, "old.txt"), "old\n");
  git(b, work, "add", ".");
  const hourAgo = `${Math.floor(Date.now() / 1000) - 3600} +0000`;
  execFileSync("git", ["commit", "-q", "-m", "an hour ago"], { cwd: work, env: { ...b.env, ...GIT_ENV, GIT_COMMITTER_DATE: hourAgo, GIT_AUTHOR_DATE: hourAgo } });
  const quiet = (session, event, extra = {}) =>
    hook(b, "post-tool-use", { session_id: session, cwd: work, hook_event_name: event, tool_name: "Bash", tool_input: { command: "git commit -q -m x" }, duration_ms: 400, ...extra }, { env: GIT_ENV });
  assert.equal(quiet(SID, "PostToolUseFailure", { error: "Exit code 1\nnothing to commit, working tree clean" }).code, 0);
  assert.deepEqual(branchRows(b), [], "a failed commit on a branch last moved an hour ago records nothing");
  commitOn(b, work, null, "now.txt");
  assert.equal(quiet(SID, "PostToolUse", { tool_response: { stdout: "", stderr: "", interrupted: false } }).code, 0);
  const [r] = branchRows(b);
  assert.equal(r.session_id, SID, "a real quiet commit is recorded");
  execFileSync("git", ["commit", "--amend", "-q", "--no-edit"], { cwd: work, env: { ...b.env, ...GIT_ENV, GIT_COMMITTER_DATE: hourAgo } });
  assert.equal(quiet("s-branches-b", "PostToolUseFailure", { error: "Exit code 1\nnothing to commit, working tree clean" }).code, 0);
  assert.equal(branchRows(b)[0].session_id, SID, "a failed commit in another session does not take the item over");
});

test("headers printed by a commit in one repository do not hide a quiet commit in another", () => {
  const b = sandbox();
  const { origin, work } = repos(b);
  const work2 = join(b.work, "repo2");
  git(b, b.work, "clone", "-q", origin, work2);
  git(b, work, "switch", "-q", "-c", "loud");
  const header = commitOut(b, work, "loud.txt");
  commitOn(b, work2, "quiet", "quiet.txt");
  const r = post(b, `git -C ${work} commit -m loud && git -C ${work2} commit -q -m quiet`, { cwd: b.work, extra: { duration_ms: 300, tool_response: { stdout: header, stderr: "", interrupted: false } } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(branchRows(b).map((x) => x.branch).sort(), ["loud", "quiet"]);
});

test("a printed header does not hide a quiet commit on another branch of the same repository", () => {
  const b = sandbox();
  const { work } = repos(b);
  git(b, work, "switch", "-q", "-c", "first");
  const header = commitOut(b, work, "loud.txt");
  commitOn(b, work, "second", "quiet.txt");
  const r = post(b, "git commit -m loud && git switch -c second && git commit -q -m quiet", { cwd: work, extra: { duration_ms: 300, tool_response: { stdout: header, stderr: "", interrupted: false } } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(branchRows(b).map((x) => x.branch).sort(), ["first", "second"]);
});

test("a quiet commit followed by a switch records the branch committed to, read from the HEAD reflog; two quiet branches make two items", () => {
  const b = sandbox();
  const { work } = repos(b);
  commitOn(b, work, "feature");
  git(b, work, "switch", "-q", "main");
  let r = post(b, "git switch -c feature && git commit -q -m x && git switch main", { cwd: work, extra: { duration_ms: 300 } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(branchRows(b).map((x) => x.branch), ["feature"]);

  const c = sandbox();
  const { work: w2 } = repos(c);
  commitOn(c, w2, "one", "one.txt");
  commitOn(c, w2, "two", "two.txt");
  git(c, w2, "switch", "-q", "main");
  r = post(c, "git switch -c one && git commit -q -m one && git switch -c two && git commit -q -m two && git switch main", { cwd: w2, extra: { duration_ms: 300 } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(branchRows(c).map((x) => x.branch).sort(), ["one", "two"]);
});

test("a failed commit right after another session's commit does not take that session's item over", () => {
  for (const command of ["git commit -m x", "git commit -q -m x"]) {
    const b = sandbox();
    const { work } = repos(b);
    git(b, work, "switch", "-q", "-c", "feature");
    const header = commitOut(b, work, "a.txt");
    post(b, "git commit -m a", { cwd: work, extra: { tool_response: { stdout: header, stderr: "", interrupted: false } } });
    assert.equal(branchRows(b)[0].session_id, SID);
    const r = hook(b, "post-tool-use", { session_id: "s-branches-b", cwd: work, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, duration_ms: 300, error: "Exit code 1\nnothing to commit, working tree clean" }, { env: GIT_ENV });
    assert.equal(r.code, 0, r.err);
    assert.equal(branchRows(b)[0].session_id, SID, `${command}: the item stays with the session that committed`);
  }
});

test("failing repositories do not starve the refresh: a failed check moves the row to the back and keeps its last status", () => {
  const b = sandbox();
  const { work } = repos(b);
  commitOn(b, work, "feature");
  post(b, "git commit -m x", { cwd: work });
  git(b, work, "push", "-q", "origin", "feature:main");
  git(b, work, "fetch", "-q", "origin");
  const db = openDb(b);
  try {
    const healthy = db.prepare("SELECT * FROM cc_owed WHERE branch IS NOT NULL").get();
    const ins = db.prepare("INSERT INTO cc_owed (id, cwd, body, state, origin, session_id, made_by, made_at, changed_at, repo, git_dir, branch, head_sha, branch_state, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (let i = 0; i < 20; i++) {
      const gone = join(b.root, `removed-${i}`);
      ins.run(`ow-fake${i}`, healthy.cwd, `land branch f${i} in ${gone}`, "owed", "agent", SID, "test", healthy.made_at, healthy.made_at, gone, join(gone, ".git"), `f${i}`, healthy.head_sha, "unpushed", "2000-01-01T00:00:00.000Z");
    }
    const first = refreshBranches(db, { dbPath: b.dbPath });
    assert.equal(first.errors.length, 20, JSON.stringify(first));
    const second = refreshBranches(db, { dbPath: b.dbPath });
    assert.deepEqual(second.done, [healthy.id], JSON.stringify(second));
    const kept = db.prepare("SELECT DISTINCT branch_state, head_sha FROM cc_owed WHERE id GLOB 'ow-fake*'").all().map((x) => ({ ...x }));
    assert.deepEqual(kept, [{ branch_state: "unpushed", head_sha: healthy.head_sha }]);
  } finally {
    db.close();
  }
});

test("a git directory emptied or replaced is a fault, not gone: the last status is kept and the refresh reports it", () => {
  const b = sandbox();
  const { work } = repos(b);
  const sha = commitOn(b, work, "feature");
  post(b, "git commit -m x", { cwd: work });
  rmSync(join(work, ".git"), { recursive: true, force: true });
  mkdirSync(join(work, ".git"));
  const db = openDb(b);
  try {
    const res = refreshBranches(db, { dbPath: b.dbPath });
    assert.equal(res.errors.length, 1, JSON.stringify(res));
    assert.match(res.errors[0], /kept as last checked/);
  } finally {
    db.close();
  }
  const [r] = branchRows(b);
  assert.deepEqual([r.state, r.branch_state, r.head_sha], ["owed", "unpushed", sha]);
});
