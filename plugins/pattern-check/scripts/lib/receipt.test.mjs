import { test } from "node:test";
import assert from "node:assert/strict";
import { FAIL_COLUMNS, HEADER, failCellProblem, parseTable, render, SEPARATOR } from "./receipt.mjs";

// The five fail cells of a well-formed row.
const FAIL = "writes errors.log, systemMessage shown | rerun the hook | yes: idempotent on the same input | none: hooks never retry, 5 s timeout | errors.log line";
const row = (base, fail = FAIL) => `| ${base} | ${fail} |`;

test("the header has nine columns in the order the brief gives", () => {
  assert.equal(HEADER, "| new piece | existing pattern (file:line) | reuse / replace / new | reason | fails how | next step | restart-safe | bounded | evidence kept |");
  assert.equal(SEPARATOR, "|---|---|---|---|---|---|---|---|---|");
  assert.deepEqual(FAIL_COLUMNS, ["fails how", "next step", "restart-safe", "bounded", "evidence kept"]);
});

test("a nine-column table with header and separator parses; the decision is lower-cased; fail cells are kept", () => {
  const r = parseTable(`${HEADER}\n${SEPARATOR}\n${row("retry helper | src/net/retry.ts:12 | Reuse | same backoff")}\n${row("webhook parser | (none: grep webhook in src/) | new | nothing parses inbound webhooks", "throws ParseError, logged by the router at src/router.ts:40 | the 400 body names the bad field | yes: parsing is pure | n/a: no retries, one parse per request | the request id in the access log")}\n`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.noNewPieces, null);
  assert.deepEqual(r.rows[0], {
    piece: "retry helper", pattern: "src/net/retry.ts:12", decision: "reuse", reason: "same backoff",
    failsHow: "writes errors.log, systemMessage shown", nextStep: "rerun the hook", restartSafe: "yes: idempotent on the same input",
    bounded: "none: hooks never retry, 5 s timeout", evidenceKept: "errors.log line",
  });
  assert.equal(r.rows[1].bounded, "n/a: no retries, one parse per request");
});

test("rows without leading and trailing pipes and without a header parse too", () => {
  const r = parseTable(`config loader | src/config.ts:1 | replace | the new one takes env too | ${FAIL}`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows[0].decision, "replace");
});

test("an empty fail cell is refused, naming the column", () => {
  for (const [k, col] of FAIL_COLUMNS.entries()) {
    const cells = FAIL.split(" | ");
    cells[k] = "";
    const r = parseTable(row("a | src/a.ts:1 | reuse | ok", cells.join(" | ")));
    assert.equal(r.ok, false, col);
    assert.ok(r.error.includes(`"${col}" is empty`), r.error);
    assert.ok(r.error.includes('row "a"'), r.error);
  }
});

test("n/a is accepted only with a reason after it; placeholders are refused", () => {
  assert.equal(failCellProblem("bounded", "n/a: pure function"), null);
  assert.equal(failCellProblem("bounded", "N/A (no I/O)"), null);
  assert.equal(failCellProblem("bounded", "na - single attempt"), null);
  assert.equal(failCellProblem("bounded", "n/a because it never retries"), null);
  assert.match(failCellProblem("bounded", "n/a"), /n\/a without a reason/);
  assert.match(failCellProblem("bounded", "N/A"), /n\/a without a reason/);
  assert.match(failCellProblem("bounded", "n/a:"), /n\/a without a reason/);
  for (const p of ["-", "—", "?", "TBD", "todo", "unknown", "…", "...", "--", "?!"]) assert.match(failCellProblem("fails how", p), /placeholder/, p);
  assert.equal(failCellProblem("bounded", "none: one attempt"), null);
  assert.equal(failCellProblem("fails how", "nasty: throws"), null); // starts with "na" but is not n/a
  // Short real answers are answers: no minimum length.
  for (const v of ["throws", "retry", "stderr", "none", "pure"]) assert.equal(failCellProblem("fails how", v), null, v);
});

test("regression (codex review B1): n/a followed by a placeholder or punctuation is n/a without a reason", () => {
  for (const v of ["n/a: TBD", "n/a: -", "n/a: ?", "n/a: ...", "N/A (todo)", "n/a - unknown", "n/a: n/a", "n/a: —", "n/a:  :"]) {
    assert.match(failCellProblem("bounded", v) ?? "", /n\/a without a reason/, v);
  }
  const r = parseTable(row("a | src/a.ts:1 | reuse | ok", "n/a: TBD | n/a: - | yes: pure | n/a: ? | n/a: ..."));
  assert.equal(r.ok, false);
  assert.match(r.error, /row "a": "fails how" is n\/a without a reason/);
});

test("restart-safe must start with yes or no and say why", () => {
  assert.equal(failCellProblem("restart-safe", "yes: idempotent"), null);
  assert.equal(failCellProblem("restart-safe", "no, the migration is not reversible"), null);
  assert.equal(failCellProblem("restart-safe", "yes pure"), null);
  assert.equal(failCellProblem("restart-safe", "n/a: nothing runs twice"), null);
  assert.match(failCellProblem("restart-safe", "probably"), /must start with yes or no/);
  assert.match(failCellProblem("restart-safe", "yesterday it worked"), /must start with yes or no/);
});

