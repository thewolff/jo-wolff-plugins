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
// exception is the per-section tests at the end: which sections a finding names (`**CITE** at
// line 7`) is the contract under test there, so that token is asserted.
//
// Run: node --test 'plugins/i-have-audhd/hooks/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OMP_TODO_CALL, OMP_TODO_RESULT } from "../triggers/fixtures/omp-todo-fragment.mjs";
import { conclusionFirstApplicable } from "../triggers/conclusion-first.mjs";
import { badNewsGate } from "../triggers/bad-news-lexicon.mjs";
import { RULE_IDS } from "../lib/rules.mjs";

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
    timeout: 5_000,
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

test("malformed stdin exits 0, blocks nothing, and leaves one errors.log line and one warning line", () => {
  const home = mkhome();
  const r = runHook("this is not json", home);
  assert.equal(r.status, 0);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /^i-have-audhd hooks\/i-have-audhd-stop\.mjs failed open .*did not parse/);
  assert.ok(!out.systemMessage.includes("\n"), "one warning line");
  assert.equal(logLines(home, "errors.log").length, 1);
  assert.match(readLog(home, "errors.log"), /hooks\/i-have-audhd-stop\.mjs stop payload did not parse/);
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
  const out = parseOut(r.stdout); // defaults are warn since the corpus measurement: no block
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /lib\/config\.mjs enforcement: profile at .* does not parse/);
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
  assert.match(readLog(home, "skipped.log"), new RegExp(`rule=do-not-batch-by-label reason=no-judge-command profile=${join(home, ".claude", "i-have-audhd.json")} session=`));
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
  assert.match(readLog(home, "judge-failures.log"), /rule=do-not-batch-by-label error=judge-exit-4 cause=no-credential session=j5 harness=claude-code .* stderr=.*not logged in/);
  assert.equal(unavailableLines(home, "do-not-batch-by-label").length, 1, "the unchecked rule is a finding, not silence");
  const pending = JSON.parse(readFileSync(join(home, ".claude", ".i-have-audhd-state", "pending-warn-j5.json"), "utf8"));
  assert.match(pending.notice, /judge unavailable/i, "the agent is told the rule was not checked");
  const out = parseOut(r.stdout);
  assert.equal(out.decision, undefined, "warn by default: no block");
  assert.match(out.systemMessage, /judge unavailable/i, "the person is told, loudly");
  assert.match(out.systemMessage, /do-not-batch-by-label: no-credential — no credential for unknown in the judge's profile/, "cause and fix");
  assert.match(out.systemMessage, /setup\.mjs/, "the next step is named");
  assert.equal(Object.keys(JSON.parse(readFileSync(alertsPath(home), "utf8")))[0], "judge-unavailable:do-not-batch-by-label:no-credential", "keyed by rule and cause");
});

test("the alert states each cause's own fix: the model for a revoked credential, the budget for a deadline", () => {
  const revoked = mkhome();
  writeProfile(revoked, {
    enforcement: { judgeCommand: "echo 'model-judge: error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth access token has been revoked.\"}}' >&2; exit 1 # anthropic/claude-haiku-5-5" },
  });
  const r1 = parseOut(runHook({ session_id: "j5e", last_assistant_message: batchyMessage }, revoked).stdout);
  assert.match(r1.systemMessage, /do-not-batch-by-label: credential-revoked — the credential for anthropic\/claude-haiku-5-5 was revoked; log the judge's CLI in again/);
  assert.match(readLog(revoked, "judge-failures.log"), /cause=credential-revoked session=j5e harness=claude-code model=anthropic\/claude-haiku-5-5 elapsedMs=\d+ budgetMs=30000 section=whole cache=[0-9a-f]{64} prompt=\S+cache\/[0-9a-f]{64}\.prompt\.txt stderr=/);
  const vibes = mkhome();
  writeProfile(vibes, { enforcement: { judgeCommand: "echo 'I have no thoughts, only vibes.' # --model haiku" } });
  const r2 = parseOut(runHook({ session_id: "j5f", last_assistant_message: batchyMessage }, vibes, { I_HAVE_AUDHD_HARNESS: "omp" }).stdout);
  assert.match(r2.systemMessage, /do-not-batch-by-label: bad-json — the judge printed no \{"violation": …, "reason": …\} object; run the command by hand on the prompt file/);
  assert.match(readLog(vibes, "judge-failures.log"), /error=judge-unparseable cause=bad-json session=j5f harness=omp model=haiku elapsedMs=\d+ budgetMs=20000 section=whole .* stdout="I have no thoughts, only vibes\."/);
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
  assert.equal(parseOut(r.stdout).decision, undefined, "a non-boolean does not arm OMP");
  assert.match(parseOut(r.stdout).systemMessage, /lib\/config\.mjs enforcement: armOmp "yes" is not a boolean/);
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
  const msg = labeledMessage(section("CLAIM", body(4)), section("CITE", body(4)), section("CLAIM", body(4)));
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
  const msg = labeledMessage(section("CLAIM", body(2)), section("CITE", body(7)), section("CLAIM", body(2)));
  runHook({ session_id: "s2", last_assistant_message: msg }, home);
  const jobs = judged(home, "conclusion-first");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].message, body(7), "the judged message is the section's prose: no label line, no other section");
});

