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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { executeVerb, recordTrustedInput } from "./verbs.mjs";
import { commitBoundary, commitEnv } from "./commit.mjs";
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
    [{ message: "a\u0000b" }, /control character/],
    [{ message: "Fine\u001b[8m hidden" }, /control character/],
    [{ message: "Fine\rOverwritten" }, /control character/],
    [{ message: "Fine\u009b8m" }, /control character/],
    [{ message: "Subject\n\n```\nfenced" }, /``` or ~~~/],
    [{ message: "Subject\n   ~~~" }, /``` or ~~~/],
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
  assert.deepEqual(d.result.commit, { sha, subject: "Change alpha", paths: ["src/a.txt", "src/new.txt"], skipped: ["ignored/build.log"], keptStaged: [], hooksRun: false });
  assert.match(d.text, new RegExp(`Committed ${sha} "Change alpha" with src/a\\.txt, src/new\\.txt, without running git hooks: run your checks yourself after the read-back\\. Left out because git ignores them or never tracked them: ignored/build\\.log\\.`));
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

/** A non-linked fixture with `files` committed (path → [content, executable?]). */
function tracked(files) {
  const f = fixture({ linked: false });
  for (const [path, [content, exec]] of Object.entries(files)) {
    mkdirSync(join(f.root, path, ".."), { recursive: true });
    writeFileSync(join(f.root, path), content);
    if (exec) chmodSync(join(f.root, path), 0o755);
    git(f.root, f.env, "add", "--", path);
  }
  git(f.root, f.env, "commit", "-q", "-m", "tracked");
  return { ...f, marker: join(f.top, "ran-outside-the-sandbox") };
}

const touchMarker = (f) => `#!/bin/sh\ntouch '${f.marker}'\nexit 1\n`;

async function commitAgentScript(f, boundary, script) {
  const before = head(f);
  const cardId = await changeSet(f, { boundary: ["src/a.txt", ...boundary], commit: { message: "Agent's change" } });
  await write(f, "src/a.txt", "alpha changed\n");
  await write(f, script, touchMarker(f));
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  return { d, before };
}

test("hooks never run: a failing pre-commit hook in the git directory does not stop or touch the commit", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const marker = join(f.top, "hook-ran");
  for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "reference-transaction", "post-index-change"]) {
    writeFileSync(join(f.main, ".git", "hooks", name), `#!/bin/sh\ntouch '${marker}'\necho 'hook says no' >&2\nexit 1\n`);
    chmodSync(join(f.main, ".git", "hooks", name), 0o755);
  }
  const cardId = await changeSet(f, { boundary: ["src/a.txt", "src/new.txt"], commit: { message: "Not blocked by hooks" } });
  await write(f, "src/a.txt", "alpha hooked\n");
  await write(f, "src/new.txt", "new\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.equal(existsSync(marker), false, "no hook ran");
  assert.match(d.text, /without running git hooks/);
  assert.equal(d.result.commit.hooksRun, false);
  assert.equal(git(f.root, f.env, "show", "--name-only", "--format=", "HEAD"), "src/a.txt\nsrc/new.txt");
  assert.equal(journal(f).find((e) => e.type === "commit").hooks, "not run");
});

test("probe A: a symlinked hook running a tracked script the agent edited does not run", { skip: !hasSandbox }, async () => {
  const f = tracked({ "scripts/pre-commit.sh": ["#!/bin/sh\nexit 0\n", true] });
  for (const name of ["pre-commit", "post-commit", "reference-transaction"]) symlinkSync("../../scripts/pre-commit.sh", join(f.root, ".git", "hooks", name));
  const { d, before } = await commitAgentScript(f, ["scripts/"], "scripts/pre-commit.sh");
  assert.equal(existsSync(f.marker), false, "the agent's script did not run");
  assert.notEqual(head(f), before);
  assert.match(d.text, /Committed [0-9a-f]+ "Agent's change"/);
});

test("probe B: husky v9 (core.hooksPath .husky/_ running .husky/<hook>) does not run the agent's hook", { skip: !hasSandbox }, async () => {
  const f = tracked({
    ".husky/_/pre-commit": ['#!/bin/sh\n. "$(dirname "$0")/h"\n', true],
    ".husky/_/h": ['#!/bin/sh\nn=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n[ -f "$s" ] && sh -e "$s"\n', true],
    ".husky/pre-commit": ["#!/bin/sh\nexit 0\n", true],
  });
  git(f.root, f.env, "config", "core.hooksPath", ".husky/_");
  const { before } = await commitAgentScript(f, [".husky/pre-commit"], ".husky/pre-commit");
  assert.equal(existsSync(f.marker), false, "the agent's hook did not run");
  assert.notEqual(head(f), before);
});

