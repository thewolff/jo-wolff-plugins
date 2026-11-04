// failure-causes.test.mjs — node --test
//
// One test per `cause=` value, each driven by a stderr/stdout string that really appeared in
// judge-failures.log on this machine (judge/fixtures/failure-corpus.mjs). The judge is a shell
// snippet that replays that string, so the whole dispatch runs: the line's fields, the
// replayable prompt file, the result the Stop hook reads. No real judge failure was reproduced
// live for these; the fixtures are the evidence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJudge, classify, modelOf, CAUSES } from "./ask.mjs";
import { CORPUS, EXTRA } from "./fixtures/failure-corpus.mjs";

const mkstate = () => mkdtempSync(join(tmpdir(), "audhd-cause-"));
const readLog = (dir) => {
  const p = join(dir, "judge-failures.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
// A judge that prints the fixture's stderr and exits with its code; a stdout fixture prints there.
const replay = (f) => {
  const parts = [];
  if (f.stderr) parts.push(`printf '%s\\n' ${shellQuote(f.stderr)} >&2`);
  if (f.stdout) parts.push(`printf '%s' ${shellQuote(f.stdout)}`);
  parts.push(`exit ${f.exit ?? 0}`);
  return parts.join("; ");
};

const FIELDS =
  /^\S+ rule=(\S+) error=(\S+) cause=(\S+) session=(\S+) harness=(\S+) model=(\S+) elapsedMs=(\d+) budgetMs=(\d+) section=(\S+) cache=([0-9a-f]{64}) prompt=(\S+)(?: stderr="(.*?)")?(?: stdout="(.*?)")?$/;

async function fail(cause, fixture, extra = {}) {
  const state = mkstate();
  const cfg = { judgeCommand: fixture.timeout ? "sleep 5" : `${replay(fixture)} # anthropic/claude-haiku-5-5` };
  const r = await askJudge("conclusion-first", "q", "msg", cfg, {
    stateDir: state,
    timeoutMs: fixture.timeout ? 50 : 5000,
    meta: { session: "sess-1", section: "CLAIM@12" },
    ...extra,
  });
  const line = readLog(state).trim();
  const m = FIELDS.exec(line);
  assert.ok(m, `line has every field: ${line}`);
  return { r, line, m, state };
}

test("CAUSES is the closed list the alert and docs enumerate", () => {
  assert.deepEqual(CAUSES, ["credential-revoked", "no-credential", "rate-limited", "judge-self-abort", "hook-deadline", "bad-json", "other"]);
});

test("every failure line carries rule, error, cause, session, harness, model, elapsed, budget, section, cache key and the prompt path", async () => {
  const { r, m, state } = await fail("credential-revoked", CORPUS["credential-revoked"]);
  assert.equal(m[1], "conclusion-first");
  assert.equal(m[2], "judge-exit-1");
  assert.equal(m[3], "credential-revoked");
  assert.equal(m[4], "sess-1");
  assert.equal(m[5], "claude-code");
  assert.equal(m[6], "anthropic/claude-haiku-5-5");
  assert.ok(Number(m[7]) >= 0 && Number(m[7]) < 5000);
  assert.equal(m[8], "5000");
  assert.equal(m[9], "CLAIM@12");
  assert.equal(m[11], join(state, "cache", `${m[10]}.prompt.txt`));
  assert.ok(existsSync(m[11]), "the prompt is written on failure, replayable");
  assert.match(readFileSync(m[11], "utf8"), /^You are judging one message[\s\S]*<<<MSG\nmsg\nMSG$/);
  assert.ok(!existsSync(join(state, "cache", `${m[10]}.json`)), "no verdict is cached");
  assert.equal(r.cause, "credential-revoked");
  assert.equal(r.model, "anthropic/claude-haiku-5-5");
  assert.equal(r.budgetMs, 5000);
});

test("cause=credential-revoked: the corpus 401 'OAuth access token has been revoked'", async () => {
  const { m } = await fail("credential-revoked", CORPUS["credential-revoked"]);
  assert.equal(m[3], "credential-revoked");
  assert.match(m[12], /OAuth access token has been revoked/);
});

test("cause=no-credential: the corpus 'no credential for … in profile agent-system-2', and a CLI's 'not logged in'", async () => {
  const { m } = await fail("no-credential", CORPUS["no-credential"]);
  assert.equal(m[3], "no-credential");
  assert.match(m[12], /no credential for anthropic\/claude-haiku-5-5 in profile agent-system-2/);
  const cli = await fail("no-credential", EXTRA["no-credential-cli"]);
  assert.equal(cli.m[3], "no-credential");
  assert.equal(cli.m[2], "judge-exit-4");
});

test("cause=judge-self-abort: the corpus 'aborted: Request was aborted' on exit 1", async () => {
  const { m } = await fail("judge-self-abort", CORPUS["judge-self-abort"]);
  assert.equal(m[3], "judge-self-abort");
  assert.equal(m[2], "judge-exit-1");
});

test("cause=other: the corpus bare exit 1 with nothing on stderr", async () => {
  const { m, line } = await fail("other", CORPUS.other);
  assert.equal(m[3], "other");
  assert.ok(!line.includes("stderr="), "no empty stderr field");
});

test("cause=hook-deadline: the hook's own timer, whatever stderr said", async () => {
  const { m, r } = await fail("hook-deadline", CORPUS["hook-deadline"]);
  assert.equal(m[2], "judge-timeout");
  assert.equal(m[3], "hook-deadline");
  assert.equal(m[8], "50");
  assert.equal(r.error, "judge-timeout");
  assert.equal(classify("judge-timeout", "model-judge: aborted: Request was aborted"), "hook-deadline");
});

test("cause=bad-json: exit 0 with no verdict object keeps the last 300 chars of stdout", async () => {
  const { m, line } = await fail("bad-json", CORPUS["bad-json"]);
  assert.equal(m[2], "judge-unparseable");
  assert.equal(m[3], "bad-json");
  assert.equal(m[13], "I have no thoughts, only vibes.");
  assert.ok(!line.includes("stderr="));
  const long = await fail("bad-json", { stdout: "x".repeat(1000) + "TAIL", exit: 0 });
  assert.equal(long.m[13].length, 300);
  assert.ok(long.m[13].endsWith("TAIL"));
});

test("cause=rate-limited: a 429 rate_limit_error", async () => {
  const { m } = await fail("rate-limited", EXTRA["rate-limited"]);
  assert.equal(m[3], "rate-limited");
});

test("harness=omp under the OMP tag", async () => {
  const state = mkstate();
  process.env.I_HAVE_AUDHD_HARNESS = "omp";
  try {
    await askJudge("bad-news-first", "q", "msg", { judgeCommand: replay(CORPUS.other) }, { stateDir: state, timeoutMs: 5000 });
  } finally {
    delete process.env.I_HAVE_AUDHD_HARNESS;
  }
  assert.match(readLog(state), / harness=omp model=unknown .* section=whole /);
});

test("classify: the order is deadline, bad-json, then the stderr patterns, then other", () => {
  assert.equal(classify("judge-exit-1", CORPUS["credential-revoked"].stderr), "credential-revoked");
  assert.equal(classify("judge-exit-1", CORPUS["no-credential"].stderr), "no-credential");
  assert.equal(classify("judge-exit-1", EXTRA["rate-limited"].stderr), "rate-limited");
  assert.equal(classify("judge-exit-1", CORPUS["judge-self-abort"].stderr), "judge-self-abort");
  assert.equal(classify("judge-exit-1", ""), "other");
  assert.equal(classify("judge-exit-127", "sh: no-such-judge: command not found"), "other");
  assert.equal(classify("judge-spawn-ENOENT", ""), "other");
  assert.equal(classify("judge-unparseable", CORPUS["credential-revoked"].stderr), "bad-json");
});

test("classify: 'quota' inside a path and a bare 'aborted' are not causes; the error-sentence shapes still are", () => {
  assert.equal(classify("judge-exit-1", "model-judge: error: ENOENT: no such file or directory, open '/tmp/quota/config.json'"), "other");
  assert.equal(classify("judge-exit-1", "model-judge: error: invalid JSON, parse aborted at byte 3"), "other");
  assert.equal(classify("judge-exit-1", "Error: You exceeded your current quota, please check your plan."), "rate-limited");
  assert.equal(classify("judge-exit-1", '{"error":{"code":"insufficient_quota"}}'), "rate-limited");
  assert.equal(classify("judge-exit-1", "model-judge: aborted: Request was aborted"), "judge-self-abort");
});

test("modelOf: --model, --model=, -m, a trailing provider/model token, else unknown", () => {
  assert.equal(modelOf("claude -p --output-format json --model haiku"), "haiku");
  assert.equal(modelOf("omp -p --no-session --model=anthropic/claude-haiku-5-5"), "anthropic/claude-haiku-5-5");
  assert.equal(modelOf("codex exec -m o4-mini -"), "o4-mini");
  assert.equal(modelOf("MODEL_JUDGE_USAGE_LOG=/x/y.jsonl /u/.bun/bin/bun /u/agent-scratch/monitor/model-judge.ts anthropic/claude-haiku-5-5"), "anthropic/claude-haiku-5-5");
  assert.equal(modelOf("codex exec --skip-git-repo-check -"), "unknown");
  assert.equal(modelOf("node /no/such/judge.mjs"), "unknown");
  assert.equal(modelOf(""), "unknown");
});