test("opposite verdicts per section: the finding names only the violating section's label and line", () => {
  const home = mkhome();
  markerProfile(home);
  const msg = labeledMessage(section("CLAIM", body(7)), section("CITE", `${body(7)}${VIOLATE_MARK}`));
  const r = runHook({ session_id: "s3", last_assistant_message: msg }, home);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.equal(judged(home, "conclusion-first").length, 2);
  const [finding, ...more] = conclusionFinding(out.reason);
  assert.equal(more.length, 0, "one finding per rule");
  assert.ok(finding.includes(`**CITE** at line ${lineOf(msg, "**CITE**")}`), finding);
  assert.ok(!finding.includes("**CLAIM**"), finding);
});

test("two violating sections: one finding naming both labels and lines, in line order", () => {
  const home = mkhome();
  markerProfile(home);
  const msg = labeledMessage(
    section("CLAIM", `${body(7)}${VIOLATE_MARK}`),
    section("CITE", body(2)),
    section("CITE(vendor docs)", `${body(7)}${VIOLATE_MARK}`),
  );
  const r = runHook({ session_id: "s4", last_assistant_message: msg }, home);
  const out = parseOut(r.stdout);
  const [finding, ...more] = conclusionFinding(out.reason);
  assert.equal(more.length, 0, "one finding per rule");
  const claim = finding.indexOf(`**CLAIM** at line ${lineOf(msg, "**CLAIM**")}`);
  const cite = finding.indexOf(`**CITE(vendor docs)** at line ${lineOf(msg, "**CITE(vendor docs)**")}`);
  assert.ok(claim > -1 && cite > -1, finding);
  assert.ok(claim < cite, "sections are named in line order");
  assert.ok(!finding.includes("**CITE**"), finding);
  assert.deepEqual(blockedRules(home, "s4"), ["conclusion-first"]);
});

test("a judge error on one section reports that section as judge unavailable: the other's violation still counts", () => {
  const msg = labeledMessage(section("CLAIM", `${body(7)}${FAIL_MARK}`), section("CITE", `${body(7)}${VIOLATE_MARK}`));
  const citeName = `**CITE** at line ${lineOf(msg, "**CITE**")}`;
  const claimName = `**CLAIM** at line ${lineOf(msg, "**CLAIM**")}`;

  // block mode
  const blocking = mkhome();
  markerProfile(blocking);
  const r = runHook({ session_id: "s5", last_assistant_message: msg }, blocking);
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.ok(blockedRules(blocking, "s5").includes("conclusion-first"));
  assert.ok(conclusionFinding(out.reason)[0].includes(citeName));
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
  assert.ok(warned.some((l) => l.includes(citeName) && !/judge unavailable/i.test(l)), warned.join("\n"));
  assert.ok(warned.some((l) => l.includes(claimName) && /judge unavailable/i.test(l)), warned.join("\n"));
  assert.match(readLog(warning, "judge-failures.log"), /rule=conclusion-first error=judge-exit-2/);
});

test("bad news leading a later section is judged in that section alone; a short section with a lexicon word dispatches nothing", () => {
  const home = mkhome();
  markerProfile(home);
  const news = `The migration failed last night and the index is missing three rows. ${body(3)}`;
  const msg = labeledMessage(section("CLAIM", body(4)), section("CITE", news));
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
  const msg = labeledMessage(section("CLAIM", body(7)), section("CITE", `${body(7)}${VIOLATE_MARK}`));
  const r = runHook({ session_id: "s9", last_assistant_message: msg }, home, OMP);
  assert.equal(r.stdout, "");
  assert.match(readLog(home, "warnings.log"), /rule=conclusion-first .*\*\*CITE\*\* at line/);
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
  const msg = labeledMessage(section("CLAIM", body(4)), section("CITE", `${sentence} ${body(3)}`));
  runHook({ session_id: "s11", last_assistant_message: msg }, home);
  const [job, ...more] = judged(home, "bad-news-first");
  assert.equal(more.length, 0);
  const window =
    "After the long weekend of careful planning and three rounds of review with the platform team and the database owners";
  assert.ok(job.question.includes(`The reader's first 20 words here are: "${window}".`), job.question);
  assert.ok(!window.includes("failed"));
  assert.ok(job.question.includes(`one labeled section (**CITE**, line ${lineOf(msg, "**CITE**")})`), job.question);
  assert.ok(!job.message.includes("**CITE**"), "the framing rides in the question, not the judged message");
});

