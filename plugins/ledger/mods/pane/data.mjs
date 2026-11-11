// data.mjs — the pane's pure functions: the command grammar, the argv the ledger CLI gets, the
// CLI's JSON read back, the snapshot query.mjs prints, and the one-line fallback.
//
// No imports: this file is loaded inside Claude Code by the hooks module (register.mjs), where
// only relative imports and `claude-code` are allowed, and by `node --test` for its unit tests.

/** The pane's id for `$.ui.open`, `$.ui.close` and `e.requestId`. */
export const PANE_ID = "ledger";

export const USAGE = "usage: /ledger (open the pane) · /ledger answer <q-id> <reply> (record an answer, no Claude turn) · /ledger close";

const Q_ID = /^q-[a-z0-9]+$/i;

/**
 * The text after `/ledger` → what to do.
 *   ''                      → { kind: 'open' }
 *   open                    → { kind: 'open' }
 *   close                   → { kind: 'close' }
 *   answer <q-id> <reply…>  → { kind: 'answer', id, reply }   (reply keeps its inner spacing collapsed)
 *   <word> <q-id>           → { kind: 'answer', id, reply: word }   (the ledger's short form)
 *   anything else           → { kind: 'usage', text }
 */
export function parseCommand(args) {
  const text = String(args ?? "").trim();
  if (text === "" || /^open$/i.test(text)) return { kind: "open" };
  if (/^close$/i.test(text)) return { kind: "close" };
  const tokens = text.split(/\s+/);
  if (/^answer$/i.test(tokens[0])) {
    if (tokens.length >= 3 && Q_ID.test(tokens[1])) return { kind: "answer", id: tokens[1].toLowerCase(), reply: tokens.slice(2).join(" ") };
    if (tokens.length === 2 && Q_ID.test(tokens[1])) return { kind: "usage", text: `answer needs a reply: /ledger answer ${tokens[1]} <reply>` };
    return { kind: "usage", text: "answer needs a question id and a reply: /ledger answer <q-id> <reply>" };
  }
  if (tokens.length === 2 && Q_ID.test(tokens[1])) return { kind: "answer", id: tokens[1].toLowerCase(), reply: tokens[0] };
  return { kind: "usage", text: USAGE };
}

/** The argv for `node scripts/ledger.mjs` that records `reply` on question `id`; the reply is one token so its spaces survive. */
export function answerArgv(id, reply) {
  return ["--json", "answer", id, String(reply).trim().replace(/\s+/g, " ")];
}

/**
 * The ledger CLI's `--json` output → { status: 'ok'|'noop'|'refused'|'error', message }.
 * The CLI prints a JSON array with one entry per line applied; exit 2 (store unavailable)
 * prints one plain line instead, which comes back as `error`.
 */
export function readCliResult({ exitCode, stdout, stderr }) {
  const out = String(stdout ?? "").trim();
  try {
    const arr = JSON.parse(out);
    const first = Array.isArray(arr) ? arr[0] : null;
    if (first && typeof first.status === "string") {
      return { status: first.status, message: String(first.message ?? "") };
    }
  } catch {
    // not JSON: the store-unavailable line, or a crash
  }
  const text = [out, String(stderr ?? "").trim()].filter(Boolean).join(" ").split("\n")[0] || `ledger exited ${exitCode}`;
  return { status: "error", message: text };
}

/** An empty snapshot: nothing waiting, nothing answered. */
export function emptySnapshot() {
  return { ok: true, since: null, elsewhere: [], answers: [] };
}

/**
 * What query.mjs printed → a snapshot the pane can draw, with every field present and typed:
 *   { ok: true, since, elsewhere: [{ id, cwd, name, body, options, default, state, asked_at, age }], answers: [{ id, name, body, state, word, via }] }
 *   { ok: false, error }
 * Anything unparseable or mis-shaped becomes `{ ok: false, error }`, never a throw.
 */
