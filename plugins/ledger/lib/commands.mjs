// commands.mjs — what each verb does to the store, one function per verb, each in one
// BEGIN IMMEDIATE transaction. Every function returns { status, id, message }:
//   ok       a row was written; `id` is the row that proves it
//   noop     nothing to do and nothing written (already answered, already asked …)
//   refused  not applied, `message` says why and what would be accepted
//
// Rules this file is the home of (see the README's bug → fix map):
//   - an answer is recorded as the option it names; `answer <q-id> <reply>` with a reply that is
//     not an option records the reply as given (via `freeform`, at most FREEFORM_MAX characters),
//     so a question is never withdrawn because the human's reply was not in the list. The short
//     forms (`<word> <q-id>`, an ordinal, a bare word) and the prompt hook take options only, so
//     a typo is refused with the option list and never becomes an answer;
//   - a question is asked once: repeating an open or held one returns its id and writes nothing;
//   - a held question (formed, deliberately deferred for the human) is unresolved like an open
//     one; `reopen` puts it to the human (open, asked_at = now), `hold` defers an open one;
//   - an answer is final: a second, different word is refused naming the first.
//
// Scope. A row is bound to the folder it was written in. "In scope for <cwd>" means the row's
// cwd equals <cwd> or is an ancestor of it, so a question asked at a repository root is pending
// in its subfolders too. `pending --all` and the SessionStart other-folders line read open and
// held questions from every folder. There is no "workload" row: the folder is the project, and the
// project's own tools (git, the issue tracker) say what is in flight.

import { writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { PROJECT_FILE, readConfigFile } from "./config.mjs";
import { newId, prefixOf } from "./ids.mjs";
import { VERBS, optionList } from "./parse.mjs";
import { nowIso, parseDeadline, relative, formatLocal } from "./time.mjs";
import { transaction } from "./db.mjs";
import { renderBounces, BOUNCES_DEFAULT_SINCE } from "./bounces.mjs";
import { renderDoctor, runDoctor } from "./doctor.mjs";

const KINDS = ["question", "approval", "plan"];
const KIND_DEFAULT_OPTIONS = { approval: ["approve", "deny"], plan: ["approve", "revise", "cancel"] };
const KIND_DEFAULT_WORD = { approval: "deny" };
const LOG_DEFAULT = 20;

export const ok = (id, message) => ({ status: "ok", id, message });
export const noop = (id, message) => ({ status: "noop", id, message });
export const refused = (message) => ({ status: "refused", id: null, message });

/** True when `dir` is `root` or lies under it. Both are expected to be absolute and normalised. */
export function isWithin(dir, root) {
  if (dir === root) return true;
  const r = root.endsWith(sep) ? root : root + sep;
  return dir.startsWith(r);
}

/** True when a question asked in `qcwd` is in scope for a session in `cwd`: the same folder, an ancestor, or a descendant. */
export function inScope(cwd, qcwd) {
  return isWithin(cwd, qcwd) || isWithin(qcwd, cwd);
}

/** Held questions in scope for `cwd` (its folder, ancestors and descendants), oldest first. */
export function heldQuestions(db, cwd) {
  const rows = db.prepare("SELECT * FROM cc_questions WHERE state = 'held' ORDER BY asked_at ASC, id ASC").all();
  return rows.filter((q) => inScope(cwd, q.cwd)).map(parseQuestion);
}

/**
 * Open questions in scope for `cwd`, oldest first (the `pending` order): its folder, ancestors
 * and, unless `below` is false, descendants. The AskUserQuestion gate and the Stop rules pass
 * `below: false`: a question asked in a subfolder does not cover a session in its parent.
 */
export function openQuestions(db, cwd, { below = true } = {}) {
  const rows = db.prepare("SELECT * FROM cc_questions WHERE state = 'open' ORDER BY asked_at ASC, id ASC").all();
  return rows.filter((q) => (below ? inScope(cwd, q.cwd) : isWithin(cwd, q.cwd))).map(parseQuestion);
}

/**
 * Every open and held question in the db, whatever its folder: a Map of cwd → questions, folders
 * in path order, oldest first within a folder.
 */
export function unresolvedByFolder(db) {
  const rows = db.prepare("SELECT * FROM cc_questions WHERE state IN ('open', 'held') ORDER BY cwd ASC, asked_at ASC, id ASC").all();
  const groups = new Map();
  for (const q of rows) {
    if (!groups.has(q.cwd)) groups.set(q.cwd, []);
    groups.get(q.cwd).push(parseQuestion(q));
  }
  return groups;
}

/**
 * Open and held questions outside the scope of `cwd`: their folder is not `cwd`, not an ancestor
 * of it and not under it. Returns { count, folders } (folders = distinct cwds among them).
 */
export function elsewhereCount(db, cwd) {
  const rows = db
    .prepare("SELECT cwd FROM cc_questions WHERE state IN ('open', 'held')")
    .all()
    .filter((q) => !isWithin(cwd, q.cwd) && !isWithin(q.cwd, cwd));
  return { count: rows.length, folders: new Set(rows.map((q) => q.cwd)).size };
}

/**
 * The open questions that belong to session `sessionId`, newest first: rows tagged with it, plus
 * untagged rows (a CLI run without LEDGER_SESSION_ID) in or around `cwd` asked at or after the
 * session row's started_at. `askedBy` keeps only questions asked at or before that ISO stamp.
 * No session id → [].
 */
export function sessionQuestions(db, { sessionId, cwd, askedBy = null }) {
  if (!sessionId) return [];
  const session = db.prepare("SELECT started_at FROM cc_sessions WHERE id = ?").get(sessionId);
  const since = session?.started_at ?? null;
  const rows = db
    .prepare("SELECT * FROM cc_questions WHERE state = 'open' AND (session_id = ? OR (session_id IS NULL AND ? IS NOT NULL AND asked_at >= ?)) ORDER BY asked_at DESC, id DESC")
    .all(sessionId, since, since ?? "");
  return rows
    .filter((q) => (q.session_id === sessionId || isWithin(cwd, q.cwd) || isWithin(q.cwd, cwd)) && (!askedBy || q.asked_at <= askedBy))
    .map(parseQuestion);
}

/**
 * Questions session `sessionId` asked that another session (or an untagged CLI run) answered or
 * withdrew in the window (`since`, `until`], oldest first: { id, name, state, word, via }.
 * Answers recorded by the session itself are left out: it already knows them.
 */
export function answersSince(db, { sessionId, since, until }) {
  if (!sessionId || !since) return [];
  return db
    .prepare(
      `SELECT q.id, q.name, q.state, a.word, a.via FROM cc_answers a JOIN cc_questions q ON q.id = a.question_id
       WHERE q.session_id = ? AND a.answered_at > ? AND a.answered_at <= ? AND (a.session_id IS NULL OR a.session_id <> ?)
       ORDER BY a.answered_at ASC, a.id ASC`,
    )
    .all(sessionId, since, until, sessionId);
}

/**
 * The note rows of the given `kinds` (default `note` only) that belong to session `sessionId`,
 * oldest first: rows tagged with it, plus untagged rows (a CLI run without LEDGER_SESSION_ID) in
 * or around `cwd` made at or after the session row's started_at. `after` keeps only rows made
 * after that ISO stamp (this turn). No session id → nothing can be attributed, so [].
 */
export function sessionNotes(db, { sessionId, cwd, after = null, kinds = ["note"] }) {
  if (!sessionId) return [];
  const session = db.prepare("SELECT started_at FROM cc_sessions WHERE id = ?").get(sessionId);
  const since = session?.started_at ?? null;
  const rows = db
    .prepare(`SELECT id, cwd, made_at, session_id FROM cc_notes WHERE kind IN (${kinds.map(() => "?").join(", ")}) AND (session_id = ? OR (session_id IS NULL AND ? IS NOT NULL AND made_at >= ?)) ORDER BY made_at ASC, id ASC`)
    .all(...kinds, sessionId, since, since ?? "");
  return rows.filter((r) => (r.session_id === sessionId || isWithin(cwd, r.cwd) || isWithin(r.cwd, cwd)) && (!after || r.made_at > after));
}

function parseQuestion(q) {
  if (!q) return null;
  return { ...q, options: JSON.parse(q.options), allows: q.allows ? JSON.parse(q.allows) : null };
}

function getQuestion(db, id) {
  return parseQuestion(db.prepare("SELECT * FROM cc_questions WHERE id = ?").get(id));
}

/** The parser's view of the store for `cwd`. */
export function createLookup(db, cwd) {
  return {
    question(id) {
      const q = getQuestion(db, id);
      return q ? { id: q.id, options: q.options, state: q.state } : null;
    },
    offering(word) {
      return openQuestions(db, cwd)
        .filter((q) => q.options.includes(word))
        .map((q) => q.id);
    },
    optionWords() {
      const words = new Set();
      for (const q of openQuestions(db, cwd)) for (const o of q.options) words.add(o);
      return [...words];
    },
    exists(id) {
      const table = { q: "cc_questions", an: "cc_answers", nt: "cc_notes" }[prefixOf(id)];
      return table ? Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) : false;
    },
  };
}

