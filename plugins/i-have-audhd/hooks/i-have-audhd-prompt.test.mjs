// i-have-audhd-prompt.test.mjs — a warn finding reaches the agent's next turn.
//
// End to end through the real CLIs, each under a throwaway HOME: the Stop core leaves the warn
// findings of a checked stop pending (lib/pending.mjs), and the UserPromptSubmit hook hands
// them to the next turn as additionalContext (agent) plus systemMessage (person), once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderNotice } from "../lib/pending.mjs";

const STOP = fileURLToPath(new URL("./i-have-audhd-stop.mjs", import.meta.url));
const PROMPT = fileURLToPath(new URL("./i-have-audhd-prompt.mjs", import.meta.url));
const HOOKS_JSON = fileURLToPath(new URL("./hooks.json", import.meta.url));

const body = (n) => "This sentence is ordinary body prose carrying findings and context. ".repeat(n);
const misordered = `${body(6)}\n\n## Needs you\n\nThe migration needs your call before it runs.\n`;
const wellFormed = `## Needs you\n\nThe migration needs your call before it runs.\n\n${body(6)}\n`;

function mkhome(profile) {
  const home = mkdtempSync(join(tmpdir(), "audhd-prompt-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (profile) writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify(profile));
  return home;
}

function run(cli, payload, home) {
  return spawnSync(process.execPath, [cli], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HOME: home, I_HAVE_AUDHD_ENFORCE: "", I_HAVE_AUDHD_PROFILE: "", I_HAVE_AUDHD_HARNESS: "" },
    timeout: 30_000,
  });
}

const stop = (home, sid, text) => run(STOP, { hook_event_name: "Stop", session_id: sid, last_assistant_message: text }, home);
const prompt = (home, sid) => run(PROMPT, { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "next" }, home);
const pendingFile = (home, sid) => join(home, ".claude", ".i-have-audhd-state", `pending-warn-${sid}.json`);

test("a warn finding reaches the next prompt as additionalContext with its fix, and a systemMessage for the person", () => {
  const home = mkhome(); // the measured defaults: every rule warns
  const s = stop(home, "s1", misordered);
  assert.equal(s.status, 0);
  assert.equal(s.stdout, "", "warn never blocks the stop");
  const p = prompt(home, "s1");
  assert.equal(p.status, 0);
  const out = JSON.parse(p.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^i-have-audhd check of your last message \(warning only/);
  assert.match(ctx, /Needs you first/);
  assert.match(ctx, /Move what needs the reader above the body\./, "the fix instruction travels with the finding");
  assert.doesNotMatch(ctx, /Paste the corrected/, "the block-only paste instruction never reaches a warning");
  assert.match(out.systemMessage, /needs-you-first/);
});

test("a notice is delivered once: the second prompt hears nothing", () => {
  const home = mkhome();
  stop(home, "s2", misordered);
  assert.ok(prompt(home, "s2").stdout);
  const again = prompt(home, "s2");
  assert.equal(again.status, 0);
  assert.equal(again.stdout, "");
  assert.equal(existsSync(pendingFile(home, "s2")), false);
});

test("judge unavailable reaches the agent every turn but the person only through the stop's once-per-key alert", () => {
  const home = mkhome({ enforcement: { judgeCommand: "echo 'judge-cli: not logged in' >&2; exit 4" } });
  const batchy =
    `${body(6)}\n\n## Questions\n\nIs the cache warm before the second run?\n` +
    "What happens to the timeout when the judge is slow?\nShould the skip be logged?";
  stop(home, "s2u", batchy);
  const out = JSON.parse(prompt(home, "s2u").stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Judge unavailable/);
  assert.equal("systemMessage" in out, false, "no per-turn line for the person about a dead judge");
});

test("a clean stop clears an older notice, so the next turn hears about the latest message only", () => {
  const home = mkhome();
  stop(home, "s3", misordered);
  assert.ok(existsSync(pendingFile(home, "s3")));
  stop(home, "s3", wellFormed);
  assert.equal(existsSync(pendingFile(home, "s3")), false);
  assert.equal(prompt(home, "s3").stdout, "");
});

test("notices are per session: another session's prompt does not consume this one's", () => {
  const home = mkhome();
  stop(home, "s4", misordered);
  assert.equal(prompt(home, "other").stdout, "");
  assert.ok(prompt(home, "s4").stdout);
});

test("a block-mode finding blocks with the paste instruction and leaves no warning pending", () => {
  const home = mkhome({ enforcement: { mode: "block" } });
  const s = stop(home, "s5", misordered);
  const verdict = JSON.parse(s.stdout);
  assert.equal(verdict.decision, "block");
  assert.match(verdict.reason, /Move what needs the reader above the body\. Paste the corrected opening lines only/);
  assert.equal(prompt(home, "s5").stdout, "");
});

test("mixed modes: the blocked rule blocks, the warned rule is pending for the next turn", () => {
  const twoAsks = `${misordered}\n## Closing ask\n\nShip it? Recommend yes.\n\n## Closing ask\n\nAlso tag it? Recommend yes.\n`;
  const home = mkhome({ enforcement: { mode: "warn", rules: { "needs-you-first": "block" } } });
  const s = stop(home, "s6", twoAsks);
  assert.match(JSON.parse(s.stdout).reason, /Needs you first/);
  const out = JSON.parse(prompt(home, "s6").stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /One closing ask/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /Needs you first/);
});

test("the kill switch silences the prompt hook and keeps the notice for later", () => {
  const home = mkhome();
  stop(home, "s7", misordered);
  const flag = join(home, ".claude", ".i-have-audhd-off");
  writeFileSync(flag, "");
  assert.equal(prompt(home, "s7").stdout, "");
  assert.ok(existsSync(pendingFile(home, "s7")));
});

test("malformed stdin and an unreadable notice exit 0 silently, each with one errors.log line", () => {
  const home = mkhome();
  const bad = spawnSync(process.execPath, [PROMPT], { input: "{nope", encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
  mkdirSync(join(home, ".claude", ".i-have-audhd-state"), { recursive: true });
  writeFileSync(pendingFile(home, "s8"), "not json");
  const p = prompt(home, "s8");
  assert.equal(p.status, 0);
  assert.equal(p.stdout, "");
  const errors = readFileSync(join(home, ".claude", ".i-have-audhd-state", "errors.log"), "utf8");
  assert.match(errors, /prompt payload did not parse/);
  assert.match(errors, /pending warning for s8 did not parse/);
});

test("a long judge reason is capped in the notice; warnings.log keeps it whole", () => {
  const notice = renderNotice([{ rule: "conclusion-first", text: "x".repeat(2000) }]);
  const line = notice.split("\n")[1];
  assert.ok(line.length <= 602, `capped line, got ${line.length}`);
  assert.ok(line.endsWith("…"));
});

test("hooks.json registers the prompt hook on UserPromptSubmit", () => {
  const hooks = JSON.parse(readFileSync(HOOKS_JSON, "utf8")).hooks;
  const cmds = hooks.UserPromptSubmit.flatMap((h) => h.hooks.map((x) => x.command));
  assert.ok(cmds.some((c) => c.includes("hooks/i-have-audhd-prompt.mjs")));
});