// ─── handed-command (rule 10) through the hook, from transcript fixtures ─────

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const bareTranscript = join(FIXTURES, "handed-command-bare.jsonl");
const scriptTranscript = join(FIXTURES, "handed-command-script.jsonl");
const writeProfile = (home, profile) => writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify(profile));

test("a transcript handing a bare `gh pr list` warns handed-command, naming rule 10 and the line", () => {
  const home = mkhome();
  const r = runHook({ session_id: "hc1", transcript_path: bareTranscript }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "", "warn by default: nothing on stdout");
  const warns = logLines(home, "warnings.log").filter((l) => l.includes("rule=handed-command"));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /i-have-audhd rule 10, Commands handed to the user/);
  assert.match(warns[0], /line 3 hands the reader `gh pr list`/);
  assert.ok(existsSync(join(home, ".claude", ".i-have-audhd-state", "pending-warn-hc1.json")), "delivered next turn");
});

test("a transcript handing `zsh ~/agent-scratch/…/x.sh` is silent", () => {
  const home = mkhome();
  const r = runHook({ session_id: "hc2", transcript_path: scriptTranscript }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "warnings.log"), "");
  assert.equal(readLog(home, "errors.log"), "");
});

test("handed-command armed to block blocks, and the reason ends with the way out", () => {
  const home = mkhome();
  writeProfile(home, { enforcement: { rules: { "handed-command": "block" } } });
  const out = parseOut(runHook({ session_id: "hc3", transcript_path: bareTranscript }, home).stdout);
  assert.equal(out.decision, "block");
  assert.deepEqual(blockedRules(home, "hc3"), ["handed-command"]);
  assert.match(out.reason, /Way out: .*"handed-command": "warn"/);
});

test("handedCommand.allow globs let the operator's own line through", () => {
  const home = mkhome();
  writeProfile(home, { handedCommand: { allow: ["gh pr list"] } });
  runHook({ session_id: "hc4", transcript_path: bareTranscript }, home);
  assert.equal(readLog(home, "warnings.log"), "");
});

test("a malformed handedCommand.allow is one errors.log line; the built-in shape still applies", () => {
  const home = mkhome();
  writeProfile(home, { handedCommand: { allow: "gh *" } });
  const r = runHook({ session_id: "hc5", transcript_path: bareTranscript }, home);
  assert.match(parseOut(r.stdout).systemMessage, /failed open/);
  assert.equal(logLines(home, "errors.log").length, 1);
  assert.match(readLog(home, "errors.log"), /handedCommand\.allow is not an array/);
  assert.match(readLog(home, "warnings.log"), /rule=handed-command/);
});

// ─── handed-command: round-1 review regressions (probe inputs reused) ───────

const hcBlock = { inject: "none", enforcement: { mode: "off", rules: { "handed-command": "block" } } };

test("HC-03 short_handoff: a one-line handoff under the master floor still blocks", () => {
  const home = mkhome();
  writeProfile(home, hcBlock);
  const out = parseOut(runHook({ session_id: "hcs1", last_assistant_message: "Run `gh pr list`." }, home).stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /line 1 hands the reader `gh pr list`/);
});

test("HC-03 shell_fence_only: a command-only bash fence blocks", () => {
  const home = mkhome();
  writeProfile(home, hcBlock);
  const out = parseOut(runHook({ session_id: "hcs2", last_assistant_message: "```bash\ngh pr list\n```" }, home).stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /line 2 hands the reader `gh pr list`/);
});

test("HC-03: under the floor only handed-command runs; a short message with no command stays silent", () => {
  const home = mkhome();
  const r = runHook({ session_id: "hcs3", last_assistant_message: "Run `gh pr list`." }, home);
  assert.equal(r.stdout, "");
  assert.equal(logLines(home, "warnings.log").length, 1, "default warn");
  assert.match(readLog(home, "warnings.log"), /rule=handed-command/);
  assert.equal(readLog(home, "skipped.log"), "", "no judge rule runs under the floor");
  const quiet = mkhome();
  writeProfile(quiet, hcBlock);
  assert.equal(runHook({ session_id: "hcs4", last_assistant_message: "Done. Small body." }, quiet).stdout, "");
  assert.ok(!existsSync(join(quiet, ".claude", ".i-have-audhd-state")), "nothing written");
});