function freshId(db, table, prefix, now) {
  for (let i = 0; i < 2; i++) {
    const id = newId(prefix, now);
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id;
  }
  throw new Error(`could not allocate a unique ${prefix}- id`);
}

function addNote(db, cwd, kind, body, questionId, by, iso, now, sessionId, ref = null) {
  const id = freshId(db, "cc_notes", "nt", now);
  db.prepare("INSERT INTO cc_notes (id, cwd, kind, body, question_id, made_by, made_at, session_id, ref) VALUES (?,?,?,?,?,?,?,?,?)").run(id, cwd, kind, body, questionId, by, iso, sessionId ?? null, ref);
  return id;
}

/**
 * The paste-ready line for one question:
 *   <default> <q-id>  # <name> · <body> · default <default> · also: <others> / withdraw
 *   then `  about …`, `  allows:` lines for plan questions, `  ceiling $…`, and `  due …`.
 */
export function pendingLines(q, { now = Date.now(), timezone = null } = {}) {
  const others = q.options.filter((o) => o !== q.default_opt);
  const body = q.body.replace(/\s+/g, " ").trim();
  const lines = [`${q.default_opt} ${q.id}  # ${q.name} · ${body} · default ${q.default_opt} · also: ${others.join(", ")} / withdraw`];
  if (q.about) lines.push(`  about ${q.about}`);
  if (q.allows && Object.keys(q.allows).length) {
    lines.push("  allows:");
    for (const o of q.options) if (Object.hasOwn(q.allows, o)) lines.push(`    ${o}: ${q.allows[o]}`);
  }
  if (q.ceiling_usd) lines.push(`  ceiling $${q.ceiling_usd}`);
  if (q.deadline) {
    const past = Date.parse(q.deadline) < now;
    lines.push(`  due ${formatLocal(q.deadline, timezone)} (${past ? "overdue, " : ""}${relative(q.deadline, now)})`);
  }
  return lines;
}

/** ` · in <folder>` for a question asked in a folder below `cwd`; "" otherwise. */
function belowSuffix(q, cwd) {
  return cwd && q.cwd !== cwd && isWithin(q.cwd, cwd) ? ` · in ${q.cwd}` : "";
}

/** One line per held question: `held <q-id>  # <name> · <body>`, plus ` · in <folder>` when it was asked below `cwd`. */
export function heldLines(held, cwd = null) {
  return held.map((q) => `held ${q.id}  # ${q.name} · ${q.body.replace(/\s+/g, " ").trim()}${belowSuffix(q, cwd)}`);
}

