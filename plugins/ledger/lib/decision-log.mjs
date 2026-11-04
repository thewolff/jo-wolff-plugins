// decision-log.mjs — the SessionEnd decision-log entry (0.3.3). When the repository the session
// ran in (its git toplevel, else the cwd) keeps `.ai/decision-log/`, and the session recorded at
// least one answer or note, SessionEnd writes ONE entry there in the newdle `/wrap-up` format
// (filename `<YYYY-MM-DD>--<HHMM>--<engineer>--<slug>.md`, frontmatter date / engineer / session /
// status / durable, the four sections) with engineer `claude-desktop`, so a session that decided
// things through the ledger leaves the same record a manual wrap-up would, and the next session's
// SessionStart (the newdle plugin's) re-injects it.
//
// Decisions are each answered question: its body and the chosen option, never the id alone. Dead
// ends are the session's withdrawn questions; heads-up its questions still open or held. Status
// is `resolved` when none is still open, `open` when one is. Nothing is written when: the
// session recorded no answer and no note; `decisionLog.enabled` is false; the repository has no
// `.ai/decision-log/` (it is never created); an entry already exists whose time falls inside the
// session's start..end (a manual wrap-up ran). A path that already exists gets `-2`, `-3`.
//
// How it fails: every fault (git missing, a query that throws, the directory unwritable) is one
// errors.log line under SessionEnd and no file; the hook's other work is untouched. Budget: one
// `git rev-parse` (1 s deadline), one readdir, one write. Rerun-safe: a second SessionEnd in the
// same minute finds its own entry inside the window and writes nothing.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { nowIso } from "./time.mjs";

export const ENGINEER = "claude-desktop";
export const LOG_DIR = join(".ai", "decision-log");
const GIT_TIMEOUT_MS = 1_000;

/**
 * `{ root, branch }`: the git toplevel of `cwd` and the checked-out branch (null when detached,
 * or on main/master, which name no topic), else `{ root: null, branch: null }` when `cwd` is in
 * no repository, or git is missing or slow: no toplevel is known, and the writer never guesses
 * one. One git call.
 */
export function repoRoot(cwd) {
  try {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
    if (r.error || r.status !== 0) return { root: null, branch: null };
    const [top = "", ref = ""] = r.stdout.split("\n").map((l) => l.trim());
    if (!top) return { root: null, branch: null };
    const branch = ref && ref !== "HEAD" && ref !== "main" && ref !== "master" ? ref : null;
    return { root: top, branch };
  } catch {
    return { root: null, branch: null };
  }
}

/** Lowercase kebab: letters, digits and hyphens only, at most 40 characters, never empty. */
export function slugify(text, fallback = "ledger-session") {
  const s = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || fallback;
}

const pad = (n) => String(n).padStart(2, "0");

/** `{ day: YYYY-MM-DD, hhmm: HHMM, iso: YYYY-MM-DDTHH:MM±HH:MM }` for `now` on the local wall clock. */
export function localStamp(now = Date.now()) {
  const d = new Date(now);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return { day, hhmm, iso: `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` };
}

/** The time (ms) an entry's filename `YYYY-MM-DD--HHMM--…` names on the local clock, else its mtime, else null. */
export function entryTime(dir, name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})--(\d{2})(\d{2})--/.exec(name);
  if (m) {
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
    if (!Number.isNaN(t)) return t;
  }
  try {
    return statSync(join(dir, name)).mtimeMs;
  } catch {
    return null;
  }
}