test("HC-03: kill switch, inject rules, a rule set to off and the loop guard still win under the floor", () => {
  const short = { last_assistant_message: "Run `gh pr list`." };
  const killed = mkhome();
  writeProfile(killed, hcBlock);
  writeFileSync(join(killed, ".claude", ".i-have-audhd-off"), "");
  assert.equal(runHook({ session_id: "hcs5", ...short }, killed).stdout, "");
  const rules = mkhome();
  writeProfile(rules, { ...hcBlock, inject: "rules" });
  assert.equal(runHook({ session_id: "hcs6", ...short }, rules).stdout, "");
  const off = mkhome();
  writeProfile(off, { inject: "none", enforcement: { mode: "block", rules: { "handed-command": "off" } } });
  assert.equal(runHook({ session_id: "hcs7", ...short }, off).stdout, "");
  assert.ok(!existsSync(join(off, ".claude", ".i-have-audhd-state")), "nothing written");
  const guarded = mkhome();
  writeProfile(guarded, hcBlock);
  assert.equal(parseOut(runHook({ session_id: "hcs8", ...short }, guarded).stdout).decision, "block");
  assert.equal(runHook({ session_id: "hcs8", ...short, stop_hook_active: true }, guarded).stdout, "");
});

test("HC-01: a script outside every scratch root warns, naming the roots; scriptRoots moves them", () => {
  const msg = `${body(4)}\n\nRun \`zsh /path/script.sh\`.`;
  const home = mkhome();
  runHook({ session_id: "hcr1", last_assistant_message: msg }, home);
  assert.match(readLog(home, "warnings.log"), /a script outside every scratch root \(~\/agent-scratch; the profile's handedCommand\.scriptRoots\)/);
  const moved = mkhome();
  writeProfile(moved, { handedCommand: { scriptRoots: ["/path"] } });
  runHook({ session_id: "hcr2", last_assistant_message: msg }, moved);
  assert.equal(readLog(moved, "warnings.log"), "");
  assert.equal(readLog(moved, "errors.log"), "");
});

test("HC-01: a script inside a git checkout warns, naming the checkout", () => {
  const home = mkhome();
  mkdirSync(join(home, "agent-scratch", "repo", ".git"), { recursive: true });
  runHook({ session_id: "hcr3", last_assistant_message: `${body(4)}\n\nRun \`zsh ~/agent-scratch/repo/x.sh\`.` }, home);
  assert.match(readLog(home, "warnings.log"), /a script inside the git checkout .*agent-scratch\/repo/);
});

// ─── handed-command: round-2 review regressions ──────────────────────────────

test("HC-01-R2: a symlink then `..` into a checkout blocks, naming the checkout", () => {
  const home = mkhome();
  writeProfile(home, hcBlock);
  mkdirSync(join(home, "repo", ".git"), { recursive: true });
  mkdirSync(join(home, "repo", "scripts"), { recursive: true });
  writeFileSync(join(home, "repo", "danger.sh"), "echo nope\n");
  mkdirSync(join(home, "agent-scratch"), { recursive: true });
  symlinkSync(join(home, "repo", "scripts"), join(home, "agent-scratch", "jump"));
  const out = parseOut(runHook({ session_id: "hcq1", last_assistant_message: "Run `zsh ~/agent-scratch/jump/../danger.sh`." }, home).stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /a script inside the git checkout .*\/repo\b/);
});

test("HC-01-R2: a symlink loop blocks as a path that does not resolve", () => {
  const home = mkhome();
  writeProfile(home, hcBlock);
  mkdirSync(join(home, "agent-scratch"), { recursive: true });
  symlinkSync(join(home, "agent-scratch", "loop.sh"), join(home, "agent-scratch", "loop.sh"));
  const out = parseOut(runHook({ session_id: "hcq2", last_assistant_message: "Run `zsh ~/agent-scratch/loop.sh`." }, home).stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /a script path that does not resolve \(ELOOP\)/);
});

test("HC-02-R2: a three-line span continuation blocks on the assembled command", () => {
  const home = mkhome();
  writeProfile(home, hcBlock);
  mkdirSync(join(home, "agent-scratch"), { recursive: true });
  const out = parseOut(runHook({ session_id: "hcq3", last_assistant_message: "Run `zsh`\n`~/agent-scratch/a.sh`\n`--force`." }, home).stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /line 1 hands the reader `zsh ~\/agent-scratch\/a\.sh --force`/);
});

test("a malformed handedCommand.scriptRoots is one errors.log line; ~/agent-scratch applies", () => {
  for (const scriptRoots of [[], "~/x", ["relative/dir"], [3]]) {
    const home = mkhome();
    writeProfile(home, { handedCommand: { scriptRoots } });
    runHook({ session_id: "hcr4", last_assistant_message: `${body(4)}\n\nRun \`zsh /path/script.sh\`.` }, home);
    assert.equal(logLines(home, "errors.log").length, 1, JSON.stringify(scriptRoots));
    assert.match(readLog(home, "errors.log"), /handedCommand\.scriptRoots is not a non-empty array/);
    assert.match(readLog(home, "warnings.log"), /~\/agent-scratch/);
  }
});

test("HC-02/05/06/07/08/09/10 through the hook: the review's long-form probes", () => {
  const cases = [
    ["e2e_split_inline_spans", "Run `zsh /path/script.sh` `--flag`.", true],
    ["e2e_safe_then_unsafe_inline", "Run `zsh ~/agent-scratch/x.sh`, then run `gh pr list`.", true],
    ["e2e_script_split_across_lines", "Run `zsh ~/agent-scratch/x.sh`\n`--flag`.", true],
    ["e2e_claim_two_paragraphs", "**CLAIM**\nThe completed check used the following command.\n\nIts exact invocation and result follow.\n\n```bash\ngh pr list\n```\nThe command exited zero.", false],
    ["e2e_arrow_next_line_inline", "Run `gh pr list`\n→ exit 0, three pull requests.", false],
    ["e2e_numbered_what_i_ran_fence", "## What I ran\n1. Listed open pull requests:\n\n   ```bash\n   gh pr list\n   ```\n\n   Exit code: 0.", false],
    ["e2e_console_instructions", "Run this in your terminal:\n\n```console\n$ gh pr list\n```", true],
    ["e2e_table_colon_evidence", "| Check | Result |\n| --- | --- |\n| Completed: run `gh pr list` | exit 0 |", false],
    ["e2e_prompt_after_run", "Run this in your terminal:\n\n$ gh pr list", true],
  ];
  for (const [name, tail, blocks] of cases) {
    const home = mkhome();
    writeProfile(home, hcBlock);
    const r = runHook({ session_id: name, last_assistant_message: `${body(4)}\n\n${tail}` }, home);
    assert.equal(r.stdout.includes('"decision":"block"'), blocks, name);
  }
});

// ─── the profile's inject switch, Stop half ──────────────────────────────────

test("inject full and absent: the Stop checks run", () => {
  for (const profile of [{}, { inject: "full" }]) {
    const home = mkhome();
    writeProfile(home, profile);
    runHook({ session_id: "inj1", last_assistant_message: misordered }, home);
    assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/, JSON.stringify(profile));
  }
});

test("inject rules: injection only, so the Stop hook checks nothing, even armed to block", () => {
  const home = mkhome();
  writeProfile(home, { inject: "rules", enforcement: { mode: "block" } });
  const r = runHook({ session_id: "inj2", last_assistant_message: misordered }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.ok(!existsSync(join(home, ".claude", ".i-have-audhd-state")), "nothing checked, nothing written");
});

test("inject none: no injection, and the Stop checks still run", () => {
  const home = mkhome();
  writeProfile(home, { inject: "none", enforcement: { rules: { "needs-you-first": "block" } } });
  const out = parseOut(runHook({ session_id: "inj3", last_assistant_message: misordered }, home).stdout);
  assert.equal(out.decision, "block");
});

test("the kill-switch file wins over every inject value", () => {
  for (const inject of ["full", "rules", "none"]) {
    const home = mkhome();
    writeProfile(home, { inject, enforcement: { mode: "block" } });
    writeFileSync(join(home, ".claude", ".i-have-audhd-off"), "");
    const r = runHook({ session_id: "inj4", last_assistant_message: misordered }, home);
    assert.equal(r.stdout, "", inject);
    assert.ok(!existsSync(join(home, ".claude", ".i-have-audhd-state")), inject);
  }
});

test("an inject value outside full|rules|none is one errors.log line and the checks run as under full", () => {
  const home = mkhome();
  writeProfile(home, { inject: "off" });
  const r = runHook({ session_id: "inj5", last_assistant_message: misordered }, home);
  assert.match(parseOut(r.stdout).systemMessage, /failed open/);
  assert.match(readLog(home, "errors.log"), /inject: "off" is not full\|rules\|none; full with every rule on applies/);
  assert.match(readLog(home, "warnings.log"), /rule=needs-you-first/);
});

// ─── per-rule switches and link-the-reference, Stop half ─────────────────────

// A message long enough to clear the master floor that hands `gh pr list` and names PR #42 and
// notes.md with no link: handed-command (rule 10) and link-the-reference (rule 11) both fire.
const handsAndRefs = `${body(4)}\n\nPR #42 touched notes.md.\n\nRun \`gh pr list\` to see it.`;

const warnedRules = (home) => [...readLog(home, "warnings.log").matchAll(/rule=(\S+)/g)].map((m) => m[1]).sort();

test("link-the-reference warns by default, names its rule, its line and its kind", () => {
  const home = mkhome();
  runHook({ session_id: "ltr1", last_assistant_message: handsAndRefs }, home);
  const line = readLog(home, "warnings.log").split("\n").find((l) => l.includes("rule=link-the-reference"));
  assert.ok(line, "a link-the-reference warning");
  assert.match(line, /i-have-audhd rule 11, Machinery anchors/);
  assert.match(line, /line \d+ `PR #42` \(issue-ref\)/);
});

test("link-the-reference: an artifact phrase is silent by default and warns once linkTheReference.kinds turns it on", () => {
  const msg = `${body(4)}\n\nThe report is ready for you to read.`;
  const quiet = mkhome();
  runHook({ session_id: "ltr2", last_assistant_message: msg }, quiet);
  assert.ok(!warnedRules(quiet).includes("link-the-reference"));
  const on = mkhome();
  writeProfile(on, { linkTheReference: { kinds: { artifact: true } } });
  runHook({ session_id: "ltr3", last_assistant_message: msg }, on);
  assert.match(readLog(on, "warnings.log"), /rule=link-the-reference .*`The report` \(artifact\)/);
});

test("a rule switched off in inject.rules silences every check bound to it, even under enforcement.mode block", () => {
  const home = mkhome();
  writeProfile(home, { inject: { rules: { commands: false, "machinery-anchors": false } }, enforcement: { mode: "block" } });
  const r = runHook({ session_id: "rs1", last_assistant_message: handsAndRefs }, home);
  assert.equal(r.stdout, "");
  assert.ok(!warnedRules(home).includes("handed-command"));
  assert.ok(!warnedRules(home).includes("link-the-reference"));
});

test("a bound check's own enforcement.rules entry re-enables it under a switched-off rule", () => {
  const home = mkhome();
  writeProfile(home, {
    inject: { rules: { commands: false, "machinery-anchors": false } },
    enforcement: { rules: { "handed-command": "block", "link-the-reference": "warn" } },
  });
  const out = parseOut(runHook({ session_id: "rs2", last_assistant_message: handsAndRefs }, home).stdout);
  assert.equal(out.decision, "block");
  assert.deepEqual(blockedRules(home, "rs2"), ["handed-command"]);
  assert.ok(warnedRules(home).includes("link-the-reference"));
});

test("a switched-off rule silences the bound check under the master floor too", () => {
  const home = mkhome();
  writeProfile(home, { inject: { mode: "none", rules: { commands: false } }, enforcement: { mode: "block" } });
  const r = runHook({ session_id: "rs3", transcript_path: bareTranscript }, home);
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "warnings.log"), "");
});

