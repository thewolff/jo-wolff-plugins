// card-context.test.mjs — the sibling-plugin path rules and the findings reader, on real files
// under a temp directory. Nothing here touches the user's state.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINDINGS_MAX_BYTES, cardContext, findingsPath, gitRoot, patternCheckKey, readFindings } from "./card-context.mjs";

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

const RECORD = { version: 1, sessionId: "s1", writtenAt: "2026-11-04T10:00:00.000Z", kind: "verdict", alternatives: [{ design: "a queue", chosen: true }, { design: "direct call", chosen: false }] };
const AS_READ = (path) => ({ path, sessionId: "s1", writtenAt: RECORD.writtenAt, alternatives: RECORD.alternatives });

test("readFindings: missing is null and silent; a valid record comes back with its identity and timestamp, extra fields dropped", () => {
  const dir = join(TOP, "findings");
  mkdirSync(dir, { recursive: true });
  const faults = [];
  const fault = (r) => faults.push(r);
  assert.equal(readFindings(join(dir, "none.json"), { sessionId: "s1", fault }), null);
  assert.equal(readFindings(join(dir, "none", "deeper.json"), { sessionId: "s1", fault }), null);
  assert.equal(readFindings(null, { sessionId: "s1", fault }), null);
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ ...RECORD, ask: "queue the exports", found: [], cwd: "/w", alternatives: [{ design: "a queue", chosen: true, note: "x" }, { design: "direct call", chosen: false }] }));
  assert.deepEqual(readFindings(join(dir, "ok.json"), { sessionId: "s1", fault }), AS_READ(join(dir, "ok.json")));
  writeFileSync(join(dir, "empty.json"), JSON.stringify({ ...RECORD, alternatives: [] }));
  assert.deepEqual(readFindings(join(dir, "empty.json"), { sessionId: "s1", fault }), { ...AS_READ(join(dir, "empty.json")), alternatives: [] });
  for (const at of ["2026-11-04T10:00:00Z", "2026-11-04T10:00:00+01:00", "2026-11-04T10:00:00.5-08:00", "2026-11-04T10:00Z"]) {
    writeFileSync(join(dir, "at.json"), JSON.stringify({ ...RECORD, writtenAt: at }));
    assert.equal(readFindings(join(dir, "at.json"), { sessionId: "s1", fault })?.writtenAt, at, at);
  }
  assert.deepEqual(faults, []);
});

