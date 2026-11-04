// links-judge.mjs — links-judge trigger: is the linked artifact what the sentence says it is?
//
// WHAT THIS DECIDES (the deterministic half only)
//   links-resolve (checks/links-resolve.mjs) proves a link opens; it cannot tell whether the
//   thing behind it is the thing the sentence names — "the comparables report" pointing at a
//   test log, "the PR that fixes the login race" pointing at a docs PR. That is a judgment,
//   and it belongs to the judge. This module decides which resolved links are WORTH a judge
//   call: the word-overlap prefilter.
//
//   For each resolved link the check hands over ({ sentence, path | title }) the target gets a
//   descriptor: a local file's basename words plus its first HEAD_BYTES of text (when it is a
//   regular text file; only those bytes are read), a directory its name and its entries'
//   names. A device, FIFO or socket is not a regular file and is skipped: never opened, so
//   `/dev/zero` or a pipe cannot block the hook. A GitHub link gets its
//   cached title. When the sentence's words (3+ letters, stopwords out) share at least one
//   word with the descriptor the sentence plausibly describes the target and no judge runs.
//   No shared word → one judge job for that link, at most MAX_JOBS per stop (first in line
//   order), so a message with 200 links costs at most MAX_JOBS verdicts.
//
//   The prefilter is deliberately generous to the message: it is the stage that is OFF by
//   default (profile `enforcement.rules["links-judge"]`), and a judge call per link is the
//   expensive thing this plugin does.
//
// Usage:
//   import { linksJudgeJobs, linksJudgeQuestion } from "./links-judge.mjs";

import { openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { basename } from "node:path";

export const MAX_JOBS = 5;
const HEAD_BYTES = 1500;
const STOP = new Set(
  (
    "the a an and or but of for to in on at by with from into over under about as is are was were be been being it its this that these " +
    "those here there which who whom what when where why how not no yes all any some one two see now then than too very can will would " +
    "should could may might must has have had do does did done also just only same other such via per each every both either neither " +
    "more most less least own out off up down again further once before after above below between through during without within " +
    "file path link url report doc docs document note notes md json txt log logs issue issues pull request pr prs github com https http"
  ).split(" "),
);

export const linksJudgeQuestion =
  "Rule 'machinery anchors': a reference the reader can open is only useful when the thing " +
  "behind it is the thing the sentence names. You are given one sentence from the message, " +
  "the link it carries, and what is actually at that link (a file's name and opening text, a " +
  "directory's entries, or a GitHub issue or pull request's kind and title). violation=true " +
  "only when the target is clearly NOT what the sentence says it is — a different document, a " +
  "different change, a different kind of thing. A target that merely says less than the " +
  "sentence, or in other words, is compliant. When unsure, answer violation=false.";

// Significant words of `s`, lowercased: letters/digits runs of 3+, minus stopwords.
export function significantWords(s) {
  const out = new Set();
  for (const m of String(s ?? "").toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    if (!STOP.has(m[0])) out.add(m[0]);
  }
  return out;
}

// What is behind a resolved link, for the prefilter and the judge: { label, text } or null
// when nothing readable is there (gone, unreadable, or not a regular file or directory).
// `fs` is injectable for tests.
export function describeTarget(link, fs = { openSync, readSync, closeSync, readdirSync, statSync }) {
  if (link.kind === "gh") {
    return { label: `GitHub ${link.ghKind === "pr" ? "pull request" : "issue"} ${link.key}`, text: link.title ?? "" };
  }
  try {
    const st = fs.statSync(link.path);
    if (st.isDirectory()) {
      const names = fs.readdirSync(link.path).slice(0, 40).join(" ");
      return { label: `directory ${basename(link.path)}`, text: `${basename(link.path)} ${names}` };
    }
    if (!st.isFile()) return null;
    const head = Buffer.alloc(HEAD_BYTES);
    const fd = fs.openSync(link.path, "r");
    let n;
    try {
      n = fs.readSync(fd, head, 0, HEAD_BYTES, 0);
    } finally {
      fs.closeSync(fd);
    }
    const got = head.subarray(0, n);
    if (got.includes(0)) return { label: `binary file ${basename(link.path)}`, text: basename(link.path).replace(/[._-]+/g, " ") };
    return { label: `file ${basename(link.path)}`, text: `${basename(link.path).replace(/[._-]+/g, " ")}\n${got.toString("utf8")}` };
  } catch {
    return null;
  }
}

// The judge jobs for `links` (links-resolve's resolved links): one per link whose sentence
// shares no significant word with its target, at most MAX_JOBS. Each job is
// { rule: "links-judge", question, contextText, link, line }.
export function linksJudgeJobs(links, options = {}) {
  const fs = options.fs;
  const max = options.maxJobs ?? MAX_JOBS;
  const jobs = [];
  for (const link of links) {
    if (jobs.length >= max) break;
    const target = describeTarget(link, fs);
    if (!target) continue;
    const want = significantWords(link.sentence.replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " "));
    if (!want.size) continue; // a sentence with no words of its own cannot be wrong about the target
    const have = significantWords(target.text);
    let shared = false;
    for (const w of want) {
      if (have.has(w)) {
        shared = true;
        break;
      }
    }
    if (shared) continue;
    jobs.push({
      rule: "links-judge",
      question: linksJudgeQuestion,
      contextText:
        `Sentence (line ${link.line}): ${link.sentence}\n` +
        `Link: ${link.href}\n` +
        `At the link: ${target.label}\n` +
        `---\n${target.text.slice(0, HEAD_BYTES)}\n---`,
      link,
      line: link.line,
    });
  }
  return jobs;
}
