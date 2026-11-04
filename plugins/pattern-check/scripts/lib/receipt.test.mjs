import { test } from "node:test";
import assert from "node:assert/strict";
import { COLUMNS, DESIGN_COLUMN, FAIL_COLUMNS, HEADER, designCellProblem, failCellProblem, parseTable, render, SEPARATOR } from "./receipt.mjs";

// The better design cell and the five fail cells of a well-formed row.
const DESIGN = "none: weighed a shared helper, more than one caller needs";
const FAIL = "writes errors.log, systemMessage shown | rerun the hook | yes: idempotent on the same input | none: hooks never retry, 5 s timeout | errors.log line";
const row = (base, fail = FAIL, design = DESIGN) => `| ${base} | ${design} | ${fail} |`;

test("the header has ten columns in the order the brief gives", () => {
  assert.equal(HEADER, "| new piece | existing pattern (file:line) | reuse / replace / new | reason | better design | fails how | next step | restart-safe | bounded | evidence kept |");
  assert.equal(SEPARATOR, "|---|---|---|---|---|---|---|---|---|---|");
  assert.equal(DESIGN_COLUMN, "better design");
  assert.deepEqual(FAIL_COLUMNS, ["fails how", "next step", "restart-safe", "bounded", "evidence kept"]);
  assert.equal(COLUMNS.length, 10);
});

test("a ten-column table with header and separator parses; the decision is lower-cased; design and fail cells are kept", () => {
  const r = parseTable(`${HEADER}\n${SEPARATOR}\n${row("retry helper | src/net/retry.ts:12 | Reuse | same backoff")}\n${row("webhook parser | (none: grep webhook in src/) | new | nothing parses inbound webhooks", "throws ParseError, logged by the router at src/router.ts:40 | the 400 body names the bad field | yes: parsing is pure | n/a: no retries, one parse per request | the request id in the access log", "one inbound module for parse and verify (fewer moving parts); costs: the outbound client's signer moves into it")}\n`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.noNewPieces, null);
  assert.deepEqual(r.rows[0], {
    piece: "retry helper", pattern: "src/net/retry.ts:12", decision: "reuse", reason: "same backoff", betterDesign: DESIGN,
    failsHow: "writes errors.log, systemMessage shown", nextStep: "rerun the hook", restartSafe: "yes: idempotent on the same input",
    bounded: "none: hooks never retry, 5 s timeout", evidenceKept: "errors.log line",
  });
  assert.equal(r.rows[1].betterDesign, "one inbound module for parse and verify (fewer moving parts); costs: the outbound client's signer moves into it");
  assert.equal(r.rows[1].bounded, "n/a: no retries, one parse per request");
});

test("rows without leading and trailing pipes and without a header parse too", () => {
  const r = parseTable(`config loader | src/config.ts:1 | replace | the new one takes env too | none: weighed a schema-checked loader, more than this repo needs | ${FAIL}`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows[0].decision, "replace");
  assert.equal(r.rows[0].betterDesign, "none: weighed a schema-checked loader, more than this repo needs");
});

test("the better design cell: none with what was weighed, or an answer, is accepted; empty, bare none, placeholder or bare n/a is refused naming row and column", () => {
  assert.equal(designCellProblem("none: weighed a side table, more moving parts"), null);
  assert.equal(designCellProblem("None — weighed a side table"), null);
  assert.equal(designCellProblem("**none**: weighed a side table"), null);
  assert.equal(designCellProblem("a column on story_revisions (fewer moving parts); costs: the join table's two readers move"), null);
  assert.match(designCellProblem(""), /"better design" is empty/);
  assert.match(designCellProblem("   "), /"better design" is empty/);
  for (const p of ["-", "—", "?", "TBD", "todo", "unknown", "…", "n/a", "N/A", "**tbd**", "(TBD?)"]) assert.match(designCellProblem(p), /"better design" is a placeholder/, p);
  // In a row: the message names the row and the column, and nothing else is reported first.
  const empty = parseTable(row("a | src/a.ts:1 | reuse | ok", FAIL, ""));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /^row "a": "better design" is empty \(write "none: <what was weighed>", or the better design with its axis and its cost\): /);
  const placeholder = parseTable(row("a | src/a.ts:1 | reuse | ok", FAIL, "TBD"));
  assert.equal(placeholder.ok, false);
  assert.match(placeholder.error, /^row "a": "better design" is a placeholder \(TBD\), not an answer/);
  // The design cell is checked before the fail cells: a row with both wrong names the design cell.
  const both = parseTable(row("a | src/a.ts:1 | reuse | ok", FAIL.replace(/^[^|]+/, ""), "?"));
  assert.match(both.error, /"better design" is a placeholder/);
});

