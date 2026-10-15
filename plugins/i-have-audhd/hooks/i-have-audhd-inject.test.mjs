// i-have-audhd-inject.test.mjs — node --test
//
// The injector is tested as a subprocess with an isolated $HOME because its rule 8 half writes a
// state marker next to the profile it already reads. The emission half is regression cover:
// the marker work must never disturb the SessionStart output.
//
// Run: node --test 'plugins/i-have-audhd/hooks/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INJECTOR = fileURLToPath(new URL("./i-have-audhd-inject.mjs", import.meta.url));

function mkhome() {
  const home = mkdtempSync(join(tmpdir(), "audhd-inj-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

function runInject(payload, home) {
  return spawnSync(process.execPath, [INJECTOR], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HOME: home, I_HAVE_AUDHD_INJECT: "", I_HAVE_AUDHD_PROFILE: "" },
    cwd: join(INJECTOR, ".."),
    timeout: 30_000,
  });
}

const markerPath = (home, sid) => join(home, ".claude", ".i-have-audhd-state", `resume-${sid}`);
// Resume markers only: the state dir may also hold the one-time no-judge notice marker.
const resumeMarkers = (home) => {
  const state = join(home, ".claude", ".i-have-audhd-state");
  return existsSync(state) ? readdirSync(state).filter((f) => f.startsWith("resume-")) : [];
};

// ─── emission regression ─────────────────────────────────────────────────────

test("a plain startup emits SessionStart output, exits 0, and writes no marker", () => {
  const home = mkhome();
  const r = runInject({ session_id: "s1", source: "startup" }, home);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(!existsSync(markerPath(home, "s1")));
});

test("no stdin at all still emits and exits 0", () => {
  const home = mkhome();
  const r = spawnSync(process.execPath, [INJECTOR], {
    input: "",
    encoding: "utf8",
    env: { ...process.env, HOME: home, I_HAVE_AUDHD_INJECT: "", I_HAVE_AUDHD_PROFILE: "" },
    timeout: 30_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /additionalContext/);
});

// ─── the restate-resumed-thread marker ───────────────────────────────────────────────────────────

test("source=resume writes a one-shot marker for the session", () => {
  const home = mkhome();
  const r = runInject({ session_id: "res1", source: "resume" }, home);
  assert.equal(r.status, 0);
  assert.ok(existsSync(markerPath(home, "res1")), "marker file written");
  assert.match(readFileSync(markerPath(home, "res1"), "utf8"), /\d{4}-\d{2}-\d{2}T/); // timestamped
  assert.match(r.stdout, /additionalContext/); // the session text is unaffected
});

test("source=compact writes the marker", () => {
  const home = mkhome();
  runInject({ session_id: "cmp1", source: "compact" }, home);
  assert.ok(existsSync(markerPath(home, "cmp1")));
});

test("source=clear with a compact reason writes the marker; plain clear does not", () => {
  const home = mkhome();
  runInject({ session_id: "cl1", source: "clear", reason: "context compacted by /compact" }, home);
  assert.ok(existsSync(markerPath(home, "cl1")));

  const home2 = mkhome();
  runInject({ session_id: "cl2", source: "clear", reason: "user ran /clear" }, home2);
  assert.ok(!existsSync(markerPath(home2, "cl2")));
});

test("no session_id means no marker — there is nothing to key it to", () => {
  const home = mkhome();
  runInject({ source: "resume" }, home);
  assert.deepEqual(resumeMarkers(home), []);
});

test("unparseable stdin is fail-open: emit, exit 0, no marker", () => {
  const home = mkhome();
  const r = spawnSync(process.execPath, [INJECTOR], {
    input: "not json",
    encoding: "utf8",
    env: { ...process.env, HOME: home, I_HAVE_AUDHD_INJECT: "", I_HAVE_AUDHD_PROFILE: "" },
    timeout: 30_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /additionalContext/);
  assert.deepEqual(resumeMarkers(home), []);
});

// ─── the one-time no-judge notice ────────────────────────────────────────────────────────────

const noticeMarker = (home) => join(home, ".claude", ".i-have-audhd-state", "judge-notice-shown");
const writeProfile = (home, obj) => writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify(obj));

test("a fresh install with no profile shows the no-judge notice once, naming the checks and the setup command", () => {
  const home = mkhome();
  const first = JSON.parse(runInject({ session_id: "s1", source: "startup" }, home).stdout);
  assert.match(first.systemMessage, /no judge is configured, so 5 of its 9 checks are off/);
  for (const rule of ["do-not-batch-by-label", "conclusion-first", "restate-resumed-thread", "report-what-you-did-not-do", "bad-news-first"]) {
    assert.ok(first.systemMessage.includes(rule), rule);
  }
  assert.ok(first.systemMessage.includes(`node ${join(INJECTOR, "..", "..", "tools", "setup.mjs")}`));
  assert.ok(first.hookSpecificOutput.additionalContext.includes(first.systemMessage));
  assert.ok(existsSync(noticeMarker(home)));

  const second = JSON.parse(runInject({ session_id: "s2", source: "startup" }, home).stdout);
  assert.equal(second.systemMessage, undefined);
  assert.ok(!second.hookSpecificOutput.additionalContext.includes("no judge is configured"));
});

test("a profile without enforcement.judgeCommand still counts as no choice", () => {
  const home = mkhome();
  writeProfile(home, { reader: "R", enforcement: { mode: "warn" } });
  const out = JSON.parse(runInject({ session_id: "s1", source: "startup" }, home).stdout);
  assert.match(out.systemMessage, /no judge is configured/);
});

test("judgeCommand null (chose none) and a set judge both suppress the notice", () => {
  for (const judgeCommand of [null, "codex exec --skip-git-repo-check -"]) {
    const home = mkhome();
    writeProfile(home, { enforcement: { judgeCommand } });
    const out = JSON.parse(runInject({ session_id: "s1", source: "startup" }, home).stdout);
    assert.equal(out.systemMessage, undefined, String(judgeCommand));
    assert.ok(!existsSync(noticeMarker(home)));
  }
});
