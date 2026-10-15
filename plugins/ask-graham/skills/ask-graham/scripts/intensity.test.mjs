import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_LEVEL, REPO_FILE, describe, describeStopCheck, main, parseIntensity, parseSetting, resolveIntensity, resolveSetting, stopCheckEnabled, userConfigPath, writeIntensity, writeSetting } from "./intensity.mjs";

const CLI = fileURLToPath(new URL("./intensity.mjs", import.meta.url));

/** A scratch home with an XDG config dir and a git repo (a `.git` directory is all findRepoRoot needs). */
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const xdg = join(base, "xdg");
  const repo = join(base, "repo");
  const sub = join(repo, "src", "deep");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  const env = { XDG_CONFIG_HOME: xdg };
  const userFile = join(xdg, "ask-graham", "config");
  const setUser = (text) => { mkdirSync(join(xdg, "ask-graham"), { recursive: true }); writeFileSync(userFile, text); };
  const setRepo = (text) => writeFileSync(join(repo, REPO_FILE), text);
  return { base, home, xdg, repo, sub, env, userFile, setUser, setRepo };
}

test("no files: the default, ask", (t) => {
  const f = fixture(t);
  const r = resolveIntensity({ cwd: f.sub, env: f.env, home: f.home });
  assert.deepEqual(r, { level: DEFAULT_LEVEL, source: "default", path: null, invalid: false });
  assert.equal(DEFAULT_LEVEL, "ask");
});

test("user file over the default", (t) => {
  const f = fixture(t);
  f.setUser("intensity=every-idea\n");
  const r = resolveIntensity({ cwd: f.sub, env: f.env, home: f.home });
  assert.equal(r.level, "every-idea");
  assert.equal(r.source, "user");
  assert.equal(r.path, f.userFile);
});

test("repo file over the user file, from any directory inside the repo", (t) => {
  const f = fixture(t);
  f.setUser("intensity=every-idea\n");
  f.setRepo("intensity=ask\n");
  for (const cwd of [f.repo, f.sub]) {
    const r = resolveIntensity({ cwd, env: f.env, home: f.home });
    assert.equal(r.level, "ask");
    assert.equal(r.source, "repo");
    assert.equal(r.path, join(f.repo, REPO_FILE));
  }
});

test("repo file turns the level up too", (t) => {
  const f = fixture(t);
  f.setUser("intensity=ask\n");
  f.setRepo("intensity=every-idea\n");
  assert.equal(resolveIntensity({ cwd: f.sub, env: f.env, home: f.home }).level, "every-idea");
});