export function readSnapshot(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? "").trim());
  } catch {
    return { ok: false, error: "query printed no JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "query printed no object" };
  if (parsed.ok === false) return { ok: false, error: String(parsed.error ?? "query failed") };
  const elsewhere = Array.isArray(parsed.elsewhere) ? parsed.elsewhere.map(normalizeQuestion).filter(Boolean) : [];
  const answers = Array.isArray(parsed.answers) ? parsed.answers.map(normalizeAnswer).filter(Boolean) : [];
  return { ok: true, since: typeof parsed.since === "string" ? parsed.since : null, elsewhere, answers };
}

function normalizeQuestion(q) {
  if (!q || typeof q !== "object" || typeof q.id !== "string") return null;
  const options = Array.isArray(q.options) ? q.options.map(String) : [];
  return {
    id: q.id,
    cwd: typeof q.cwd === "string" ? q.cwd : "",
    name: typeof q.name === "string" ? q.name : q.id,
    body: typeof q.body === "string" ? q.body : "",
    options,
    default: typeof q.default === "string" ? q.default : null,
    state: q.state === "held" ? "held" : "open",
    asked_at: typeof q.asked_at === "string" ? q.asked_at : null,
    age: typeof q.age === "string" ? q.age : "",
  };
}

function normalizeAnswer(a) {
  if (!a || typeof a !== "object" || typeof a.id !== "string") return null;
  return {
    id: a.id,
    name: typeof a.name === "string" ? a.name : a.id,
    body: typeof a.body === "string" ? a.body : "",
    state: a.state === "withdrawn" ? "withdrawn" : "answered",
    word: typeof a.word === "string" ? a.word : "",
    via: typeof a.via === "string" ? a.via : "",
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The pane's first line: counts, or the error. */
export function headline(snapshot) {
  if (!snapshot.ok) return `ledger: ${snapshot.error}`;
  const folders = new Set(snapshot.elsewhere.map((q) => q.cwd)).size;
  const parts = [];
  if (snapshot.elsewhere.length) parts.push(`${plural(snapshot.elsewhere.length, "question")} waiting in ${plural(folders, "other folder")}`);
  if (snapshot.answers.length) parts.push(`${plural(snapshot.answers.length, "answer")} since your last turn`);
  return parts.length ? parts.join(" · ") : "nothing waiting elsewhere, no new answers";
}

/** The pane's heading over the answers, count first: `1 answer since your last turn`. */
export function answersHeading(snapshot) {
  return `${plural(snapshot.answers.length, "answer")} since your last turn`;
}

/** The pane's heading over the questions, count first: `2 questions waiting in other folders`. */
export function waitingHeading(snapshot) {
  const folders = new Set(snapshot.elsewhere.map((q) => q.cwd)).size;
  return `${plural(snapshot.elsewhere.length, "question")} waiting in ${folders === 1 ? "another folder" : "other folders"}`;
}

/**
 * Each folder's shortest trailing path that no other listed folder ends in: `newdle-mobile`, or
 * `a/web` and `b/web` when two folders are both called `web`. A folder with no path is `(no folder)`.
 */
export function folderLabels(cwds) {
  const parts = cwds.map((c) => String(c ?? "").split(/[\\/]+/).filter(Boolean));
  return cwds.map((cwd, i) => {
    const own = parts[i];
    if (!own.length) return "(no folder)";
    for (let n = 1; n < own.length; n++) {
      const tail = own.slice(-n).join("/");
      if (!parts.some((other, j) => cwds[j] !== cwd && other.slice(-n).join("/") === tail)) return tail;
    }
    return own.join("/");
  });
}

const ID = String.raw`(?:q|an|nt|oc)-[a-z0-9]+`;

// The refusals `ledger --json answer <q-id> <reply>` gives (lib/commands.mjs), each as the pane
// says it. The reply in `already answered <reply>` is the human's own text and is kept whole,
// even when it holds something that looks like an id.
const KNOWN = [
  [new RegExp(String.raw`^q-[a-z0-9]+ already answered ([\s\S]*) \(an-[a-z0-9]+\); ([\s\S]*)$`, "i"), (m) => `Already answered with ${m[1]}; ${m[2]}`],
  [new RegExp(String.raw`^q-[a-z0-9]+ was withdrawn \(an-[a-z0-9]+\); ([\s\S]*)$`, "i"), (m) => `This question was withdrawn; ${m[1]}`],
  [/^no such question q-[a-z0-9]+$/i, () => "This question is no longer in the ledger"],
  [/^id cut short: /i, () => "That reply looks like a cut-short id; nothing was recorded"],
];

/**
 * A CLI message as the pane shows it, with no row id in it. The CLI's known refusals become
 * plain sentences; any other message loses its ids (a `q-…` and the name in brackets after it
 * become `this question`; answer, note and other ids, and ids cut short, go).
 */
export function withoutIds(message) {
  const text = String(message ?? "").trim();
  for (const [shape, say] of KNOWN) {
    const m = shape.exec(text);
    if (m) return capitalized(say(m));
  }
  const stripped = text
    .replace(new RegExp(String.raw`\s*\(${ID}\)`, "gi"), "")
    .replace(/\bq-[a-z0-9]+(?:\s*\((?:[^()]|\([^()]*\))*\))?/gi, "this question")
    .replace(new RegExp(String.raw`\b${ID}\b`, "gi"), "")
    .replace(/\b(?:q|an|nt|oc)-(?![a-z0-9])/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([;,.])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return capitalized(stripped);
}

const capitalized = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the pane shows in place of a question's text when the row has none; never its name or id. */
export const MISSING_TEXT = "(question text missing)";

/** A question's or an answer's text for the pane: its body, or MISSING_TEXT. */
export function questionText(row) {
  const body = typeof row?.body === "string" ? row.body.trim() : "";
  return body || MISSING_TEXT;
}

/** An option button's label: the default option says so. */
export function optionLabel(q, option) {
  return option === q.default ? `${option} · default` : option;
}

/**
 * The transcript line for a surface where the pane is not drawn (or not placed), or null when
 * there is nothing to say. Names the command so the reader can open the pane.
 */
export function fallbackLine(snapshot) {
  if (!snapshot.ok) return `ledger pane: ${snapshot.error}`;
  if (!snapshot.elsewhere.length && !snapshot.answers.length) return null;
  const lines = [];
  for (const a of snapshot.answers) lines.push(`answered since your last turn: ${a.name} ${a.state === "withdrawn" ? "withdrawn" : `→ ${a.word}`} (via ${a.via})`);
  for (const q of snapshot.elsewhere) lines.push(`${q.state === "held" ? "held" : "open"} ${q.id} in ${q.cwd}: ${q.body}${q.options.length ? ` · ${optionList(q)}` : ""}`);
  lines.push(`answer with /ledger answer <q-id> <reply>, or /ledger to open the pane`);
  return lines.join("\n");
}

/** `alpha (default) · beta · gamma` */
export function optionList(q) {
  return q.options.map((o) => (o === q.default ? `${o} (default)` : o)).join(" · ");
}

/** The question the pane treats as selected: `selectedId` when it is still listed, else the first open one, else the first, else null. */
export function selectQuestion(snapshot, selectedId) {
  if (!snapshot.ok || !snapshot.elsewhere.length) return null;
  const chosen = snapshot.elsewhere.find((q) => q.id === selectedId);
  if (chosen) return chosen.id;
  return (snapshot.elsewhere.find((q) => q.state === "open") ?? snapshot.elsewhere[0]).id;
}

/** The questions grouped by folder, in the order the snapshot lists them. */
export function byFolder(snapshot) {
  const groups = [];
  for (const q of snapshot.elsewhere) {
    let g = groups[groups.length - 1];
    if (!g || g.cwd !== q.cwd) {
      g = { cwd: q.cwd, questions: [] };
      groups.push(g);
    }
    g.questions.push(q);
  }
  return groups;
}

/** A stable string for "did anything change since the last draw". */
export function fingerprint(snapshot) {
  return JSON.stringify(snapshot);
}
