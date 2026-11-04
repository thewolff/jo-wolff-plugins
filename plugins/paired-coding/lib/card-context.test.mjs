// card-context.test.mjs — the sibling-plugin path rules and the findings reader, on real files
// under a temp directory. Nothing here touches the user's state.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardContext, findingsPath, gitRoot, patternCheckKey, readFindings } from "./card-context.mjs";

const TOP = realpathSync(mkdtempSync(join(tmpdir(), "pc-card-context-")));
after(() => rmSync(TOP, { recursive: true, force: true }));

function repo(name) {
  const root = join(TOP, name);
  mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
  writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n"); // a worktree's .git is a file; it counts
  return root;
}

test("gitRoot is the nearest ancestor holding .git (file or directory), else null", () => {
  const root = repo("r1");
  assert.equal(gitRoot(root), root);
  assert.equal(gitRoot(join(root, "packages", "app", "src")), root);
  const nested = join(root, "packages", "app");
  rmSync(join(root, ".git"));
  mkdirSync(join(nested, ".git"));
  assert.equal(gitRoot(join(nested, "src")), nested);
  assert.equal(gitRoot(root), null);
});

test("patternCheckKey is the session id when it is a plain file name of at most 128 characters, else cwd-<sha>", () => {
  assert.equal(patternCheckKey("s-eval-paired-coding", "/w"), "s-eval-paired-coding");
  assert.equal(patternCheckKey("a".repeat(128), "/w"), "a".repeat(128));
  const digest = `cwd-${createHash("sha256").update("/w", "utf8").digest("hex").slice(0, 16)}`;
  for (const bad of ["a".repeat(129), "../x", ".hidden", "with space", "", null, undefined]) assert.equal(patternCheckKey(bad, "/w"), digest, String(bad));
});

test("findingsPath follows XDG_STATE_HOME when absolute, else HOME/.local/state; an unsafe id has no path", () => {
  assert.equal(findingsPath("s1", { XDG_STATE_HOME: "/x/state" }, "/home/u"), "/x/state/ask-graham/findings/s1.json");
  assert.equal(findingsPath("s1", { XDG_STATE_HOME: "relative/state" }, "/home/u"), "/home/u/.local/state/ask-graham/findings/s1.json");
  assert.equal(findingsPath("s1", {}, "/home/u"), "/home/u/.local/state/ask-graham/findings/s1.json");
  for (const bad of ["../s1", "a/b", "", null]) assert.equal(findingsPath(bad, {}, "/home/u"), null, String(bad));
});

test("readFindings: missing is null and silent; unreadable, non-JSON or non-object is null with one fault; entries are filtered", () => {
  const dir = join(TOP, "findings");
  mkdirSync(dir, { recursive: true });
  const faults = [];
  const fault = (r) => faults.push(r);
  assert.equal(readFindings(join(dir, "none.json"), { fault }), null);
  assert.equal(readFindings(null, { fault }), null);
  assert.deepEqual(faults, []);
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.equal(readFindings(join(dir, "bad.json"), { fault }), null);
  assert.match(faults.at(-1), /bad\.json are not JSON .*; the card's alternatives were not checked against them/);
  writeFileSync(join(dir, "list.json"), "[1]");
  assert.equal(readFindings(join(dir, "list.json"), { fault }), null);
  assert.match(faults.at(-1), /list\.json are not a JSON object/);
  writeFileSync(join(dir, "ok.json"), JSON.stringify({
    version: 1, sessionId: "s1", kind: "verdict",
    alternatives: [{ design: "a queue", chosen: true }, { design: "", chosen: false }, { design: "direct", chosen: "no" }, "x", null, { design: "direct call", chosen: false }],
  }));
  assert.deepEqual(readFindings(join(dir, "ok.json"), { fault }), { path: join(dir, "ok.json"), alternatives: [{ design: "a queue", chosen: true }, { design: "direct call", chosen: false }] });
  writeFileSync(join(dir, "empty.json"), JSON.stringify({ version: 1 }));
  assert.deepEqual(readFindings(join(dir, "empty.json"), { fault }), { path: join(dir, "empty.json"), alternatives: [] });
  assert.equal(faults.length, 2);
  if (process.getuid?.() !== 0) {
    writeFileSync(join(dir, "locked.json"), "{}");
    chmodSync(join(dir, "locked.json"), 0o000);
    assert.equal(readFindings(join(dir, "locked.json"), { fault }), null);
    assert.match(faults.at(-1), /locked\.json could not be read \(EACCES/);
  }
});

test("cardContext: the receipt directory and this session's receipt under the git root, the findings from the sandbox state", () => {
  const root = repo("r2");
  const state = join(TOP, "state");
  mkdirSync(join(state, "ask-graham", "findings"), { recursive: true });
  writeFileSync(join(state, "ask-graham", "findings", "s1.json"), JSON.stringify({ version: 1, alternatives: [{ design: "d", chosen: true }] }));
  const env = { XDG_STATE_HOME: state };
  const c = cardContext({ root: join(root, "packages", "app"), sessionId: "s1", env, home: join(TOP, "nohome") });
  assert.deepEqual(c, {
    receiptDir: join(root, ".pattern-check"),
    receiptPath: join(root, ".pattern-check", "s1.md"),
    repoRoot: root,
    findings: { path: join(state, "ask-graham", "findings", "s1.json"), alternatives: [{ design: "d", chosen: true }] },
  });
  // No findings for another session; no git root → no receipt directory, the worktree is the repository.
  assert.equal(cardContext({ root, sessionId: "s2", env, home: join(TOP, "nohome") }).findings, null);
  const loose = join(TOP, "loose");
  mkdirSync(loose, { recursive: true });
  assert.deepEqual(cardContext({ root: loose, sessionId: "s1", env: {}, home: join(TOP, "nohome") }), { receiptDir: null, receiptPath: null, repoRoot: loose, findings: null });
});

test("cardContext logs a findings fault to this plugin's errors.log and still returns the context", () => {
  const root = repo("r3");
  const state = join(TOP, "state3");
  const base = join(TOP, "pc-state3");
  mkdirSync(join(state, "ask-graham", "findings"), { recursive: true });
  writeFileSync(join(state, "ask-graham", "findings", "s1.json"), "nope");
  const env = { XDG_STATE_HOME: state, PAIRED_CODING_STATE_DIR: base };
  const c = cardContext({ root, sessionId: "s1", env, home: join(TOP, "nohome") });
  assert.equal(c.findings, null);
  assert.equal(c.receiptDir, join(root, ".pattern-check"));
  const log = readFileSync(join(base, "errors.log"), "utf8").trim().split("\n");
  assert.equal(log.length, 1);
  assert.match(log[0], /lib\/card-context\.mjs pair_propose session=s1: ask-graham findings .*s1\.json are not JSON/);
  assert.equal(existsSync(join(state, "ask-graham", "errors.log")), false, "never writes under ask-graham's state");
});