test("a repo file above the git root covers nested repositories and worktrees; the nearest file wins", (t) => {
  const f = fixture(t);
  f.setUser("intensity=every-idea\n");
  const workspace = join(f.base, "workspace");
  const nested = join(workspace, "repos", "app");
  const worktree = join(workspace, "repos", "app.worktrees", "feature");
  mkdirSync(join(nested, ".git"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
  writeFileSync(join(workspace, REPO_FILE), "intensity=ask\n");
  for (const cwd of [nested, worktree]) {
    const r = resolveIntensity({ cwd, env: f.env, home: f.home });
    assert.equal(r.level, "ask");
    assert.equal(r.path, join(workspace, REPO_FILE));
  }
  writeFileSync(join(nested, REPO_FILE), "intensity=every-idea\n");
  assert.equal(resolveIntensity({ cwd: nested, env: f.env, home: f.home }).level, "every-idea");
  assert.equal(resolveIntensity({ cwd: worktree, env: f.env, home: f.home }).level, "ask");
});

test("outside a repository only the user file counts", (t) => {
  const f = fixture(t);
  f.setUser("intensity=every-idea\n");
  const r = resolveIntensity({ cwd: f.home, env: f.env, home: f.home });
  assert.equal(r.source, "user");
  assert.equal(r.level, "every-idea");
});

test("an invalid user file means ask", (t) => {
  const f = fixture(t);
  for (const text of ["intensity=loud\n", "garbage\n", "", "intensity = EVERY-IDEA\n"]) {
    f.setUser(text);
    const r = resolveIntensity({ cwd: f.sub, env: f.env, home: f.home });
    assert.equal(r.level, "ask", JSON.stringify(text));
    assert.equal(r.source, "user");
    assert.equal(r.invalid, true);
  }
});

test("an invalid repo file means ask and does not fall through to the user file", (t) => {
  const f = fixture(t);
  f.setUser("intensity=every-idea\n");
  f.setRepo("intensity=quiet\n");
  const r = resolveIntensity({ cwd: f.sub, env: f.env, home: f.home });
  assert.equal(r.level, "ask");
  assert.equal(r.source, "repo");
  assert.equal(r.invalid, true);
  assert.match(describe(r), /names no valid level, so it counts as ask/);
});

test("parseIntensity skips comments and blank lines and allows spaces round =", () => {
  assert.equal(parseIntensity("# a comment\n\nintensity = every-idea\n"), "every-idea");
  assert.equal(parseIntensity("intensity=ask"), "ask");
  assert.equal(parseIntensity("intensity=every idea"), null);
});

test("XDG_CONFIG_HOME counts only when absolute", () => {
  assert.equal(userConfigPath({ XDG_CONFIG_HOME: "/x" }, "/h"), "/x/ask-graham/config");
  assert.equal(userConfigPath({ XDG_CONFIG_HOME: "rel" }, "/h"), "/h/.config/ask-graham/config");
  assert.equal(userConfigPath({}, "/h"), "/h/.config/ask-graham/config");
});

test("writeIntensity writes the user file, or the repo file with here", (t) => {
  const f = fixture(t);
  assert.equal(writeIntensity("every-idea", { cwd: f.sub, env: f.env, home: f.home }), f.userFile);
  assert.match(readFileSync(f.userFile, "utf8"), /^intensity=every-idea$/m);
  const repoPath = writeIntensity("ask", { here: true, cwd: f.sub, env: f.env, home: f.home });
  assert.equal(repoPath, join(f.repo, REPO_FILE));
  assert.equal(resolveIntensity({ cwd: f.sub, env: f.env, home: f.home }).source, "repo");
  assert.throws(() => writeIntensity("loud", { env: f.env, home: f.home }), /unknown intensity/);
  assert.throws(() => writeIntensity("ask", { here: true, cwd: f.home, env: f.env, home: f.home }), /needs a git repository/);
});

test("main prints both settings, and with a value writes first", (t) => {
  const f = fixture(t);
  const lines = [];
  const out = (l) => lines.push(l);
  main(["--cwd", f.sub], { env: f.env, home: f.home, out });
  assert.deepEqual(lines, [
    "ask-graham intensity: ask (from the default; no repo or user file sets it)",
    "ask-graham stop-check: on (from the default; no repo or user file sets it)",
  ]);
  lines.length = 0;
  main(["every-idea", "--cwd", f.sub], { env: f.env, home: f.home, out });
  assert.equal(lines[0], `wrote intensity=every-idea to ${f.userFile}`);
  assert.equal(lines[1], `ask-graham intensity: every-idea (from user file ${f.userFile})`);
  assert.throws(() => main(["--here"], { env: f.env, home: f.home, out }), /usage/);
});

// --- stop-check -----------------------------------------------------------------------------------

const stopCheck = (f, cwd = f.sub) => resolveSetting("stop-check", { cwd, env: f.env, home: f.home });

test("stop-check: no files means on, from the default", (t) => {
  const f = fixture(t);
  assert.deepEqual(stopCheck(f), { key: "stop-check", value: "on", source: "default", path: null, invalid: false });
  assert.equal(stopCheckEnabled({ cwd: f.sub, env: f.env, home: f.home }), true);
});

test("stop-check: the user file turns it off; a repo file wins over the user file both ways", (t) => {
  const f = fixture(t);
  f.setUser("stop-check=off\n");
  assert.deepEqual(stopCheck(f), { key: "stop-check", value: "off", source: "user", path: f.userFile, invalid: false });
  assert.equal(stopCheckEnabled({ cwd: f.sub, env: f.env, home: f.home }), false);
  f.setRepo("stop-check=on\n");
  assert.equal(stopCheck(f).value, "on");
  assert.equal(stopCheck(f).source, "repo");
  f.setUser("stop-check=on\n");
  f.setRepo("stop-check = off\n");
  assert.equal(stopCheck(f).value, "off");
  assert.equal(stopCheckEnabled({ cwd: f.sub, env: f.env, home: f.home }), false);
});

test("each key resolves on its own: a file setting only the other key falls through for this one", (t) => {
  const f = fixture(t);
  f.setUser("intensity=every-idea\nstop-check=off\n");
  f.setRepo("intensity=ask\n");
  assert.equal(resolveIntensity({ cwd: f.sub, env: f.env, home: f.home }).level, "ask");
  assert.deepEqual(stopCheck(f), { key: "stop-check", value: "off", source: "user", path: f.userFile, invalid: false });
  f.setRepo("stop-check=on\n");
  const r = resolveIntensity({ cwd: f.sub, env: f.env, home: f.home });
  assert.equal(r.level, "every-idea");
  assert.equal(r.source, "user");
  assert.equal(stopCheck(f).value, "on");
});

test("stop-check: an unknown value counts as on and does not fall through", (t) => {
  const f = fixture(t);
  f.setUser("stop-check=off\n");
  f.setRepo("stop-check=of\n");
  const r = stopCheck(f);
  assert.equal(r.value, "on");
  assert.equal(r.source, "repo");
  assert.equal(r.invalid, true);
  assert.match(describeStopCheck(r), /names no valid stop-check value, so it counts as on/);
});

test("a file naming neither key decides both, as today: blank, comments and garbage", (t) => {
  const f = fixture(t);
  f.setUser("intensity=every-idea\nstop-check=off\n");
  for (const text of ["", "# just a comment\n\n", "garbage\n", "stop-check=of f\n"]) {
    f.setRepo(text);
    const i = resolveIntensity({ cwd: f.sub, env: f.env, home: f.home });
    assert.deepEqual([i.level, i.source, i.invalid], ["ask", "repo", true], JSON.stringify(text));
    const s = stopCheck(f);
    assert.deepEqual([s.value, s.source, s.invalid], ["on", "repo", true], JSON.stringify(text));
  }
});

test("parseSetting: value, null for an unknown value, undefined for no line", () => {
  assert.equal(parseSetting("# c\nstop-check = off\n", "stop-check"), "off");
  assert.equal(parseSetting("stop-check=OFF\n", "stop-check"), null);
  assert.equal(parseSetting("intensity=ask\n", "stop-check"), undefined);
  assert.equal(parseSetting("stop-check=off\n", "intensity"), undefined);
  assert.equal(parseIntensity("stop-check=off\n"), null);
  assert.throws(() => parseSetting("", "loudness"), /unknown setting/);
});

test("writeSetting replaces its own line and keeps the other key", (t) => {
  const f = fixture(t);
  writeIntensity("every-idea", { cwd: f.sub, env: f.env, home: f.home });
  writeSetting("stop-check", "off", { cwd: f.sub, env: f.env, home: f.home });
  writeSetting("stop-check", "on", { cwd: f.sub, env: f.env, home: f.home });
  writeSetting("stop-check", "off", { cwd: f.sub, env: f.env, home: f.home });
  const text = readFileSync(f.userFile, "utf8");
  assert.equal(text.match(/^stop-check=/gm).length, 1);
  assert.match(text, /^intensity=every-idea$/m);
  assert.match(text, /^stop-check=off$/m);
  f.setRepo("# mine\nintensity=ask\n");
  assert.equal(writeSetting("stop-check", "off", { here: true, cwd: f.sub, env: f.env, home: f.home }), join(f.repo, REPO_FILE));
  assert.equal(readFileSync(join(f.repo, REPO_FILE), "utf8"), "# mine\nintensity=ask\nstop-check=off\n");
  assert.throws(() => writeSetting("stop-check", "maybe", { env: f.env, home: f.home }), /unknown stop-check "maybe"; use on or off/);
});

test("main stop-check: off writes the user file, --here the repo file, bare prints", (t) => {
  const f = fixture(t);
  const lines = [];
  const out = (l) => lines.push(l);
  main(["stop-check", "off", "--cwd", f.sub], { env: f.env, home: f.home, out });
  assert.deepEqual(lines, [
    `wrote stop-check=off to ${f.userFile}`,
    "ask-graham intensity: ask (from the default; no repo or user file sets it)",
    `ask-graham stop-check: off (from user file ${f.userFile})`,
  ]);
  lines.length = 0;
  main(["stop-check", "on", "--here", "--cwd", f.sub], { env: f.env, home: f.home, out });
  assert.equal(lines[0], `wrote stop-check=on to ${join(f.repo, REPO_FILE)}`);
  assert.equal(lines[2], `ask-graham stop-check: on (from repo file ${join(f.repo, REPO_FILE)})`);
  lines.length = 0;
  main(["stop-check", "--cwd", f.sub], { env: f.env, home: f.home, out });
  assert.equal(lines.length, 2);
  assert.throws(() => main(["stop-check", "--here", "--cwd", f.sub], { env: f.env, home: f.home, out }), /usage/);
  assert.throws(() => main(["stop-check", "off", "extra"], { env: f.env, home: f.home, out }), /usage/);
});

test("the CLI exits 1 with a message on a bad level", (t) => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [CLI, "loud", "--cwd", f.sub], { env: { ...process.env, ...f.env, HOME: f.home }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ask-graham: unknown intensity "loud"/);
});