/**
 * The open questions, numbered, then the held ones marked `held` (not numbered: not answerable by
 * ordinal). A question asked in a folder below `cwd` ends its first line with ` · in <folder>`.
 */
export function renderPending(questions, cwd, opts = {}, held = []) {
  const out = [];
  if (!questions.length) out.push(`no open questions for ${cwd}`);
  questions.forEach((q, i) => {
    const lines = pendingLines(q, opts);
    out.push(`${i + 1}. ${lines[0]}${belowSuffix(q, cwd)}`);
    out.push(...lines.slice(1));
  });
  out.push(...heldLines(held, cwd));
  return out.join("\n");
}

/**
 * `pending --all`: one group per folder, headed by the folder's path, then its open questions as
 * `pending` lines (not numbered: an ordinal answers only the current folder's list) and its held
 * ones marked `held`. Groups are separated by a blank line.
 */
export function renderPendingAll(groups, opts = {}) {
  if (!groups.size) return "no open or held questions in the ledger";
  const blocks = [];
  for (const [cwd, questions] of groups) {
    const out = [cwd];
    for (const q of questions.filter((x) => x.state === "open")) out.push(...pendingLines(q, opts));
    out.push(...heldLines(questions.filter((x) => x.state === "held")));
    blocks.push(out.join("\n"));
  }
  return blocks.join("\n\n");
}

