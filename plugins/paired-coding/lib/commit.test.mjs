// commit.test.mjs — node --test, run from plugins/paired-coding/.
//
// The commit pair_done makes when the agreed card asked for one, through the real verbs on real
// git repositories: mostly a linked worktree (git worktree add), the case pair_run cannot commit
// in. Writes go through pair_write, so these cases skip where no sandbox is usable. git runs with
// a temporary HOME, XDG config and global config file holding the author, so the host's own
// git configuration plays no part.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { executeVerb, recordTrustedInput } from "./verbs.mjs";
import { commitEnv } from "./commit.mjs";
import { sandboxProblem } from "./host-io.mjs";

const hasSandbox = sandboxProblem() === null;

// Under $HOME rather than a temp directory, as in verbs.test.mjs: pair_run and pair_write may
// write temp paths, so a worktree there is not fenced the way a real one is.
const FIXTURES = realpathSync(mkdtempSync(join(homedir(), ".pc-commit-")));
after(() => rmSync(FIXTURES, { recursive: true, force: true }));

const AUTHOR = { name: "Pair Tester", email: "pair-tester@example.invalid" };

function gitEnv(top) {
  const home = join(top, "home");
  const xdg = join(top, "xdg");
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  const global = join(top, "gitconfig");
  writeFileSync(global, `[user]\n\tname = ${AUTHOR.name}\n\temail = ${AUTHOR.email}\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n`);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|AUTHOR_|COMMITTER_)/.test(k)) delete env[k];
  return env;
}

