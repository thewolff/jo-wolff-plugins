// Both hooks run as processes on real Claude Code 2.1.317 output captured by
// fixtures/capture-claude-code.sh (account and organization UUIDs redacted; nothing else edited):
// the stdin payloads Claude Code sent each hook, the session transcripts after each run, and the
// transcripts as they stood at the moment the Stop hooks ran. The only change made here is to point
// a payload's cwd at a temp dir and its transcript_path at the fixture copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NUDGE } from "../skills/ask-graham/scripts/intensity.mjs";
import { BLOCK_REASON, currentTurn, lastAssistantText, parseJsonl } from "../skills/ask-graham/scripts/verdict.mjs";
import { PROMPT_HOOK, STOP_HOOK, reply, spawnScript } from "../fixtures/run-hook.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "claude-code");
const fixture = (name) => join(DIR, name);
const payload = (name) => JSON.parse(readFileSync(fixture(name), "utf8"));

function env(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-real-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  return {
    base,
    repo,
    vars: { HOME: base, XDG_STATE_HOME: join(base, "state"), XDG_CONFIG_HOME: join(base, "config") },
    blocked: join(base, "state", "ask-graham", "blocked"),
    errorsLog: join(base, "state", "ask-graham", "errors.log"),
  };
}

function stop(e, payloadName, transcriptName) {
  const p = { ...payload(payloadName), cwd: e.repo, transcript_path: fixture(transcriptName) };
  const r = spawnScript(STOP_HOOK, { input: p, env: e.vars });
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 0, r.stderr);
  return { p, out: reply(r) };
}

test("the captured payloads have the fields the hooks read", () => {
  for (const name of ["new-idea", "no-verdict"]) {
    const up = payload(`${name}.UserPromptSubmit-1.payload.json`);
    assert.equal(up.hook_event_name, "UserPromptSubmit");
    for (const k of ["session_id", "cwd", "prompt", "transcript_path"]) assert.equal(typeof up[k], "string", k);
    const st = payload(`${name}.Stop-1.payload.json`);
    assert.equal(st.hook_event_name, "Stop");
    assert.equal(st.stop_hook_active, false);
    for (const k of ["session_id", "cwd", "transcript_path"]) assert.equal(typeof st[k], "string", k);
  }
});

test("real UserPromptSubmit payloads at every-idea get the nudge", (t) => {
  const e = env(t);
  writeFileSync(join(e.repo, ".ask-graham"), "intensity=every-idea\n");
  for (const name of ["new-idea", "no-verdict"]) {
    const p = { ...payload(`${name}.UserPromptSubmit-1.payload.json`), cwd: e.repo };
    const r = spawnScript(PROMPT_HOOK, { input: p, env: e.vars });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(reply(r), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: NUDGE } }, name);
  }
  assert.equal(existsSync(e.errorsLog), false);
});

test("real finished transcript whose reply has a verdict passes with no record", (t) => {
  const e = env(t);
  assert.equal(stop(e, "new-idea.Stop-1.payload.json", "new-idea.transcript.jsonl").out, null);
  assert.equal(existsSync(e.blocked), false);
  assert.equal(existsSync(e.errorsLog), false);
});

test("real finished transcript that read the skill and replied 'noted' is blocked once", (t) => {
  const e = env(t);
  const { p, out } = stop(e, "no-verdict.Stop-1.payload.json", "no-verdict.transcript.jsonl");
  assert.deepEqual(out, { decision: "block", reason: BLOCK_REASON });
  assert.ok(existsSync(join(e.blocked, p.session_id)));
  assert.equal(stop(e, "no-verdict.Stop-1.payload.json", "no-verdict.transcript.jsonl").out, null, "second stop in the turn passes");
});

// Captured 2026-11-03 with Claude Code 2.1.317: when the Stop hooks ran, the transcript did not yet
// hold the turn's final reply; that reply arrived only in the payload's last_assistant_message. The
// transcript's last entry with an id was an `api-request` entry with `id` and no parent
// (no-verdict.Stop-1) or an attachment (new-idea.Stop-1). Before 0.7.1 the check walked the parent
// chain back from that entry and read the reply from the transcript, so it let the "noted" reply
// through and blocked the reply that ended in a verdict.

test("the Stop-time transcripts really lack the final reply", () => {
  for (const name of ["no-verdict", "new-idea"]) {
    const final = payload(`${name}.Stop-1.payload.json`).last_assistant_message;
    assert.equal(typeof final, "string");
    const at = (f) => lastAssistantText(currentTurn(parseJsonl(readFileSync(fixture(f), "utf8"))));
    assert.notEqual(at(`${name}.Stop-1.transcript.jsonl`), final, `${name} at Stop`);
    const firstLine = JSON.stringify(final.trim().split("\n")[0]).slice(1, -1);
    assert.ok(readFileSync(fixture(`${name}.transcript.jsonl`), "utf8").includes(firstLine), `${name} finished`);
  }
});

test("real transcript as it stood when Stop fired, for a reply with no verdict, is blocked once", (t) => {
  const e = env(t);
  const { p, out } = stop(e, "no-verdict.Stop-1.payload.json", "no-verdict.Stop-1.transcript.jsonl");
  assert.equal(p.last_assistant_message, "noted");
  assert.deepEqual(out, { decision: "block", reason: BLOCK_REASON });
  assert.equal(stop(e, "no-verdict.Stop-1.payload.json", "no-verdict.Stop-1.transcript.jsonl").out, null, "second stop in the turn passes");
});

test("real transcript as it stood when Stop fired, for a reply ending in a verdict, passes with no record", (t) => {
  const e = env(t);
  const { p, out } = stop(e, "new-idea.Stop-1.payload.json", "new-idea.Stop-1.transcript.jsonl");
  assert.match(p.last_assistant_message, /^\*\*Verdict:\*\* do it now/m);
  assert.equal(out, null);
  assert.equal(existsSync(e.blocked), false);
});

test("without last_assistant_message the reply is read from the transcript", (t) => {
  const e = env(t);
  const noText = (name, transcript) => {
    const p = { ...payload(name), cwd: e.repo, transcript_path: fixture(transcript) };
    delete p.last_assistant_message;
    return reply(spawnScript(STOP_HOOK, { input: p, env: e.vars }));
  };
  // The finished transcript holds the verdict reply: it passes.
  assert.equal(noText("new-idea.Stop-1.payload.json", "new-idea.transcript.jsonl"), null);
  // The Stop-time transcript holds the skill read but no reply yet: it is blocked.
  assert.equal(noText("no-verdict.Stop-1.payload.json", "no-verdict.Stop-1.transcript.jsonl")?.decision, "block");
});
