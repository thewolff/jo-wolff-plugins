// links-judge.test.mjs — node --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linksJudgeJobs, significantWords, describeTarget, MAX_JOBS } from "./links-judge.mjs";

const dir = mkdtempSync(join(tmpdir(), "audhd-linksjudge-"));
writeFileSync(join(dir, "comparables.md"), "# Link validation comparables\n\nlychee, markdown-link-check and friends.\n");
writeFileSync(join(dir, "run.log"), "ok 1 - something\nok 2 - else\n");
writeFileSync(join(dir, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
mkdirSync(join(dir, "evals"));
writeFileSync(join(dir, "evals", "manifest.json"), "{}");

const pathLink = (sentence, file) => ({ kind: "path", line: 3, sentence, href: join(dir, file), path: join(dir, file) });
const ghLink = (sentence, ghKind, title) => ({ kind: "gh", line: 4, sentence, href: "https://github.com/o/r/pull/1", key: "o/r#1", ghKind, title });

test("significantWords: 3+ letter runs, lowercased, stopwords and link vocabulary out", () => {
  assert.deepEqual([...significantWords("The comparables report is at the PR, see https://x")], ["comparables"]);
  assert.deepEqual([...significantWords("")], []);
});

test("no job when the sentence shares a word with the target's name or opening text", () => {
  assert.deepEqual(linksJudgeJobs([pathLink("The comparables report is at `x`.", "comparables.md")]), []);
  assert.deepEqual(linksJudgeJobs([pathLink("Lychee is covered in `x`.", "comparables.md")]), []);
  assert.deepEqual(linksJudgeJobs([ghLink("The login race fix is in https://github.com/o/r/pull/1.", "pr", "Fix the login race")]), []);
  assert.deepEqual(linksJudgeJobs([pathLink("The evals manifest lives in `x`.", "evals")]), []);
});

test("one job when nothing overlaps, carrying the sentence, the link and what is at it", () => {
  const jobs = linksJudgeJobs([pathLink("The deploy checklist is at `x`.", "run.log")]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].rule, "links-judge");
  assert.equal(jobs[0].line, 3);
  assert.match(jobs[0].contextText, /Sentence \(line 3\): The deploy checklist/);
  assert.match(jobs[0].contextText, /At the link: file run\.log/);
  assert.match(jobs[0].contextText, /ok 1 - something/);
  const gh = linksJudgeJobs([ghLink("The deploy checklist PR is https://github.com/o/r/pull/1.", "pr", "Fix the login race")]);
  assert.match(gh[0].contextText, /At the link: GitHub pull request o\/r#1\n---\nFix the login race/);
});

test("a sentence with no words of its own, an unreadable target and a binary file never produce a judge job", () => {
  assert.deepEqual(linksJudgeJobs([pathLink("See `x`.", "run.log")]), []);
  assert.deepEqual(linksJudgeJobs([pathLink("The deploy checklist is at `x`.", "nope.md")]), []);
  assert.equal(describeTarget(pathLink("", "blob.bin")).label, "binary file blob.bin");
  assert.equal(linksJudgeJobs([pathLink("The blob image is `x`.", "blob.bin")]).length, 0);
  assert.equal(linksJudgeJobs([pathLink("The deploy checklist is `x`.", "blob.bin")]).length, 1);
});

test("at most MAX_JOBS jobs per stop, first in line order", () => {
  const links = Array.from({ length: MAX_JOBS + 3 }, (_, i) => ({ ...pathLink("The deploy checklist is at `x`.", "run.log"), line: i + 1 }));
  const jobs = linksJudgeJobs(links);
  assert.equal(jobs.length, MAX_JOBS);
  assert.deepEqual(jobs.map((j) => j.line), [1, 2, 3, 4, 5]);
});