function git(cwd, env, ...args) {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A main repository with one commit and a linked worktree on branch `feature`; the pairing
 * session's worktree is the linked one. `linked: false` pairs in the main repository instead.
 */
function fixture({ linked = true } = {}) {
  const top = mkdtempSync(join(FIXTURES, "f-"));
  const env = gitEnv(top);
  const main = join(top, "main");
  mkdirSync(join(main, "src"), { recursive: true });
  writeFileSync(join(main, "src", "a.txt"), "alpha\n");
  writeFileSync(join(main, "src", "b.txt"), "bravo\n");
  writeFileSync(join(main, "notes.txt"), "user's own notes\n");
  writeFileSync(join(main, ".gitignore"), "ignored/\n");
  git(main, env, "init", "-q");
  git(main, env, "add", "-A");
  git(main, env, "commit", "-q", "-m", "initial");
  let root = main;
  if (linked) {
    root = join(top, "wt");
    git(main, env, "worktree", "add", "-q", "-b", "feature", root);
  }
  const base = join(top, "state");
  const dir = join(base, "sess-1");
  const ctx = { sessionId: "sess-1", sessionDir: dir, root, env };
  return { top, main, root, env, dir, ctx };
}

const journal = (f) => readFileSync(join(f.dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const head = (f) => git(f.root, f.env, "rev-parse", "HEAD");

async function changeSet(f, card) {
  assert.equal((await executeVerb("pair_start", {}, f.ctx)).ok, true);
  const p = await executeVerb("pair_propose", { decision: "d", ...card }, f.ctx);
  assert.equal(p.ok, true, p.text);
  recordTrustedInput({ sessionDir: f.dir, text: "yes, go ahead", source: "interactive" });
  const b = await executeVerb("pair_begin", { cardId: p.result.card.id, quote: "go ahead" }, f.ctx);
  assert.equal(b.ok, true, b.text);
  return p.result.card.id;
}

async function write(f, path, content) {
  const w = await executeVerb("pair_write", { path, content }, f.ctx);
  assert.equal(w.ok, true, w.text);
}

test("the card shows the commit request, and a malformed one is refused", { skip: !hasSandbox }, async () => {
  const f = fixture();
  assert.equal((await executeVerb("pair_start", {}, f.ctx)).ok, true);
  const p = await executeVerb("pair_propose", { boundary: ["src/a.txt"], commit: { message: "Change alpha\n\nBody line." } }, f.ctx);
  assert.equal(p.ok, true, p.text);
  assert.deepEqual(p.result.card.commit, { message: "Change alpha\n\nBody line." });
  assert.match(p.text, /Commit at pair_done, to show on the card: .*\n```\nChange alpha\n\nBody line\.\n```/);
  for (const [commit, reason] of [
    [{ message: "" }, /non-blank first line/],
    [{ message: "\nbody only" }, /non-blank first line/],
    [{ message: "x", amend: true }, /nothing else/],
    ["Change alpha", /nothing else/],
    [{ message: "a\u0000b" }, /NUL/],
  ]) {
    const bad = await executeVerb("pair_propose", { boundary: ["src/a.txt"], commit }, f.ctx);
    assert.equal(bad.ok, false, JSON.stringify(commit));
    assert.match(bad.text, reason);
  }
});

test("in a linked worktree the boundary files are committed and a changed file outside the boundary is not", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const before = head(f);
  // The person's own unstaged edit outside the boundary, made before the card.
  writeFileSync(join(f.root, "notes.txt"), "edited by the person\n");
  mkdirSync(join(f.root, "ignored"));
  const cardId = await changeSet(f, { boundary: ["src/a.txt", "src/new.txt", "ignored/"], commit: { message: "Change alpha\n\nAnd add new." } });
  await write(f, "src/a.txt", "alpha two\n");
  await write(f, "src/new.txt", "new\n");
  await write(f, "ignored/build.log", "noise\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  const sha = head(f);
  assert.notEqual(sha, before);
  assert.deepEqual(d.result.commit, { sha, subject: "Change alpha", paths: ["src/a.txt", "src/new.txt"], skipped: ["ignored/build.log"] });
  assert.match(d.text, new RegExp(`Committed ${sha} "Change alpha" with src/a\\.txt, src/new\\.txt\\. Left out because git ignores them or never tracked them: ignored/build\\.log\\.`));
  assert.equal(git(f.root, f.env, "show", "--name-only", "--format=", "HEAD"), "src/a.txt\nsrc/new.txt");
  assert.equal(git(f.root, f.env, "log", "-1", "--format=%an <%ae>%n%B"), `${AUTHOR.name} <${AUTHOR.email}>\nChange alpha\n\nAnd add new.`);
  assert.equal(git(f.root, f.env, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
  assert.equal(git(f.root, f.env, "status", "--porcelain"), "M notes.txt");
  // The main checkout's branch is untouched.
  assert.equal(git(f.main, f.env, "rev-parse", "main"), before);
});

test("the SHA lands in the journal", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const cardId = await changeSet(f, { boundary: ["src/a.txt"], commit: { message: "Journal me" } });
  await write(f, "src/a.txt", "alpha journaled\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  const entries = journal(f);
  const c = entries.find((e) => e.type === "commit");
  assert.ok(c, "a commit entry");
  assert.equal(c.sha, head(f));
  assert.equal(c.cardId, cardId);
  assert.equal(c.subject, "Journal me");
  assert.deepEqual(c.paths, ["src/a.txt"]);
  assert.ok(entries.findIndex((e) => e.type === "done") < entries.indexOf(c), "after the done entry");
});

test("a file the person staged outside the boundary stays staged and uncommitted", { skip: !hasSandbox }, async () => {
  const f = fixture();
  writeFileSync(join(f.root, "notes.txt"), "staged by the person\n");
  git(f.root, f.env, "add", "notes.txt");
  const cardId = await changeSet(f, { boundary: ["src/a.txt"], commit: { message: "Only alpha" } });
  await write(f, "src/a.txt", "alpha only\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.equal(git(f.root, f.env, "show", "--name-only", "--format=", "HEAD"), "src/a.txt");
  assert.equal(git(f.root, f.env, "diff", "--cached", "--name-only"), "notes.txt");
  assert.equal(git(f.root, f.env, "show", ":notes.txt"), "staged by the person");
});

test("a card without a commit request leaves no commit", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const before = head(f);
  const cardId = await changeSet(f, { boundary: ["src/a.txt"] });
  await write(f, "src/a.txt", "alpha, uncommitted\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.equal(head(f), before);
  assert.equal(d.result.commit, undefined);
  assert.doesNotMatch(d.text, /Committed|Not committed/);
  assert.equal(journal(f).some((e) => /^commit/.test(e.type)), false);
  assert.equal(git(f.root, f.env, "status", "--porcelain"), "M src/a.txt");
});

test("an empty diff makes no commit", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const before = head(f);
  const cardId = await changeSet(f, { boundary: ["src/a.txt"], commit: { message: "Nothing to see" } });
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.equal(head(f), before);
  assert.deepEqual(d.result.commit, { error: "nothing inside the boundary changed", refused: true });
  assert.match(d.text, /Not committed: nothing inside the boundary changed\. The change set is closed either way\./);
  assert.ok(journal(f).some((e) => e.type === "commit-refused" && e.reason === "nothing inside the boundary changed"));
});

test("a rebase in progress refuses the commit and the change set still closes", { skip: !hasSandbox }, async () => {
  const f = fixture();
  // A real stopped rebase: feature and main both change notes.txt.
  writeFileSync(join(f.root, "notes.txt"), "feature's notes\n");
  git(f.root, f.env, "commit", "-q", "-am", "feature notes");
  writeFileSync(join(f.main, "notes.txt"), "main's notes\n");
  git(f.main, f.env, "commit", "-q", "-am", "main notes");
  const r = spawnSync("git", ["rebase", "main"], { cwd: f.root, env: f.env, encoding: "utf8" });
  assert.notEqual(r.status, 0, "the rebase stops on the conflict");
  const before = head(f);
  const cardId = await changeSet(f, { boundary: ["src/a.txt"], commit: { message: "Mid-rebase" } });
  await write(f, "src/a.txt", "alpha mid-rebase\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.match(d.text, /Not committed: a rebase is in progress in this worktree \(rebase-merge is in .*\); the gate does not commit during one/);
  assert.equal(d.result.commit.refused, true);
  assert.equal(head(f), before);
  assert.ok(journal(f).some((e) => e.type === "commit-refused" && /a rebase is in progress/.test(e.reason)));
  // Closed: the next card can be proposed.
  assert.equal((await executeVerb("pair_propose", { boundary: ["src/a.txt"] }, f.ctx)).ok, true);
});

test("a detached HEAD refuses the commit", { skip: !hasSandbox }, async () => {
  const f = fixture();
  git(f.root, f.env, "checkout", "-q", "--detach");
  const cardId = await changeSet(f, { boundary: ["src/a.txt"], commit: { message: "Detached" } });
  await write(f, "src/a.txt", "alpha detached\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.match(d.text, /Not committed: HEAD is detached/);
});

test("a failing pre-commit hook surfaces its error, makes no commit, and leaves no new file in the index", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const hook = join(f.main, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'pre-commit hook says no' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const before = head(f);
  const cardId = await changeSet(f, { boundary: ["src/a.txt", "src/new.txt"], commit: { message: "Blocked by the hook" } });
  await write(f, "src/a.txt", "alpha hooked\n");
  await write(f, "src/new.txt", "new\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.match(d.text, /Not committed: git commit failed: pre-commit hook says no/);
  assert.match(d.result.commit.error, /pre-commit hook says no/);
  assert.equal(head(f), before);
  assert.equal(git(f.root, f.env, "diff", "--cached", "--name-only"), "");
  assert.equal(git(f.root, f.env, "ls-files", "src/new.txt"), "");
  assert.ok(journal(f).some((e) => e.type === "commit-failed" && /pre-commit hook says no/.test(e.reason)));
});

test("pathspecs are literal: a boundary file named with glob characters commits only itself", { skip: !hasSandbox }, async () => {
  const f = fixture();
  // The person's unstaged edit beside it, which the pathspec src/* would take in as a glob.
  writeFileSync(join(f.root, "src", "b.txt"), "bravo, edited by the person\n");
  const cardId = await changeSet(f, { boundary: ["src/*"], commit: { message: "Star" } });
  await write(f, "src/*", "a file named star\n");
  await write(f, "src/a.txt", "alpha starred\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.equal(git(f.root, f.env, "show", "--name-only", "--format=", "HEAD"), "src/*\nsrc/a.txt");
  assert.equal(git(f.root, f.env, "status", "--porcelain"), "M src/b.txt");
});

test("a change set that changed the hooks directory git runs is not committed", { skip: !hasSandbox }, async () => {
  const f = fixture({ linked: false });
  mkdirSync(join(f.root, ".husky"));
  writeFileSync(join(f.root, ".husky", "pre-commit"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(f.root, ".husky", "pre-commit"), 0o755);
  git(f.root, f.env, "add", ".husky");
  git(f.root, f.env, "commit", "-q", "-m", "husky");
  git(f.root, f.env, "config", "core.hooksPath", ".husky");
  const before = head(f);
  const cardId = await changeSet(f, { boundary: ["src/a.txt", ".husky/"], commit: { message: "Sneaky hook" } });
  await write(f, "src/a.txt", "alpha\nmore\n");
  await write(f, ".husky/pre-commit", "#!/bin/sh\ntouch \"$HOME/pwned\"\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.match(d.text, /Not committed: the change set changed \.husky\/pre-commit in the hooks directory git runs \(\.husky\)/);
  assert.equal(head(f), before);
});
test("commitEnv keeps the host's identity and global config and drops what steers git elsewhere", () => {
  const env = commitEnv({ HOME: "/h", PATH: "/bin", GIT_DIR: "/x/.git", GIT_WORK_TREE: "/x", GIT_INDEX_FILE: "/x/i", GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/x", GIT_CONFIG_GLOBAL: "/h/g", GIT_AUTHOR_NAME: "Host", GIT_EXEC_PATH: "/x" });
  assert.deepEqual(env, { HOME: "/h", PATH: "/bin", GIT_CONFIG_GLOBAL: "/h/g", GIT_AUTHOR_NAME: "Host", GIT_TERMINAL_PROMPT: "0" });
});
