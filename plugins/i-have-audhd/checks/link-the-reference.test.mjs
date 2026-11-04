// link-the-reference.test.mjs — node --test
//
// Each kind has a flagging case and the exemptions that keep it off evidence and linked
// references. ALL turns every kind on, so the off-by-default kinds are tested too; the shipped
// defaults have their own test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLinkTheReference, DEFAULT_KINDS, KINDS } from "./link-the-reference.mjs";

const ALL = { kinds: Object.fromEntries(KINDS.map((k) => [k, true])) };
const run = (text, options = ALL) => checkLinkTheReference(text, options);
const kinds = (text, options) => run(text, options).findings.map((f) => f.kind);

test("shipped defaults: issue-ref and file-name on, artifact and branch off (measured)", () => {
  assert.deepEqual(DEFAULT_KINDS, { "issue-ref": true, "file-name": true, artifact: false, branch: false });
  assert.deepEqual(kinds("The report is ready and the branch `fix-login` has a PR.", {}), []);
  assert.deepEqual(kinds("PR #42 is merged and notes.md is updated.", {}), ["issue-ref"]);
});

test("issue-ref: PR #N, pull request N, issue N and a bare #NN each flag", () => {
  for (const line of ["PR #42 merged.", "PR 42 merged.", "The pull request 42 merged.", "See issue 7 for it.", "Merged #42 tonight."]) {
    assert.deepEqual(kinds(line), ["issue-ref"], line);
  }
});

test("issue-ref: a GitHub URL for the same number on the line is the link", () => {
  assert.deepEqual(kinds("PR #42 (https://github.com/o/r/pull/42) merged."), []);
  assert.deepEqual(kinds("Issue 7 is https://github.com/o/r/issues/7 now."), []);
  assert.deepEqual(kinds("PR #43 merged; https://github.com/o/r/pull/42 is another one."), ["issue-ref"]);
});

test("issue-ref: a single-digit #N, a #NN inside a URL, path or code span, and an anchor are not references", () => {
  assert.deepEqual(kinds("Step #1 is done."), []);
  assert.deepEqual(kinds("Read https://example.com/page#42 for it."), []);
  assert.deepEqual(kinds("The colour is `#123456` in the theme."), []);
  assert.deepEqual(kinds("It lives at /tmp/run#42/out now."), []);
});

test("file-name: a bare name or a relative path flags; an absolute, ~/ or file:// path ending in it is the link", () => {
  assert.deepEqual(kinds("I updated notes.md with the result."), ["file-name"]);
  assert.deepEqual(kinds("I updated `src/format.ts` with the fix."), ["file-name"]);
  assert.deepEqual(kinds("I updated /Users/example/repo/notes.md with the result."), []);
  assert.deepEqual(kinds("I updated ~/agent-scratch/run/notes.md today."), []);
  assert.deepEqual(kinds("I updated notes.md (/Users/example/repo/notes.md) today."), []);
  assert.deepEqual(kinds("Open notes.md at file:///Users/example/repo/notes.md today."), []);
  assert.deepEqual(kinds("Written: [closed.md](/Users/example/handoffs/2026-10-14--closed.md)."), []);
});

test("file-name: every listed extension is a file; other dotted words are not", () => {
  for (const ext of ["md", "sh", "zsh", "mjs", "ts", "js", "json", "yaml", "yml", "txt", "log", "sql", "py"]) {
    assert.deepEqual(kinds(`Changed thing.${ext} today.`), ["file-name"], ext);
  }
  assert.deepEqual(kinds("The version is 1.6.0 and e.g. this is fine."), []);
});

test("file-name: names inside a command span or a command line are arguments, not references", () => {
  assert.deepEqual(kinds("A plain `bun file.js` run loads it."), []);
  assert.deepEqual(kinds("To undo it: `git checkout -- src/format.ts`."), []);
  assert.deepEqual(kinds("zsh ~/agent-scratch/x/paste.zsh jo-waiting/p-one.txt"), []);
});

test("artifact: the report and its kin flag unless a link follows in the same sentence", () => {
  assert.deepEqual(kinds("The report is ready for you."), ["artifact"]);
  assert.deepEqual(kinds("The report is at /Users/example/out/REPORT.md for you."), []);
  assert.deepEqual(kinds("The plan is [here](https://example.com/plan) now."), []);
  assert.deepEqual(kinds("The plan is ready. It is at /Users/example/out/PLAN.md."), ["artifact"]);
  assert.deepEqual(kinds("The review-model workload builds it."), []);
});

test("branch: a branch-looking code span flags only on a line that says branch or PR", () => {
  assert.deepEqual(kinds("The fix is on branch `fix-login-race` now."), ["branch"]);
  assert.deepEqual(kinds("The `fix-login-race` work is done."), []);
  assert.deepEqual(kinds("Branch `fix-login-race` is https://github.com/o/r/pull/9 now."), []);
  assert.deepEqual(kinds("Branch `fix-login-race` is checked out at /Users/example/wt/fix now."), []);
});

test("receipts, fences, → lines, blockquotes, headings and comments never count", () => {
  const text = [
    "**CLAIM**",
    "PR #42 touched notes.md, the receipt says so.",
    "",
    "```",
    "PR #43 and notes.md in a fence",
    "```",
    "",
    "`gh pr view 44` → PR #44 merged, notes.md listed",
    "",
    "> PR #45 quoted from someone else",
    "",
    "## PR #46 heading",
    "",
    "<!-- PR #47 notes.md in a comment -->",
  ].join("\n");
  assert.deepEqual(run(text).findings, []);
});

test("one finding per offending line, naming its first reference, line and kind", () => {
  const r = run("Intro line with nothing.\nPR #42 touched notes.md and the report.\nSecond notes.md mention.");
  assert.equal(r.flagged, true);
  assert.deepEqual(r.findings, [
    { line: 2, where: "line 2", kind: "issue-ref", excerpt: "PR #42" },
    { line: 3, where: "line 3", kind: "file-name", excerpt: "notes.md" },
  ]);
});

test("options.kinds switches kinds; with none on the check reports that and flags nothing", () => {
  assert.deepEqual(kinds("PR #42 touched notes.md.", { kinds: { "issue-ref": false } }), ["file-name"]);
  const none = run("PR #42 touched notes.md.", { kinds: { "issue-ref": false, "file-name": false } });
  assert.equal(none.flagged, false);
  assert.equal(none.reason, "no-kind-enabled");
});

test("empty and null input never throw", () => {
  assert.equal(run("").flagged, false);
  assert.equal(run(null).flagged, false);
});

test("a 1.9 MB message is checked well inside the Stop hook's budget", () => {
  const line = "The completed inspection retains a plain-language explanation of the result for a reader.\n";
  const big = `${line.repeat(21000).slice(0, 1_900_000)}\nPR #42 touched notes.md.`;
  const t0 = performance.now();
  const r = run(big);
  const ms = performance.now() - t0;
  assert.equal(r.findings.length, 1);
  assert.ok(ms < 400, `${ms.toFixed(0)} ms`);
});

test("a line opening with its own bold CLAIM or CITE label is a receipt written inline", () => {
  assert.deepEqual(kinds("- **CLAIM:** `grep -i x` on DESIGN.md returned no matches."), []);
  assert.deepEqual(kinds("**CITE** PR #42 says so."), []);
  assert.deepEqual(kinds("A CLAIM about PR #42 in prose still counts."), ["issue-ref"]);
});
