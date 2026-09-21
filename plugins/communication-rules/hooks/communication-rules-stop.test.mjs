// communication-rules-stop.test.mjs — node --test
//
// The hook is tested as a SUBPROCESS with an isolated $HOME, because its whole contract is
// about the world around it: the kill-switch file, the state directory, stdin shapes, and the
// single JSON object it is allowed to write to stdout. Spawning it with a temp home is the
// only honest way to prove those.
//
// The false-positive cases carry the same weight they carry in the check suites: a hook that
// blocks a correct message is worse than no hook, so "does not block" is the load-bearing
// assertion wherever the message is fine.
//
// Run: node --test plugins/communication-rules/hooks/

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./communication-rules-stop.mjs", import.meta.url));

const body = (n) => "This sentence is ordinary body prose carrying findings and context. ".repeat(n);

// A message that violates R1: plenty of substantive prose BEFORE the marker.
const misordered = `${body(6)}

## Needs you

Approve the deploy before Friday.

${body(2)}`;

// A correct message: the marker leads, body follows.
const wellFormed = `## Needs you

Approve the deploy before Friday.

${body(6)}`;

function mkhome() {
  const home = mkdtempSync(join(tmpdir(), "commrules-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

function runHook(payload, home, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: home,
    COMMUNICATION_RULES_ENFORCE: "",
    COMMUNICATION_RULES_PROFILE: "",
    ...extraEnv,
  };
  return spawnSync(process.execPath, [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
}

const parseOut = (stdout) => {
  assert.ok(stdout.trim(), "expected a JSON object on stdout");
  return JSON.parse(stdout);
};

const readLog = (home, name) => {
  const p = join(home, ".claude", ".communication-rules-state", name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

// ─── chosen silence: the kill switch ─────────────────────────────────────────

test("the kill-switch file silences the hook completely, even on a violating message", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", ".communication-rules-off"), "");
  const r = runHook({ session_id: "s1", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.ok(!existsSync(join(home, ".claude", ".communication-rules-state")), "no state written when killed");
});

test("COMMUNICATION_RULES_ENFORCE=off is the secondary switch and stays silent", () => {
  const home = mkhome();
  const r = runHook({ session_id: "s1", last_assistant_message: misordered }, home, {
    COMMUNICATION_RULES_ENFORCE: "off",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

// ─── fail-open ───────────────────────────────────────────────────────────────

test("malformed stdin exits 0 with no stdout and one errors.log line", () => {
  const home = mkhome();
  const r = runHook("this is not json", home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "errors.log"), /stop payload did not parse/);
});

test("an empty payload is no text, no opinion", () => {
  const home = mkhome();
  const r = runHook({}, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "errors.log"), "");
});

// ─── both stdin shapes ───────────────────────────────────────────────────────

test("last_assistant_message shape: an R1 violation blocks with the house reason format", () => {
  const home = mkhome();
  const r = runHook({ session_id: "s1", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Needs you first/);
  assert.match(out.reason, /\(line \d+\)/); // markerLine is named in the reason
  assert.match(out.reason, /paste the corrected opening lines only/i);
  assert.match(out.reason, /never resend the whole message/i);
});

test("transcript_path shape: the last assistant entry with TEXT is the message", () => {
  const home = mkhome();
  const transcript = join(home, "transcript.jsonl");
  const entries = [
    JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: misordered }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "and now?" } }),
  ];
  writeFileSync(transcript, entries.join("\n") + "\n");
  const r = runHook({ session_id: "s2", transcript_path: transcript }, home);
  assert.equal(r.status, 0);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Needs you first/);
});

test("a transcript that cannot be read is no text, no opinion, no error", () => {
  const home = mkhome();
  const r = runHook({ session_id: "s3", transcript_path: join(home, "nope.jsonl") }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

// ─── the master floor and correct messages ───────────────────────────────────

test("a short misordered message is below the master floor and passes", () => {
  const home = mkhome();
  const r = runHook({ session_id: "s1", last_assistant_message: "Small body.\n\n## Needs you\n\nApprove." }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("a well-formed message does not block", () => {
  const home = mkhome();
  const r = runHook({ session_id: "s1", last_assistant_message: wellFormed }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

// ─── the loop guard ──────────────────────────────────────────────────────────

test("a block is recorded, and the same text with stop_hook_active passes", () => {
  const home = mkhome();
  const first = runHook({ session_id: "lg", last_assistant_message: misordered }, home);
  assert.equal(parseOut(first.stdout).decision, "block");
  const stateDir = join(home, ".claude", ".communication-rules-state");
  assert.ok(existsSync(join(stateDir, "last-blocked-lg.json")));

  const retry = runHook(
    { session_id: "lg", last_assistant_message: misordered, stop_hook_active: true },
    home,
  );
  assert.equal(retry.status, 0);
  assert.equal(retry.stdout, "");
});

test("stop_hook_active with DIFFERENT text blocks again — the guard is per message, not per session", () => {
  const home = mkhome();
  runHook({ session_id: "lg2", last_assistant_message: misordered }, home);
  const retry = runHook(
    { session_id: "lg2", last_assistant_message: `${body(7)}\n\n## Needs you\n\nApprove now.` , stop_hook_active: true },
    home,
  );
  assert.equal(parseOut(retry.stdout).decision, "block");
});

test("stop_hook_active with no prior block is not special — the message is judged", () => {
  const home = mkhome();
  const r = runHook(
    { session_id: "lg3", last_assistant_message: wellFormed, stop_hook_active: true },
    home,
  );
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

// ─── modes from the operator profile ─────────────────────────────────────────

test("a per-rule warn mode logs to warnings.log and does not block", () => {
  const home = mkhome();
  writeFileSync(
    join(home, ".claude", "communication-rules.json"),
    JSON.stringify({ enforcement: { rules: { "needs-you-first": "warn" } } }),
  );
  const r = runHook({ session_id: "w1", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/);
});

test("a global mode of warn downgrades every rule, including the block defaults", () => {
  const home = mkhome();
  writeFileSync(
    join(home, ".claude", "communication-rules.json"),
    JSON.stringify({ enforcement: { mode: "warn" } }),
  );
  const r = runHook({ session_id: "w2", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/);
});

test("mode off disables enforcement without the kill-switch file", () => {
  const home = mkhome();
  writeFileSync(
    join(home, ".claude", "communication-rules.json"),
    JSON.stringify({ enforcement: { mode: "off" } }),
  );
  const r = runHook({ session_id: "o1", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "warnings.log"), "");
});

test("an unparseable profile means defaults (block) plus one errors.log line", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", "communication-rules.json"), "{ not json");
  const r = runHook({ session_id: "b1", last_assistant_message: misordered }, home);
  assert.equal(parseOut(r.stdout).decision, "block"); // defaults still enforce
  assert.match(readLog(home, "errors.log"), /does not parse/);
});

// ─── R2 through the hook ─────────────────────────────────────────────────────

test("two closing-ask markers block with the ending-lines-only reason", () => {
  const home = mkhome();
  const msg = `${body(6)}\n\n## Closing ask\n\nApprove the deploy.\n\n${body(2)}\n\n**Closing ask**\n\nAlso answer the question.`;
  const r = runHook({ session_id: "c1", last_assistant_message: msg }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /One closing ask/);
  assert.match(out.reason, /2 closing-ask markers/);
  assert.match(out.reason, /paste the corrected ending lines only/i);
});

test("prose after the single ask blocks; a clean ask-last message does not", () => {
  const home = mkhome();
  const overtime = `${body(6)}\n\n## Closing ask\n\nApprove the deploy.\n\n${body(2)}`;
  const blocked = runHook({ session_id: "c2", last_assistant_message: overtime }, home);
  assert.equal(parseOut(blocked.stdout).decision, "block");
  assert.match(parseOut(blocked.stdout).reason, /prose follow the closing-ask marker/);

  const home2 = mkhome();
  const clean = `${body(6)}\n\n## Closing ask\n\nApprove the deploy.`;
  const passed = runHook({ session_id: "c3", last_assistant_message: clean }, home2);
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, "");
});

// ─── R5 through the hook: warn by default ───────────────────────────────────

const artifactlessReport =
  "I fixed the login flow today and verified the behavior by hand. " +
  "The session handling was wrong before and now behaves as intended. " +
  `${body(7)}Everything was checked twice and the work is complete for this slice.`;

test("a report naming no artifact warns by default — warnings.log, no block", () => {
  const home = mkhome();
  const r = runHook({ session_id: "n1", last_assistant_message: artifactlessReport }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=name-the-artifact/);
  assert.match(readLog(home, "warnings.log"), /names no file, path, command, or URL/);
});

test("an operator can upgrade name-the-artifact to block per-rule", () => {
  const home = mkhome();
  writeFileSync(
    join(home, ".claude", "communication-rules.json"),
    JSON.stringify({ enforcement: { rules: { "name-the-artifact": "block" } } }),
  );
  const r = runHook({ session_id: "n2", last_assistant_message: artifactlessReport }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Name the artifact/);
});

// ─── R3 through the hook: trigger + judge ────────────────────────────────────

const batchyMessage =
  `${body(6)}\n\n## Questions\n\nIs the cache warm before the second run?\n` +
  `What happens to the timeout when the judge is slow?\nShould the skip be logged?`;

// A fake judge: prints a fixed verdict. Proves the hook dispatches, parses, and respects the
// verdict without paying a model bill.
const fakeJudgePath = (home) => join(home, "fake-judge.mjs");
const writeFakeJudge = (home, verdict, reason) =>
  writeFileSync(
    fakeJudgePath(home),
    `process.stdout.write(JSON.stringify({ violation: ${verdict}, reason: ${JSON.stringify(reason)} }));\n`,
  );

test("a judge verdict of violation blocks with the batch-by-label reason", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "terminal dump of detached questions");
  writeFileSync(
    join(home, ".claude", "communication-rules.json"),
    JSON.stringify({ enforcement: { judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const r = runHook({ session_id: "j1", last_assistant_message: batchyMessage }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Do not batch by label/);
  assert.match(out.reason, /trailing "Questions" section/);
  assert.match(out.reason, /terminal dump of detached questions/);
  assert.match(out.reason, /paste the corrected sections only/i);
});

test("a judge verdict of no violation does not block", () => {
  const home = mkhome();
  writeFakeJudge(home, false, "legitimate terminal summary");
  writeFileSync(
    join(home, ".claude", "communication-rules.json"),
    JSON.stringify({ enforcement: { judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const r = runHook({ session_id: "j2", last_assistant_message: batchyMessage }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("a fired trigger with no judge command lands in skipped.log, named", () => {
  const home = mkhome();
  const r = runHook({ session_id: "j3", last_assistant_message: batchyMessage }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "skipped.log"), /rule=do-not-batch-by-label reason=no-judge-command/);
});

test("a judge rule in warn mode warns instead of blocking", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "terminal dump");
  writeFileSync(
    join(home, ".claude", "communication-rules.json"),
    JSON.stringify({
      enforcement: {
        judgeCommand: `node ${fakeJudgePath(home)}`,
        rules: { "do-not-batch-by-label": "warn" },
      },
    }),
  );
  // Under 400 total prose chars so ONLY R3 fires — R4's floor keeps it out of this test.
  const r3Only = `${body(4)}\n\n## Questions\n\nIs the cache warm?\nWhat about the timeout?\nIs the skip logged?`;
  const r = runHook({ session_id: "j4", last_assistant_message: r3Only }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=do-not-batch-by-label/);
});

test("a failing judge fails open: no block, judge-failures.log carries it", () => {
  const home = mkhome();
  writeFileSync(
    join(home, ".claude", "communication-rules.json"),
    JSON.stringify({ enforcement: { judgeCommand: "printf 'vibes only'" } }),
  );
  const r = runHook({ session_id: "j5", last_assistant_message: batchyMessage }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "judge-failures.log"), /rule=do-not-batch-by-label error=judge-unparseable/);
});

// ─── R4 through the hook ─────────────────────────────────────────────────────

const twoParagraphReport = `${body(7)}\n\n${body(7)}`;

test("conclusion-first dispatches on two paragraphs and blocks on a violating verdict", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "verdict buried under three paragraphs of context");
  writeFileSync(
    join(home, ".claude", "communication-rules.json"),
    JSON.stringify({ enforcement: { judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const r = runHook({ session_id: "k1", last_assistant_message: twoParagraphReport }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Conclusion first/);
  assert.match(out.reason, /verdict buried under three paragraphs of context/);
});

test("a single-paragraph message never reaches the judge — no skip, no bill", () => {
  const home = mkhome();
  const r = runHook({ session_id: "k2", last_assistant_message: body(10) }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "skipped.log"), ""); // trigger never fired: not a skip
});

// ─── R6 through the hook: marker consumed, judge dispatched ─────────────────

test("a resume marker dispatches R6, and the marker is consumed exactly once", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "continues without restating subject or pending work");
  writeFileSync(
    join(home, ".claude", "communication-rules.json"),
    JSON.stringify({ enforcement: { judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const marker = join(home, ".claude", ".communication-rules-state", "resume-r6a");
  mkdirSync(join(home, ".claude", ".communication-rules-state"), { recursive: true });
  writeFileSync(marker, "2026-09-21T00:00:00.000Z\n");

  const first = runHook({ session_id: "r6a", last_assistant_message: body(6) }, home);
  const out = parseOut(first.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Restate the resumed thread/);
  assert.match(out.reason, /without restating subject or pending work/);
  assert.ok(!existsSync(marker), "marker consumed by the first stop");

  const second = runHook({ session_id: "r6a", last_assistant_message: body(6) + " More." }, home);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, ""); // one-shot: the second message is not re-judged for R6
});

test("a consumed marker with no judge command lands in skipped.log", () => {
  const home = mkhome();
  const marker = join(home, ".claude", ".communication-rules-state", "resume-r6b");
  mkdirSync(join(home, ".claude", ".communication-rules-state"), { recursive: true });
  writeFileSync(marker, "2026-09-21T00:00:00.000Z\n");
  const r = runHook({ session_id: "r6b", last_assistant_message: body(6) }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.ok(!existsSync(marker), "marker still consumed — the skip is logged, not deferred");
  assert.match(readLog(home, "skipped.log"), /rule=restate-resumed-thread reason=no-judge-command/);
});

test("no marker means no R6 job at all", () => {
  const home = mkhome();
  const r = runHook({ session_id: "r6c", last_assistant_message: body(6) }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "skipped.log"), "");
});
