// i-have-audhd-stop.test.mjs — node --test
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
// Which rule fired is asserted by rule id — warnings.log's `rule=` field and the `rules` the
// loop guard records in last-blocked-<session>.json — never by the wording of a reason. The one
// exception is the per-section tests at the end: which sections a finding names (`**GUESS** at
// line 7`) is the contract under test there, so that token is asserted.
//
// Run: node --test 'plugins/i-have-audhd/hooks/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OMP_TODO_CALL, OMP_TODO_RESULT } from "../triggers/fixtures/omp-todo-fragment.mjs";
import { conclusionFirstApplicable } from "../triggers/conclusion-first.mjs";
import { badNewsGate } from "../triggers/bad-news-lexicon.mjs";

const HOOK = fileURLToPath(new URL("./i-have-audhd-stop.mjs", import.meta.url));

const body = (n) => "This sentence is ordinary body prose carrying findings and context. ".repeat(n);

// A message that violates needs-you-first: plenty of substantive prose BEFORE the marker.
const misordered = `${body(6)}

## Needs you

Approve the deploy before Friday.

${body(2)}`;

// A correct message: the marker leads, body follows.
const wellFormed = `## Needs you

Approve the deploy before Friday.

${body(6)}`;

function mkhome() {
  const home = mkdtempSync(join(tmpdir(), "audhd-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

function runHook(payload, home, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: home,
    I_HAVE_AUDHD_ENFORCE: "",
    I_HAVE_AUDHD_PROFILE: "",
    I_HAVE_AUDHD_HARNESS: "", // only the OMP adapter sets it; tests opt in per call
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
  const p = join(home, ".claude", ".i-have-audhd-state", name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

const logLines = (home, name) => readLog(home, name).split("\n").filter(Boolean);

// The rule ids the hook recorded for its block (skill reference: last-blocked-<session>.json
// carries the loop guard's hash and rules).
const blockedRules = (home, sid) =>
  JSON.parse(readFileSync(join(home, ".claude", ".i-have-audhd-state", `last-blocked-${sid}.json`), "utf8")).rules.split(",");

// The measured default is warn for every rule (lib/config.mjs, 2026-09-21 corpus pass), so
// every teeth-path test arms block explicitly — the assertions below test the TEETH, and the
// teeth are config-gated by design. The one default-behavior test asserts warn.
const blockProfile = (home, extra = {}) =>
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { mode: "block", ...extra } }),
  );

// ─── chosen silence: the kill switch ─────────────────────────────────────────

test("the kill-switch file silences the hook completely, even on a violating message", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", ".i-have-audhd-off"), "");
  const r = runHook({ session_id: "s1", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.ok(!existsSync(join(home, ".claude", ".i-have-audhd-state")), "no state written when killed");
});

test("I_HAVE_AUDHD_ENFORCE=off is the secondary switch and stays silent", () => {
  const home = mkhome();
  const r = runHook({ session_id: "s1", last_assistant_message: misordered }, home, {
    I_HAVE_AUDHD_ENFORCE: "off",
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
  assert.equal(logLines(home, "errors.log").length, 1);
});

test("an empty payload is no text, no opinion", () => {
  const home = mkhome();
  const r = runHook({}, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "errors.log"), "");
});

// ─── both stdin shapes ───────────────────────────────────────────────────────

test("last_assistant_message shape: a needs-you-first violation blocks", () => {
  const home = mkhome();
  blockProfile(home);
  const r = runHook({ session_id: "s1", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(home, "s1").includes("needs-you-first"));
});

test("transcript_path shape: the last assistant entry with TEXT is the message", () => {
  const home = mkhome();
  blockProfile(home);
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
  blockProfile(home);
  const first = runHook({ session_id: "lg", last_assistant_message: misordered }, home);
  assert.equal(parseOut(first.stdout).decision, "block");
  const stateDir = join(home, ".claude", ".i-have-audhd-state");
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
  blockProfile(home);
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

test("a per-rule warn overrides an armed global block — the teeth stay per-rule", () => {
  const home = mkhome();
  blockProfile(home, { rules: { "needs-you-first": "warn" } });
  const r = runHook({ session_id: "w1", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/);
});

test("an explicit global mode of warn logs to warnings.log and does not block", () => {
  const home = mkhome();
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { mode: "warn" } }),
  );
  const r = runHook({ session_id: "w2", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/);
});

test("the MEASURED default is warn: no profile, no block, the finding lands in warnings.log", () => {
  const home = mkhome(); // deliberately no profile — defaults apply
  const r = runHook({ session_id: "d1", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "", "warn default never blocks");
  assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/);
});

test("mode off disables enforcement without the kill-switch file", () => {
  const home = mkhome();
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { mode: "off" } }),
  );
  const r = runHook({ session_id: "o1", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "warnings.log"), "");
});

test("an unparseable profile means the measured defaults (warn) plus one errors.log line", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", "i-have-audhd.json"), "{ not json");
  const r = runHook({ session_id: "b1", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, ""); // defaults are warn since the corpus measurement
  assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/);
  assert.equal(logLines(home, "errors.log").length, 1);
});

// ─── closing-ask-last through the hook ─────────────────────────────────────────────────────

test("two closing-ask markers block", () => {
  const home = mkhome();
  blockProfile(home);
  const msg = `${body(6)}\n\n## Closing ask\n\nApprove the deploy.\n\n${body(2)}\n\n**Closing ask**\n\nAlso answer the question.`;
  const r = runHook({ session_id: "c1", last_assistant_message: msg }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(home, "c1").includes("closing-ask-last"));
});

test("prose after the single ask blocks; a clean ask-last message does not", () => {
  const home = mkhome();
  blockProfile(home);
  const overtime = `${body(6)}\n\n## Closing ask\n\nApprove the deploy.\n\n${body(2)}`;
  const blocked = runHook({ session_id: "c2", last_assistant_message: overtime }, home);
  assert.equal(parseOut(blocked.stdout).decision, "block");
  assert.ok(blockedRules(home, "c2").includes("closing-ask-last"));

  const home2 = mkhome();
  const clean = `${body(6)}\n\n## Closing ask\n\nApprove the deploy.`;
  const passed = runHook({ session_id: "c3", last_assistant_message: clean }, home2);
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, "");
});

// ─── plural back-reference through the hook: warn by default ────────────────

test("a closing ask leaning on 'those' warns by default; named files do not", () => {
  const home = mkhome();
  const vague = `${body(6)}\n\n## Closing ask\n\nShould I merge those?`;
  const r = runHook({ session_id: "p1", last_assistant_message: vague }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=plural-back-reference/);

  const home2 = mkhome();
  const named = `${body(6)}\n\n## Closing ask\n\nShould I merge both \`foo.ts\` and \`bar.ts\`?`;
  const r2 = runHook({ session_id: "p2", last_assistant_message: named }, home2);
  assert.equal(r2.stdout, "");
  assert.doesNotMatch(readLog(home2, "warnings.log"), /rule=plural-back-reference/);
});

// ─── name-the-artifact through the hook: warn by default ───────────────────────────────────

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
});

