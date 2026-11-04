// links-resolve.test.mjs — node --test
//
// Each kind has a flagging case and the exemptions that keep it off evidence, future files and
// unknown GitHub links. The disk is a temp directory, the GitHub cache an in-memory object, so
// nothing here touches the network or the real state directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLinksResolve, toLocalPath, sentenceAround, wordBefore } from "./links-resolve.mjs";
import { HIT_TTL_MS, MISS_TTL_MS } from "../lib/gh-cache.mjs";

const home = mkdtempSync(join(tmpdir(), "audhd-links-"));
mkdirSync(join(home, "repo", "src"), { recursive: true });
writeFileSync(join(home, "repo", "src", "format.ts"), "export const x = 1;\n");
writeFileSync(join(home, "repo", "NOTES.md"), "# Notes\n");

const NOW = Date.parse("2026-11-04T12:00:00Z");
const at = (agoMs) => new Date(NOW - agoMs).toISOString();
const cache = {
  entries: {
    "o/r#1": { kind: "pr", title: "Fix the login race", at: at(1000) },
    "o/r#2": { kind: "issue", title: "Login flakes", at: at(1000) },
    "o/r#3": { kind: "missing", title: "", at: at(1000) },
    "o/r#4": { kind: "missing", title: "", at: at(MISS_TTL_MS + 1) },
    "o/r#5": { kind: "pr", title: "stale", at: at(HIT_TTL_MS + 1) },
  },
};

const run = (text, options = {}) => checkLinksResolve(text, { home, ghCache: cache, now: NOW, ...options });
const kinds = (text, options) => run(text, options).findings.map((f) => f.kind);

test("missing-path: a code span or markdown link to a path that does not exist flags; an existing one is a resolved link", () => {
  const r = run(`The fix is in \`${home}/repo/src/format.ts\` and the notes in \`${home}/repo/NOPE.md\`.`);
  assert.deepEqual(r.findings.map((f) => [f.kind, f.excerpt]), [["missing-path", `${home}/repo/NOPE.md`]]);
  assert.deepEqual(r.links.map((l) => l.path), [join(home, "repo", "src", "format.ts")]);
  assert.deepEqual(kinds(`Written: [notes](${home}/repo/gone.md).`), ["missing-path"]);
  assert.deepEqual(kinds(`Written: [notes](${home}/repo/NOTES.md).`), []);
});

test("missing-path: ~/ and file:// forms resolve against the home given; line and column suffixes are stripped", () => {
  assert.deepEqual(kinds("See `~/repo/src/format.ts:12` and `~/repo/NOTES.md:3-9` and `~/repo/src/format.ts#L4`."), []);
  assert.deepEqual(kinds("See `~/repo/missing.ts:12`."), ["missing-path"]);
  assert.deepEqual(kinds(`Open \`file://${home}/repo/NOTES.md\` now.`), []);
  assert.deepEqual(kinds(`Open \`file://${home}/repo/none.md\` now.`), ["missing-path"]);
  assert.equal(toLocalPath("/a/b.ts:41-50", home), "/a/b.ts");
  assert.equal(toLocalPath("~/x.md:7:3", home), `${home}/x.md`);
  assert.equal(toLocalPath("/a/b.ts).", home), "/a/b.ts");
});

test("missing-path: a sentence that says the file is still to come, or gone, is not checked", () => {
  for (const line of [
    "The report will be written to `/never/here/report.md` once the run ends.",
    "The output is to be produced at `/never/here/out.json`.",
    "Once it lands, `/never/here/x.md` holds the result.",
    "I removed `/never/here/old.md` as part of the cleanup.",
    "`/never/here/tmp.log` no longer exists after the prune.",
    "It will live at `/never/here/plan.md`.",
    "The file `/never/here/gone.md` does not exist yet.",
  ]) {
    assert.deepEqual(kinds(line), [], line);
  }
  assert.deepEqual(kinds("The report is at `/never/here/report.md` for you."), ["missing-path"]);
});

test("missing-path: the sentence, not the line, decides: a later sentence's future tense does not cover an earlier path", () => {
  assert.deepEqual(kinds("The report is at `/never/here/report.md`. The next one will be written to `/never/here/next.md`."), ["missing-path"]);
  assert.equal(sentenceAround("A `/x` b. C `/y` d.", 12), "C `/y` d.");
  assert.equal(sentenceAround("A `/x` b. C `/y` d.", 2), "A `/x` b.");
});

test("missing-path: a missing slash command or HTTP route (one segment, no dot; or a :param segment) is not a file", () => {
  for (const line of [
    "Run `/mcp` to re-authenticate.",
    "You do not need to run `/wrap-up` again.",
    "The `/health` endpoint returns ok.",
    "The route `/:id` takes the slug.",
    "Type `/clear` and start over.",
    "| POST | `/messages/:id/delivered` | Stamped update |",
  ]) {
    assert.deepEqual(kinds(line, { exists: () => false }), [], line);
  }
  // Two segments, or a dot, is still a path.
  assert.deepEqual(kinds("See `/never/here` now.", { exists: () => false }), ["missing-path"]);
  assert.deepEqual(kinds("See `/never.md` now.", { exists: () => false }), ["missing-path"]);
  // A one-segment path that exists is a resolved link as before.
  assert.deepEqual(run("See `/tmp` now.", { exists: () => true }).links.map((l) => l.path), ["/tmp"]);
});

