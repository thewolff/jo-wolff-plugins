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
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", I_HAVE_AUDHD_INJECT: "", I_HAVE_AUDHD_PROFILE: "" },
    cwd: join(INJECTOR, ".."),
    timeout: 5_000,
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
    timeout: 5_000,
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
    timeout: 5_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /additionalContext/);
  assert.deepEqual(resumeMarkers(home), []);
});

// ─── the one-time no-judge notice ────────────────────────────────────────────────────────────

const noticeMarker = (home) => join(home, ".claude", ".i-have-audhd-state", "judge-notice-shown");
const writeProfile = (home, obj) => writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify(obj));

const sharedJudgeFile = (home) => join(home, ".config", "judge", "config.json");
const writeSharedJudge = (home, text) => {
  mkdirSync(join(home, ".config", "judge"), { recursive: true });
  writeFileSync(sharedJudgeFile(home), typeof text === "string" ? text : JSON.stringify(text));
};

test("a fresh install with no profile and no shared judge file shows the no-judge notice once, naming the checks, both files and both setup commands", () => {
  const home = mkhome();
  const first = JSON.parse(runInject({ session_id: "s1", source: "startup" }, home).stdout);
  assert.match(first.systemMessage, /no judge is configured \(no enforcement\.judgeCommand in the profile and no command in /);
  assert.ok(first.systemMessage.includes(sharedJudgeFile(home)), "the shared file is named");
  assert.match(first.systemMessage, /so 5 of its 13 checks are off/);
  for (const rule of ["do-not-batch-by-label", "conclusion-first", "restate-resumed-thread", "report-what-you-did-not-do", "bad-news-first"]) {
    assert.ok(first.systemMessage.includes(rule), rule);
  }
  assert.ok(first.systemMessage.includes(`node ${join(INJECTOR, "..", "..", "lib", "judge.mjs")} setup`), "the shared setup is named");
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

test("a shared judge file naming a command suppresses the notice; a malformed one suppresses it too and logs one fault", () => {
  const configured = mkhome();
  writeSharedJudge(configured, { command: "codex exec --skip-git-repo-check -" });
  const out = JSON.parse(runInject({ session_id: "s1", source: "startup" }, configured).stdout);
  assert.equal(out.systemMessage, undefined);
  assert.ok(!existsSync(noticeMarker(configured)));

  const broken = mkhome();
  writeSharedJudge(broken, "{ not json");
  const r = JSON.parse(runInject({ session_id: "s1", source: "startup" }, broken).stdout);
  assert.ok(!r.systemMessage.includes("no judge is configured"), "something was configured: no setup notice");
  assert.match(r.systemMessage, /failed open .*the shared judge file is malformed \(.*judge\/config\.json: .*\); the judge checks stay off until it is fixed/);
  assert.match(readFileSync(join(broken, ".claude", ".i-have-audhd-state", "errors.log"), "utf8"), /the shared judge file is malformed/);
  assert.ok(!existsSync(noticeMarker(broken)));
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

// ─── the profile's inject switch ─────────────────────────────────────────────

test("inject full (and absent) emits the core, the profile's reader, and the judge notice", () => {
  for (const profile of [{ reader: "R" }, { reader: "R", inject: "full" }]) {
    const home = mkhome();
    writeProfile(home, profile);
    const out = JSON.parse(runInject({ session_id: "s1", source: "startup" }, home).stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /installed the i-have-audhd rules/, JSON.stringify(profile));
    assert.match(out.hookSpecificOutput.additionalContext, /written for R/);
    assert.match(out.systemMessage, /no judge is configured/);
  }
});

test("inject rules emits the core but no judge notice: the Stop hook checks nothing", () => {
  const home = mkhome();
  writeProfile(home, { inject: "rules" });
  const out = JSON.parse(runInject({ session_id: "s1", source: "startup" }, home).stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /installed the i-have-audhd rules/);
  assert.equal(out.systemMessage, undefined);
  assert.ok(!existsSync(noticeMarker(home)));
});

test("inject none emits no additionalContext, still arms the resume marker and shows the judge notice", () => {
  const home = mkhome();
  writeProfile(home, { inject: "none" });
  const out = JSON.parse(runInject({ session_id: "s1", source: "resume" }, home).stdout);
  assert.equal(out.hookSpecificOutput, undefined);
  assert.match(out.systemMessage, /no judge is configured/);
  assert.ok(existsSync(markerPath(home, "s1")), "the Stop hook's checks still run, so rule 8 is still armed");
  const quiet = runInject({ session_id: "s2", source: "startup" }, home);
  assert.equal(quiet.stdout, "", "notice shown once; nothing else to say");
});

test("an inject value outside full|rules|none is one errors.log line and reads as full", () => {
  const home = mkhome();
  writeProfile(home, { inject: "some", enforcement: { judgeCommand: null } });
  const out = JSON.parse(runInject({ session_id: "s1", source: "startup" }, home).stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /installed the i-have-audhd rules/);
  assert.match(out.systemMessage, /failed open/);
  const errors = readFileSync(join(home, ".claude", ".i-have-audhd-state", "errors.log"), "utf8").trim().split("\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lib\/config\.mjs inject: "some" is not full\|rules\|none; full with every rule on applies/);
});

// ─── per-rule switches ───────────────────────────────────────────────────────

test("a rule switched off in inject.rules is absent from the injection: its core block and its list line", () => {
  const home = mkhome();
  writeProfile(home, { inject: { rules: { commands: false } }, enforcement: { judgeCommand: null } });
  const ctx = JSON.parse(runInject({ session_id: "s1", source: "startup" }, home).stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /Commands \(rule 10\)/);
  assert.doesNotMatch(ctx, /^- 10\. Commands handed to the user$/m);
  assert.match(ctx, /Machinery anchors \(rule 11\)/);
  assert.match(ctx, /^- 11\. Machinery anchors$/m);
});

test("every rule on, in string or object form, injects the skill's span unchanged", () => {
  const texts = [{ inject: "full" }, { inject: { mode: "full", rules: { commands: true } } }].map((profile) => {
    const home = mkhome();
    writeProfile(home, { ...profile, enforcement: { judgeCommand: null } });
    const ctx = JSON.parse(runInject({ session_id: "s1", source: "startup" }, home).stdout).hookSpecificOutput.additionalContext;
    return ctx.split(home).join("<home>"); // the profile note names each run's own home
  });
  assert.equal(texts[0], texts[1]);
  assert.match(texts[0], /^- 10\. Commands handed to the user$/m);
});

test("inject object with mode none injects nothing, whatever its rules say", () => {
  const home = mkhome();
  writeProfile(home, { inject: { mode: "none", rules: { commands: false } }, enforcement: { judgeCommand: null } });
  assert.equal(runInject({ session_id: "s1", source: "startup" }, home).stdout, "");
});

test("a malformed inject object is one errors.log line and the full injection with every rule", () => {
  const home = mkhome();
  writeProfile(home, { inject: { rules: { "rule-10": false } }, enforcement: { judgeCommand: null } });
  const out = JSON.parse(runInject({ session_id: "s1", source: "startup" }, home).stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /^- 10\. Commands handed to the user$/m);
  assert.match(out.systemMessage, /failed open/);
  const errors = readFileSync(join(home, ".claude", ".i-have-audhd-state", "errors.log"), "utf8").trim().split("\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /inject: rules\["rule-10"\] is not a rule id/);
});
