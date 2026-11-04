// real-judge-output.test.mjs — node --test
//
// The verdict parser against output a REAL judge printed, never a hand-written sample. The files
// in judge/fixtures/ were captured once by judge/fixtures/capture-real-judge.mjs (not a test): it
// ran the real Stop hook on a message that trips conclusion-first and bad-news-first, with the
// operator's configured enforcement.judgeCommand behind a recording wrapper. Each rule has the
// exact prompt the hook sent (<rule>.prompt.txt), the judge's stdout, stderr and exit code.
// CAPTURED.txt names the judge command and the time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { askJudge, parseVerdict } from "./ask.mjs";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const read = (name) => readFileSync(fixture(name), "utf8");
const RULES = ["conclusion-first", "bad-news-first"];

for (const rule of RULES) {
  test(`${rule}: the captured real judge exited 0 and answered the prompt the hook really sent`, () => {
    assert.equal(read(`${rule}.exit.txt`).trim(), "0");
    const prompt = read(`${rule}.prompt.txt`);
    assert.match(prompt, new RegExp(`^Rule: ${rule}$`, "m"));
    assert.match(prompt, /^<<<MSG\n[\s\S]*\nMSG$/m);
  });

  test(`${rule}: parseVerdict reads the captured real stdout as a strict verdict`, () => {
    const stdout = read(`${rule}.stdout.txt`);
    const verdict = parseVerdict(stdout);
    assert.ok(verdict, `no verdict parsed from ${JSON.stringify(stdout)}`);
    assert.deepEqual(Object.keys(verdict), ["violation", "reason"]);
    assert.equal(verdict.violation, true, "the captured message buries its point; the real judge said so");
    assert.ok(verdict.reason.length > 20, verdict.reason);
    // The judge printed exactly one JSON object; the parsed verdict is that object, nothing lost.
    assert.deepEqual(verdict, JSON.parse(stdout.trim()));
  });

  test(`${rule}: askJudge dispatches a command replaying the captured stdout and returns its verdict`, async () => {
    const state = mkdtempSync(join(tmpdir(), "audhd-real-judge-"));
    const judgeCommand = `cat >/dev/null; cat '${fixture(`${rule}.stdout.txt`)}'`;
    const r = await askJudge(rule, "q", "msg", { judgeCommand }, { stateDir: state, timeoutMs: 5_000 });
    assert.deepEqual(r, { ...JSON.parse(read(`${rule}.stdout.txt`).trim()), cached: false });
  });
}

test("the captured stdout survives banner noise and a claude -p envelope around it", () => {
  const real = read("conclusion-first.stdout.txt").trim();
  const expected = JSON.parse(real);
  assert.deepEqual(parseVerdict(`judge v1.2 starting\n{"session": "abc"}\n${real}\n`), expected);
  assert.deepEqual(parseVerdict(JSON.stringify({ type: "result", result: `Here you go:\n${real}` })), expected);
});
