// receipt.mjs — the receipt: what it must contain, how it is parsed, how it is written.
//
// A receipt is Markdown at <repo root>/<receiptDir>/<session key>.md, with a copy in the state
// directory. Its body is one table, ten columns:
//
//   | new piece | existing pattern (file:line) | reuse / replace / new | reason | better design |
//   | fails how | next step | restart-safe | bounded | evidence kept |
//
// (one row, split here for width). The first four say what exists already; the fifth says what
// would beat the pattern; the last five say how the piece fails, before it is written:
//
//   better design  `none: <what was weighed>`, or a design better than the pattern-fit one with
//                  the axis it wins on (fewer moving parts, a failure mode removed, a gap closed,
//                  what the repo would adopt today) and what it costs over the pattern
//   fails how      what breaks and what the operator sees: where it is logged or surfaced
//   next step      what the failure message tells the reader to do
//   restart-safe   `yes` or `no`, then why (is a rerun after a crash safe?)
//   bounded        the retry or deadline bound, or `n/a: <why>`
//   evidence kept  what survives cleanup (logs, files, rows) for the person debugging it
//
// `reuse` and `replace` name the existing pattern; `new` needs a reason, because "nothing like it
// exists" is the claim the whole check exists to make an agent earn. The better design cell is
// `none: <what was weighed>` or the design; a bare `none`, a placeholder (`-`, `?`, `TBD`, a bare
// `n/a`), a prefix with a placeholder after it (`none: TBD`, `n/a: TBD`) or a deferral (`tbd
// later`, `see above`) is refused, because "is there a better way?" is the second question this
// check asks on every row, and it is answered only by saying what was weighed. Every fail column
// must be filled; `n/a` is accepted only with a reason after it (`n/a: pure function, nothing to
// retry`). A receipt with no rows is valid only when it says, in so many words,
// `No new pieces: <reason>`. An empty receipt, a row whose decision is not one of the three
// words, a row without the better design cell, or a row with an empty fail column is rejected
// and nothing is written.
//
// BACKWARD COMPATIBLE. Receipts written by 0.1 and 0.2 have four columns; by 0.3, nine (no
// better design). The hooks only check that a receipt file exists, so an old receipt still lifts
// the hold. `parseTable(text, { requireAllColumns: false })` reads both older shapes too (the
// missing fields null); `record` parses with the default, which requires the ten.
//
// The parser accepts the table with or without a header row and with or without leading and
// trailing pipes, and ignores the `|---|` separator line. A literal pipe inside a cell is written
// `\|`. A `No new pieces:` line may appear instead of the table.

export const DECISIONS = Object.freeze(["reuse", "replace", "new"]);
export const NO_NEW_PIECES = /^\s*no new pieces\s*:\s*(.+?)\s*$/i;
export const BASE_COLUMNS = Object.freeze(["new piece", "existing pattern (file:line)", "reuse / replace / new", "reason"]);
export const DESIGN_COLUMN = "better design";
export const FAIL_COLUMNS = Object.freeze(["fails how", "next step", "restart-safe", "bounded", "evidence kept"]);
const FAIL_KEYS = Object.freeze(["failsHow", "nextStep", "restartSafe", "bounded", "evidenceKept"]);
export const COLUMNS = Object.freeze([...BASE_COLUMNS, DESIGN_COLUMN, ...FAIL_COLUMNS]);
export const HEADER = `| ${COLUMNS.join(" | ")} |`;
export const SEPARATOR = `|${"---|".repeat(COLUMNS.length)}`;

const HEADER_CELL = /^new piece$/i;
// `n/a`, `N/A`, `na`, `n.a.`, then the reason (if any) after a separator: blank, `:`, `(`, `)`,
// `,`, `;`, `-`, `–` or `—`, spaced or not. `)` closes a wrapped prefix: `(n/a): why`.
const NA = /^n\/?\.?a\.?(?=$|[\s:(),;\-–—])(.*)$/i;
const PLACEHOLDER = /^(?:tbd|tba|tbc|todo|fixme|unknown|n\/?\.?a\.?)$/i;
const RESTART = /^(yes|no)\b(.*)$/i;
const NONE = /^none\b(.*)$/i;
// A design cell that defers instead of answering: a placeholder word first (`tbd later`), or a
// pointer elsewhere (`see above`, `same as above`, `ditto`).
const DEFERRAL = /^(?:(?:tbd|tba|tbc|todo|fixme)(?=$|[\s:;,.!?)–—])|see (?:above|below)\b|(?:same )?as above\b|ditto\b)/i;
const DESIGN_HINT = 'write "none: <what was weighed>", or the better design with its axis and its cost';

