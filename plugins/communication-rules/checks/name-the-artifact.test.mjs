// name-the-artifact.test.mjs — node --test
//
// The false-positive cases are the point of this file. The applicability gate exists because
// most messages are correctly about nothing on disk; each artifact KIND must also be proven
// to satisfy the check, so a message naming its artifact one way is never flagged.
//
// Run: node --test plugins/communication-rules/checks/

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNamesArtifact } from "./name-the-artifact.mjs";

const filler = (n) => "This sentence is ordinary body prose that carries findings and context. ".repeat(n);

// A report-shaped message: over the 400-char floor, speaking in report verbs, naming nothing.
const bareReport = (verb = "fixed") =>
  `I ${verb} the login flow today and verified the behavior by hand. ` +
  `The session handling was wrong before and now behaves as intended. ` +
  `${filler(7)}Everything was checked twice and the work is complete for this slice.`;

// ─── must not flag: the applicability gate ───────────────────────────────────

test("a short report naming nothing is below the floor", () => {
  const r = checkNamesArtifact("I fixed it. It works now.");
  assert.equal(r.applicable, false);
  assert.equal(r.reason, "below-floor");
  assert.equal(r.flagged, false);
});

test("a long message with no report verb is not a report and not applicable", () => {
  const r = checkNamesArtifact(filler(10) + "So that is the situation as it stands today.");
  assert.equal(r.applicable, false);
  assert.equal(r.reason, "no-report-verb");
  assert.equal(r.flagged, false);
});

// ─── must not flag: each artifact kind satisfies the check ───────────────────

test("an absolute path is an artifact", () => {
  const r = checkNamesArtifact(bareReport() + ` The change is in /Users/jo/src/server/auth.ts.`);
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "artifact-named");
  assert.equal(r.matchedVerb, "fixed");
});

test("a file:line token is an artifact", () => {
  const r = checkNamesArtifact(bareReport("updated") + ` See auth.ts:41 for the guard.`);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "artifact-named");
});

test("a fenced code block is an artifact", () => {
  const msg = `${bareReport("ran")}\n\n\`\`\`\nnode --test plugins/\n\`\`\`\n\nThat is the command.`;
  const r = checkNamesArtifact(msg);
  assert.equal(r.flagged, false);
});

test("an inline code span is an artifact", () => {
  const r = checkNamesArtifact(bareReport("added") + " The flag is `--reporter dot`.");
  assert.equal(r.flagged, false);
});

test("a URL is an artifact", () => {
  const r = checkNamesArtifact(bareReport("shipped") + " The PR is https://github.com/jo/repo/pull/12.");
  assert.equal(r.flagged, false);
});

test("a shell-command-looking line is an artifact, prompt or no prompt", () => {
  for (const line of ["$ node --test checks/", "git rebase main before landing", "❯ psql -c 'select 1'"]) {
    const r = checkNamesArtifact(`${bareReport("verified")}\n\n${line}\n\nDone.`);
    assert.equal(r.flagged, false, line);
  }
});

test("a relative path is an artifact", () => {
  const r = checkNamesArtifact(bareReport("removed") + " The file was deleted: ../old/notes.md is gone.");
  assert.equal(r.flagged, false);
});

// ─── must flag ───────────────────────────────────────────────────────────────

test("a report-shaped message naming no artifact is the finding", () => {
  const r = checkNamesArtifact(bareReport());
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "no-artifact-named");
});

test("operator verbs replace the default rather than extending it", () => {
  const msg = filler(10) + " The migration was deployed by hand.";
  assert.equal(checkNamesArtifact(msg).reason, "no-report-verb"); // "deployed" is not a default verb
  const withCustom = checkNamesArtifact(msg, { reportVerbs: ["deployed"] });
  assert.equal(withCustom.matchedVerb, "deployed");
  assert.equal(withCustom.reason, "no-artifact-named");
});

test("the floor is configurable and the check never throws", () => {
  for (const bad of [undefined, null, 7, "", "```", { toString: () => "fixed " + filler(9) }]) {
    const r = checkNamesArtifact(bad);
    assert.equal(typeof r.flagged, "boolean");
    if (r.flagged) assert.equal(r.applicable, true);
  }
  const low = checkNamesArtifact("I fixed the thing.", { minProseChars: 5 });
  assert.equal(low.applicable, true);
  assert.equal(low.reason, "no-artifact-named");
});