test("an operator can upgrade name-the-artifact to block per-rule", () => {
  const home = mkhome();
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { rules: { "name-the-artifact": "block" } } }),
  );
  const r = runHook({ session_id: "n2", last_assistant_message: artifactlessReport }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(home, "n2").includes("name-the-artifact"));
});

// ─── do-not-batch-by-label through the hook: trigger + judge ────────────────────────────────────

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

test("a judge verdict of violation on a trailing labeled section blocks do-not-batch-by-label", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "terminal dump of detached questions");
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { mode: "block", judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const r = runHook({ session_id: "j1", last_assistant_message: batchyMessage }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(home, "j1").includes("do-not-batch-by-label"));
});

test("a judge verdict of no violation does not block", () => {
  const home = mkhome();
  writeFakeJudge(home, false, "legitimate terminal summary");
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
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
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({
      enforcement: {
        judgeCommand: `node ${fakeJudgePath(home)}`,
        rules: { "do-not-batch-by-label": "warn" },
      },
    }),
  );
  // Under 400 total prose chars so ONLY do-not-batch-by-label fires — conclusion-first's floor keeps it out of this test.
  const r3Only = `${body(4)}\n\n## Questions\n\nIs the cache warm?\nWhat about the timeout?\nIs the skip logged?`;
  const r = runHook({ session_id: "j4", last_assistant_message: r3Only }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=do-not-batch-by-label/);
});

// ─── a judge that cannot answer: "judge unavailable", never a pass ───────────────────────

// A judge that fails with a reason on stderr, the shape of a logged-out judge CLI.
const failingJudge = (home, extra = {}) =>
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({
      enforcement: { judgeCommand: "echo 'judge-cli: not logged in' >&2; exit 4", ...extra },
    }),
  );

