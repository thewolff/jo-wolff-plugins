// setup.test.mjs — node --test
//
// The setup tool as a subprocess under a temp $HOME, answering its prompts on stdin. Judges are
// stand-in shell commands, so no model is called: one prints a verdict, one exits non-zero.
//
// Run: node --test plugins/i-have-audhd/tools/setup.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SETUP = fileURLToPath(new URL("./setup.mjs", import.meta.url));
const GOOD_JUDGE = `cat >/dev/null; printf '%s\\n' 'banner' '{"violation": false, "reason": "no banana"}'`;
const BAD_JUDGE = "cat >/dev/null; exit 3";

function mkhome() {
  const home = mkdtempSync(join(tmpdir(), "audhd-setup-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}
const profilePath = (home) => join(home, ".claude", "i-have-audhd.json");
const readProfile = (home) => JSON.parse(readFileSync(profilePath(home), "utf8"));

function runSetup(home, answers = [], args = []) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    input: answers.map((a) => `${a}\n`).join(""),
    encoding: "utf8",
    env: { ...process.env, HOME: home, I_HAVE_AUDHD_PROFILE: "" },
    timeout: 30_000,
  });
}

test("choosing none writes judgeCommand null, says which checks stay off, and makes no test call", () => {
  const home = mkhome();
  const r = runSetup(home, ["5", "yes"]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readProfile(home).enforcement.judgeCommand, null);
  assert.match(r.stdout, /node v\d+/);
  assert.match(r.stdout, /No judge, no test\. do-not-batch-by-label, conclusion-first, restate-resumed-thread, report-what-you-did-not-do, bad-news-first stay off/);
  assert.equal(statSync(profilePath(home)).mode & 0o777, 0o600);
});

test("a custom judge is tested, previewed, and written; every other profile field is kept", () => {
  const home = mkhome();
  writeFileSync(profilePath(home), JSON.stringify({ reader: "R", traits: ["t"], enforcement: { mode: "warn", rules: { "name-the-artifact": "block" } } }));
  const r = runSetup(home, ["4", GOOD_JUDGE, "yes"]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /The judge answered in [\d.]+s: violation=false, "no banana"/);
  assert.match(r.stdout, /enforcement\.judgeCommand: not chosen yet {2}-> {2}/);
  assert.deepEqual(readProfile(home), {
    reader: "R",
    traits: ["t"],
    enforcement: { mode: "warn", rules: { "name-the-artifact": "block" }, judgeCommand: GOOD_JUDGE },
  });
});

test("re-running with the same choice writes nothing and exits 0", () => {
  const home = mkhome();
  assert.equal(runSetup(home, ["4", GOOD_JUDGE, "yes"]).status, 0);
  const before = readFileSync(profilePath(home), "utf8");
  const r = runSetup(home, ["4", GOOD_JUDGE]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /already has this choice; nothing to write/);
  assert.equal(readFileSync(profilePath(home), "utf8"), before);
});

test("a judge that fails its test call is reported and not written unless the operator types yes", () => {
  const home = mkhome();
  const declined = runSetup(home, ["4", BAD_JUDGE, "no"]);
  assert.equal(declined.status, 1);
  assert.match(declined.stdout, /The judge did not work: it exited with status 3/);
  assert.ok(!existsSync(profilePath(home)));

  const forced = runSetup(home, ["4", BAD_JUDGE, "yes"]);
  assert.equal(forced.status, 0, forced.stdout);
  assert.equal(readProfile(home).enforcement.judgeCommand, BAD_JUDGE);
});

test("--yes never writes a judge whose test call failed", () => {
  const home = mkhome();
  const r = runSetup(home, [], ["--judge", "custom", "--command", BAD_JUDGE, "--yes"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /--yes does not write it/);
  assert.ok(!existsSync(profilePath(home)));
});

test("the flags write without prompting when the test passes", () => {
  const home = mkhome();
  const r = runSetup(home, [], ["--judge", "custom", "--command", GOOD_JUDGE, "--yes"]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readProfile(home).enforcement.judgeCommand, GOOD_JUDGE);
});

test("an answer that is not a choice is asked again; no answer at all writes nothing", () => {
  const home = mkhome();
  const r = runSetup(home, ["9", "banana"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /"9" is not one of the choices/);
  assert.match(r.stdout, /No choice made; nothing was written/);
  assert.ok(!existsSync(profilePath(home)));
});

test("declining the preview writes nothing", () => {
  const home = mkhome();
  const r = runSetup(home, ["5", "no"]);
  assert.equal(r.status, 1);
  assert.ok(!existsSync(profilePath(home)));
});

test("an unparseable profile is refused untouched and its contents are not printed", () => {
  const home = mkhome();
  writeFileSync(profilePath(home), "{ secret-ish not json");
  const r = runSetup(home, ["5", "yes"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /is not valid JSON/);
  assert.ok(!r.stdout.includes("secret-ish"));
  assert.equal(readFileSync(profilePath(home), "utf8"), "{ secret-ish not json");
});

test("the listed choices are Claude Code, Codex, OMP, custom, and none", () => {
  const home = mkhome();
  const r = runSetup(home, []);
  for (const line of [/1\. Claude Code CLI, Haiku model/, /2\. Codex CLI/, /3\. OMP, a model you name/, /4\. A command you type/, /5\. None: 5 of 9 checks stay off/]) {
    assert.match(r.stdout, line);
  }
});

test("an unknown flag is a usage error", () => {
  const r = runSetup(mkhome(), [], ["--bogus"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node setup\.mjs/);
});