test("a malformed inject object is one errors.log line, and every check runs as under full", () => {
  const home = mkhome();
  writeProfile(home, { inject: { mode: "full", rules: { commands: "off" } } });
  const r = runHook({ session_id: "rs4", last_assistant_message: handsAndRefs }, home);
  assert.match(parseOut(r.stdout).systemMessage, /failed open/);
  const errors = readLog(home, "errors.log").trim().split("\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /inject: rules\["commands"\] "off" is not true\|false; full with every rule on applies/);
  assert.ok(warnedRules(home).includes("handed-command"));
});

// ─── a disabled rule's check never executes ──────────────────────────────────
// Silence is not the contract: a check whose finding is discarded is silent too. These count the
// exported predicates' calls through hooks/fixtures/count-check-calls.mjs (a module hook that
// wraps each one in memory) and assert on the count.

const COUNTER = fileURLToPath(new URL("./fixtures/count-check-calls.mjs", import.meta.url));

function checkCalls(payload, home) {
  const log = join(home, "check-calls.log");
  writeFileSync(log, "");
  const r = spawnSync(process.execPath, ["--import", COUNTER, HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      I_HAVE_AUDHD_ENFORCE: "",
      I_HAVE_AUDHD_PROFILE: "",
      I_HAVE_AUDHD_HARNESS: "",
      AUDHD_CHECK_COUNT_FILE: log,
    },
    timeout: 5_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

const countOf = (calls, name) => calls.filter((c) => c === name).length;

test("defaults: needs-you-first's check runs exactly once per Stop (the floor does not call it)", () => {
  const calls = checkCalls({ session_id: "ex1", last_assistant_message: misordered }, mkhome());
  assert.equal(countOf(calls, "checkNeedsYouFirst"), 1);
});

test("skeleton switched off: needs-you-first's check never runs, under any enforcement mode", () => {
  for (const enforcement of [{ mode: "off" }, { mode: "warn" }, { mode: "block" }]) {
    const home = mkhome();
    writeProfile(home, { inject: { rules: { skeleton: false } }, enforcement });
    const calls = checkCalls({ session_id: "ex2", last_assistant_message: misordered }, home);
    assert.equal(countOf(calls, "checkNeedsYouFirst"), 0, `enforcement ${enforcement.mode}`);
    assert.equal(countOf(calls, "checkClosingAskLast"), 0, `enforcement ${enforcement.mode}`);
  }
});

test("every rule switched off: no check or trigger runs at all, even under enforcement.mode block", () => {
  const home = mkhome();
  const rules = Object.fromEntries(RULE_IDS.map((id) => [id, false]));
  writeProfile(home, { inject: { rules }, enforcement: { mode: "block" } });
  const calls = checkCalls({ session_id: "ex3", last_assistant_message: `${misordered}\n\n${handsAndRefs}` }, home);
  assert.deepEqual(calls, []);
});

test("enforcement.mode off: no check or trigger runs at all", () => {
  const home = mkhome();
  writeProfile(home, { enforcement: { mode: "off" } });
  const calls = checkCalls({ session_id: "ex4", last_assistant_message: `${misordered}\n\n${handsAndRefs}` }, home);
  assert.deepEqual(calls, []);
});

// ─── links-resolve: a link the message hands the reader opens ────────────────
// GitHub existence and kind come from the local cache file only; the detached helper is a real
// child here, pointed at a fake `gh` on PATH so nothing reaches the network.

const ghCacheFile = (home) => join(home, ".claude", ".i-have-audhd-state", "gh-cache.json");

// A message over the floor with the given link lines and a clean closing ask.
const withLinks = (...lines) => `${body(4)}\n\n${lines.join("\n")}\n\n## Closing ask\n\nApprove the deploy of the thing named above.`;

test("links-resolve (default warn): a missing local path and a mismatched PR/issue word are one warn finding; an existing path is silent", () => {
  const home = mkhome();
  writeFileSync(join(home, "real.md"), "# real\n");
  const r = runHook(
    { session_id: "lr1", last_assistant_message: withLinks(`The notes are in \`${home}/real.md\`.`, `The notes are in \`${home}/nope.md\`.`, "PR https://github.com/o/r/issues/5 is open.") },
    home,
    { I_HAVE_AUDHD_NO_GH_FILL: "1" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "", "warn by default: nothing on stdout");
  const warn = logLines(home, "warnings.log").filter((l) => l.includes("rule=links-resolve"));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /nope\.md.*no such file/);
  assert.match(warn[0], /the sentence says PR but the URL is \/issues\//);
  assert.ok(!warn[0].includes("real.md"));
});

test("links-resolve: a GitHub URL with no cache entry is unknown, never a finding", () => {
  const home = mkhome();
  const r = runHook({ session_id: "lr2", last_assistant_message: withLinks("Issue https://github.com/o/r/issues/77 tracks it.") }, home, { I_HAVE_AUDHD_NO_GH_FILL: "1" });
  assert.equal(r.stdout, "");
  assert.equal(readLog(home, "warnings.log"), "");
});

test("links-resolve: a cached 404 and a cached wrong kind are findings; under block mode they block", () => {
  const home = mkhome();
  mkdirSync(join(home, ".claude", ".i-have-audhd-state"), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(ghCacheFile(home), JSON.stringify({ entries: { "o/r#1": { kind: "missing", title: "", at: now }, "o/r#2": { kind: "pr", title: "x", at: now } } }));
  blockProfile(home);
  const r = runHook(
    { session_id: "lr3", last_assistant_message: withLinks("Tracked at https://github.com/o/r/issues/1 today.", "Tracked at https://github.com/o/r/issues/2 today.") },
    home,
    { I_HAVE_AUDHD_NO_GH_FILL: "1" },
  );
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Links resolve \(i-have-audhd rule 11, Machinery anchors\)/);
  assert.match(out.reason, /GitHub answered 404 for o\/r#1/);
  assert.match(out.reason, /o\/r#2 is a pull request, the URL says \/issues\//);
  assert.match(out.reason, /"links-resolve": "warn"/);
  assert.deepEqual(blockedRules(home, "lr3"), ["links-resolve"]);
});

test("links-resolve: the detached helper fills the cache from gh for the unknown keys, and the next stop reads it", async () => {
  const home = mkhome();
  // A fake `gh` on PATH: issue 1 is a PR, issue 2 is a 404.
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\ncase "$*" in *issues/1*) echo '{"number":1,"title":"Fix the race","pull_request":true}';; *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1;; esac\n`,
    { mode: 0o755 },
  );
  const msg = withLinks("Issue https://github.com/o/r/issues/1 and issue https://github.com/o/r/issues/2 are tracked.");
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const first = runHook({ session_id: "lr4", last_assistant_message: msg }, home, env);
  assert.equal(first.stdout, "", "first stop: both unknown, nothing said");
  const cache = ghCacheFile(home);
  for (let i = 0; i < 40 && !existsSync(cache); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(existsSync(cache), "the helper wrote the cache after the hook exited");
  const entries = JSON.parse(readFileSync(cache, "utf8")).entries;
  assert.equal(entries["o/r#1"].kind, "pr");
  assert.equal(entries["o/r#2"].kind, "missing");
  runHook({ session_id: "lr4", last_assistant_message: msg }, home, env);
  const warn = logLines(home, "warnings.log").filter((l) => l.includes("rule=links-resolve"));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /o\/r#1 is a pull request/);
  assert.match(warn[0], /GitHub answered 404 for o\/r#2/);
});

test("links-resolve: gh missing from PATH leaves the cache unfilled with helper.error and one errors.log line; the hook itself stays silent", async () => {
  const home = mkhome();
  const msg = withLinks("Issue https://github.com/o/r/issues/9 is tracked.");
  const r = runHook({ session_id: "lr5", last_assistant_message: msg }, home, { PATH: join(home, "empty-bin") });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const cache = ghCacheFile(home);
  for (let i = 0; i < 40 && !existsSync(cache); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(existsSync(cache));
  const parsed = JSON.parse(readFileSync(cache, "utf8"));
  assert.deepEqual(parsed.entries, {});
  assert.equal(parsed.helper.error, "gh-not-found");
  assert.match(readLog(home, "errors.log"), /gh-cache-fill.*gh-not-found/);
});

test("links-resolve: a 200-link message adds under 50 ms to the Stop hook", () => {
  const home = mkhome();
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(`Line ${i}: the file is at \`/usr/bin\` in sentence ${i}.`);
  for (let i = 0; i < 50; i++) lines.push(`Line ${i}: see \`${home}/missing-${i}.md\` for run ${i}.`);
  for (let i = 0; i < 25; i++) lines.push(`Issue https://github.com/o/r/issues/${300 + i} tracks part ${i}.`);
  for (let i = 0; i < 25; i++) lines.push(`PR https://github.com/o/r/pull/${60 + i} carries part ${i}.`);
  const msg = withLinks(...lines);
  const time = (env) => {
    const t = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      runHook({ session_id: "lr6", last_assistant_message: msg }, home, env);
      t.push(performance.now() - t0);
    }
    return t.sort((a, b) => a - b)[2];
  };
  writeProfile(home, { enforcement: { rules: { "links-resolve": "off" } } });
  const off = time({ I_HAVE_AUDHD_NO_GH_FILL: "1" });
  writeProfile(home, {});
  const on = time({ I_HAVE_AUDHD_NO_GH_FILL: "1" });
  assert.ok(on - off < 50, `links-resolve added ${(on - off).toFixed(0)} ms (off ${off.toFixed(0)}, on ${on.toFixed(0)})`);
});

// ─── links-judge: off until named; the prefilter keeps it to unmatched links ─

test("links-judge is off by default and under a global mode; enforcement.rules names it on", () => {
  const home = mkhome();
  writeFileSync(join(home, "run.log"), "ok 1 - something\n");
  const msg = withLinks(`The deploy checklist is at \`${home}/run.log\`.`);
  writeFakeJudge(home, true, "a test log, not a checklist");
  const judge = `node ${fakeJudgePath(home)}`;
  for (const enforcement of [{ judgeCommand: judge }, { mode: "block", judgeCommand: judge }]) {
    const h = mkhome();
    writeFileSync(join(h, "run.log"), "ok 1 - something\n");
    writeFakeJudge(h, true, "a test log, not a checklist");
    writeProfile(h, { enforcement: { ...enforcement, judgeCommand: `node ${fakeJudgePath(h)}` } });
    const r = runHook({ session_id: "lj0", last_assistant_message: withLinks(`The deploy checklist is at \`${h}/run.log\`.`) }, h, { I_HAVE_AUDHD_NO_GH_FILL: "1" });
    assert.ok(!warnedRules(h).includes("links-judge"), JSON.stringify(enforcement));
    assert.ok(!(r.stdout && r.stdout.includes("links-judge")), JSON.stringify(enforcement));
  }
  writeProfile(home, { enforcement: { judgeCommand: judge, rules: { "links-judge": "block" } } });
  const r = runHook({ session_id: "lj1", last_assistant_message: msg }, home, { I_HAVE_AUDHD_NO_GH_FILL: "1" });
  const out = parseOut(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Links judge \(i-have-audhd rule 11, Machinery anchors\)/);
  assert.match(out.reason, /run\.log.*judge: a test log, not a checklist/);
  assert.deepEqual(blockedRules(home, "lj1"), ["links-judge"]);
});

test("links-judge: a sentence that shares a word with the target never reaches the judge; an unresolved link never does either", () => {
  const home = mkhome();
  writeFileSync(join(home, "checklist.md"), "# Deploy checklist\n");
  // The judge records every call; a violation verdict would be a finding, so a clean log is the proof.
  const calls = join(home, "judge-calls.log");
  writeFileSync(fakeJudgePath(home), `require("fs").appendFileSync(${JSON.stringify(calls)}, "call\\n"); process.stdout.write(JSON.stringify({ violation: true, reason: "x" }));\n`);
  writeProfile(home, { enforcement: { judgeCommand: `node ${fakeJudgePath(home)}`, rules: { "links-judge": "warn" } } });
  const msg = withLinks(`The deploy checklist is at \`${home}/checklist.md\`.`, `The deploy checklist is also at \`${home}/missing.md\`.`);
  runHook({ session_id: "lj2", last_assistant_message: msg }, home, { I_HAVE_AUDHD_NO_GH_FILL: "1" });
  assert.ok(!existsSync(calls), "no judge call");
  assert.ok(!warnedRules(home).includes("links-judge"));
  assert.ok(warnedRules(home).includes("links-resolve"), "the missing one is links-resolve's");
});