// The rule's warnings.log lines that report the judge as unavailable.
const unavailableLines = (home, rule) =>
  logLines(home, "warnings.log").filter((l) => l.includes(` rule=${rule} `) && /judge unavailable/i.test(l));

const alertsPath = (home) => join(home, ".claude", ".i-have-audhd-state", "alerts.json");

test("a failing judge is reported as judge unavailable, never as a pass: a warn finding, stderr in the log, one loud line", () => {
  const home = mkhome();
  failingJudge(home);
  const r = runHook({ session_id: "j5", last_assistant_message: batchyMessage }, home);
  assert.equal(r.status, 0);
  assert.match(readLog(home, "judge-failures.log"), /rule=do-not-batch-by-label error=judge-exit-4 stderr=.*not logged in/);
  assert.equal(unavailableLines(home, "do-not-batch-by-label").length, 1, "the unchecked rule is a finding, not silence");
  const pending = JSON.parse(readFileSync(join(home, ".claude", ".i-have-audhd-state", "pending-warn-j5.json"), "utf8"));
  assert.match(pending.notice, /judge unavailable/i, "the agent is told the rule was not checked");
  const out = parseOut(r.stdout);
  assert.equal(out.decision, undefined, "warn by default: no block");
  assert.match(out.systemMessage, /judge unavailable/i, "the person is told, loudly");
  assert.match(out.systemMessage, /do-not-batch-by-label/);
  assert.match(out.systemMessage, /judge-exit-4/);
  assert.match(out.systemMessage, /setup\.mjs/, "the next step is named");
});

test("judge unavailable is loud once per key: a second failure within the hour logs and warns, but says nothing to the person", () => {
  const home = mkhome();
  failingJudge(home);
  const first = runHook({ session_id: "j5b", last_assistant_message: batchyMessage }, home);
  assert.match(parseOut(first.stdout).systemMessage, /judge unavailable/i);
  const second = runHook({ session_id: "j5b", last_assistant_message: `${batchyMessage}\nIs the cache cold?` }, home);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, "", "same key inside the hour: no second systemMessage");
  assert.equal(unavailableLines(home, "do-not-batch-by-label").length, 2, "every failure is still a finding");
  assert.equal(logLines(home, "judge-failures.log").filter((l) => l.includes("rule=do-not-batch-by-label")).length, 2);
});

test("judge unavailable re-alerts once the hour is up, naming when it started", () => {
  const home = mkhome();
  failingJudge(home);
  runHook({ session_id: "j5c", last_assistant_message: batchyMessage }, home);
  const alerts = JSON.parse(readFileSync(alertsPath(home), "utf8"));
  const keys = Object.keys(alerts);
  assert.ok(keys.length > 0, "the alert is recorded");
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
  for (const k of keys) alerts[k] = { first: twoHoursAgo, last: twoHoursAgo };
  writeFileSync(alertsPath(home), JSON.stringify(alerts));
  const again = runHook({ session_id: "j5c", last_assistant_message: `${batchyMessage}\nIs the cache cold?` }, home);
  const msg = parseOut(again.stdout).systemMessage;
  assert.match(msg, /judge unavailable/i);
  assert.ok(msg.includes(`still failing since ${twoHoursAgo}`), msg);
});

test("a judge that answers again clears the alert, so the next failure is loud at once", () => {
  const home = mkhome();
  failingJudge(home);
  assert.match(parseOut(runHook({ session_id: "j5d", last_assistant_message: batchyMessage }, home).stdout).systemMessage, /judge unavailable/i);
  writeFakeJudge(home, false, "legitimate terminal summary");
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const healthy = runHook({ session_id: "j5d", last_assistant_message: `${batchyMessage}\nIs it warm now?` }, home);
  assert.equal(healthy.stdout, "");
  failingJudge(home);
  const broken = runHook({ session_id: "j5d", last_assistant_message: `${batchyMessage}\nAnd now?` }, home);
  assert.match(parseOut(broken.stdout).systemMessage, /judge unavailable/i, "a re-break after recovery alerts at once");
});

test("judge unavailable follows the rule's mode: block mode blocks, naming the unchecked rule", () => {
  const home = mkhome();
  failingJudge(home, { rules: { "do-not-batch-by-label": "block" } });
  const r = runHook({ session_id: "j5e", last_assistant_message: batchyMessage }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /judge unavailable/i);
  assert.ok(blockedRules(home, "j5e").includes("do-not-batch-by-label"));
});

