import { test } from "node:test";
import assert from "node:assert/strict";
import { renderUpkeep } from "./upkeep.mjs";

function evidence(overrides = {}) {
  return {
    candidate: "Example 2.4",
    asOf: "2026-10-20",
    window: "2026-04-20 through 2026-10-20",
    exitPath: "Use the maintained replacement and migrate data.",
    lastCommit: { date: "2026-10-01", receipt: "https://example.test/commit — observed commit" },
    lastRelease: { date: "2026-05-01", receipt: "https://example.test/releases — observed release" },
    issues: { opened: 12, closed: 10, sampleSize: 12, unanswered: 0, medianFirstHumanResponseHours: 8, receipt: "https://example.test/issues — 12 sampled" },
    maintainers: { count: 3, receipt: "https://example.test/contributors — 3 active humans" },
    compatibility: [{ runtime: "Node", installed: "22", detectionReceipt: "node --version → v22", status: "supported", supportReceipt: "https://example.test/support — Node 22 supported" }],
    ...overrides,
  };
}

test("healthy evidence retains all fixed fields and provenance without warnings or popularity signals", () => {
  const report = renderUpkeep(evidence());
  for (const text of ["Example 2.4", "2026-10-20", "2026-04-20 through 2026-10-20", "Last commit:", "Last release:", "Issues:", "Active human maintainers:", "Runtime compatibility:", "https://example.test/commit", "https://example.test/issues", "https://example.test/contributors", "node --version → v22"]) assert.ok(report.includes(text), text);
  assert.doesNotMatch(report, /stars|score|rank|recommendation boolean|gate verdict|\*\*Upkeep warning:\*/i);
  assert.match(report, /Warnings \/ exit paths:\n- None identified/);
});

test("six calendar months is inclusive; newer releases are the control and month ends clamp", () => {
  const threshold = renderUpkeep(evidence({ asOf: "2026-10-20", lastRelease: { date: "2026-04-20", receipt: "release receipt" } }));
  assert.match(threshold, /Last release is at least six calendar months old/);
  const newer = renderUpkeep(evidence({ lastRelease: { date: "2026-04-21", receipt: "release receipt" } }));
  assert.doesNotMatch(newer, /Last release is at least six calendar months old/);
  const monthEndBefore = renderUpkeep(evidence({ asOf: "2026-08-31", lastRelease: { date: "2026-03-01", receipt: "release receipt" } }));
  assert.doesNotMatch(monthEndBefore, /Last release is at least six calendar months old/);
  const monthEndOlder = renderUpkeep(evidence({ asOf: "2026-08-31", lastRelease: { date: "2026-02-27", receipt: "release receipt" } }));
  assert.match(monthEndOlder, /Last release is at least six calendar months old/);
});

for (const { release, before, at, after } of [
  { release: "2026-04-20", before: "2026-10-19", at: "2026-10-20", after: "2026-10-21" },
  { release: "2026-08-31", before: "2027-02-27", at: "2027-02-28", after: "2027-03-01" },
  { release: "2027-08-31", before: "2028-02-28", at: "2028-02-29", after: "2028-03-01" },
  { release: "2028-02-29", before: "2028-08-28", at: "2028-08-29", after: "2028-08-30" },
]) {
  for (const [boundary, asOf, shouldWarn] of [
    ["before", before, false],
    ["at", at, true],
    ["after", after, true],
  ]) {
    test(`release ${release} ${boundary} its clamped six-month anniversary ${at} as of ${asOf}`, () => {
      const report = renderUpkeep(evidence({
        asOf,
        window: `${release} through ${asOf}`,
        lastCommit: { date: asOf, receipt: "recent commit receipt" },
        lastRelease: { date: release, receipt: "release receipt" },
      }));
      if (shouldWarn) assert.match(report, /Last release is at least six calendar months old/);
      else assert.doesNotMatch(report, /Last release is at least six calendar months old/);
    });
  }
}

test("a recent commit does not clear the stale release warning", () => {
  const report = renderUpkeep(evidence({ lastCommit: { date: "2026-10-19", receipt: "commit receipt" }, lastRelease: { date: "2026-04-20", receipt: "release receipt" } }));
  assert.match(report, /Last release is at least six calendar months old/);
});