test("missing-path: comma line lists, en-dash ranges and percent-encoded file:// suffixes are stripped", () => {
  assert.equal(toLocalPath("/a/b.md:18,22", home), "/a/b.md");
  assert.equal(toLocalPath("/a/b.md:13-14,56-59", home), "/a/b.md");
  assert.equal(toLocalPath("/a/b.md:307–321", home), "/a/b.md");
  assert.equal(toLocalPath("/a/b.md:12,40-41,90.", home), "/a/b.md");
  assert.equal(toLocalPath("file:///a/b.md:307%E2%80%93321", home), "/a/b.md");
  assert.equal(toLocalPath("file:///a/b.md:18,22", home), "/a/b.md");
  assert.equal(toLocalPath("file:///a/my%20notes.md:4", home), "/a/my notes.md");
  assert.deepEqual(kinds("See `~/repo/NOTES.md:18,22` and `~/repo/src/format.ts:13-14,56-59`."), []);
  assert.deepEqual(kinds(`See [notes](file://${home}/repo/NOTES.md:307%E2%80%93321).`), []);
});

test("missing-path: I'll, we'll, didn't save, not written, Plan: and Step N say the file is not there yet", () => {
  for (const line of [
    "I'll write the report to `/never/here/report.md` when the run ends.",
    "We’ll save it at `/never/here/out.json`.",
    "If so, I'll save it to `~/never/recap.md`.",
    "I didn't save `/never/here/recap.md` this time.",
    "The recap is not written: `/never/here/recap.md`.",
    "Plan: put the notes in `/never/here/notes.md` and link them.",
    "Step 3, after it reports back: I save them to `/never/here/p.md`.",
  ]) {
    assert.deepEqual(kinds(line), [], line);
  }
});

test("sentenceAround: e.g., i.e., vs. and a dotted version number do not end a sentence", () => {
  assert.deepEqual(kinds("The helper will produce output, e.g. `/never/a.md` for the first run."), []);
  assert.deepEqual(kinds("A later run will write it, i.e. `/never/a.md` once done."), []);
  assert.equal(sentenceAround("Use x vs. `/y` here. Next.", 12), "Use x vs. `/y` here.");
  assert.equal(sentenceAround("Shipped in 1.6.1. `/y` is it. Next.", 18), "Shipped in 1.6.1. `/y` is it.");
  // A real sentence end still splits.
  assert.equal(sentenceAround("Done. `/y` is it.", 6), "`/y` is it.");
});

test("gh-word: the word binds to its nearest URL, not to the whole sentence", () => {
  assert.deepEqual(kinds("Opened PR https://github.com/o/r/pull/1 for https://github.com/o/r/issues/2 today."), []);
  assert.deepEqual(kinds("Filed https://github.com/o/r/issues/2 to track the PR review."), []);
  assert.deepEqual(kinds("Merged https://github.com/o/r/pull/1 with no issues."), []);
  assert.deepEqual(kinds("PR #72 is https://github.com/o/r/issues/72 now."), ["gh-word"]);
  assert.deepEqual(kinds("Issue #72 is https://github.com/o/r/pull/72 now."), ["gh-word"]);
  assert.deepEqual(kinds("[PR #79](https://github.com/o/r/issues/79) is up."), ["gh-word"]);
  // A clause break or more than WORD_WINDOW tokens cuts the binding.
  assert.deepEqual(kinds("I opened the PR, then filed https://github.com/o/r/issues/2 today."), []);
  assert.deepEqual(kinds("The PR is one of a b c d e f https://github.com/o/r/issues/2 today."), []);
  assert.equal(wordBefore("The pull request https://x", 17), "pr");
  assert.equal(wordBefore("No word at all https://x", 15), null);
});

test("missing-path: commands, placeholders, globs and variables are not paths to check", () => {
  for (const line of [
    "Run `rm /never/here/x.md` to clean up.",
    "Run `cat ~/never/here/x.md` to see it.",
    "Put it at `/path/to/<name>.md` and rerun.",
    "Logs match `/never/here/*.log` today.",
    "The root is `$HOME/never/here` on that box.",
    "It is under `/never/here/…` somewhere.",
    "Try `/absolute/path/script.sh` as the shape.",
  ]) {
    assert.deepEqual(kinds(line), [], line);
  }
});

test("missing-path: a span holding more than a path, or a relative path, is not a candidate", () => {
  assert.deepEqual(kinds("The pair `/never/a and /never/b` is prose in a span."), []);
  assert.deepEqual(kinds("See `src/format.ts` for it."), []);
});