test("judge unavailable blocks at most once per continuation chain: a revision after a block only warns", () => {
  const home = mkhome();
  failingJudge(home, { rules: { "do-not-batch-by-label": "block" } });
  runHook({ session_id: "j5f", last_assistant_message: batchyMessage }, home);
  const revised = runHook(
    { session_id: "j5f", stop_hook_active: true, last_assistant_message: `${batchyMessage}\nRevised.` },
    home,
  );
  assert.equal(revised.status, 0);
  assert.notEqual(revised.stdout.trim() && JSON.parse(revised.stdout).decision, "block", "nothing in the message can fix a dead judge");
  assert.equal(unavailableLines(home, "do-not-batch-by-label").length, 1, "the revision's unchecked rule still warns");
});

// ─── conclusion-first through the hook ─────────────────────────────────────────────────────

const twoParagraphReport = `${body(7)}\n\n${body(7)}`;

test("conclusion-first dispatches on two paragraphs and blocks on a violating verdict", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "verdict buried under three paragraphs of context");
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { mode: "block", judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const r = runHook({ session_id: "k1", last_assistant_message: twoParagraphReport }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(home, "k1").includes("conclusion-first"));
});

test("a single long paragraph reaches the conclusion-first judge: its point can sit past word 20", () => {
  const home = mkhome();
  const r = runHook({ session_id: "k2", last_assistant_message: body(10) }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "skipped.log"), /rule=conclusion-first reason=no-judge-command/);
});

test("a message under the 400-char floor never reaches the conclusion-first judge — no skip, no bill", () => {
  const home = mkhome();
  const r = runHook({ session_id: "k3", last_assistant_message: body(4) }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "skipped.log"), ""); // trigger never fired: not a skip
});

// ─── restate-resumed-thread through the hook: marker consumed, judge dispatched ─────────────────

test("a resume marker dispatches restate-resumed-thread, and the marker is consumed exactly once", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "continues without restating subject or pending work");
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { mode: "block", judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const marker = join(home, ".claude", ".i-have-audhd-state", "resume-r6a");
  mkdirSync(join(home, ".claude", ".i-have-audhd-state"), { recursive: true });
  writeFileSync(marker, "2026-09-21T00:00:00.000Z\n");

  // body(5): under conclusion-first's 400-char floor, so restate-resumed-thread is the only judge rule in play.
  const first = runHook({ session_id: "r6a", last_assistant_message: body(5) }, home);
  const out = parseOut(first.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(home, "r6a").includes("restate-resumed-thread"));
  assert.ok(!existsSync(marker), "marker consumed by the first stop");

  const second = runHook({ session_id: "r6a", last_assistant_message: body(5) + " More." }, home);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, ""); // one-shot: the second message is not re-judged for restate-resumed-thread
});

test("a consumed marker with no judge command lands in skipped.log", () => {
  const home = mkhome();
  const marker = join(home, ".claude", ".i-have-audhd-state", "resume-r6b");
  mkdirSync(join(home, ".claude", ".i-have-audhd-state"), { recursive: true });
  writeFileSync(marker, "2026-09-21T00:00:00.000Z\n");
  const r = runHook({ session_id: "r6b", last_assistant_message: body(6) }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.ok(!existsSync(marker), "marker still consumed — the skip is logged, not deferred");
  assert.match(readLog(home, "skipped.log"), /rule=restate-resumed-thread reason=no-judge-command/);
});

test("no marker means no restate-resumed-thread job at all", () => {
  const home = mkhome();
  const r = runHook({ session_id: "r6c", last_assistant_message: body(5) }, home); // under conclusion-first's floor
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "skipped.log"), "");
});

// ─── report-what-you-did-not-do through the hook: todo trigger + judge ───────────────────────────────

const todoTranscript = (home, todos) => {
  const p = join(home, "transcript.jsonl");
  writeFileSync(
    p,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos } }],
        },
      }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: body(6) }] } }),
    ].join("\n") + "\n",
  );
  return p;
};

test("unfinished todos at the last write dispatch report-what-you-did-not-do and block on a violating verdict", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "neither item's status is reported");
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { mode: "block", judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const tp = todoTranscript(home, [
    { content: "wire the hook", status: "completed" },
    { content: "update the docs", status: "in_progress" },
  ]);
  const r = runHook({ session_id: "t1", transcript_path: tp }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(home, "t1").includes("report-what-you-did-not-do"));
});