test("probe C: a hook running a tracked script does not run the agent's edit of it", { skip: !hasSandbox }, async () => {
  const f = tracked({ "tools/check.sh": ["#!/bin/sh\nexit 0\n", true] });
  writeFileSync(join(f.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nsh tools/check.sh\n");
  chmodSync(join(f.root, ".git", "hooks", "pre-commit"), 0o755);
  const { before } = await commitAgentScript(f, ["tools/check.sh"], "tools/check.sh");
  assert.equal(existsSync(f.marker), false, "the agent's script did not run");
  assert.notEqual(head(f), before);
});

test("probe D: config included from a file in the worktree refuses the commit, and its clean filter never runs", { skip: !hasSandbox }, async () => {
  const f = tracked({ ".gitconfig": ["[core]\n", false] });
  git(f.root, f.env, "config", "include.path", "../.gitconfig");
  const before = head(f);
  const cardId = await changeSet(f, { boundary: ["src/a.txt", ".gitconfig", ".gitattributes"], commit: { message: "Agent's filter" } });
  await write(f, ".gitconfig", `[filter "x"]\n\tclean = "sh -c 'touch ${f.marker}; cat'"\n`);
  await write(f, ".gitattributes", "*.txt filter=x\n");
  await write(f, "src/a.txt", "alpha filtered\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.equal(existsSync(f.marker), false, "the agent's filter did not run");
  assert.match(d.text, /Not committed: git reads config from \.gitconfig, a file inside the worktree/);
  assert.equal(head(f), before);
});

test("a clean filter from the person's own config, running a tracked script, is not run: the commit holds the bytes as written", { skip: !hasSandbox }, async () => {
  const f = tracked({ "tools/clean.sh": ["#!/bin/sh\ncat\n", true], ".gitattributes": ["*.txt filter=x\n", false] });
  git(f.root, f.env, "config", "filter.x.clean", "sh tools/clean.sh");
  const cardId = await changeSet(f, { boundary: ["src/a.txt", "tools/clean.sh"], commit: { message: "Unfiltered" } });
  await write(f, "tools/clean.sh", `#!/bin/sh\ntouch '${f.marker}'\ncat\n`);
  await write(f, "src/a.txt", "alpha unfiltered\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  // Checked before any git call of the test's own, which would run the filter.
  assert.equal(existsSync(f.marker), false, "the filter did not run");
  assert.match(d.text, /Committed [0-9a-f]+ "Unfiltered"/);
});

test("a version of a boundary file the person staged stays staged; the commit holds the read-back version", { skip: !hasSandbox }, async () => {
  const f = fixture();
  writeFileSync(join(f.root, "src", "a.txt"), "v1 staged by the person\n");
  git(f.root, f.env, "add", "src/a.txt");
  const cardId = await changeSet(f, { boundary: ["src/a.txt"], commit: { message: "v2" } });
  await write(f, "src/a.txt", "v2 written by the agent\n");
  const d = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(d.ok, true, d.text);
  assert.deepEqual(d.result.commit.keptStaged, ["src/a.txt"]);
  assert.match(d.text, /Your own staged version of src\/a\.txt stays staged; the commit holds the read-back version\./);
  assert.equal(git(f.root, f.env, "show", "HEAD:src/a.txt"), "v2 written by the agent");
  assert.equal(git(f.root, f.env, "show", ":src/a.txt"), "v1 staged by the person");
});

test("commitBoundary commits the read-back copies, not the worktree: content, deletion, exec bit and symlink", () => {
  const f = fixture();
  const copies = join(f.top, "copies");
  mkdirSync(copies);
  writeFileSync(join(copies, "a"), "what the read-back showed\n");
  writeFileSync(join(copies, "run"), "#!/bin/sh\n");
  const r = commitBoundary({
    root: f.root,
    entries: [
      { path: "src/a.txt", kind: "file", source: join(copies, "a"), exec: false },
      { path: "bin/run.sh", kind: "file", source: join(copies, "run"), exec: true },
      { path: "link", kind: "link", target: "src/a.txt" },
      { path: "notes.txt", kind: "absent" },
    ],
    message: "From copies",
    env: f.env,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.sha, head(f));
  assert.equal(git(f.root, f.env, "show", "HEAD:src/a.txt"), "what the read-back showed");
  // bin/run.sh executable, link a symlink to src/a.txt, notes.txt gone.
  assert.equal(git(f.root, f.env, "ls-tree", "HEAD", "bin/run.sh", "link", "notes.txt").replace(/ [0-9a-f]{40}/g, ""), "100755 blob\tbin/run.sh\n120000 blob\tlink");
  assert.equal(git(f.root, f.env, "cat-file", "-p", "HEAD:link"), "src/a.txt");
  // The worktree is untouched: its src/a.txt still holds the old bytes.
  assert.equal(readFileSync(join(f.root, "src", "a.txt"), "utf8"), "alpha\n");
});

test("commitEnv keeps the host's identity and global config and drops what steers git elsewhere or names a program", () => {
  const env = commitEnv({
    HOME: "/h", PATH: "/bin", GIT_DIR: "/x/.git", GIT_WORK_TREE: "/x", GIT_INDEX_FILE: "/x/i", GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/x", GIT_CONFIG_GLOBAL: "/h/g", GIT_AUTHOR_NAME: "Host", GIT_EXEC_PATH: "/x",
    GIT_EDITOR: "x", GIT_SSH: "x", GIT_SSH_COMMAND: "x", GIT_ASKPASS: "x", SSH_ASKPASS: "x", GIT_EXTERNAL_DIFF: "x", GIT_PAGER: "x", GPG_TTY: "x", GNUPGHOME: "x", EDITOR: "x", VISUAL: "x",
  });
  assert.deepEqual(env, { HOME: "/h", PATH: "/bin", GIT_CONFIG_GLOBAL: "/h/g", GIT_AUTHOR_NAME: "Host", GIT_TERMINAL_PROMPT: "0" });
});