for (const opened of [12, null]) {
  test(`issue qualification stays alongside the summary with ${opened === null ? "unknown" : "known"} counts`, () => {
    const reason = "Opened/closed counts are sampled, not complete window totals";
    const report = renderUpkeep(evidence({ issues: {
      ...evidence().issues,
      opened,
      receipt: "https://example.test/issues — observed measurements",
      reason,
    } }));
    const issueLine = report.split("\n").find((line) => line.startsWith("- Issues:"));
    assert.ok(issueLine.includes(`; reason: ${reason}; median first human response: 8 hours`));
    assert.ok(issueLine.includes(opened === null ? "opened: unknown" : "opened: 12 —"));
    assert.match(issueLine, /closed: 10 —.*sampleSize: 12 —.*unanswered: 0 —/);
  });
}

test("solo, zero, and unknown maintainer evidence are meaningfully warned", () => {
  const solo = renderUpkeep(evidence({ maintainers: { count: 1, receipt: "one human" } }));
  assert.match(solo, /Only one active human maintainer/);
  const zero = renderUpkeep(evidence({ maintainers: { count: 0, receipt: "no humans found" } }));
  assert.match(zero, /No active human maintainers/);
  const unknown = renderUpkeep(evidence({ maintainers: { count: null, receipt: "contributors checked", reason: "activity could not be distinguished" } }));
  assert.match(unknown, /Active human maintainer count is unknown/);
  assert.match(unknown, /activity could not be distinguished/);
});

test("missing records and receiptless evidence stay unknown with meaningful warnings", () => {
  const report = renderUpkeep(evidence({ lastCommit: { date: "2026-10-01", receipt: "   " }, issues: { opened: 1, closed: null, sampleSize: 2, unanswered: null, medianFirstHumanResponseHours: null, receipt: "" }, compatibility: [] }));
  assert.match(report, /Last commit: unknown \(date lacks receipt/);
  assert.match(report, /closed: unknown/);
  assert.match(report, /Issues opened has no receipt/);
  assert.match(report, /No measurable human response is evidenced/);
  assert.match(report, /No runtime compatibility evidence was collected/);
  assert.match(report, /\*\*Upkeep warning:\*/);
  assert.match(report, /Exit path: Use the maintained replacement and migrate data\./);
});

test("compatibility requires installed version and both nonblank provenance receipts", () => {
  const report = renderUpkeep(evidence({ compatibility: [
    { runtime: "Node", installed: "22", detectionReceipt: "node --version → 22", status: "supported", supportReceipt: "support page" },
    { runtime: "Python", installed: "3.12", detectionReceipt: "python --version → 3.12", status: "unsupported", supportReceipt: "unsupported matrix" },
    { runtime: "Ruby", installed: null, detectionReceipt: "not installed", status: "unknown", supportReceipt: "", reason: "no matrix" },
    { runtime: "Deno", installed: "2", detectionReceipt: "  ", status: "supported", supportReceipt: "support matrix" },
  ] }));
  assert.match(report, /Node: supported/);
  assert.match(report, /Python: unsupported/);
  assert.match(report, /Ruby: unknown/);
  assert.match(report, /Deno: unknown/);
  assert.match(report, /Python is reported unsupported/);
  assert.match(report, /Ruby compatibility is unknown/);
});

test("zero or wholly unanswered samples cannot yield a measurable response median", () => {
  for (const issueFields of [
    { sampleSize: 0, unanswered: 0, medianFirstHumanResponseHours: 0 },
    { sampleSize: 4, unanswered: 4, medianFirstHumanResponseHours: 0 },
  ]) {
    const report = renderUpkeep(evidence({ issues: { opened: 4, closed: 0, receipt: "issue sample", ...issueFields } }));
    assert.match(report, /median first human response: unknown/);
    assert.match(report, /No measurable human response is evidenced/);
  }
});

test("invalid dates cannot produce healthy output and malformed required inputs fail clearly", () => {
  const report = renderUpkeep(evidence({ lastRelease: { date: "2026-02-30", receipt: "receipt" } }));
  assert.match(report, /Last release: unknown \(invalid date/);
  assert.match(report, /Last release date is malformed/);
  assert.throws(() => renderUpkeep(evidence({ asOf: "2026-02-30" })), /asOf must be a valid/);
  assert.throws(() => renderUpkeep(evidence({ window: "" })), /window must disclose/);
});

test("stars and candidate age have no effect when upkeep evidence is identical", () => {
  const first = evidence();
  const second = { ...evidence(), stars: 1, createdAt: "2000-01-01" };
  assert.equal(renderUpkeep(first), renderUpkeep(second));
});