test("a real OMP todo call + result in the session file dispatches report-what-you-did-not-do and blocks", () => {
  const home = mkhome();
  // A judge that records the prompt it was given, so the test sees what the trigger handed it.
  const prompts = join(home, "judge-prompts.log");
  writeFileSync(
    fakeJudgePath(home),
    `import { appendFileSync } from "node:fs";\n` +
      `let s = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (d) => (s += d));\n` +
      `process.stdin.on("end", () => {\n  appendFileSync(${JSON.stringify(prompts)}, s + "\\n");\n` +
      `  process.stdout.write(JSON.stringify({ violation: true, reason: "the open items go unreported" }));\n});\n`,
  );
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    // armOmp: under the omp tag an unarmed profile caps every block to a warn (harness cap).
    JSON.stringify({ enforcement: { mode: "block", armOmp: true, judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const finalText = body(6);
  const tp = join(home, "session.jsonl");
  writeFileSync(
    tp,
    [
      OMP_TODO_CALL,
      OMP_TODO_RESULT,
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: finalText }] } }),
    ].join("\n") + "\n",
  );
  // The OMP adapter's payload: transcript_path is the session file, the text rides along.
  const r = runHook(
    { session_id: "t1omp", transcript_path: tp, stop_hook_active: false, last_assistant_message: finalText },
    home,
    { I_HAVE_AUDHD_HARNESS: "omp" },
  );
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(home, "t1omp").includes("report-what-you-did-not-do"));
  const seen = readFileSync(prompts, "utf8");
  assert.ok(seen.includes("- [in_progress] (Persistence) Persist context-only unfinished work"));
  assert.ok(seen.includes("- [pending] (Wrap-up) Run and verify wrap-up artifact"));
});

test("no todo data (OMP last_assistant_message shape) is not applicable and not a skip", () => {
  const home = mkhome();
  const r = runHook({ session_id: "t2", last_assistant_message: body(5) }, home); // under conclusion-first's floor
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "skipped.log"), ""); // nothing fired: the boundary is silence
});

test("all-completed todos do not dispatch report-what-you-did-not-do even with a judge configured", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "should not be asked");
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const tp = todoTranscript(home, [{ content: "wire the hook", status: "completed" }]);
  const r = runHook({ session_id: "t3", transcript_path: tp }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

// ─── bad-news-first through the hook: lexicon gate + judge ───────────────────────────────

const badNewsMessage = `${body(5)}The migration failed last night and the index is now missing three rows, ` +
  `which nobody has noticed yet but will tomorrow.`;

test("bad news below the fold dispatches bad-news-first and blocks on a violating verdict", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "the failure arrives after five sentences of context");
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { mode: "block", judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const r = runHook({ session_id: "b1", last_assistant_message: badNewsMessage }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(home, "b1").includes("bad-news-first"));
  assert.match(out.reason, /bad news into the opening 20 words/);
  assert.doesNotMatch(out.reason, /first (substantive )?sentence/);
});

test("a clean message with no lexicon word never dispatches bad-news-first", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "should not be asked");
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { judgeCommand: `node ${fakeJudgePath(home)}` } }),
  );
  const r = runHook({ session_id: "b2", last_assistant_message: body(6) }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

// ─── the OMP harness cap (I_HAVE_AUDHD_HARNESS=omp) ───────────────────────────

const OMP = { I_HAVE_AUDHD_HARNESS: "omp" };
const revised = `${body(7)}\n\n## Needs you\n\nApprove now.`; // a DIFFERENT text that still violates needs-you-first

test("omp tag, profile blocks, OMP not armed → warn with the real rule id, no block, no hash", () => {
  const home = mkhome();
  blockProfile(home);
  const r = runHook({ session_id: "o1", last_assistant_message: misordered }, home, OMP);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "", "unarmed OMP never blocks");
  assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/);
  assert.ok(!existsSync(join(home, ".claude", ".i-have-audhd-state", "last-blocked-o1.json")));
});

test("omp tag, unarmed: a judge-gated block is capped to warn too", () => {
  const home = mkhome();
  writeFakeJudge(home, true, "the failure arrives after five sentences of context");
  blockProfile(home, { judgeCommand: `node ${fakeJudgePath(home)}` });
  const r = runHook({ session_id: "o2", last_assistant_message: badNewsMessage }, home, OMP);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=bad-news-first/);
});

