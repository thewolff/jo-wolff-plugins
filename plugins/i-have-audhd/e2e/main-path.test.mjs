// main-path.test.mjs — node --test
//
// The plugin's main path end to end, through the real processes only: a temp HOME (so a temp
// state dir), a temp git repo as the session's cwd, tools/setup.mjs choosing a judge, then the
// three hooks in the order Claude Code runs them, each with the JSON Claude Code sends:
//
//   setup.mjs --judge custom → SessionStart (inject) → Stop on a Claude Code transcript whose last
//   reply violates the closing-ask rules and buries its bad news → UserPromptSubmit (prompt)
//   delivers the warnings → the judge dies → Stop reports JUDGE UNAVAILABLE, never a pass →
//   the kill switch silences both.
//
// The judge replays the stdout a REAL judge printed for the same rules (judge/fixtures/, captured
// by capture-real-judge.mjs), so the verdicts are real model output and the run is free.
// Every spawn has a 5 s timeout: a hang fails the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const at = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const SETUP = at("tools/setup.mjs");
const INJECT = at("hooks/i-have-audhd-inject.mjs");
const STOP = at("hooks/i-have-audhd-stop.mjs");
const PROMPT = at("hooks/i-have-audhd-prompt.mjs");
const FIXTURES = at("judge/fixtures");

// Answers each rule with the real judge's captured stdout for it; anything else (setup's test
// call) gets a plain no-violation verdict.
const REPLAY_JUDGE =
  `p=$(cat); case "$p" in ` +
  `*"Rule: conclusion-first"*) cat '${join(FIXTURES, "conclusion-first.stdout.txt")}';; ` +
  `*"Rule: bad-news-first"*) cat '${join(FIXTURES, "bad-news-first.stdout.txt")}';; ` +
  `*) echo '{"violation": false, "reason": "no fixture for this rule"}';; esac`;

const reply = (opening) =>
  [
    opening,
    "",
    "After all of that, the conclusion is that the production deploy failed last night and the " +
      "rollback did not run, so the site is still serving the broken build. The fix is to rerun the " +
      "rollback job by hand from the actions page.",
    "",
    "## Closing ask",
    "",
    "Should I rerun those?",
  ].join("\n");
const firstReply = reply(
  "I started by reading the deploy workflow end to end, then compared the staging and production " +
    "configuration files line by line, then walked through the last three release tags to see how " +
    "the cache keys were derived in each of them, and then read the runbook section on rollbacks.",
);
const secondReply = reply(
  "I went back over the deploy workflow a second time, then compared the staging and production " +
    "configuration files again, then re-read the last three release tags to see how the cache keys " +
    "were derived in each of them, and then re-read the runbook section on rollbacks.",
);

function spawn(file, input, env, args = []) {
  const r = spawnSync(process.execPath, [file, ...args], { input, encoding: "utf8", env, timeout: 5_000 });
  assert.equal(r.error, undefined, `${file} did not finish in 5 s: ${r.error}`);
  assert.equal(r.status, 0, `${file} exit ${r.status}: ${r.stderr}${r.stdout}`);
  return r.stdout;
}
const json = (stdout) => (stdout.trim() ? JSON.parse(stdout) : {});