/** The last `count` events in scope for `cwd` (notes, questions, answers), newest first. */
export function logEntries(db, cwd, count) {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT id, cwd, made_at AS at, made_by AS who, kind, body, question_id, ref FROM cc_notes
         UNION ALL
         SELECT id, cwd, asked_at AS at, asked_by AS who, CASE state WHEN 'held' THEN 'held' ELSE 'ask' END AS kind, name || ' · ' || body AS body, NULL, NULL FROM cc_questions
         UNION ALL
         SELECT a.id, q.cwd, a.answered_at AS at, a.answered_by AS who, CASE a.via WHEN 'freeform' THEN 'answer-freeform' ELSE 'answer' END AS kind, a.word || ' → ' || q.id || ' (' || q.name || ')' AS body, q.id, NULL
           FROM cc_answers a JOIN cc_questions q ON q.id = a.question_id
       ) ORDER BY at DESC, id DESC`,
    )
    .all()
    .filter((r) => isWithin(cwd, r.cwd));
  return rows.slice(0, count);
}

export function renderLog(rows, cwd, count, { now = Date.now() } = {}) {
  if (!rows.length) return `no notes, questions or answers for ${cwd}`;
  const label = { note: "note", withdraw: "withdrew", extend: "extended", ask: "asked", held: "asked (held)", answer: "answered", "answer-freeform": "answered (freeform)", outcome: "outcome" };
  const about = (r) => (r.kind === "outcome" && r.question_id ? ` (for ${r.question_id})` : "");
  return rows.map((r) => `${r.id} ${relative(r.at, now)} · ${r.who} ${label[r.kind] ?? r.kind}: ${r.body.replace(/\s+/g, " ")}${r.ref ? ` → ${r.ref}` : ""}${about(r)}`).join("\n");
}

export function renderHelp() {
  const lines = ["ledger verbs (who usually says it in brackets):"];
  for (const v of VERBS) lines.push(`  ${v.usage}`, `      [${v.who}] ${v.help}`);
  lines.push(
    "",
    "ids: q- question, an- answer, nt- note; an id looks like q-mvr3k2p9a1xq.",
    "answers: <word> <q-id>, where the word is one of the question's options (or withdraw); a word that is not an option is refused. `answer <q-id> <reply>` records a reply that is not an option as given (free-form, up to 200 characters).",
    "batch: with no verb and stdin piped, one command per line; each line is applied on its own, in order, and reported on its own line.",
    "prose: a line that does not match a shape above is `not a command` and is never recorded.",
  );
  return lines.join("\n");
}

/**
 * `enable` / `disable`: write `"enabled"` into the project file in `cwd`. Creates a minimal
 * `{ "enabled": true }`; otherwise updates that one key and keeps the rest. Never deletes the file.
 * A file that exists but does not parse is left alone and the line is refused, so a typo in it is
 * never silently replaced.
 */
export function setEnabled(cwd, enabled) {
  const path = join(cwd, PROJECT_FILE);
  const notices = [];
  let current = readConfigFile(path, notices);
  if (notices.length) return refused(`${path} exists but could not be read (${notices[0].replace(/^ledger: config .* ignored: /, "")}); fix or remove it first`);
  const existed = current !== null;
  current = { ...(current ?? {}), enabled };
  const text = `${JSON.stringify(current, null, 2)}\n`;
  try {
    writeFileSync(path, text);
  } catch (err) {
    return refused(`could not write ${path}: ${err.message}`);
  }
  const verb = enabled ? "enabled" : "disabled";
  return ok(null, `${verb} the ledger hooks for ${cwd}\n${existed ? "updated" : "wrote"} ${path}:\n${text.trimEnd()}`);
}

function parseAllows(text) {
  const out = Object.create(null);
  for (const part of String(text).split(";")) {
    const m = /^\s*([^:\s]+)\s*:\s*(.+?)\s*$/.exec(part);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/**
 * Run one parsed command.
 * @param ctx { cwd, actor(verb) → name, via: 'cli'|'prompt-hook', sessionId, now, config, configText, dbPath }
 */
export function execute(db, parsed, ctx) {
  const now = ctx.now ?? Date.now();
  const iso = nowIso(now);
  const by = ctx.actor(parsed.verb);
  const via = ctx.via ?? "cli";
  const run = (fn) => transaction(db, fn, ctx.dbPath);
  const tz = ctx.config?.timezone ?? null;

  switch (parsed.verb) {
    case "help":
      return ok(null, renderHelp());
    case "config":
      return ok(null, ctx.configText ?? "(config unavailable here)");
    case "enable":
    case "disable":
      return setEnabled(ctx.cwd, parsed.verb === "enable");
    case "pending":
      if (parsed.all) return ok(null, renderPendingAll(unresolvedByFolder(db), { now, timezone: tz }));
      return ok(null, renderPending(openQuestions(db, ctx.cwd), ctx.cwd, { now, timezone: tz }, heldQuestions(db, ctx.cwd)));
    case "review":
      return refused("review runs on its own line: `ledger review …`, not inside a batch");
    case "bounces":
      return ok(null, renderBounces(db, { since: parsed.since ?? BOUNCES_DEFAULT_SINCE, now }));
    case "doctor": {
      // The CLI runs `doctor` before opening the store; this path is a batch line.
      const report = runDoctor({ env: process.env, cwd: ctx.cwd, now });
      return report.fails ? refused(renderDoctor(report)) : ok(null, renderDoctor(report));
    }
    case "log": {
      const count = parsed.count ?? LOG_DEFAULT;
      return ok(null, renderLog(logEntries(db, ctx.cwd, count), ctx.cwd, count, { now }));
    }
    case "ask":
      return run(() => ask(db, parsed, by, iso, now, ctx));
    case "answer":
      return run(() => answer(db, parsed, by, via, iso, now, ctx));
    case "withdraw":
      return run(() => withdrawQuestion(db, parsed.id, by, via, iso, now, ctx));
    case "extend":
      return run(() => extendQuestion(db, parsed.id, by, iso, now, ctx));
    case "note":
      return run(() => note(db, parsed, by, iso, now, ctx));
    case "outcome":
      return run(() => outcome(db, parsed, by, iso, now, ctx));
    case "hold":
      return run(() => setHeld(db, parsed.id, true, iso));
    case "reopen":
      return run(() => setHeld(db, parsed.id, false, iso));
    default:
      return refused(`unknown verb ${parsed.verb}`);
  }
}

function ask(db, parsed, by, iso, now, ctx) {
  const f = parsed.flags ?? {};
  const body = parsed.textArg.trim();
  if (!body) return refused('ask needs a body: ask "<question>" --name <short> --options a,b');
  const kind = f.kind === undefined ? "question" : String(f.kind);
  if (!KINDS.includes(kind)) return refused(`--kind must be one of ${KINDS.join(", ")}`);
  const name = typeof f.name === "string" ? f.name.trim() : "";
  if (!name) return refused(`ask needs --name <short>: ask "${body}" --name <short> --options a,b`);

  let options;
  if (typeof f.options === "string") {
    options = [...new Set(f.options.split(",").map((o) => o.trim().toLowerCase()).filter(Boolean))];
  } else if (KIND_DEFAULT_OPTIONS[kind]) {
    options = KIND_DEFAULT_OPTIONS[kind];
  } else {
    return refused(`ask needs --options a,b (at least two words): ask "${body}" --name ${name} --options a,b`);
  }
  if (options.length < 2) return refused(`--options needs at least two distinct words; got ${JSON.stringify(options)}`);
  if (options.some((o) => /\s/.test(o))) return refused("each option is one word");
  // An option named `withdraw` is allowed: the parser resolves options first, so `withdraw q-…` records it.

  const def = f.default !== undefined ? String(f.default).toLowerCase() : (KIND_DEFAULT_WORD[kind] ?? options[0]);
  if (!options.includes(def)) return refused(`--default ${def} is not one of the options ${options.join(", ")}`);

  let allows = null;
  if (f.allows !== undefined) {
    allows = parseAllows(f.allows);
    const unknown = Object.keys(allows).filter((k) => !options.includes(k));
    if (unknown.length) return refused(`--allows names ${unknown.join(", ")}, not among the options ${options.join(", ")}`);
  }
  if (kind === "plan") {
    const missing = options.filter((o) => !(allows && Object.hasOwn(allows, o)));
    if (missing.length) return refused(`--kind plan needs --allows covering every option; missing: ${missing.join(", ")} (e.g. --allows "${options.map((o) => `${o}: what it allows`).join("; ")}")`);
  }

  let ceiling = null;
  if (f.ceiling !== undefined) {
    const m = /^\$?(\d+(?:\.\d+)?)$/.exec(String(f.ceiling).trim());
    ceiling = m ? Number(m[1]) : NaN;
    if (!(ceiling > 0)) return refused(`--ceiling takes a usd amount above 0; got ${f.ceiling}`);
  }
  const about = typeof f.about === "string" && f.about.trim() ? f.about.trim() : null;

  let deadline = null;
  let span = null;
  if (f.deadline !== undefined) {
    const d = parseDeadline(String(f.deadline), now);
    if (!d) return refused(`--deadline takes a duration (2h, 30m, 3d) or an ISO date; got ${f.deadline}`);
    deadline = d.iso;
    span = d.spanMs;
  }

  const optionsJson = JSON.stringify(options);
  const repeat = db.prepare("SELECT id, state FROM cc_questions WHERE cwd = ? AND body = ? AND options = ? AND state IN ('open','held')").get(ctx.cwd, body, optionsJson);
  if (repeat?.state === "held") return noop(repeat.id, `${repeat.id} already asked and held; run \`reopen ${repeat.id}\` when you put it to the human`);
  if (repeat) {
    const q = getQuestion(db, repeat.id);
    return noop(repeat.id, `${repeat.id} already asked and still open\n${pendingLines(q, { now, timezone: ctx.config?.timezone ?? null }).join("\n")}`);
  }

  const id = freshId(db, "cc_questions", "q", now);
  db.prepare(
    `INSERT INTO cc_questions (id, cwd, kind, name, body, about, options, allows, default_opt, ceiling_usd, deadline, deadline_span_ms, state, asked_by, asked_at, session_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)`,
  ).run(id, ctx.cwd, kind, name, body, about, optionsJson, allows ? JSON.stringify(allows) : null, def, ceiling, deadline, span, by, iso, ctx.sessionId ?? null);
  const q = getQuestion(db, id);
  return ok(id, `${id} asked for ${ctx.cwd}; ask the human in plain words without showing this id, then record their reply with \`answer ${id} <option>\`:\n${pendingLines(q, { now, timezone: ctx.config?.timezone ?? null }).join("\n")}`);
}