test("omp tag, armed, first stop → block, and the hash is recorded", () => {
  const home = mkhome();
  blockProfile(home, { armOmp: true });
  const r = runHook({ session_id: "o3", last_assistant_message: misordered }, home, OMP);
  assert.equal(parseOut(r.stdout).decision, "block");
  assert.ok(existsSync(join(home, ".claude", ".i-have-audhd-state", "last-blocked-o3.json")));
});

test("omp tag, armed, stop_hook_active with a changed violating text → warn, never a second block", () => {
  const home = mkhome();
  blockProfile(home, { armOmp: true });
  runHook({ session_id: "o4", last_assistant_message: misordered }, home, OMP);
  const retry = runHook({ session_id: "o4", last_assistant_message: revised, stop_hook_active: true }, home, OMP);
  assert.equal(retry.status, 0);
  assert.equal(retry.stdout, "", "a revision is re-checked but cannot be blocked");
  assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/, "the re-check ran and logged its finding");
});

test("omp tag, armed, stop_hook_active with identical text → passes before any check", () => {
  const home = mkhome();
  blockProfile(home, { armOmp: true });
  runHook({ session_id: "o5", last_assistant_message: misordered }, home, OMP);
  const retry = runHook({ session_id: "o5", last_assistant_message: misordered, stop_hook_active: true }, home, OMP);
  assert.equal(retry.stdout, "");
  assert.equal(readLog(home, "warnings.log"), "", "the hash guard returned before the checks ran");
});

test("armOmp of the wrong type is one errors.log line and reads as false", () => {
  const home = mkhome();
  blockProfile(home, { armOmp: "yes" });
  const r = runHook({ session_id: "o6", last_assistant_message: misordered }, home, OMP);
  assert.equal(r.stdout, "", "a non-boolean does not arm OMP");
  assert.equal(logLines(home, "errors.log").length, 1);
  assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/);
});

test("untagged (Claude Code): a malformed armOmp changes nothing — same stdout, no errors.log line", () => {
  const plain = mkhome();
  blockProfile(plain);
  const malformed = mkhome();
  blockProfile(malformed, { armOmp: "yes" });
  const a = runHook({ session_id: "u1", last_assistant_message: misordered }, plain);
  const b = runHook({ session_id: "u1", last_assistant_message: misordered }, malformed);
  assert.equal(parseOut(b.stdout).decision, "block", "the Claude path still blocks");
  assert.equal(b.stdout, a.stdout);
  assert.equal(readLog(malformed, "errors.log"), "", "the field is never read without the omp tag");
});

// ─── conclusion-first and bad-news-first per labeled section ─────────────────

// A content-sensitive fake judge: it records every prompt it is given (rule, question, and the
// judged message between <<<MSG and MSG) to judged.jsonl, exits 2 when the judged message holds
// FAIL_MARK, and answers violation=true only when it holds VIOLATE_MARK. So one hook run can get
// opposite verdicts per section, and the test can read exactly what each judge call saw.
const VIOLATE_MARK = "zq-violate-mark";
const FAIL_MARK = "zq-error-mark";
const markerJudgePath = (home) => join(home, "marker-judge.mjs");
const judgedLogPath = (home) => join(home, "judged.jsonl");
const writeMarkerJudge = (home) =>
  writeFileSync(
    markerJudgePath(home),
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      'const prompt = readFileSync(0, "utf8");',
      'const rule = (/^Rule: (.*)$/m.exec(prompt) ?? [])[1] ?? "";',
      'const question = (/^Question: (.*)$/m.exec(prompt) ?? [])[1] ?? "";',
      'const open = prompt.indexOf("<<<MSG\\n") + "<<<MSG\\n".length;',
      'const message = prompt.slice(open, prompt.lastIndexOf("\\nMSG"));',
      `appendFileSync(${JSON.stringify(judgedLogPath(home))}, JSON.stringify({ rule, question, message }) + "\\n");`,
      `if (message.includes(${JSON.stringify(FAIL_MARK)})) process.exit(2);`,
      `const violation = message.includes(${JSON.stringify(VIOLATE_MARK)});`,
      'process.stdout.write(JSON.stringify({ violation, reason: violation ? "marked section" : "clean section" }));',
      "",
    ].join("\n"),
  );