/** The session's rows: answers (recorded in it, or to its questions), notes, withdrawn and open questions. */
export function gather(db, sessionId) {
  const answers = db
    .prepare(
      `SELECT q.id, q.name, q.body, q.options, a.word, a.answered_by, a.answered_at, a.via
         FROM cc_answers a JOIN cc_questions q ON q.id = a.question_id
        WHERE (a.session_id = ? OR q.session_id = ?) AND q.state = 'answered'
        ORDER BY a.answered_at ASC, a.id ASC`,
    )
    .all(sessionId, sessionId);
  const notes = db.prepare("SELECT id, kind, body, ref, question_id, made_at FROM cc_notes WHERE session_id = ? ORDER BY made_at ASC, id ASC").all(sessionId);
  const withdrawn = db
    .prepare(
      `SELECT q.id, q.name, q.body, (SELECT body FROM cc_notes n WHERE n.question_id = q.id AND n.kind = 'withdraw' ORDER BY n.made_at DESC LIMIT 1) AS why
         FROM cc_questions q WHERE q.session_id = ? AND q.state = 'withdrawn' ORDER BY q.resolved_at ASC, q.id ASC`,
    )
    .all(sessionId);
  const open = db.prepare("SELECT id, name, body, options, default_opt, state FROM cc_questions WHERE session_id = ? AND state IN ('open','held') ORDER BY asked_at ASC, id ASC").all(sessionId);
  return { answers, notes, withdrawn, open };
}

const options = (json) => {
  try {
    return JSON.parse(json).join(", ");
  } catch {
    return "";
  }
};
const line = (s) => String(s).replace(/\s+/g, " ").trim();

/** The entry's text: the wrap-up frontmatter and four sections. */
export function render({ answers, notes, withdrawn, open }, { sessionId, stamp, status }) {
  const plain = notes.filter((n) => n.kind === "note" || n.kind === "outcome");
  const what = plain.length ? plain.map((n) => `- ${n.kind === "outcome" ? `${n.ref}: ` : ""}${line(n.body)}`) : ["- None recorded in the ledger (answers only)."];
  const decisions = answers.length
    ? answers.map((a) => `- ${line(a.body)} → **${a.word}** (question \`${a.name}\`; options: ${options(a.options)}; answered by ${a.answered_by} via ${a.via})`)
    : ["- None: the session recorded notes and no answer."];
  // The withdraw verb's own note ("q-… (name) withdrawn") says nothing a reader needs; a reason given with the withdrawal does.
  const why = (q) => (q.why && !/^q-\S+ \(.*\) withdrawn$/.test(line(q.why)) ? `: ${line(q.why)}` : "");
  const dead = withdrawn.length ? withdrawn.map((q) => `- ${line(q.body)} (question \`${q.name}\`, withdrawn${why(q)})`) : ["None"];
  const heads = open.length ? open.map((q) => `- Still ${q.state}: ${line(q.body)} (question \`${q.name}\`; options: ${options(q.options)}${q.default_opt ? `; default ${q.default_opt}` : ""})`) : ["None"];
  return [
    "---",
    `date: ${stamp.iso}`,
    `engineer: ${ENGINEER}`,
    `session: ledger session ${sessionId.slice(0, 8)}: ${answers.length} answer(s), ${plain.length} note(s), ${withdrawn.length} withdrawn, ${open.length} open`,
    `status: ${status}`,
    "durable: false",
    "---",
    "",
    "## What changed",
    "",
    ...what,
    "",
    "## Decisions made (and why)",
    "",
    ...decisions,
    "",
    "## Dead ends — don't retry these",
    "",
    ...dead,
    "",
    "## Heads-up for whoever touches this next",
    "",
    ...heads,
    "",
  ].join("\n");
}

/**
 * Write the session's entry. Returns `{ path }` when written, `{ skipped: <why> }` otherwise.
 * Throws nothing it can avoid: git and query faults surface as thrown errors for the caller's
 * errors.log line.
 * @param {{ db, sessionId: string, cwd: string, config: object, now?: number, startedAt?: string|null }} args
 */