/** The longest free-form answer recorded, in characters. */
export const FREEFORM_MAX = 200;

function answer(db, parsed, by, via, iso, now, ctx) {
  let id = parsed.id;
  if (parsed.ordinal !== undefined) {
    const list = openQuestions(db, ctx.cwd);
    const q = list[parsed.ordinal - 1];
    if (!q) return refused(list.length ? `no pending question numbered ${parsed.ordinal}; pending has ${list.length}` : `no open questions for ${ctx.cwd}`);
    id = q.id;
  }
  const q = getQuestion(db, id);
  if (!q) return refused(`no such question ${id}`);
  let word = String(parsed.word).toLowerCase().trim();
  let answerVia = via;

  const isOption = q.options.includes(word);
  if (!isOption) {
    if (word === "withdraw") return withdrawQuestion(db, id, by, via, iso, now, ctx);
    // Free-form only from `answer <q-id> <reply>` outside the prompt hook (parsed.reply is set by that shape alone).
    if (parsed.reply === undefined || via === "prompt-hook") return refused(`${word} is not an option of ${id} (${q.name}); options: ${optionList(q.options)}. Nothing recorded.`);
    word = String(parsed.reply).trim().replace(/\s+/g, " ");
    if (!word) return refused(`answer needs a reply: answer ${id} <reply>`);
    if (word.length > FREEFORM_MAX) return refused(`a free-form answer is at most ${FREEFORM_MAX} characters; this one is ${word.length}. Nothing recorded.`);
    answerVia = "freeform";
  }
  if (q.state !== "open" && q.state !== "held") {
    const a = db.prepare("SELECT id, word FROM cc_answers WHERE question_id = ?").get(id);
    if (q.state === "withdrawn") return refused(`${id} was withdrawn${a ? ` (${a.id})` : ""}; ask it again to answer it`);
    if (a && a.word === word) return noop(a.id, `already answered ${word} (${a.id})`);
    return refused(`${id} already answered ${a?.word} (${a?.id}); an answer is final`);
  }
  const an = freshId(db, "cc_answers", "an", now);
  db.prepare("INSERT INTO cc_answers (id, question_id, word, answered_by, answered_at, via, session_id) VALUES (?,?,?,?,?,?,?)").run(an, id, word, by, iso, answerVia, ctx.sessionId ?? null);
  db.prepare("UPDATE cc_questions SET state = 'answered', resolved_at = ? WHERE id = ?").run(iso, id);
  if (!isOption) return ok(an, `${an} ${word} → ${id} (${q.name}) · freeform: not one of ${q.options.join(", ")}`);
  const allows = q.allows && Object.hasOwn(q.allows, word) ? ` · allows: ${q.allows[word]}` : "";
  return ok(an, `${an} ${word} → ${id} (${q.name})${allows}`);
}