// The three row shapes: 0.1/0.2 (four cells), 0.3 (nine: no better design), current (ten).
const LEGACY_FOUR = BASE_COLUMNS.length;
const LEGACY_NINE = BASE_COLUMNS.length + FAIL_COLUMNS.length;

/**
 * The cell as the checks read it: Markdown emphasis and code markers removed everywhere
 * (`*`, `` ` ``, `~`), and every run of `_` at a word edge removed whole (`__n/a__` reads as
 * `n/a`; `snake_case` keeps its inner underscore), blanks collapsed. Only for classification;
 * the receipt keeps the cell as written, so `__init__.py` reading as `init.py` here is harmless.
 */
function forCheck(value) {
  return String(value ?? "")
    .replace(/[*`~]+/g, "")
    .replace(/(^|[^\p{L}\p{N}_])_+|_+(?=$|[^\p{L}\p{N}_])/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a reason says something: it holds a letter or digit, and is not a placeholder word once
 * the punctuation around it is stripped (`TBD?`, `(todo)` are placeholders). The argument is
 * already through `forCheck`. No minimum length: `pure` and `0` are reasons.
 */
function substantive(reason) {
  const r = String(reason ?? "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return r !== "" && !PLACEHOLDER.test(r);
}

// Splits a row on unescaped pipes; `\|` becomes a literal pipe in the cell.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

const escapeCell = (c) => String(c).replace(/\|/g, "\\|");

/**
 * Why a fail cell is not acceptable, or null when it is. The cell is normalized first
 * (`forCheck`), then split into an n/a or yes/no prefix and its reason, then the reason is checked:
 * `**n/a: TBD**`, `**n/a**: TBD`, `n/a—TBD` and `_n/a_ – tbd` are all n/a without a reason.
 */
export function failCellProblem(column, value) {
  const v = String(value ?? "").trim();
  if (v === "") return `"${column}" is empty`;
  const c = forCheck(v).replace(/^[^\p{L}\p{N}]+/u, ""); // `(n/a: TBD)` reads as `n/a: TBD)`
  const na = c.match(NA);
  if (na) return substantive(na[1]) ? null : `"${column}" is n/a without a reason (write "n/a: <why>")`;
  if (!substantive(c)) return `"${column}" is a placeholder (${v}), not an answer`;
  if (column === "restart-safe") {
    const m = c.match(RESTART);
    if (!m) return `"restart-safe" must start with yes or no and say why, got "${v}"`;
    if (!substantive(m[2])) return `"restart-safe" says ${m[1].toLowerCase()} without a reason (write "${m[1].toLowerCase()}: <why>")`;
  }
  return null;
}

/**
 * Why the better design cell is not acceptable, or null when it is. `none: <what was weighed>`
 * is an answer; so is any design with its axis. The cell is normalized (`forCheck`), then split
 * into a `none` or `n/a` prefix and its reason, like the fail cells. An empty cell, a bare `none`
 * or `n/a`, a placeholder (`none: TBD`, `N/A - TBD`) or a deferral (`tbd later`, `see above`) is
 * not: the question has to be answered, and `none` has to say what was weighed.
 */
export function designCellProblem(value) {
  const v = String(value ?? "").trim();
  if (v === "") return `"${DESIGN_COLUMN}" is empty (${DESIGN_HINT})`;
  const c = forCheck(v).replace(/^[^\p{L}\p{N}]+/u, ""); // `(none: TBD)` reads as `none: TBD)`
  const none = c.match(NONE);
  if (none) return answers(none[1]) ? null : `"${DESIGN_COLUMN}" says none without what was weighed (${DESIGN_HINT})`;
  const na = c.match(NA);
  if (!answers(na ? na[1] : c)) return `"${DESIGN_COLUMN}" is a placeholder (${v}), not an answer (${DESIGN_HINT})`;
  return null;
}

/** Whether a design cell's text (after any prefix) answers: substantive and not a deferral. */
function answers(text) {
  const r = String(text ?? "").replace(/^[^\p{L}\p{N}]+/u, "");
  return substantive(r) && !DEFERRAL.test(r);
}

/**
 * Parses receipt text (a table, or a `No new pieces: ...` line) into rows.
 * @param {string} text
 * @param {{ requireAllColumns?: boolean }} [opts] false reads the 0.1/0.2 four-column and 0.3 nine-column receipts too
 * @returns {{ ok: true, rows: Array<{ piece: string, pattern: string, decision: string, reason: string, betterDesign: string|null, failsHow: string|null, nextStep: string|null, restartSafe: string|null, bounded: string|null, evidenceKept: string|null }>, noNewPieces: string|null } | { ok: false, error: string }}
 */
export function parseTable(text, { requireAllColumns = true } = {}) {
  const lines = String(text ?? "").split(/\r?\n/);
  const rows = [];
  let noNewPieces = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const nn = line.match(NO_NEW_PIECES);
    if (nn) { noNewPieces = nn[1]; continue; }
    if (!line.includes("|")) {
      if (line.startsWith("#") || /^(session|what|opened|recorded):/i.test(line)) continue; // receipt front matter
      return { ok: false, error: `line is neither a table row nor "No new pieces: <reason>": ${line}` };
    }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // the |---| separator
    if (HEADER_CELL.test(cells[0] ?? "")) continue;
    const shape = cells.length;
    if (shape !== LEGACY_FOUR && shape !== LEGACY_NINE && shape !== COLUMNS.length) {
      return { ok: false, error: `a row needs ${COLUMNS.length} cells (${COLUMNS.join(" | ")}), got ${shape}: ${line}` };
    }
    const [piece, pattern, decisionRaw, reason] = cells;
    const decision = decisionRaw.toLowerCase();
    if (piece === "") return { ok: false, error: `a row has an empty "new piece" cell: ${line}` };
    if (!DECISIONS.includes(decision)) return { ok: false, error: `decision must be one of ${DECISIONS.join(", ")}, got "${decisionRaw}": ${line}` };
    if (decision === "new" && reason === "") return { ok: false, error: `a "new" row needs a reason: ${line}` };
    if (decision !== "new" && pattern === "") return { ok: false, error: `a "${decision}" row needs the existing pattern (file:line): ${line}` };
    const hasFail = shape !== LEGACY_FOUR;
    if (requireAllColumns && !hasFail) {
      return { ok: false, error: `row "${piece}" has no fail columns; every piece needs ${DESIGN_COLUMN} | ${FAIL_COLUMNS.join(" | ")} after the reason (better design: "none: <what was weighed>" or the design with its axis; n/a only with a reason: "n/a: <why>"): ${line}` };
    }
    if (requireAllColumns && shape === LEGACY_NINE) {
      return { ok: false, error: `row "${piece}" has no "${DESIGN_COLUMN}" cell; every piece needs it after the reason, before ${FAIL_COLUMNS[0]} (${DESIGN_HINT}): ${line}` };
    }
    let betterDesign = null;
    let failStart = BASE_COLUMNS.length;
    if (shape === COLUMNS.length) {
      betterDesign = cells[BASE_COLUMNS.length];
      failStart += 1;
      const problem = designCellProblem(betterDesign);
      if (problem) return { ok: false, error: `row "${piece}": ${problem}: ${line}` };
    }
    const fail = {};
    for (let k = 0; k < FAIL_KEYS.length; k++) {
      const value = hasFail ? cells[failStart + k] : null;
      if (hasFail) {
        const problem = failCellProblem(FAIL_COLUMNS[k], value);
        if (problem) return { ok: false, error: `row "${piece}": ${problem}. Fill it by reading the piece's error paths, not by guessing: ${line}` };
      }
      fail[FAIL_KEYS[k]] = value;
    }
    rows.push({ piece, pattern, decision, reason, betterDesign, ...fail });
  }
  if (rows.length === 0 && noNewPieces === null) {
    return { ok: false, error: 'the receipt is empty: give at least one row, or the line "No new pieces: <reason>"' };
  }
  if (rows.length > 0 && noNewPieces !== null) {
    return { ok: false, error: '"No new pieces" and table rows cannot both be present' };
  }
  return { ok: true, rows, noNewPieces };
}

/** The receipt file's text. Rows are rendered with all ten columns. */
export function render({ key, what, opened, recorded, rows, noNewPieces }) {
  const head = [
    "# pattern-check receipt",
    "",
    `session: ${key}`,
    `what: ${what ?? "(not opened)"}`,
    `opened: ${opened ?? "(not opened)"}`,
    `recorded: ${recorded}`,
    "",
  ];
  if (noNewPieces !== null && noNewPieces !== undefined) return `${[...head, `No new pieces: ${noNewPieces}`].join("\n")}\n`;
  const cellsOf = (r) => [r.piece, r.pattern, r.decision, r.reason, r.betterDesign ?? "", ...FAIL_KEYS.map((k) => r[k] ?? "")];
  const body = [HEADER, SEPARATOR, ...rows.map((r) => `| ${cellsOf(r).map(escapeCell).join(" | ")} |`)];
  return `${[...head, ...body].join("\n")}\n`;
}