export function writeDecisionLog({ db, sessionId, cwd, config, now = Date.now(), startedAt = null }) {
  if (config?.decisionLog?.enabled === false) return { skipped: "decisionLog.enabled is false" };
  const { root, branch } = repoRoot(cwd);
  // Only a toplevel git named: a cwd whose repository is unknown (none, or git missing or slow)
  // gets no entry, however likely a `.ai/decision-log` beside it looks.
  if (!root) return { skipped: `${cwd} is in no git repository that could be read` };
  const dir = join(root, LOG_DIR);
  if (!existsSync(dir)) return { skipped: `no ${LOG_DIR} in ${root}` };
  const rows = gather(db, sessionId);
  if (!rows.answers.length && !rows.notes.length) return { skipped: "no answer or note in this session" };
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const from = Number.isNaN(start) ? now : Math.min(start, now);
  // An entry from inside the session's window (to the minute) means a wrap-up already ran.
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const t = entryTime(dir, name);
    if (t !== null && t >= from - 60_000 && t <= now) return { skipped: `${name} already covers this session` };
  }
  const stamp = localStamp(now);
  const status = rows.open.length ? "open" : "resolved";
  // The slug: the branch, else the first answered question's name, else the first note.
  const topic = branch ?? rows.answers[0]?.name ?? rows.notes[0]?.body ?? "";
  const stem = `${stamp.day}--${stamp.hhmm}--${ENGINEER}--${slugify(topic)}`;
  let path = join(dir, `${stem}.md`);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${stem}-${n}.md`);
  writeFileSync(path, render(rows, { sessionId, stamp, status }), { flag: "wx" });
  return { path, at: nowIso(now) };
}

// ---------------------------------------------------------------------------------------------
// The reader (SessionStart). Claude Desktop runs with the newdle plugin off, so its
// recent-activity hook never injects the entries there; this does, in the same spirit: the
// newest entries, plus every entry still `open` or `durable`, in one bounded block. It stands
// down where the newdle hook will inject: the nearest `newdle-hooks.json` walking up from the
// repository root (and from a linked worktree's main checkout) says `"hooks": "on"` — the
// plugin's own scope check (hook-scope.mjs: nearest usable declaration wins; an absent,
// unreadable or malformed file is walked past). A person's newdle mute file is not read, so a
// muted recent-activity hook leaves both silent: the mute is theirs to lift.
// ---------------------------------------------------------------------------------------------

export const READ_NEWEST = 5;
export const READ_BUDGET = 3_000;
const NEWDLE_FILE = "newdle-hooks.json";
const MAX_WALK = 64;

/** `true` / `false` for the nearest usable newdle declaration above `dir`, null when none. */
function newdleDeclaration(dir) {
  let raw;
  try {
    raw = readFileSync(join(dir, NEWDLE_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.version !== undefined && parsed.version !== 1) return null;
    return parsed.hooks === "on" ? true : parsed.hooks === "off" ? false : null;
  } catch {
    return null;
  }
}

/** The main checkout a linked worktree's `.git` file points at, else null. */
function mainCheckoutFor(dir) {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(dir, ".git"), "utf8"));
    if (!m) return null;
    const idx = m[1].indexOf("/.git/worktrees/");
    return idx > 0 ? m[1].slice(0, idx) : null;
  } catch {
    return null;
  }
}

function walkFrom(start) {
  let dir = resolvePath(start);
  let mainCheckout = null;
  for (let i = 0; i < MAX_WALK; i++) {
    const found = newdleDeclaration(dir);
    if (found !== null) return { verdict: found, mainCheckout };
    if (!mainCheckout) mainCheckout = mainCheckoutFor(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { verdict: null, mainCheckout };
}

/** Whether the newdle plugin's hooks are declared on for `root` (so its own hook injects the log). */
export function newdleHooksOn(root) {
  const first = walkFrom(root);
  if (first.verdict !== null) return first.verdict;
  if (first.mainCheckout) return walkFrom(first.mainCheckout).verdict === true;
  return false;
}

/** The leading frontmatter's `status`, `durable`, `date`, `engineer` (defaults as the newdle parser's) and the body lines. */
export function parseEntry(text) {
  const out = { status: "resolved", durable: false, date: "", engineer: "", body: [] };
  const lines = String(text).split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    for (i = 1; i < lines.length && lines[i].trim() !== "---"; i++) {
      const m = /^([A-Za-z_]+)\s*:\s*(.*?)\s*$/.exec(lines[i]);
      if (!m) continue;
      const [, key, raw] = m;
      const value = raw.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
      if (key === "status" && ["open", "resolved", "superseded", "promoted"].includes(value.toLowerCase())) out.status = value.toLowerCase();
      else if (key === "durable") out.durable = ["true", "yes", "1"].includes(value.toLowerCase());
      else if (key === "date") out.date = value;
      else if (key === "engineer") out.engineer = value;
    }
    i = Math.min(i + 1, lines.length);
  }
  out.body = lines.slice(i);
  return out;
}

/** One entry's lines: `- <date> <engineer> — <title>` then up to two non-empty body lines. */
function entryLines(dir, name) {
  const text = readFileSync(join(dir, name), "utf8");
  const e = parseEntry(text);
  const h1 = e.body.find((l) => /^#\s+\S/.test(l));
  const title = h1 ? h1.replace(/^#\s+/, "").trim() : name.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}--\d{4}--[^-]+(?:-[^-]+)*?--/, "");
  const stem = name.replace(/\.md$/, "");
  const m = /^(\d{4}-\d{2}-\d{2})--(\d{2})(\d{2})--([a-z0-9-]+)--(.+)$/.exec(stem);
  const date = e.date || (m ? `${m[1]} ${m[2]}:${m[3]}` : "");
  const engineer = e.engineer || m?.[4] || "";
  const flags = [e.status === "open" ? "open" : null, e.durable ? "durable" : null].filter(Boolean);
  const head = `- ${date}${engineer ? ` ${engineer}` : ""} — ${h1 ? title : m ? m[5] : title}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
  const snippet = e.body
    .map((l) => l.trim())
    .filter((l) => l && !/^#/.test(l) && l !== "---")
    .slice(0, 2)
    .map((l) => `    ${l}`);
  return { lines: [head, ...snippet], status: e.status, durable: e.durable };
}

