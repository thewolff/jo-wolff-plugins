// receipt.mjs — the receipt: what it must contain, how it is parsed, how it is written.
//
// A receipt is Markdown at <repo root>/<receiptDir>/<session key>.md, with a copy in the state
// directory. Its body is one table, nine columns:
//
//   | new piece | existing pattern (file:line) | reuse / replace / new | reason |
//   | fails how | next step | restart-safe | bounded | evidence kept |
//
// (one row, split here for width). The first four say what exists already; the last five say how
// the piece fails, before it is written:
//
//   fails how      what breaks and what the operator sees: where it is logged or surfaced
//   next step      what the failure message tells the reader to do
//   restart-safe   `yes` or `no`, then why (is a rerun after a crash safe?)
//   bounded        the retry or deadline bound, or `n/a: <why>`
//   evidence kept  what survives cleanup (logs, files, rows) for the person debugging it
//
// `reuse` and `replace` name the existing pattern; `new` needs a reason, because "nothing like it
// exists" is the claim the whole check exists to make an agent earn. Every fail column must be
// filled; `n/a` is accepted only with a reason after it (`n/a: pure function, nothing to retry`).
// A receipt with no rows is valid only when it says, in so many words, `No new pieces: <reason>`.
// An empty receipt, a row whose decision is not one of the three words, or a row with an empty
// fail column is rejected and nothing is written.
//
// BACKWARD COMPATIBLE. Receipts written by 0.1 and 0.2 have four columns. The hooks only check
// that a receipt file exists, so an old receipt still lifts the hold. `parseTable(text,
// { requireFailColumns: false })` reads a four-column table too (fail fields null); `record`
// parses with the default, which requires the nine.
//
// The parser accepts the table with or without a header row and with or without leading and
// trailing pipes, and ignores the `|---|` separator line. A literal pipe inside a cell is written
// `\|`. A `No new pieces:` line may appear instead of the table.

export const DECISIONS = Object.freeze(["reuse", "replace", "new"]);
export const NO_NEW_PIECES = /^\s*no new pieces\s*:\s*(.+?)\s*$/i;
export const BASE_COLUMNS = Object.freeze(["new piece", "existing pattern (file:line)", "reuse / replace / new", "reason"]);
export const FAIL_COLUMNS = Object.freeze(["fails how", "next step", "restart-safe", "bounded", "evidence kept"]);
const FAIL_KEYS = Object.freeze(["failsHow", "nextStep", "restartSafe", "bounded", "evidenceKept"]);
export const HEADER = `| ${[...BASE_COLUMNS, ...FAIL_COLUMNS].join(" | ")} |`;
export const SEPARATOR = `|${"---|".repeat(BASE_COLUMNS.length + FAIL_COLUMNS.length)}`;

const HEADER_CELL = /^new piece$/i;
// `n/a`, `N/A`, `na`, `n.a.`, then the reason (if any) after a separator: blank, `:`, `(`, `,`,
// `;`, `-`, `–` or `—`, spaced or not.
const NA = /^n\/?\.?a\.?(?=$|[\s:(,;\-–—])(.*)$/i;
const PLACEHOLDER = /^(?:tbd|tba|tbc|todo|fixme|unknown|n\/?\.?a\.?)$/i;
const RESTART = /^(yes|no)\b(.*)$/i;

/**
 * The cell as the checks read it: Markdown emphasis and code markers removed everywhere
 * (`*`, `` ` ``, `~`, and `_` at a word edge, so `snake_case` keeps its underscore), blanks
 * collapsed. Only for classification; the receipt keeps the cell as written.
 */
function forCheck(value) {
  return String(value ?? "")
    .replace(/[*`~]+/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=$|[^\p{L}\p{N}])/gu, "$1")
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
 * Parses receipt text (a table, or a `No new pieces: ...` line) into rows.
 * @param {string} text
 * @param {{ requireFailColumns?: boolean }} [opts] false reads 0.1/0.2 four-column receipts too
 * @returns {{ ok: true, rows: Array<{ piece: string, pattern: string, decision: string, reason: string, failsHow: string|null, nextStep: string|null, restartSafe: string|null, bounded: string|null, evidenceKept: string|null }>, noNewPieces: string|null } | { ok: false, error: string }}
 */
export function parseTable(text, { requireFailColumns = true } = {}) {
  const lines = String(text ?? "").split(/\r?\n/);
  const rows = [];
  let noNewPieces = null;
  const full = BASE_COLUMNS.length + FAIL_COLUMNS.length;
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
    const legacy = cells.length === BASE_COLUMNS.length;
    if (!legacy && cells.length !== full) {
      return { ok: false, error: `a row needs ${full} cells (${[...BASE_COLUMNS, ...FAIL_COLUMNS].join(" | ")}), got ${cells.length}: ${line}` };
    }
    const [piece, pattern, decisionRaw, reason] = cells;
    const decision = decisionRaw.toLowerCase();
    if (piece === "") return { ok: false, error: `a row has an empty "new piece" cell: ${line}` };
    if (!DECISIONS.includes(decision)) return { ok: false, error: `decision must be one of ${DECISIONS.join(", ")}, got "${decisionRaw}": ${line}` };
    if (decision === "new" && reason === "") return { ok: false, error: `a "new" row needs a reason: ${line}` };
    if (decision !== "new" && pattern === "") return { ok: false, error: `a "${decision}" row needs the existing pattern (file:line): ${line}` };
    if (legacy && requireFailColumns) {
      return { ok: false, error: `row "${piece}" has no fail columns; every piece needs ${FAIL_COLUMNS.join(" | ")} after the reason (n/a only with a reason: "n/a: <why>"): ${line}` };
    }
    const fail = {};
    for (let k = 0; k < FAIL_KEYS.length; k++) {
      const value = legacy ? null : cells[BASE_COLUMNS.length + k];
      if (!legacy) {
        const problem = failCellProblem(FAIL_COLUMNS[k], value);
        if (problem) return { ok: false, error: `row "${piece}": ${problem}. Fill it by reading the piece's error paths, not by guessing: ${line}` };
      }
      fail[FAIL_KEYS[k]] = value;
    }
    rows.push({ piece, pattern, decision, reason, ...fail });
  }
  if (rows.length === 0 && noNewPieces === null) {
    return { ok: false, error: 'the receipt is empty: give at least one row, or the line "No new pieces: <reason>"' };
  }
  if (rows.length > 0 && noNewPieces !== null) {
    return { ok: false, error: '"No new pieces" and table rows cannot both be present' };
  }
  return { ok: true, rows, noNewPieces };
}

/** The receipt file's text. Rows are rendered with all nine columns. */
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
  const cellsOf = (r) => [r.piece, r.pattern, r.decision, r.reason, ...FAIL_KEYS.map((k) => r[k] ?? "")];
  const body = [HEADER, SEPARATOR, ...rows.map((r) => `| ${cellsOf(r).map(escapeCell).join(" | ")} |`)];
  return `${[...head, ...body].join("\n")}\n`;
}
