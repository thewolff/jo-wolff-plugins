// Both Claude Code hooks, spawned as processes with the payload Claude Code sends, under every
// fault the test bar names: empty stdin, malformed JSON, an unwritable state dir, a missing or
// malformed config, a throw, and a 5 s budget. Each must exit 0, allow (no block, nudge only when
// the level says so), append one errors.log line naming the hook file and the reason, and print one
// systemMessage line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NUDGE } from "../skills/ask-graham/scripts/intensity.mjs";
import { BLOCK_REASON } from "../skills/ask-graham/scripts/verdict.mjs";
import { claudeCode } from "../fixtures/transcripts.mjs";
import { BUDGET_MS, PROMPT_HOOK, STOP_HOOK, reply, spawnScript } from "../fixtures/run-hook.mjs";
import { run as runPrompt } from "./ask-graham-hook.mjs";
import { run as runStop } from "./ask-graham-stop.mjs";

const SESSION = "5f1c2a9e-7b3d-4e8a-9c21-0d4b6e8f1a33";

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-failopen-")));
  t.after(() => {
    try { chmodSync(join(base, "state"), 0o755); } catch { /* not made read-only */ }
    rmSync(base, { recursive: true, force: true });
  });
  const state = join(base, "state");
  const config = join(base, "config");
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const env = { HOME: base, XDG_STATE_HOME: state, XDG_CONFIG_HOME: config };
  const errorsLog = join(state, "ask-graham", "errors.log");
  const logLines = () => (existsSync(errorsLog) ? readFileSync(errorsLog, "utf8").trimEnd().split("\n") : []);
  const setUser = (text) => {
    mkdirSync(join(config, "ask-graham"), { recursive: true });
    writeFileSync(join(config, "ask-graham", "config"), text);
  };
  const cc = claudeCode();
  cc.prompt("should we build a cache?");
  cc.skill("ask-graham:ask-graham", "should we build a cache");
  cc.say("Searched the repo; nothing like it exists.");
  const transcript = join(base, "transcript.jsonl");
  writeFileSync(transcript, cc.jsonl());
  const promptPayload = { session_id: SESSION, cwd: repo, prompt: "what if we built a changelog emailer" };
  const stopPayload = { session_id: SESSION, cwd: repo, stop_hook_active: false, transcript_path: transcript };
  const prompt = (input, extraEnv = {}) => spawnScript(PROMPT_HOOK, { input, env: { ...env, ...extraEnv } });
  const stop = (input, extraEnv = {}) => spawnScript(STOP_HOOK, { input, env: { ...env, ...extraEnv } });
  return { base, state, config, repo, env, errorsLog, logLines, setUser, transcript, promptPayload, stopPayload, prompt, stop };
}

// The process finished inside the budget and exited 0.
function exitedClean(r) {
  assert.equal(r.timedOut, false, `ran past ${BUDGET_MS} ms`);
  assert.equal(r.status, 0, r.stderr);
}