test("readFindings: a file that is not this session's findings reads as missing with one fault naming why; nothing is dropped silently", () => {
  const dir = join(TOP, "findings-bad");
  mkdirSync(dir, { recursive: true });
  const faults = [];
  const fault = (r) => faults.push(r);
  const path = join(dir, "s1.json");
  const cases = [
    ["{not json", /s1\.json are not JSON \(/],
    ["[1]", /s1\.json are not a JSON object;/],
    ['"text"', /s1\.json are not a JSON object;/],
    ["null", /s1\.json are not a JSON object;/],
    [JSON.stringify({ ...RECORD, version: 2 }), /s1\.json have version 2, not one this plugin reads \(1\);/],
    [JSON.stringify({ ...RECORD, version: "1" }), /s1\.json have version "1", not one/],
    [JSON.stringify({ sessionId: "s1", writtenAt: RECORD.writtenAt, alternatives: [] }), /s1\.json have version undefined, not one/],
    [JSON.stringify({ ...RECORD, sessionId: "s2" }), /s1\.json name session "s2", not this session \("s1"\);/],
    [JSON.stringify({ ...RECORD, sessionId: undefined }), /s1\.json name session undefined, not this session \("s1"\);/],
    [JSON.stringify({ ...RECORD, writtenAt: "yesterday" }), /s1\.json have no ISO 8601 writtenAt \("yesterday"\);/],
    [JSON.stringify({ ...RECORD, writtenAt: "2026-11-04" }), /have no ISO 8601 writtenAt \("2026-11-04"\)/],
    [JSON.stringify({ ...RECORD, writtenAt: "2026-13-40T10:00:00Z" }), /have no ISO 8601 writtenAt/],
    [JSON.stringify({ ...RECORD, writtenAt: 1762250400000 }), /have no ISO 8601 writtenAt \(1762250400000\)/],
    [JSON.stringify({ version: 1, sessionId: "s1", writtenAt: RECORD.writtenAt }), /s1\.json have no alternatives list \(undefined\);/],
    [JSON.stringify({ ...RECORD, alternatives: "a queue" }), /have no alternatives list \("a queue"\)/],
    [JSON.stringify({ ...RECORD, alternatives: [{ design: "a queue", chosen: true }, { design: "", chosen: false }] }), /s1\.json have alternatives\[1\] \{"design":"","chosen":false\}, not \{ design: non-empty string, chosen: boolean \};/],
    [JSON.stringify({ ...RECORD, alternatives: [{ design: "a queue", chosen: "no" }] }), /have alternatives\[0\] \{"design":"a queue","chosen":"no"\}/],
    [JSON.stringify({ ...RECORD, alternatives: ["x"] }), /have alternatives\[0\] "x"/],
    [JSON.stringify({ ...RECORD, alternatives: [null] }), /have alternatives\[0\] null/],
  ];
  for (const [i, [text, reason]] of cases.entries()) {
    writeFileSync(path, text);
    assert.equal(readFindings(path, { sessionId: "s1", fault }), null, text);
    assert.equal(faults.length, i + 1, text);
    assert.match(faults[i], reason, text);
    assert.match(faults[i], /; the card's alternatives were not checked against them$/, text);
  }
  // The session id is the reader's, not the file's: the same record read for another session is not that session's.
  writeFileSync(path, JSON.stringify(RECORD));
  assert.equal(readFindings(path, { sessionId: "s2", fault }), null);
  assert.match(faults.at(-1), /name session "s1", not this session \("s2"\)/);
  if (process.getuid?.() !== 0) {
    writeFileSync(join(dir, "locked.json"), "{}");
    chmodSync(join(dir, "locked.json"), 0o000);
    assert.equal(readFindings(join(dir, "locked.json"), { sessionId: "s1", fault }), null);
    assert.match(faults.at(-1), /locked\.json could not be read \(EACCES/);
  }
});

test("readFindings: only a regular file of at most FINDINGS_MAX_BYTES is read; a symlink, a directory and an oversized file read as missing with one fault", () => {
  const dir = join(TOP, "findings-shape");
  mkdirSync(join(dir, "adir"), { recursive: true });
  const faults = [];
  const fault = (r) => faults.push(r);
  writeFileSync(join(dir, "real.json"), JSON.stringify(RECORD));
  symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
  assert.equal(readFindings(join(dir, "link.json"), { sessionId: "s1", fault }), null);
  assert.match(faults.at(-1), /link\.json is a symbolic link, not a regular file; the card's alternatives were not checked/);
  assert.deepEqual(readFindings(join(dir, "real.json"), { sessionId: "s1", fault }), AS_READ(join(dir, "real.json")), "the target itself still reads");
  assert.equal(readFindings(join(dir, "adir"), { sessionId: "s1", fault }), null);
  assert.match(faults.at(-1), /adir is not a regular file;/);
  symlinkSync(join(dir, "nowhere.json"), join(dir, "dangling.json"));
  assert.equal(readFindings(join(dir, "dangling.json"), { sessionId: "s1", fault }), null);
  assert.match(faults.at(-1), /dangling\.json is a symbolic link, not a regular file;/);
  // Exactly the cap is read; one byte over is not. Padding sits inside the JSON so the record would otherwise be valid.
  const padded = (size) => { const base = JSON.stringify({ ...RECORD, pad: "" }); return JSON.stringify({ ...RECORD, pad: "x".repeat(size - base.length) }); };
  writeFileSync(join(dir, "cap.json"), padded(FINDINGS_MAX_BYTES));
  assert.equal(readFileSync(join(dir, "cap.json")).length, FINDINGS_MAX_BYTES);
  assert.deepEqual(readFindings(join(dir, "cap.json"), { sessionId: "s1", fault }), AS_READ(join(dir, "cap.json")));
  writeFileSync(join(dir, "over.json"), padded(FINDINGS_MAX_BYTES + 1));
  assert.equal(readFindings(join(dir, "over.json"), { sessionId: "s1", fault }), null);
  assert.match(faults.at(-1), new RegExp(`over\\.json is ${FINDINGS_MAX_BYTES + 1} bytes, over the ${FINDINGS_MAX_BYTES}-byte limit;`));
  assert.equal(faults.length, 4);
});

test("cardContext: the receipt directory and this session's receipt under the git root, the findings from the adapter's env; no env is a thrown TypeError", () => {
  const root = repo("r2");
  const state = join(TOP, "state");
  mkdirSync(join(state, "ask-graham", "findings"), { recursive: true });
  writeFileSync(join(state, "ask-graham", "findings", "s1.json"), JSON.stringify({ ...RECORD, alternatives: [{ design: "d", chosen: true }] }));
  const env = { XDG_STATE_HOME: state, HOME: join(TOP, "nohome") };
  const c = cardContext({ root: join(root, "packages", "app"), sessionId: "s1", env });
  assert.deepEqual(c, {
    receiptDir: join(root, ".pattern-check"),
    receiptPath: join(root, ".pattern-check", "s1.md"),
    repoRoot: root,
    findings: { path: join(state, "ask-graham", "findings", "s1.json"), sessionId: "s1", writtenAt: RECORD.writtenAt, alternatives: [{ design: "d", chosen: true }] },
  });
  // No findings for another session; no git root → no receipt directory, the worktree is the repository.
  assert.equal(cardContext({ root, sessionId: "s2", env }).findings, null);
  const loose = join(TOP, "loose");
  mkdirSync(loose, { recursive: true });
  assert.deepEqual(cardContext({ root: loose, sessionId: "s1", env: { HOME: join(TOP, "nohome") } }), { receiptDir: null, receiptPath: null, repoRoot: loose, findings: null });
  // The env is the adapter's: HOME in it, not the process's, is where the state falls back to.
  const home = join(TOP, "home2");
  mkdirSync(join(home, ".local", "state", "ask-graham", "findings"), { recursive: true });
  writeFileSync(join(home, ".local", "state", "ask-graham", "findings", "s1.json"), JSON.stringify(RECORD));
  assert.equal(cardContext({ root, sessionId: "s1", env: { HOME: home } }).findings?.path, join(home, ".local", "state", "ask-graham", "findings", "s1.json"));
  assert.equal(cardContext({ root, sessionId: "s1", env: { HOME: home, XDG_STATE_HOME: "relative" } }).findings?.path, join(home, ".local", "state", "ask-graham", "findings", "s1.json"), "a relative XDG_STATE_HOME does not count");
  assert.equal(cardContext({ root, sessionId: "s1", env: { HOME: home, XDG_STATE_HOME: state } }).findings?.path, join(state, "ask-graham", "findings", "s1.json"));
  for (const bad of [undefined, null, "env", 7]) assert.throws(() => cardContext({ root, sessionId: "s1", env: bad }), /cardContext needs the adapter's env/, String(bad));
});

test("cardContext logs a findings fault to this plugin's errors.log and still returns the context", () => {
  const root = repo("r3");
  const state = join(TOP, "state3");
  const base = join(TOP, "pc-state3");
  mkdirSync(join(state, "ask-graham", "findings"), { recursive: true });
  writeFileSync(join(state, "ask-graham", "findings", "s1.json"), "nope");
  const env = { XDG_STATE_HOME: state, PAIRED_CODING_STATE_DIR: base, HOME: join(TOP, "nohome") };
  const c = cardContext({ root, sessionId: "s1", env });
  assert.equal(c.findings, null);
  assert.equal(c.receiptDir, join(root, ".pattern-check"));
  const log = readFileSync(join(base, "errors.log"), "utf8").trim().split("\n");
  assert.equal(log.length, 1);
  assert.match(log[0], /lib\/card-context\.mjs pair_propose session=s1: ask-graham findings .*s1\.json are not JSON/);
  assert.equal(existsSync(join(state, "ask-graham", "errors.log")), false, "never writes under ask-graham's state");
});