test("regression (codex review B1): restart-safe yes or no without a reason is refused", () => {
  for (const v of ["yes", "yes:", "no,", "No -", "yes: TBD", "no: ?", "yes (…)"]) {
    assert.match(failCellProblem("restart-safe", v) ?? "", /restart-safe" says (yes|no) without a reason/, v);
  }
});

test("regression (codex review round 2, B1): placeholders decorated with punctuation or Markdown are still placeholders", () => {
  for (const v of ["n/a: TBD?", "n/a: TODO!", "n/a: TBD!", "n/a: **TBD**", "n/a: unknown?", "n/a: `todo`", "n/a: _TBD_", "n/a: (TBD?)", "n/a: tbd.", "n/a: ???"]) {
    assert.match(failCellProblem("bounded", v) ?? "", /n\/a without a reason/, v);
  }
  for (const v of ["yes: TBD?", "no: TODO!", "yes: **unknown**"]) {
    assert.match(failCellProblem("restart-safe", v) ?? "", /restart-safe" says (yes|no) without a reason/, v);
  }
  for (const v of ["TBD?", "**TBD**", "**n/a**", "`unknown`", "TODO!"]) {
    assert.match(failCellProblem("fails how", v) ?? "", /placeholder/, v);
  }
  // The complete row from the round-2 report.
  const r = parseTable("| x | a.ts:1 | reuse | same | n/a: TBD? | n/a: TODO! | yes: TBD? | n/a: **TBD** | n/a: unknown? |");
  assert.equal(r.ok, false);
  assert.match(r.error, /row "x": "fails how" is n\/a without a reason/);
  // Short genuine answers, decorated or not, still pass: only the ends are stripped, only for the check.
  for (const v of ["n/a: pure", "n/a: **pure**", "throws!", "0", "none", "C++ exception, logged", "n/a: (no I/O)"]) {
    assert.equal(failCellProblem("bounded", v), null, v);
  }
  assert.equal(failCellProblem("restart-safe", "yes: pure!"), null);
  assert.equal(failCellProblem("restart-safe", "no: **writes twice**"), null);
});

test("a four-column row is refused by default (record) and read with requireFailColumns false (old receipts)", () => {
  const old = "| retry helper | src/net/retry.ts:12 | reuse | same backoff |";
  const strict = parseTable(old);
  assert.equal(strict.ok, false);
  assert.match(strict.error, /row "retry helper" has no fail columns.*fails how \| next step \| restart-safe \| bounded \| evidence kept/);
  const lenient = parseTable(old, { requireFailColumns: false });
  assert.equal(lenient.ok, true, lenient.error);
  assert.equal(lenient.rows[0].failsHow, null);
});

test("a 0.2.0 receipt file re-parses leniently, header and front matter skipped", () => {
  const v020 = [
    "# pattern-check receipt", "", "session: k", "what: w", "opened: o", "recorded: r", "",
    "| new piece | existing pattern (file:line) | reuse / replace / new | reason |",
    "|---|---|---|---|",
    "| a | b:1 | reuse | c |",
    "",
  ].join("\n");
  const r = parseTable(v020, { requireFailColumns: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows.length, 1);
});

test("a bad decision word, a 'new' row without a reason, a reuse row without a pattern, a wrong cell count: rejected", () => {
  assert.match(parseTable(row("a | b | maybe | c")).error, /decision must be one of reuse, replace, new/);
  assert.match(parseTable(row("a | | new | ")).error, /a "new" row needs a reason/);
  assert.match(parseTable(row("a | | reuse | fine")).error, /needs the existing pattern/);
  assert.match(parseTable("| a | b | reuse |").error, /needs 9 cells/);
  assert.match(parseTable(row("| b | reuse | c")).error, /empty "new piece"/);
});

test("zero rows is valid only with a 'No new pieces:' line; empty input is rejected", () => {
  assert.match(parseTable("").error, /the receipt is empty/);
  assert.match(parseTable("\n\n").error, /the receipt is empty/);
  const r = parseTable("No new pieces: the change is a copy edit in two existing files");
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows, []);
  assert.equal(r.noNewPieces, "the change is a copy edit in two existing files");
  assert.match(parseTable("no new pieces:   ").error ?? "", /neither a table row/);
});

test("'No new pieces' and rows together are rejected; a stray prose line is rejected", () => {
  assert.match(parseTable(`No new pieces: x\n${row("a | b | reuse | c")}`).error, /cannot both be present/);
  assert.match(parseTable(`here is my table\n${row("a | b | reuse | c")}`).error, /neither a table row/);
});

test("a literal pipe is written \\| in a cell and survives render and re-parse", () => {
  const r = parseTable(row("a | b:1 | reuse | c", "prints to stderr \\| tail shows it | rerun | yes: pure | n/a: no retry | stderr only"));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows[0].failsHow, "prints to stderr | tail shows it");
  const again = parseTable(render({ key: "k", what: null, opened: null, recorded: "r", rows: r.rows, noNewPieces: null }));
  assert.equal(again.ok, true, again.error);
  assert.equal(again.rows[0].failsHow, "prints to stderr | tail shows it");
});

test("a receipt file re-parses: its front matter lines are skipped", () => {
  const parsed = parseTable(row("a | b:1 | reuse | c")).rows;
  const text = render({ key: "k", what: "w", opened: "o", recorded: "r", rows: parsed, noNewPieces: null });
  assert.match(text, /^# pattern-check receipt\n\nsession: k\nwhat: w\nopened: o\nrecorded: r\n\n/);
  assert.ok(text.includes(`${HEADER}\n${SEPARATOR}\n| a | b:1 | reuse | c | ${FAIL} |`), text);
  const r = parseTable(text);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows.length, 1);
  const none = render({ key: "k", what: null, opened: null, recorded: "r", rows: [], noNewPieces: "copy edit" });
  assert.match(none, /what: \(not opened\)\n/);
  assert.equal(parseTable(none).noNewPieces, "copy edit");
});
