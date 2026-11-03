import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySession, normalizePath, paths, readCurrent, readSession, repoRoot, sessionKey, stateDir, writeAtomic, writeCurrent, writeSession } from "./state.mjs";

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pattern-check-state-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const state = join(base, "state");
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  return { base, state, repo, env: { XDG_STATE_HOME: state }, sd: stateDir({ XDG_STATE_HOME: state }, base) };
}

test("stateDir honours an absolute XDG_STATE_HOME and falls back to ~/.local/state", (t) => {
  const f = fixture(t);
  assert.equal(f.sd, join(f.state, "pattern-check"));
  assert.equal(stateDir({ XDG_STATE_HOME: "rel" }, f.base), join(f.base, ".local", "state", "pattern-check"));
});

test("sessionKey uses session_id when safe, else a per-cwd key flagged as degraded", (t) => {
  const f = fixture(t);
  assert.deepEqual(sessionKey({ sessionId: "0b0e6a1c-5d2f-4c1e-9a77-3f0e2c1d9b10", cwd: f.repo }), { key: "0b0e6a1c-5d2f-4c1e-9a77-3f0e2c1d9b10", degraded: false });
  const missing = sessionKey({ sessionId: undefined, cwd: f.repo });
  assert.equal(missing.degraded, true);
  assert.match(missing.key, /^cwd-[0-9a-f]{16}$/);
  assert.deepEqual(sessionKey({ sessionId: "../escape", cwd: f.repo }).degraded, true);
  assert.deepEqual(sessionKey({ sessionId: "", cwd: f.repo }).degraded, true);
  // The same cwd always gives the same degraded key.
  assert.equal(sessionKey({ cwd: f.repo }).key, missing.key);
});

test("repoRoot is the nearest ancestor with .git, else cwd", (t) => {
  const f = fixture(t);
  assert.equal(repoRoot(join(f.repo, "src")), f.repo);
  assert.equal(repoRoot(f.base), f.base);
});

test("writeAtomic leaves the file and no temp file; a torn write leaves the previous file", (t) => {
  const f = fixture(t);
  const file = join(f.sd, "sessions", "x.json");
  writeAtomic(file, "one");
  assert.equal(readFileSync(file, "utf8"), "one");
  writeAtomic(file, "two");
  assert.equal(readFileSync(file, "utf8"), "two");
  assert.deepEqual(readdirSync(join(f.sd, "sessions")), ["x.json"]);
});

test("readSession: missing is fresh; valid round-trips; corrupt reports a fault and a fresh record", (t) => {
  const f = fixture(t);
  const key = "abc";
  const fresh = readSession(f.sd, key, f.repo);
  assert.deepEqual(fresh, { session: emptySession(key, f.repo), fault: null });
  const s = { ...emptySession(key, f.repo), files: ["/a", "/b"], what: "w", opened: "t" };
  writeSession(f.sd, s);
  assert.deepEqual(readSession(f.sd, key, f.repo), { session: s, fault: null });
  writeFileSync(paths.session(f.sd, key), "{ torn");
  const bad = readSession(f.sd, key, f.repo);
  assert.deepEqual(bad.session, emptySession(key, f.repo));
  assert.match(bad.fault, /not valid JSON/);
  writeFileSync(paths.session(f.sd, key), JSON.stringify({ files: "nope" }));
  assert.match(readSession(f.sd, key, f.repo).fault, /unexpected shape/);
});

test("the current pointer round-trips per repository and rejects an unsafe value", (t) => {
  const f = fixture(t);
  assert.equal(readCurrent(f.sd, f.repo), null);
  writeCurrent(f.sd, f.repo, "sess-1");
  assert.equal(readCurrent(f.sd, f.repo), "sess-1");
  assert.equal(readCurrent(f.sd, f.base), null);
  writeFileSync(paths.current(f.sd, f.repo), "../x\n");
  assert.equal(readCurrent(f.sd, f.repo), null);
  assert.equal(existsSync(paths.current(f.sd, f.repo)), true);
});

test("normalizePath: absolute, dot segments resolved, backslashes to slashes, no trailing slash", (t) => {
  const f = fixture(t);
  assert.equal(normalizePath(join(f.repo, "src", "..", "src", "a.ts"), f.repo), join(f.repo, "src", "a.ts"));
  assert.equal(normalizePath("src/a.ts", f.repo), join(f.repo, "src", "a.ts"));
  assert.equal(normalizePath(`${join(f.repo, "src")}/`, f.repo), join(f.repo, "src"));
  assert.equal(normalizePath(`${f.repo}\\src\\a.ts`, f.repo), join(f.repo, "src", "a.ts"));
  assert.equal(normalizePath("/", "/"), "/");
});