// Every prompt the marker judge saw for `rule`, in the order they were recorded.
const judged = (home, rule) =>
  (existsSync(judgedLogPath(home)) ? readFileSync(judgedLogPath(home), "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((j) => j.rule === rule);

// Marker judge configured; `mode: "block"` unless `extra` says otherwise.
const markerProfile = (home, extra = {}) => {
  writeMarkerJudge(home);
  blockProfile(home, { judgeCommand: `node ${markerJudgePath(home)}`, ...extra });
};

const section = (label, prose) => `**${label}**\n${prose}`;
const labeledMessage = (...sections) => sections.join("\n\n");
const lineOf = (msg, labelLine) => msg.split("\n").indexOf(labelLine) + 1;

// The conclusion-first finding in a block reason (one finding per rule, findings joined by blank lines).
const conclusionFinding = (reason) => reason.split("\n\n").filter((f) => f.startsWith("Conclusion first ("));

test("sections each under the floor dispatch no conclusion-first job, even when the whole message passes", () => {
  const home = mkhome();
  markerProfile(home);
  const msg = labeledMessage(section("CLAIM", body(4)), section("GUESS", body(4)), section("CITE", body(4)));
  assert.equal(conclusionFirstApplicable(msg).applicable, true, "precondition: the whole text passes the gate");
  const r = runHook({ session_id: "s1", last_assistant_message: msg }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.deepEqual(judged(home, "conclusion-first"), []);
  assert.equal(readLog(home, "warnings.log"), "");
});

test("one long section among short ones: one conclusion-first job, judging that section's prose alone", () => {
  const home = mkhome();
  markerProfile(home);
  const msg = labeledMessage(section("CLAIM", body(2)), section("GUESS", body(7)), section("CITE", body(2)));
  runHook({ session_id: "s2", last_assistant_message: msg }, home);
  const jobs = judged(home, "conclusion-first");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].message, body(7), "the judged message is the section's prose: no label line, no other section");
});

test("opposite verdicts per section: the finding names only the violating section's label and line", () => {
  const home = mkhome();
  markerProfile(home);
  const msg = labeledMessage(section("CLAIM", body(7)), section("GUESS", `${body(7)}${VIOLATE_MARK}`));
  const r = runHook({ session_id: "s3", last_assistant_message: msg }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.equal(judged(home, "conclusion-first").length, 2);
  const [finding, ...more] = conclusionFinding(out.reason);
  assert.equal(more.length, 0, "one finding per rule");
  assert.ok(finding.includes(`**GUESS** at line ${lineOf(msg, "**GUESS**")}`), finding);
  assert.ok(!finding.includes("**CLAIM**"), finding);
});

test("two violating sections: one finding naming both labels and lines, in line order", () => {
  const home = mkhome();
  markerProfile(home);
  const msg = labeledMessage(
    section("CLAIM", `${body(7)}${VIOLATE_MARK}`),
    section("CITE", body(2)),
    section("GUESS(inference)", `${body(7)}${VIOLATE_MARK}`),
  );
  const r = runHook({ session_id: "s4", last_assistant_message: msg }, home);
  const out = parseOut(r.stdout);
  const [finding, ...more] = conclusionFinding(out.reason);
  assert.equal(more.length, 0, "one finding per rule");
  const claim = finding.indexOf(`**CLAIM** at line ${lineOf(msg, "**CLAIM**")}`);
  const guess = finding.indexOf(`**GUESS(inference)** at line ${lineOf(msg, "**GUESS(inference)**")}`);
  assert.ok(claim > -1 && guess > -1, finding);
  assert.ok(claim < guess, "sections are named in line order");
  assert.ok(!finding.includes("**CITE**"), finding);
  assert.deepEqual(blockedRules(home, "s4"), ["conclusion-first"]);
});

test("a judge error on one section reports that section as judge unavailable: the other's violation still counts", () => {
  const msg = labeledMessage(section("CLAIM", `${body(7)}${FAIL_MARK}`), section("GUESS", `${body(7)}${VIOLATE_MARK}`));
  const guessName = `**GUESS** at line ${lineOf(msg, "**GUESS**")}`;
  const claimName = `**CLAIM** at line ${lineOf(msg, "**CLAIM**")}`;

  // block mode
  const blocking = mkhome();
  markerProfile(blocking);
  const r = runHook({ session_id: "s5", last_assistant_message: msg }, blocking);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(blocking, "s5").includes("conclusion-first"));
  assert.ok(conclusionFinding(out.reason)[0].includes(guessName));
  assert.ok(!conclusionFinding(out.reason)[0].includes(claimName), "the violation names only the judged section");
  const unavailable = out.reason.split("\n\n").filter((f) => f.startsWith("Judge unavailable (conclusion-first)"));
  assert.equal(unavailable.length, 1);
  assert.ok(unavailable[0].includes(claimName), "the unjudged section is named as unchecked, not passed");
  assert.match(readLog(blocking, "judge-failures.log"), /rule=conclusion-first error=judge-exit-2/);

  // warn mode
  const warning = mkhome();
  markerProfile(warning, { mode: "warn" });
  const w = runHook({ session_id: "s6", last_assistant_message: msg }, warning);
  const wout = parseOut(w.stdout);
  assert.equal(wout.decision, undefined, "warn mode: no block");
  assert.match(wout.systemMessage, /judge unavailable/i);
  const warned = logLines(warning, "warnings.log").filter((l) => l.includes(" rule=conclusion-first "));
  assert.equal(warned.length, 2, "one violation finding, one judge-unavailable finding");
  assert.ok(warned.some((l) => l.includes(guessName) && !/judge unavailable/i.test(l)), warned.join("\n"));
  assert.ok(warned.some((l) => l.includes(claimName) && /judge unavailable/i.test(l)), warned.join("\n"));
  assert.match(readLog(warning, "judge-failures.log"), /rule=conclusion-first error=judge-exit-2/);
});

test("bad news leading a later section is judged in that section alone; a short section with a lexicon word dispatches nothing", () => {
  const home = mkhome();
  markerProfile(home);
  const news = `The migration failed last night and the index is missing three rows. ${body(3)}`;
  const msg = labeledMessage(section("CLAIM", body(4)), section("GUESS", news));
  runHook({ session_id: "s7", last_assistant_message: msg }, home);
  const jobs = judged(home, "bad-news-first");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].message, news);

  const quiet = mkhome();
  markerProfile(quiet);
  const short = labeledMessage(section("CLAIM", body(4)), section("CITE", "The deploy failed."));
  assert.equal(badNewsGate(short).applicable, true, "precondition: the whole text passes the gate");
  runHook({ session_id: "s8", last_assistant_message: short }, quiet);
  assert.deepEqual(judged(quiet, "bad-news-first"), []);
});