function withdrawQuestion(db, id, by, via, iso, now, ctx) {
  const q = getQuestion(db, id);
  if (!q) return refused(`no such question ${id}`);
  if (q.state === "withdrawn") {
    const a = db.prepare("SELECT id FROM cc_answers WHERE question_id = ?").get(id);
    return noop(id, `${id} already withdrawn${a ? ` (${a.id})` : ""}`);
  }
  if (q.state === "answered") {
    const a = db.prepare("SELECT id, word FROM cc_answers WHERE question_id = ?").get(id);
    return refused(`${id} already answered ${a.word} (${a.id}); an answered question cannot be withdrawn`);
  }
  const an = freshId(db, "cc_answers", "an", now);
  db.prepare("INSERT INTO cc_answers (id, question_id, word, answered_by, answered_at, via, session_id) VALUES (?,?,?,?,?,?,?)").run(an, id, "withdraw", by, iso, via, ctx.sessionId ?? null);
  db.prepare("UPDATE cc_questions SET state = 'withdrawn', resolved_at = ? WHERE id = ?").run(iso, id);
  addNote(db, q.cwd, "withdraw", `${id} (${q.name}) withdrawn`, id, by, iso, now, ctx.sessionId);
  return ok(an, `${an} withdrew ${id} (${q.name})`);
}

