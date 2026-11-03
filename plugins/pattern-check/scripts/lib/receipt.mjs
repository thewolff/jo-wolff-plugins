// receipt.mjs — the receipt: what it must contain, how it is parsed, how it is written.
//
// A receipt is Markdown at <repo root>/<receiptDir>/<session key>.md, with a copy in the state
// directory. Its body is one table, four columns:
//
//   | new piece | existing pattern (file:line) | reuse / replace / new | reason |
//
// `reuse` and `replace` name the existing pattern; `new` needs a reason, because "nothing like it
// exists" is the claim the whole check exists to make an agent earn. A receipt with no rows is
// valid only when it says, in so many words, `No new pieces: <reason>`. An empty receipt, or a
// row whose decision is not one of the three words, is rejected and nothing is written.
//
// The parser accepts the table with or without a header row and with or without leading and
// trailing pipes, and ignores the `|---|` separator line. A `No new pieces:` line may appear
// instead of the table.

export const DECISIONS = Object.freeze(["reuse", "replace", "new"]);
export const NO_NEW_PIECES = /^\s*no new pieces\s*:\s*(.+?)\s*$/i;
export const HEADER = "| new piece | existing pattern (file:line) | reuse / replace / new | reason |";
export const SEPARATOR = "|---|---|---|---|";

const HEADER_CELL = /^new piece$/i;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/**
 * Parses receipt text (a table, or a `No new pieces: ...` line) into rows.
 * @param {string} text
 * @returns {{ ok: true, rows: Array<{ piece: string, pattern: string, decision: string, reason: string }>, noNewPieces: string|null } | { ok: false, error: string }}
 */
export function parseTable(text) {
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
    if (cells.length !== 4) return { ok: false, error: `a row needs 4 cells (new piece | existing pattern | reuse/replace/new | reason), got ${cells.length}: ${line}` };
    const [piece, pattern, decisionRaw, reason] = cells;
    const decision = decisionRaw.toLowerCase();
    if (piece === "") return { ok: false, error: `a row has an empty "new piece" cell: ${line}` };
    if (!DECISIONS.includes(decision)) return { ok: false, error: `decision must be one of ${DECISIONS.join(", ")}, got "${decisionRaw}": ${line}` };
    if (decision === "new" && reason === "") return { ok: false, error: `a "new" row needs a reason: ${line}` };
    if (decision !== "new" && pattern === "") return { ok: false, error: `a "${decision}" row needs the existing pattern (file:line): ${line}` };
    rows.push({ piece, pattern, decision, reason });
  }
  if (rows.length === 0 && noNewPieces === null) {
    return { ok: false, error: 'the receipt is empty: give at least one row, or the line "No new pieces: <reason>"' };
  }
  if (rows.length > 0 && noNewPieces !== null) {
    return { ok: false, error: '"No new pieces" and table rows cannot both be present' };
  }
  return { ok: true, rows, noNewPieces };
}

/** The receipt file's text. */
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
  const body = [HEADER, SEPARATOR, ...rows.map((r) => `| ${r.piece} | ${r.pattern} | ${r.decision} | ${r.reason} |`)];
  return `${[...head, ...body].join("\n")}\n`;
}