test("omp tag, unarmed: a per-section block is capped to warn", () => {
  const home = mkhome();
  markerProfile(home);
  const msg = labeledMessage(section("CLAIM", body(7)), section("GUESS", `${body(7)}${VIOLATE_MARK}`));
  const r = runHook({ session_id: "s9", last_assistant_message: msg }, home, OMP);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=conclusion-first .*\*\*GUESS\*\* at line/);
});

test("an unlabeled message keeps one whole-message job, with its opening window and no section framing", () => {
  const home = mkhome();
  markerProfile(home);
  runHook({ session_id: "s10", last_assistant_message: twoParagraphReport }, home);
  const jobs = judged(home, "conclusion-first");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].message, twoParagraphReport);
  assert.ok(!jobs[0].question.includes("labeled section"), jobs[0].question);
  assert.ok(jobs[0].question.includes(`The reader's first 20 words here are: "${body(3).split(" ").slice(0, 20).join(" ")}".`));
});

test("the judge is shown the section's first 20 words: bad news at words 25-30 of a long first sentence is outside them", () => {
  const home = mkhome();
  markerProfile(home);
  const sentence =
    "After the long weekend of careful planning and three rounds of review with the platform team and " +
    "the database owners we finally tried it and the migration failed on step four, leaving the index short.";
  const msg = labeledMessage(section("CLAIM", body(4)), section("GUESS", `${sentence} ${body(3)}`));
  runHook({ session_id: "s11", last_assistant_message: msg }, home);
  const [job, ...more] = judged(home, "bad-news-first");
  assert.equal(more.length, 0);
  const window =
    "After the long weekend of careful planning and three rounds of review with the platform team and the database owners";
  assert.ok(job.question.includes(`The reader's first 20 words here are: "${window}".`), job.question);
  assert.ok(!window.includes("failed"));
  assert.ok(job.question.includes(`one labeled section (**GUESS**, line ${lineOf(msg, "**GUESS**")})`), job.question);
  assert.ok(!job.message.includes("**GUESS**"), "the framing rides in the question, not the judged message");
});
