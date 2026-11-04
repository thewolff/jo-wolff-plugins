// End to end over a temp HOME, state dir, config dir and repo, through the real processes only:
// the settings CLI turns the level up, the UserPromptSubmit hook nudges, the Stop hook blocks a
// turn that read the skill without a verdict once and records it, a verdict passes, the CLI turns
// the Stop check off and the level down, and nothing lands in errors.log on the way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NUDGE } from "./skills/ask-graham/scripts/intensity.mjs";
import { BLOCK_REASON } from "./skills/ask-graham/scripts/verdict.mjs";
import { claudeCode } from "./fixtures/transcripts.mjs";
import { INTENSITY_CLI, PROMPT_HOOK, STOP_HOOK, reply, spawnScript } from "./fixtures/run-hook.mjs";

const SESSION = "9d6c3b1e-2a4f-4b7d-8e10-5c3a7f9e2d41";

test("end to end: CLI sets every-idea, prompt hook nudges, Stop hook blocks once, CLI turns both off", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-e2e-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const sub = join(repo, "src");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  const env = { HOME: base, XDG_STATE_HOME: join(base, "state"), XDG_CONFIG_HOME: join(base, "config") };
  const errorsLog = join(base, "state", "ask-graham", "errors.log");
  const record = join(base, "state", "ask-graham", "blocked", SESSION);
  const transcript = join(base, "transcript.jsonl");
  const ok = (r) => {
    assert.equal(r.timedOut, false, "ran past the 5 s budget");
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const cli = (...args) => ok(spawnScript(INTENSITY_CLI, { args: [...args, "--cwd", sub], env }));
  const prompt = (text) => reply(ok(spawnScript(PROMPT_HOOK, { input: { session_id: SESSION, cwd: sub, prompt: text }, env })));
  const stop = (active = false) =>
    reply(ok(spawnScript(STOP_HOOK, { input: { session_id: SESSION, cwd: sub, stop_hook_active: active, transcript_path: transcript }, env })));

  // Level ask by default: the prompt hook is silent.
  assert.equal(prompt("what if we built a changelog emailer"), null);

  // The CLI writes intensity=every-idea to the repo file; the prompt hook now nudges.
  const set = cli("every-idea", "--here");
  assert.match(set.stdout, new RegExp(`wrote intensity=every-idea to ${join(repo, ".ask-graham")}`));
  assert.match(set.stdout, /ask-graham intensity: every-idea \(from repo file /);
  assert.deepEqual(prompt("what if we built a changelog emailer"), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: NUDGE },
  });

  // The agent reads the skill and ends without a verdict: blocked once, and the block recorded.
  const cc = claudeCode();
  const opener = cc.prompt("what if we built a changelog emailer");
  cc.skill("ask-graham:ask-graham", "a changelog emailer");
  cc.say("Searched the repo; nothing like it exists.");
  writeFileSync(transcript, cc.jsonl());
  assert.deepEqual(stop(), { decision: "block", reason: BLOCK_REASON });
  assert.equal(readFileSync(record, "utf8"), `${opener}\n`);

  // The continued turn still lacks it: the second stop passes, so the hook cannot loop.
  cc.stopSummary();
  cc.say("Still thinking.");
  writeFileSync(transcript, cc.jsonl());
  assert.equal(stop(true), null);

  // A new turn that ends with a verdict passes.
  cc.prompt("and a slack bot?");
  cc.skill("ask-graham:ask-graham", "a slack bot");
  cc.say("Nothing like it exists.\n\n**Verdict:** later");
  writeFileSync(transcript, cc.jsonl());
  assert.equal(stop(), null);

  // stop-check off in the repo file: a no-verdict turn passes and the record is untouched.
  assert.match(cli("stop-check", "off", "--here").stdout, /ask-graham stop-check: off \(from repo file /);
  cc.prompt("and a cron job?");
  cc.skill("ask-graham:ask-graham", "a cron job");
  cc.say("No verdict here.");
  writeFileSync(transcript, cc.jsonl());
  assert.equal(stop(), null);
  assert.equal(readFileSync(record, "utf8"), `${opener}\n`);

  // Back to ask: silent again.
  cli("ask", "--here");
  assert.equal(prompt("what if we built a changelog emailer"), null);
  assert.equal(readFileSync(join(repo, ".ask-graham"), "utf8"), "# ask-graham settings: intensity=ask|every-idea, stop-check=on|off\nintensity=ask\nstop-check=off\n");

  assert.equal(existsSync(errorsLog), false, "a clean run logs no faults");
});