test("gh-shape: /issue/N and /pulls/N are not GitHub pages; /issues/N and /pull/N are", () => {
  assert.deepEqual(kinds("See https://github.com/o/r/issue/9 for it."), ["gh-shape"]);
  assert.deepEqual(kinds("See https://github.com/o/r/pulls/9 for it."), ["gh-shape"]);
  assert.deepEqual(kinds("See https://github.com/o/r/issues/2 and https://github.com/o/r/pull/1 for it."), []);
});

test("gh-word: the sentence's word and the URL's kind disagree", () => {
  assert.deepEqual(kinds("PR https://github.com/o/r/issues/2 is merged."), ["gh-word"]);
  assert.deepEqual(kinds("The pull request https://github.com/o/r/issues/2 is merged."), ["gh-word"]);
  assert.deepEqual(kinds("Issue https://github.com/o/r/pull/1 is closed."), ["gh-word"]);
  assert.deepEqual(kinds("PR https://github.com/o/r/pull/1 is merged."), []);
  assert.deepEqual(kinds("Issue https://github.com/o/r/issues/2 is closed."), []);
  // Both words in the sentence: nothing to disagree with.
  assert.deepEqual(kinds("The PR for issue https://github.com/o/r/issues/2 is open."), []);
  // The URL's own /issues/ segment is not the sentence's word.
  assert.deepEqual(kinds("Merged https://github.com/o/r/pull/1 tonight."), []);
});

test("gh-missing and gh-kind come from the cache; an unknown or expired entry is a lookup, never a finding", () => {
  const r = run(
    [
      "Tracked at https://github.com/o/r/issues/3 (404 in cache).",
      "Tracked at https://github.com/o/r/issues/1 (cached as a pull).",
      "Tracked at https://github.com/o/r/issues/4 (expired miss).",
      "Tracked at https://github.com/o/r/pull/5 (expired hit).",
      "Tracked at https://github.com/o/r/pull/77 (never seen) and again https://github.com/o/r/pull/77.",
    ].join("\n"),
  );
  assert.deepEqual(r.findings.map((f) => [f.line, f.kind]), [
    [1, "gh-missing"],
    [2, "gh-kind"],
  ]);
  assert.deepEqual(r.lookups, ["o/r#4", "o/r#5", "o/r#77"]);
});

test("a resolved GitHub link carries its cached title for the judge stage; no cache means every link is a lookup", () => {
  const r = run("Fixed in https://github.com/o/r/pull/1 today.");
  assert.deepEqual(r.links.map((l) => [l.kind, l.key, l.title]), [["gh", "o/r#1", "Fix the login race"]]);
  const none = checkLinksResolve("Fixed in https://github.com/o/r/pull/1 today.", { home });
  assert.deepEqual(none.findings, []);
  assert.deepEqual(none.lookups, ["o/r#1"]);
});

test("fences, → lines, blockquotes, headings and comments never count", () => {
  const text = [
    "```",
    "cat /never/here/fenced.md",
    "`/never/here/fenced2.md`",
    "```",
    "`ls /never/here` → No such file",
    "> `/never/here/quoted.md`",
    "## `/never/here/heading.md`",
    "<!-- `/never/here/comment.md` -->",
    "See https://github.com/o/r/issues/3 → 404 as expected",
  ].join("\n");
  assert.deepEqual(run(text).findings, []);
});

test("one finding per link, in line order, each naming its line, kind and excerpt", () => {
  const r = run("Intro line.\nSee `/never/a.md` and `/never/b.md`.\nAnd PR https://github.com/o/r/issues/2.");
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "unresolved-link");
  assert.deepEqual(
    r.findings.map((f) => [f.where, f.kind, f.excerpt]),
    [
      ["line 2", "missing-path", "/never/a.md"],
      ["line 2", "missing-path", "/never/b.md"],
      ["line 3", "gh-word", "https://github.com/o/r/issues/2"],
    ],
  );
});

test("empty and null input never throw; prose with no links is all-resolve", () => {
  assert.equal(run("").flagged, false);
  assert.equal(run("").reason, "no-prose");
  assert.equal(run(null).flagged, false);
  assert.equal(run("Nothing to open here.").reason, "all-resolve");
});

test("a 200-link message is checked well inside the Stop hook's budget", () => {
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(`Line ${i}: the file is at \`${home}/repo/NOTES.md\` in sentence ${i}.`);
  for (let i = 0; i < 50; i++) lines.push(`Line ${i}: see \`${home}/missing-${i}.md\` for run ${i}.`);
  for (let i = 0; i < 25; i++) lines.push(`Issue https://github.com/o/r/issues/${300 + i} tracks part ${i}.`);
  for (let i = 0; i < 25; i++) lines.push(`PR https://github.com/o/r/pull/${60 + i} carries part ${i}.`);
  const t0 = performance.now();
  const r = run(lines.join("\n"));
  const ms = performance.now() - t0;
  assert.equal(r.findings.length, 50);
  assert.equal(r.lookups.length, 50);
  assert.ok(ms < 50, `${ms.toFixed(0)} ms`);
});