function extendQuestion(db, id, by, iso, now, ctx) {
  const q = getQuestion(db, id);
  if (!q) return refused(`no such question ${id}`);
  if (q.state !== "open" && q.state !== "held") return refused(`${id} is ${q.state}; nothing to extend`);
  if (!q.deadline) return refused(`${id} has no deadline to extend (ask with --deadline 2h to set one)`);
  const span = q.deadline_span_ms ?? Date.parse(q.deadline) - Date.parse(q.asked_at);
  if (!(span > 0)) return refused(`${id} has no positive deadline span to extend by`);
  const next = nowIso(Date.parse(q.deadline) + span);
  db.prepare("UPDATE cc_questions SET deadline = ? WHERE id = ?").run(next, id);
  const nt = addNote(db, q.cwd, "extend", `${id} deadline moved to ${next}`, id, by, iso, now, ctx.sessionId);
  return ok(nt, `${nt} ${id} deadline now ${next} (${relative(next, now)})`);
}

/** `hold`: open → held. `reopen`: held → open with asked_at = now (it is being put to the human now). */
function setHeld(db, id, hold, iso) {
  const q = getQuestion(db, id);
  if (!q) return refused(`no such question ${id}`);
  const [from, to] = hold ? ["open", "held"] : ["held", "open"];
  if (q.state === to) return noop(id, `${id} (${q.name}) already ${to}`);
  if (q.state !== from) return refused(`${id} is ${q.state}; only a${from === "open" ? "n" : ""} ${from} question can be ${hold ? "held" : "reopened"}`);
  if (hold) db.prepare("UPDATE cc_questions SET state = 'held' WHERE id = ?").run(id);
  else db.prepare("UPDATE cc_questions SET state = 'open', asked_at = ? WHERE id = ?").run(iso, id);
  return ok(id, hold ? `${id} (${q.name}) held: waiting on the human, not put to them yet` : `${id} (${q.name}) reopened; ask the human in plain words now`);
}

/** `outcome <ref> [q-id] "<body>"`: what a decision or an answered question produced. */
function outcome(db, parsed, by, iso, now, ctx) {
  const ref = String(parsed.ref ?? "").trim();
  if (!ref || /\s/.test(ref)) return refused('outcome needs a ref (a PR URL, a commit, a path) with no spaces: outcome <ref> [q-id] "<what it produced>"');
  const text = parsed.textArg.trim();
  if (!text) return refused('outcome needs text: outcome <ref> [q-id] "<what it produced>"');
  if (parsed.questionId && !getQuestion(db, parsed.questionId)) return refused(`no such question ${parsed.questionId}`);
  const nt = addNote(db, ctx.cwd, "outcome", text, parsed.questionId ?? null, by, iso, now, ctx.sessionId, ref);
  return ok(nt, `${nt} outcome for ${ctx.cwd}: ${text} → ${ref}${parsed.questionId ? ` (for ${parsed.questionId})` : ""}`);
}

function note(db, parsed, by, iso, now, ctx) {
  const text = parsed.textArg.trim();
  if (!text) return refused('note needs text: note "<what was decided or assumed>"');
  const nt = addNote(db, ctx.cwd, "note", text, null, by, iso, now, ctx.sessionId);
  return ok(nt, `${nt} noted for ${ctx.cwd}: ${text}`);
}