// A Claude Code transcript: user turn, a tool-only assistant entry, then the reply's text.
function writeTranscript(path, text) {
  const lines = [
    { type: "user", message: { role: "user", content: "why is the site broken?" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh run list" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "failure" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("main path: setup → session start → stop warns → next prompt delivers → dead judge is unavailable, not a pass → kill switch", () => {
  const root = mkdtempSync(join(tmpdir(), "audhd-e2e-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(repo);
  const git = spawnSync("git", ["init", "-q", repo], { encoding: "utf8", timeout: 5_000 });
  assert.equal(git.status, 0, git.stderr);
  const env = { ...process.env, HOME: home, I_HAVE_AUDHD_PROFILE: "", I_HAVE_AUDHD_ENFORCE: "", I_HAVE_AUDHD_HARNESS: "", I_HAVE_AUDHD_INJECT: "" };
  const state = join(home, ".claude", ".i-have-audhd-state");
  const log = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8") : "");
  const profile = join(home, ".claude", "i-have-audhd.json");
  const sid = "e2e-session";

  // 1. Install step: choose the judge through the real setup CLI.
  const setupOut = spawn(SETUP, "", env, ["--judge", "custom", "--command", REPLAY_JUDGE, "--yes"]);
  assert.match(setupOut, /The judge answered in [\d.]+s: violation=false/);
  assert.equal(JSON.parse(readFileSync(profile, "utf8")).enforcement.judgeCommand, REPLAY_JUDGE);

  // 2. SessionStart: the rules are injected; a chosen judge means no notice.
  const start = json(spawn(INJECT, JSON.stringify({ session_id: sid, cwd: repo, source: "startup" }), env));
  assert.equal(start.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(start.hookSpecificOutput.additionalContext, /i-have-audhd rules/);
  assert.equal(start.systemMessage, undefined);

  // 3. Stop on the transcript: warn by default, so nothing on stdout; the findings are pending.
  const transcript = join(repo, "transcript.jsonl");
  writeTranscript(transcript, firstReply);
  const stopPayload = { session_id: sid, cwd: repo, stop_hook_active: false, transcript_path: transcript };
  assert.deepEqual(json(spawn(STOP, JSON.stringify(stopPayload), env)), {});
  for (const rule of ["plural-back-reference", "conclusion-first", "bad-news-first"]) {
    assert.match(log("warnings.log"), new RegExp(`rule=${rule} `), rule);
  }
  assert.match(log("warnings.log"), /judge: The opening sentence is a long chain of process narration/, "the real judge's reason is carried");

  // 4. UserPromptSubmit: the agent gets the fixes, the person one line; delivered once.
  const promptPayload = JSON.stringify({ session_id: sid, cwd: repo, prompt: "ok, go on" });
  const next = json(spawn(PROMPT, promptPayload, env));
  assert.equal(next.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(next.hookSpecificOutput.additionalContext, /Plural back-reference .* uses "those"/);
  assert.match(next.hookSpecificOutput.additionalContext, /Conclusion first/);
  assert.match(next.hookSpecificOutput.additionalContext, /Bad news first/);
  assert.match(next.systemMessage, /^i-have-audhd warned on the agent's last message: /);
  assert.deepEqual(json(spawn(PROMPT, promptPayload, env)), {}, "a notice is delivered once");

  // 5. The judge dies: JUDGE UNAVAILABLE, loud to the person, never a pass, the turn still allowed.
  const p = JSON.parse(readFileSync(profile, "utf8"));
  p.enforcement.judgeCommand = join(root, "no-such-judge");
  writeFileSync(profile, JSON.stringify(p));
  writeTranscript(transcript, secondReply);
  const dead = json(spawn(STOP, JSON.stringify(stopPayload), env));
  assert.equal(dead.decision, undefined, "warn mode: a dead judge warns");
  assert.match(dead.systemMessage, /^i-have-audhd: judge unavailable\. conclusion-first: other — the judge exited without a known cause/);
  assert.match(dead.systemMessage, /which is not a pass/);
  // The shell's own words differ by OS (macOS sh: "No such file or directory"; dash: "not found").
  assert.match(log("judge-failures.log"), /rule=conclusion-first error=judge-exit-127 cause=other session=\S+ harness=claude-code model=unknown elapsedMs=\d+ budgetMs=30000 section=whole cache=[0-9a-f]{64} prompt=\S+ stderr=".*no-such-judge.*(No such file|not found)/);
  const told = json(spawn(PROMPT, promptPayload, env));
  assert.match(told.hookSpecificOutput.additionalContext, /Judge unavailable \(conclusion-first\)/);
  assert.match(told.hookSpecificOutput.additionalContext, /Plural back-reference/, "the deterministic check still ran");
  assert.equal(log("errors.log"), "", "nothing in the main path is a fault of the plugin");

  // 6. Kill switch: both hooks silent, within the same turn.
  writeFileSync(join(home, ".claude", ".i-have-audhd-off"), "");
  writeTranscript(transcript, firstReply.replace("Should I rerun those?", "Should I rerun those now?"));
  assert.deepEqual(json(spawn(STOP, JSON.stringify(stopPayload), env)), {});
  assert.deepEqual(json(spawn(PROMPT, promptPayload, env)), {});
});