// One systemMessage line naming the hook file, and the matching errors.log line.
function warnedAndLogged(f, r, hookFile, reason) {
  const out = reply(r);
  assert.equal(typeof out?.systemMessage, "string");
  assert.doesNotMatch(out.systemMessage, /\n/);
  assert.match(out.systemMessage, new RegExp(`^ask-graham ${hookFile} failed open`));
  assert.match(out.systemMessage, reason);
  const lines = f.logLines();
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+Z ${hookFile} `));
  assert.match(lines[0], reason);
  return out;
}

// --- UserPromptSubmit -------------------------------------------------------------------------

test("prompt hook: the payload Claude Code sends, at every-idea, gives the nudge and logs nothing", (t) => {
  const f = fixture(t);
  f.setUser("intensity=every-idea\n");
  const r = f.prompt(f.promptPayload);
  exitedClean(r);
  assert.deepEqual(reply(r), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: NUDGE } });
  assert.deepEqual(f.logLines(), []);
});

test("prompt hook: missing config is level ask: no output, no log", (t) => {
  const f = fixture(t);
  const r = f.prompt(f.promptPayload);
  exitedClean(r);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(f.errorsLog), false);
});

test("prompt hook: empty stdin exits 0, warns once, logs once", (t) => {
  const f = fixture(t);
  const r = f.prompt("");
  exitedClean(r);
  const out = warnedAndLogged(f, r, "ask-graham-hook.mjs", /stdin was empty/);
  assert.equal(out.hookSpecificOutput, undefined);
});

test("prompt hook: malformed JSON exits 0, warns once, logs once", (t) => {
  const f = fixture(t);
  for (const bad of ["{not json", "[1,2]", "null", "42"]) {
    rmSync(f.errorsLog, { force: true });
    const r = f.prompt(bad);
    exitedClean(r);
    warnedAndLogged(f, r, "ask-graham-hook.mjs", /stdin is not a JSON object/);
  }
});

test("prompt hook: a malformed user config counts as ask, warns, and logs the file", (t) => {
  const f = fixture(t);
  f.setUser("intensity=loud\n");
  const r = f.prompt(f.promptPayload);
  exitedClean(r);
  const out = warnedAndLogged(f, r, "ask-graham-hook.mjs", /names no valid intensity/);
  assert.equal(out.hookSpecificOutput, undefined);
  assert.ok(out.systemMessage.includes(join(f.config, "ask-graham", "config")));
});

test("prompt hook: a binary-garbage repo .ask-graham counts as ask, warns, and logs the file", (t) => {
  const f = fixture(t);
  f.setUser("intensity=every-idea\n");
  writeFileSync(join(f.repo, ".ask-graham"), Buffer.from([0xff, 0xfe, 0x00, 0x3d, 0x0a, 0x9c]));
  const r = f.prompt(f.promptPayload);
  exitedClean(r);
  const out = warnedAndLogged(f, r, "ask-graham-hook.mjs", /\.ask-graham names no valid intensity/);
  assert.equal(out.hookSpecificOutput, undefined);
});

test("prompt hook: an unwritable state dir still exits 0 and says the fault could not be logged", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.base, "state-file"), "");
  const r = f.prompt("{not json", { XDG_STATE_HOME: join(f.base, "state-file") });
  exitedClean(r);
  assert.match(reply(r).systemMessage, /could not be logged to/);
});

test("prompt hook: a throw inside the hook is allowed, warned and logged (in process)", (t) => {
  const f = fixture(t);
  const out = runPrompt(JSON.stringify(f.promptPayload), { env: f.env, home: f.base, handleFn: () => { throw new Error("boom"); } });
  assert.equal(out.hookSpecificOutput, undefined);
  assert.match(out.systemMessage, /^ask-graham ask-graham-hook\.mjs failed open \(the prompt went through\): the intensity setting could not be read this turn \(boom\)/);
  assert.match(f.logLines()[0], / ask-graham-hook\.mjs the intensity setting could not be read this turn \(boom\)/);
});

test("prompt hook: a deep working directory resolves inside the 5 s budget", (t) => {
  const f = fixture(t);
  let deep = f.repo;
  for (let i = 0; i < 200; i++) deep = join(deep, "d");
  mkdirSync(deep, { recursive: true });
  f.setUser("intensity=every-idea\n");
  const r = f.prompt({ ...f.promptPayload, cwd: deep });
  exitedClean(r);
  assert.ok(r.ms < BUDGET_MS, `${r.ms} ms`);
  assert.equal(reply(r).hookSpecificOutput.additionalContext, NUDGE);
});

// --- Stop -------------------------------------------------------------------------------------

test("stop hook: the payload Claude Code sends blocks a turn with no verdict and logs nothing", (t) => {
  const f = fixture(t);
  const r = f.stop(f.stopPayload);
  exitedClean(r);
  assert.deepEqual(reply(r), { decision: "block", reason: BLOCK_REASON });
  assert.deepEqual(f.logLines(), []);
});

test("stop hook: empty stdin lets the stop through, warns once, logs once", (t) => {
  const f = fixture(t);
  const r = f.stop("");
  exitedClean(r);
  const out = warnedAndLogged(f, r, "ask-graham-stop.mjs", /stdin was empty/);
  assert.equal(out.decision, undefined);
});

test("stop hook: malformed JSON lets the stop through, warns once, logs once", (t) => {
  const f = fixture(t);
  for (const bad of ["{not json", "[]", "\"str\""]) {
    rmSync(f.errorsLog, { force: true });
    const r = f.stop(bad);
    exitedClean(r);
    const out = warnedAndLogged(f, r, "ask-graham-stop.mjs", /stdin is not a JSON object/);
    assert.equal(out.decision, undefined);
  }
});

test("stop hook: a payload missing session_id or transcript_path lets the stop through, warned and logged", (t) => {
  const f = fixture(t);
  for (const [payload, reason] of [
    [{ ...f.stopPayload, session_id: undefined }, /session_id undefined is not a plain file name/],
    [{ ...f.stopPayload, session_id: "../escape" }, /session_id "\.\.\/escape" is not a plain file name/],
    [{ ...f.stopPayload, transcript_path: undefined }, /no transcript_path/],
  ]) {
    rmSync(f.errorsLog, { force: true });
    const r = f.stop(payload);
    exitedClean(r);
    assert.equal(warnedAndLogged(f, r, "ask-graham-stop.mjs", reason).decision, undefined);
  }
});

test("stop hook: a missing transcript lets the stop through, warned and logged with the path", (t) => {
  const f = fixture(t);
  const missing = join(f.base, "gone.jsonl");
  const r = f.stop({ ...f.stopPayload, transcript_path: missing });
  exitedClean(r);
  const out = warnedAndLogged(f, r, "ask-graham-stop.mjs", /could not be read \(ENOENT\)/);
  assert.ok(out.systemMessage.includes(missing));
  assert.equal(out.decision, undefined);
});

test("stop hook: an unwritable state dir lets the stop through instead of blocking without a record", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.base, "state-file"), "");
  const r = f.stop(f.stopPayload, { XDG_STATE_HOME: join(f.base, "state-file") });
  exitedClean(r);
  const out = reply(r);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /^ask-graham ask-graham-stop\.mjs failed open \(the stop went through\): block record .* could not be written \(ENOTDIR\), so the stop was not blocked \(could not be logged to /);
});

test("stop hook: a read-only state dir: no block, and the fault is reported", { skip: process.getuid?.() === 0 && "root ignores modes" }, (t) => {
  const f = fixture(t);
  mkdirSync(f.state, { recursive: true });
  chmodSync(f.state, 0o555);
  const r = f.stop(f.stopPayload);
  exitedClean(r);
  const out = reply(r);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /could not be written \(EACCES\)/);
});

test("stop hook: a malformed stop-check config counts as on, still blocks, and warns", (t) => {
  const f = fixture(t);
  f.setUser("stop-check=maybe\n");
  const r = f.stop(f.stopPayload);
  exitedClean(r);
  const out = reply(r);
  assert.equal(out.decision, "block");
  assert.equal(out.reason, BLOCK_REASON);
  assert.match(out.systemMessage, /failed open \(the check still ran\): config .* names no valid stop-check/);
  assert.match(f.logLines()[0], / ask-graham-stop\.mjs config .*config names no valid stop-check/);
});

test("stop hook: a throw inside the hook lets the stop through, warned and logged (in process)", (t) => {
  const f = fixture(t);
  const out = runStop(JSON.stringify(f.stopPayload), { env: f.env, home: f.base, handleFn: () => { throw new Error("kaboom"); } });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /the Stop check threw \(kaboom\), so the stop went through/);
  assert.match(f.logLines()[0], / ask-graham-stop\.mjs the Stop check threw \(kaboom\)/);
});

test("stop hook: a large transcript (20,000 turns) is checked inside the 5 s budget", (t) => {
  const f = fixture(t);
  const cc = claudeCode();
  for (let i = 0; i < 20000; i++) {
    cc.prompt(`turn ${i}: keep going`);
    cc.say(`did step ${i}`);
  }
  cc.prompt("should we build a cache?");
  cc.skill("ask-graham:ask-graham", "should we build a cache");
  cc.say("Searched the repo; nothing like it exists.");
  writeFileSync(f.transcript, cc.jsonl());
  const r = f.stop(f.stopPayload);
  exitedClean(r);
  assert.ok(r.ms < BUDGET_MS, `${r.ms} ms`);
  assert.equal(reply(r).decision, "block");
});