/**
 * The SessionStart block for `root`'s decision log: '' when there is nothing to inject
 * (no directory, no entry, `decisionLog.enabled` false, or the newdle hook will inject). The
 * newest READ_NEWEST entries, then every other entry `open` or `durable` (newest first), as
 * many as fit: the whole, with its "N more not shown" line counting every entry not shown, is
 * at most READ_BUDGET characters. There is no count cap below the budget.
 */
export function readDecisionLog(root, config) {
  if (config?.decisionLog?.enabled === false) return "";
  const dir = join(root, LOG_DIR);
  if (!existsSync(dir)) return "";
  if (newdleHooksOn(root)) return "";
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .reverse();
  if (!names.length) return "";
  const entries = [];
  for (const name of names) {
    try {
      entries.push({ name, ...entryLines(dir, name) });
    } catch {
      /* an unreadable entry is left out */
    }
  }
  const newest = entries.slice(0, READ_NEWEST);
  const flagged = entries.slice(READ_NEWEST).filter((e) => e.status === "open" || e.durable);
  const chosen = [...newest, ...flagged];
  const header = `ledger: decision log (${LOG_DIR}, ${entries.length} entr${entries.length === 1 ? "y" : "ies"}; newest ${Math.min(READ_NEWEST, entries.length)}${flagged.length ? `, then ${flagged.length} open or durable` : ""}):`;
  const out = [header];
  let used = header.length;
  let shown = 0;
  for (const e of chosen) {
    const block = e.lines.join("\n");
    // The footer this block would leave: every entry not shown, chosen or not.
    const more = entries.length - shown - 1;
    const tail = more ? `\n${more} more not shown` : "";
    if (used + 1 + block.length + tail.length > READ_BUDGET) break;
    out.push(block);
    used += 1 + block.length;
    shown++;
  }
  const left = entries.length - shown;
  if (left > 0) out.push(`${left} more not shown`);
  return out.join("\n");
}