test("regression (codex review 0.8.0, S2): a bare none is refused; none has to say what was weighed", () => {
  const bare = ["none", "None", "NONE", "**none**", "`none`", "_none_", "(none)", "none.", "none?", "none:", "none —",
    "nothing", "Nothing.", "nothing better", "Nothing better:", "no better", "No better.", "no better design", "**No better design**"];
  for (const v of bare) {
    assert.match(designCellProblem(v) ?? "", /"better design" says none without what was weighed \(write "none: <what was weighed>"/, v);
    assert.equal(designCellProblem(`${v.replace(/[.:?]$/, "")}: weighed X`), null, `${v}: weighed X`);
  }
  assert.equal(designCellProblem("Nothing-shaped loader (fewer moving parts); costs: two callers move"), null);
  const r = parseTable(row("a | src/a.ts:1 | reuse | ok", FAIL, "none"));
  assert.equal(r.ok, false);
  assert.match(r.error, /^row "a": "better design" says none without what was weighed/);
});

test("regression (codex review 0.8.0, S1): a none or n/a prefix with a placeholder after it, or a deferral, is not an answer", () => {
  for (const v of ["none: TBD", "none: todo", "**none**: TBD?", "none — unknown", "None: see above", "none: tbd later"]) {
    assert.match(designCellProblem(v) ?? "", /says none without what was weighed/, v);
  }
  for (const v of ["n/a: TBD", "n/a: todo", "N/A - TBD", "**n/a**: TBD", "(n/a: TBD)", "n/a—tbd", "tbd later", "TODO: decide", "see above", "See below", "same as above", "ditto", "n/a: see above"]) {
    assert.match(designCellProblem(v) ?? "", /"better design" is a placeholder/, v);
    const r = parseTable(row("a | src/a.ts:1 | reuse | ok", FAIL, v));
    assert.equal(r.ok, false, v);
    assert.match(r.error, /^row "a": "better design" is a placeholder/, v);
  }
  // Genuine answers that only look close stay accepted.
  for (const v of ["n/a: one caller, nothing to share", "todolist module (fewer moving parts); costs: two callers move", "nonexistent today: one loader (closes the gap); costs: three scripts migrate"]) {
    assert.equal(designCellProblem(v), null, v);
  }
});

test("a nine-column row (0.3, no better design) is refused by record, naming the row and the missing cell", () => {
  const r = parseTable(`| a | src/a.ts:1 | reuse | ok | ${FAIL} |`);
  assert.equal(r.ok, false);
  assert.match(r.error, /^row "a" has no "better design" cell; every piece needs it after the reason, before fails how \(write "none: <what was weighed>", or the better design with its axis and its cost\): /);
  const lenient = parseTable(`| a | src/a.ts:1 | reuse | ok | ${FAIL} |`, { requireAllColumns: false });
  assert.equal(lenient.ok, true, lenient.error);
  assert.equal(lenient.rows[0].betterDesign, null);
  assert.equal(lenient.rows[0].failsHow, "writes errors.log, systemMessage shown");
  assert.equal(lenient.rows[0].evidenceKept, "errors.log line");
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
  for (const v of ["TBD?", "**TBD**", "`unknown`", "TODO!"]) {
    assert.match(failCellProblem("fails how", v) ?? "", /placeholder/, v);
  }
  // Since round 3 the cell is normalized before the n/a split, so a bolded bare n/a is named as such.
  assert.match(failCellProblem("fails how", "**n/a**") ?? "", /n\/a without a reason/);
  // The complete row from the round-2 report.
  const r = parseTable(`| x | a.ts:1 | reuse | same | ${DESIGN} | n/a: TBD? | n/a: TODO! | yes: TBD? | n/a: **TBD** | n/a: unknown? |`);
  assert.equal(r.ok, false);
  assert.match(r.error, /row "x": "fails how" is n\/a without a reason/);
  // Short genuine answers, decorated or not, still pass: only the ends are stripped, only for the check.
  for (const v of ["n/a: pure", "n/a: **pure**", "throws!", "0", "none", "C++ exception, logged", "n/a: (no I/O)"]) {
    assert.equal(failCellProblem("bounded", v), null, v);
  }
  assert.equal(failCellProblem("restart-safe", "yes: pure!"), null);
  assert.equal(failCellProblem("restart-safe", "no: **writes twice**"), null);
});

test("regression (codex review round 3, B1): Markdown or dash decoration on the n/a prefix does not hide a placeholder reason", () => {
  for (const v of ["**n/a: TBD**", "**n/a**: TBD", "n/a—TBD", "_n/a_ – tbd", "n/a–TBD", "n/a-TBD", "`n/a`: todo", "(n/a: TBD)", "~~n/a~~ — unknown"]) {
    assert.match(failCellProblem("bounded", v) ?? "", /n\/a without a reason/, v);
    // The full row, every fail cell except restart-safe holding the value: refused, nothing saved.
    const r = parseTable(`| x | a.ts:1 | reuse | same | ${DESIGN} | ${v} | ${v} | yes: pure | ${v} | ${v} |`);
    assert.equal(r.ok, false, v);
    assert.match(r.error, /row "x": "fails how" is n\/a without a reason/, v);
  }
  for (const v of ["**yes**: TBD", "**yes: TBD**", "_no_ – tbd"]) {
    assert.match(failCellProblem("restart-safe", v) ?? "", /restart-safe" says (yes|no) without a reason/, v);
  }
});

test("regression (codex review round 3): normalization keeps genuine answers and saves the cell as written", () => {
  for (const v of ["**n/a: pure**", "**n/a**: pure", "n/a—pure function", "_n/a_ – no retries", "n/a: 0", "0", "none", "uses snake_case keys", "`retry()` gives up after 3", "**throws** ParseError"]) {
    assert.equal(failCellProblem("bounded", v), null, v);
  }
  assert.equal(failCellProblem("restart-safe", "**yes**: pure"), null);
  assert.match(failCellProblem("restart-safe", "**probably**") ?? "", /must start with yes or no/);
  const r = parseTable(`| x | a.ts:1 | reuse | same | **none**: weighed a helper | **throws** ParseError | n/a—pure function | **yes**: pure | \`retry()\` gives up after 3 | none |`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows[0].betterDesign, "**none**: weighed a helper");
  assert.equal(r.rows[0].failsHow, "**throws** ParseError");
  assert.equal(r.rows[0].nextStep, "n/a—pure function");
  assert.equal(r.rows[0].bounded, "`retry()` gives up after 3");
});

test("regression (codex review round 4, B1): double-underscore runs and wrapping parens around the prefix are stripped whole", () => {
  // Placeholders: refused in a full row (every fail cell but restart-safe), nothing saved.
  for (const v of ["__n/a__—TODO", "__n/a__—`TODO!`", "__n/a__: tbd", "(__n/a__): **TBD**", "(n/a): TBD"]) {
    assert.match(failCellProblem("bounded", v) ?? "", /n\/a without a reason/, v);
    const r = parseTable(`| x | a.ts:1 | reuse | same | ${DESIGN} | ${v} | ${v} | yes: pure | ${v} | ${v} |`);
    assert.equal(r.ok, false, v);
    assert.match(r.error, /row "x": "fails how" is n\/a without a reason/, v);
  }
  assert.match(failCellProblem("restart-safe", "(__no__)–~~unknown~~") ?? "", /says no without a reason/);
  // Genuine answers: accepted in a full row and saved as written.
  for (const rs of ["(__no__) - writes twice", "(__yes__): pure"]) {
    assert.equal(failCellProblem("restart-safe", rs), null, rs);
    const r = parseTable(`| x | a.ts:1 | reuse | same | ${DESIGN} | throws | rerun | ${rs} | n/a: one call | the log |`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.rows[0].restartSafe, rs);
  }
  for (const v of ["uses snake_case keys", "calls __init__ then exits", "fails in __init__.py, logged", "(__n/a__) - no I/O", "__uses snake_case keys__"]) {
    assert.equal(failCellProblem("fails how", v), null, v);
  }
  const r = parseTable(`| x | a.ts:1 | reuse | same | ${DESIGN} | fails in __init__.py, logged | rerun | yes: pure | n/a: one call | uses snake_case keys |`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows[0].failsHow, "fails in __init__.py, logged");
  assert.equal(r.rows[0].evidenceKept, "uses snake_case keys");
});

test("a four-column row is refused by default (record) and read with requireAllColumns false (old receipts)", () => {
  const old = "| retry helper | src/net/retry.ts:12 | reuse | same backoff |";
  const strict = parseTable(old);
  assert.equal(strict.ok, false);
  assert.match(strict.error, /row "retry helper" has no fail columns.*better design \| fails how \| next step \| restart-safe \| bounded \| evidence kept/);
  const lenient = parseTable(old, { requireAllColumns: false });
  assert.equal(lenient.ok, true, lenient.error);
  assert.equal(lenient.rows[0].betterDesign, null);
  assert.equal(lenient.rows[0].failsHow, null);
});

test("0.2.0 and 0.3.x receipt files re-parse leniently, header and front matter skipped", () => {
  const v020 = [
    "# pattern-check receipt", "", "session: k", "what: w", "opened: o", "recorded: r", "",
    "| new piece | existing pattern (file:line) | reuse / replace / new | reason |",
    "|---|---|---|---|",
    "| a | b:1 | reuse | c |",
    "",
  ].join("\n");
  const r = parseTable(v020, { requireAllColumns: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows.length, 1);
  const v030 = [
    "# pattern-check receipt", "", "session: k", "what: w", "opened: o", "recorded: r", "",
    "| new piece | existing pattern (file:line) | reuse / replace / new | reason | fails how | next step | restart-safe | bounded | evidence kept |",
    "|---|---|---|---|---|---|---|---|---|",
    `| a | b:1 | reuse | c | ${FAIL} |`,
    "",
  ].join("\n");
  const r3 = parseTable(v030, { requireAllColumns: false });
  assert.equal(r3.ok, true, r3.error);
  assert.equal(r3.rows.length, 1);
  assert.equal(r3.rows[0].betterDesign, null);
  assert.equal(r3.rows[0].restartSafe, "yes: idempotent on the same input");
  // Lenient reading still checks what the old shape does carry.
  assert.match(parseTable("| a | b:1 | reuse | c | TBD | rerun | yes: pure | n/a: x | log |", { requireAllColumns: false }).error, /"fails how" is a placeholder/);
});

test("a bad decision word, a 'new' row without a reason, a reuse row without a pattern, a wrong cell count: rejected", () => {
  assert.match(parseTable(row("a | b | maybe | c")).error, /decision must be one of reuse, replace, new/);
  assert.match(parseTable(row("a | | new | ")).error, /a "new" row needs a reason/);
  assert.match(parseTable(row("a | | reuse | fine")).error, /needs the existing pattern/);
  assert.match(parseTable("| a | b | reuse |").error, /needs 10 cells/);
  assert.match(parseTable(`| a | b | reuse | c | none | ${FAIL} | extra |`).error, /needs 10 cells.*got 11/);
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
  const r = parseTable(row("a | b:1 | reuse | c", "prints to stderr \\| tail shows it | rerun | yes: pure | n/a: no retry | stderr only", "one writer \\| one reader (fewer moving parts); costs: two callers move"));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows[0].failsHow, "prints to stderr | tail shows it");
  assert.equal(r.rows[0].betterDesign, "one writer | one reader (fewer moving parts); costs: two callers move");
  const again = parseTable(render({ key: "k", what: null, opened: null, recorded: "r", rows: r.rows, noNewPieces: null }));
  assert.equal(again.ok, true, again.error);
  assert.equal(again.rows[0].failsHow, "prints to stderr | tail shows it");
  assert.equal(again.rows[0].betterDesign, "one writer | one reader (fewer moving parts); costs: two callers move");
});

test("a receipt file re-parses: its front matter lines are skipped", () => {
  const parsed = parseTable(row("a | b:1 | reuse | c")).rows;
  const text = render({ key: "k", what: "w", opened: "o", recorded: "r", rows: parsed, noNewPieces: null });
  assert.match(text, /^# pattern-check receipt\n\nsession: k\nwhat: w\nopened: o\nrecorded: r\n\n/);
  assert.ok(text.includes(`${HEADER}\n${SEPARATOR}\n| a | b:1 | reuse | c | ${DESIGN} | ${FAIL} |`), text);
  const r = parseTable(text);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows.length, 1);
  const none = render({ key: "k", what: null, opened: null, recorded: "r", rows: [], noNewPieces: "copy edit" });
  assert.match(none, /what: \(not opened\)\n/);
  assert.equal(parseTable(none).noNewPieces, "copy edit");
});
