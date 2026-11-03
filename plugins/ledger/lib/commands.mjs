// commands.mjs — what each verb does to the store, one function per verb, each in one
// BEGIN IMMEDIATE transaction. Every function returns { status, id, message }:
//   ok       a row was written; `id` is the row that proves it
//   noop     nothing to do and nothing written (already answered, already open, closed …)
//   refused  not applied, `message` says why and what would be accepted
//
// Rules this file is the home of (see the README's bug → fix map):
//   - an answer is recorded only when the word is one of the question's options (or `withdraw`);
//     anything else is refused with the option list and nothing is written;
//   - a question is asked once: repeating an open one returns its id and writes nothing;
//   - answering a question on a closed workload says `closed, nothing to decide`, not an error;
//   - close needs a reason and nothing else; open questions on the workload are withdrawn in
//     the same transaction and listed in the reply;
//   - `open` with a title already open in the same folder returns that id and writes nothing.
//
// Scope. A workload is bound to the folder it was opened in. "In scope for <cwd>" means the
// workload's cwd equals <cwd> or is an ancestor of it, so a workload opened at a repository root
// covers work in its subfolders. The gate workload is the deepest open one in scope.

import { sep } from "node:path";
import { newId, prefixOf } from "./ids.mjs";
import { VERBS, optionList } from "./parse.mjs";
import { nowIso, parseDeadline, relative, formatLocal, days as daysMs } from "./time.mjs";
import { transaction } from "./db.mjs";

const STAKES = ["throwaway", "normal", "production"];
const KINDS = ["question", "approval", "plan"];
const KIND_DEFAULT_OPTIONS = { approval: ["approve", "deny"], plan: ["approve", "revise", "cancel"] };
const KIND_DEFAULT_WORD = { approval: "deny" };

export const ok = (id, message) => ({ status: "ok", id, message });
export const noop = (id, message) => ({ status: "noop", id, message });
export const refused = (message) => ({ status: "refused", id: null, message });

/** True when `dir` is `root` or lies under it. Both are expected to be absolute and normalised. */
export function isWithin(dir, root) {
  if (dir === root) return true;
  const r = root.endsWith(sep) ? root : root + sep;
  return dir.startsWith(r);
}

function scopeRows(db, cwd, statuses) {
  const marks = statuses.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM workloads WHERE status IN (${marks}) ORDER BY length(cwd) DESC, opened_at DESC`).all(...statuses);
  return rows.filter((w) => isWithin(cwd, w.cwd));
}

/**
 * The workloads that govern `cwd`: the gate (deepest open), plus halted and parked ones a
 * hook or the SessionStart text may name.
 */
export function gateState(db, cwd) {
  const rows = scopeRows(db, cwd, ["open", "halted", "parked"]);
  return {
    open: rows.find((w) => w.status === "open") ?? null,
    halted: rows.find((w) => w.status === "halted") ?? null,
    parked: rows.filter((w) => w.status === "parked"),
    openAll: rows.filter((w) => w.status === "open"),
  };
}

/** Open questions on non-closed workloads in scope, oldest first (the `pending` order). */
export function openQuestions(db, cwd) {
  const rows = db
    .prepare(
      `SELECT q.*, w.cwd AS wl_cwd, w.status AS wl_status, w.title AS wl_title
         FROM questions q JOIN workloads w ON w.id = q.workload_id
        WHERE q.state = 'open' AND w.status != 'closed'
        ORDER BY q.asked_at ASC, q.id ASC`,
    )
    .all();
  return rows.filter((q) => isWithin(cwd, q.wl_cwd)).map(parseQuestion);
}

function parseQuestion(q) {
  if (!q) return null;
  return { ...q, options: JSON.parse(q.options), allows: q.allows ? JSON.parse(q.allows) : null };
}

function getQuestion(db, id) {
  return parseQuestion(db.prepare("SELECT * FROM questions WHERE id = ?").get(id));
}

function getWorkload(db, id) {
  return db.prepare("SELECT * FROM workloads WHERE id = ?").get(id) ?? null;
}

/** The parser's view of the store for `cwd`. */
export function createLookup(db, cwd) {
  return {
    question(id) {
      const q = getQuestion(db, id);
      if (!q) return null;
      const w = getWorkload(db, q.workload_id);
      return { id: q.id, options: q.options, state: q.state, workloadStatus: w?.status ?? null };
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
      const table = { wl: "workloads", q: "questions", an: "answers", de: "decisions", ce: "ceilings" }[prefixOf(id)];
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

function touch(db, wlId, iso, sessionId) {
  if (sessionId) db.prepare("UPDATE workloads SET last_seen_at = ?, session_id = ? WHERE id = ?").run(iso, sessionId, wlId);
  else db.prepare("UPDATE workloads SET last_seen_at = ? WHERE id = ?").run(iso, wlId);
}

function decision(db, wlId, kind, body, by, iso, now) {
  const id = freshId(db, "decisions", "de", now);
  db.prepare("INSERT INTO decisions (id, workload_id, kind, body, made_by, made_at) VALUES (?,?,?,?,?,?)").run(id, wlId, kind, body, by, iso);
  return id;
}

/** Mark every open question on `wlId` withdrawn, writing one `withdraw` answer each. Returns their ids. */
function withdrawOpenQuestions(db, wlId, by, via, iso, now) {
  const open = db.prepare("SELECT id FROM questions WHERE workload_id = ? AND state = 'open' ORDER BY asked_at").all(wlId);
  for (const q of open) {
    db.prepare("INSERT INTO answers (id, question_id, word, answered_by, answered_at, via) VALUES (?,?,?,?,?,?)").run(freshId(db, "answers", "an", now), q.id, "withdraw", by, iso, via);
    db.prepare("UPDATE questions SET state = 'withdrawn', resolved_at = ? WHERE id = ?").run(iso, q.id);
  }
  return open.map((q) => q.id);
}

/**
 * The paste-ready line for one question:
 *   <default> <q-id>  # <name> · <body> · default <default> · also: <others> / withdraw
 *   then `  allows:` lines for plan questions, then `  due <deadline>` (`overdue` when past).
 */
export function pendingLines(q, { now = Date.now(), timezone = null } = {}) {
  const others = q.options.filter((o) => o !== q.default_opt);
  const body = q.body.replace(/\s+/g, " ").trim();
  const lines = [`${q.default_opt} ${q.id}  # ${q.name} · ${body} · default ${q.default_opt} · also: ${others.join(", ")} / withdraw`];
  if (q.allows && Object.keys(q.allows).length) {
    lines.push("  allows:");
    for (const o of q.options) if (Object.hasOwn(q.allows, o)) lines.push(`    ${o}: ${q.allows[o]}`);
  }
  if (q.deadline) {
    const past = Date.parse(q.deadline) < now;
    lines.push(`  due ${formatLocal(q.deadline, timezone)} (${past ? "overdue, " : ""}${relative(q.deadline, now)})`);
  }
  return lines;
}

export function renderPending(questions, cwd, opts = {}) {
  if (!questions.length) return `no open questions for ${cwd}`;
  const out = [];
  questions.forEach((q, i) => {
    const lines = pendingLines(q, opts);
    out.push(`${i + 1}. ${lines[0]}`);
    out.push(...lines.slice(1));
  });
  return out.join("\n");
}

export function renderStale(rows, days, { now = Date.now() } = {}) {
  if (!rows.length) return `no open or parked workloads untouched for ${days} days`;
  return rows
    .map(
      (w) =>
        `${w.id} ${w.title} · ${w.status} · last seen ${relative(w.last_seen_at, now)} · clear with: close ${w.id} <reason>  |  park ${w.id} <reason>`,
    )
    .join("\n");
}

export function renderHelp() {
  const lines = ["ledger verbs (who usually says it in brackets):"];
  for (const v of VERBS) lines.push(`  ${v.usage}`, `      [${v.who}] ${v.help}`);
  lines.push(
    "",
    "ids: wl- workload, q- question, an- answer, de- decision, ce- ceiling; an id looks like q-mvr3k2p9a1xq.",
    "answers: <word> <q-id>, where the word is one of the question's options (or withdraw); a word that is not an option is refused.",
    "batch: with no verb and stdin piped, one command per line; each line is applied on its own, in order, and reported on its own line.",
    "prose: a line that does not match a shape above is `not a command` and is never recorded.",
  );
  return lines.join("\n");
}

/** One line for the SessionStart text and `stale`: title, stakes, age, ceiling. */
export function workloadLine(db, w, now) {
  const c = db.prepare("SELECT usd, hours FROM ceilings WHERE workload_id = ? ORDER BY set_at DESC, id DESC LIMIT 1").get(w.id);
  const ceiling = c ? ` · ceiling $${c.usd}${c.hours ? `/${c.hours}h` : ""}` : "";
  return `${w.id} ${w.title} · ${w.stakes} · opened ${relative(w.opened_at, now)}${ceiling}`;
}

function parseAllows(text) {
  const out = {};
  for (const part of String(text).split(";")) {
    const m = /^\s*([^:\s]+)\s*:\s*(.+?)\s*$/.exec(part);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/**
 * Execute one parsed command.
 * @param ctx { cwd, actor(verb) → name, via: 'cli'|'prompt-hook', sessionId, now, config, configText }
 */
export function execute(db, parsed, ctx) {
  const now = ctx.now ?? Date.now();
  const iso = nowIso(now);
  const by = ctx.actor(parsed.verb);
  const via = ctx.via ?? "cli";
  const run = (fn) => transaction(db, fn, ctx.dbPath);

  switch (parsed.verb) {
    case "help":
      return ok(null, renderHelp());
    case "config":
      return ok(null, ctx.configText ?? "(config unavailable here)");
    case "pending":
      return ok(null, renderPending(openQuestions(db, ctx.cwd), ctx.cwd, { now, timezone: ctx.config?.timezone ?? null }));
    case "stale": {
      const days = parsed.days ?? ctx.config?.stale?.days ?? 7;
      const cutoff = nowIso(now - daysMs(days));
      const rows = db.prepare("SELECT * FROM workloads WHERE status IN ('open','parked') AND last_seen_at < ? ORDER BY last_seen_at ASC").all(cutoff);
      return ok(null, renderStale(rows, days, { now }));
    }

    case "open":
      return run(() => (parsed.id ? reopen(db, parsed.id, by, iso, now, ctx) : openWorkload(db, parsed, by, iso, now, ctx)));
    case "close":
      return run(() => closeWorkload(db, parsed.id, parsed.reason, by, via, iso, now, "close"));
    case "park":
      return run(() => park(db, parsed.id, parsed.reason, by, iso, now));
    case "halt":
      return run(() => halt(db, parsed.id, by, iso, now));
    case "withdraw":
      return run(() => (prefixOf(parsed.id) === "q" ? withdrawQuestion(db, parsed.id, by, via, iso, now) : withdrawWorkload(db, parsed.id, by, via, iso, now)));
    case "ask":
      return run(() => ask(db, parsed, by, iso, now, ctx));
    case "answer":
      return run(() => answer(db, parsed, by, via, iso, now, ctx));
    case "ceiling":
      return run(() => ceiling(db, parsed, by, iso, now));
    case "extend":
      return run(() => (prefixOf(parsed.id) === "q" ? extendQuestion(db, parsed.id, by, iso, now) : extendWorkload(db, parsed.id, by, iso, now)));
    case "decide":
      return run(() => decide(db, parsed, by, iso, now, ctx));
    default:
      return refused(`unknown verb ${parsed.verb}`);
  }
}

function openWorkload(db, parsed, by, iso, now, ctx) {
  const title = parsed.textArg.trim();
  if (!title) return refused('open needs a title: open "<title>"');
  const stakes = parsed.flags?.stakes ?? "normal";
  if (!STAKES.includes(stakes)) return refused(`--stakes must be one of ${STAKES.join(", ")}`);
  const existing = db.prepare("SELECT id FROM workloads WHERE cwd = ? AND status = 'open' AND title = ?").get(ctx.cwd, title);
  if (existing) return noop(existing.id, `${existing.id} already open with that title in ${ctx.cwd}`);
  const id = freshId(db, "workloads", "wl", now);
  db.prepare(
    "INSERT INTO workloads (id, title, cwd, stakes, status, opened_at, last_seen_at, session_id) VALUES (?,?,?,?,'open',?,?,?)",
  ).run(id, title, ctx.cwd, stakes, iso, iso, ctx.sessionId ?? null);
  return ok(id, `${id} opened "${title}" (${stakes}) for ${ctx.cwd}`);
}

function reopen(db, id, by, iso, now, ctx) {
  const w = getWorkload(db, id);
  if (!w) return refused(`no such workload ${id}`);
  if (w.status === "open") return noop(id, `${id} already open`);
  if (w.status === "closed") return refused(`${id} is closed (${w.status_reason}); open a new workload with open "<title>"`);
  db.prepare("UPDATE workloads SET status = 'open', status_reason = NULL, status_by = NULL, last_seen_at = ?, session_id = COALESCE(?, session_id) WHERE id = ?").run(iso, ctx.sessionId ?? null, id);
  const de = decision(db, id, "reopen", `reopened (was ${w.status}: ${w.status_reason})`, by, iso, now);
  return ok(id, `${id} reopened (was ${w.status}: ${w.status_reason}) · ${de}`);
}

function closeWorkload(db, id, reason, by, via, iso, now, kind) {
  const w = getWorkload(db, id);
  if (!w) return refused(`no such workload ${id}`);
  const r = String(reason ?? "").trim();
  if (!r) return refused(`close needs a reason: close ${id} <reason>`);
  if (w.status === "closed") return noop(id, `${id} already closed ${w.closed_at} (${w.status_reason})`);
  const withdrawn = withdrawOpenQuestions(db, id, by, via, iso, now);
  db.prepare("UPDATE workloads SET status = 'closed', status_reason = ?, status_by = ?, closed_at = ?, last_seen_at = ? WHERE id = ?").run(r, by, iso, iso, id);
  const de = decision(db, id, kind, r, by, iso, now);
  const tail = withdrawn.length ? `; withdrew ${withdrawn.join(", ")}` : "";
  return ok(id, `${id} closed (${r}) · ${de}${tail}`);
}

function park(db, id, reason, by, iso, now) {
  const w = getWorkload(db, id);
  if (!w) return refused(`no such workload ${id}`);
  const r = String(reason ?? "").trim();
  if (!r) return refused(`park needs a reason: park ${id} <reason>`);
  if (w.status === "parked") return noop(id, `${id} already parked (${w.status_reason})`);
  if (w.status === "closed") return refused(`${id} is closed (${w.status_reason}); nothing to park`);
  db.prepare("UPDATE workloads SET status = 'parked', status_reason = ?, status_by = ?, last_seen_at = ? WHERE id = ?").run(r, by, iso, id);
  const de = decision(db, id, "park", r, by, iso, now);
  return ok(id, `${id} parked (${r}) · ${de}; resume with open ${id}`);
}

function halt(db, id, by, iso, now) {
  const w = getWorkload(db, id);
  if (!w) return refused(`no such workload ${id}`);
  if (w.status !== "open") return refused(`${id} is ${w.status} (${w.status_reason}); halt takes an open workload`);
  const reason = `halted by ${by}`;
  db.prepare("UPDATE workloads SET status = 'halted', status_reason = ?, status_by = ?, last_seen_at = ? WHERE id = ?").run(reason, by, iso, id);
  const de = decision(db, id, "halt", reason, by, iso, now);
  return ok(id, `${id} halted · ${de}; the gate denies until open ${id}`);
}

function withdrawQuestion(db, id, by, via, iso, now) {
  const q = getQuestion(db, id);
  if (!q) return refused(`no such question ${id}`);
  if (q.state === "withdrawn") {
    const a = db.prepare("SELECT id FROM answers WHERE question_id = ?").get(id);
    return noop(id, `${id} already withdrawn${a ? ` (${a.id})` : ""}`);
  }
  if (q.state === "answered") {
    const a = db.prepare("SELECT id, word FROM answers WHERE question_id = ?").get(id);
    return refused(`${id} already answered ${a.word} (${a.id}); an answered question cannot be withdrawn`);
  }
  const an = freshId(db, "answers", "an", now);
  db.prepare("INSERT INTO answers (id, question_id, word, answered_by, answered_at, via) VALUES (?,?,?,?,?,?)").run(an, id, "withdraw", by, iso, via);
  db.prepare("UPDATE questions SET state = 'withdrawn', resolved_at = ? WHERE id = ?").run(iso, id);
  touch(db, q.workload_id, iso);
  return ok(an, `${an} withdrew ${id} (${q.name})`);
}

function withdrawWorkload(db, id, by, via, iso, now) {
  const w = getWorkload(db, id);
  if (!w) return refused(`no such workload ${id}`);
  if (w.status === "closed") return noop(id, `${id} already closed ${w.closed_at} (${w.status_reason})`);
  const open = db.prepare("SELECT id FROM questions WHERE workload_id = ? AND state = 'open' ORDER BY asked_at").all(id);
  if (open.length) return refused(`${id} has open questions: ${open.map((q) => q.id).join(", ")}; answer or withdraw them first, or close ${id} <reason>`);
  return closeWorkload(db, id, "withdrawn", by, via, iso, now, "close");
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

  let deadline = null;
  let span = null;
  if (f.deadline !== undefined) {
    const d = parseDeadline(String(f.deadline), now);
    if (!d) return refused(`--deadline takes a duration (2h, 30m, 3d) or an ISO date; got ${f.deadline}`);
    deadline = d.iso;
    span = d.spanMs;
  }

  let wl;
  if (f.wl !== undefined) {
    wl = getWorkload(db, String(f.wl));
    if (!wl) return refused(`no such workload ${f.wl}`);
  } else {
    wl = gateState(db, ctx.cwd).open;
    if (!wl) return refused(`no open workload for ${ctx.cwd}: open "<title>" first, or pass --wl <wl-id>`);
  }
  if (wl.status !== "open") return refused(`${wl.id} is ${wl.status} (${wl.status_reason}); open ${wl.id} first`);

  const optionsJson = JSON.stringify(options);
  const repeat = db.prepare("SELECT id FROM questions WHERE workload_id = ? AND body = ? AND options = ? AND state = 'open'").get(wl.id, body, optionsJson);
  if (repeat) {
    const q = getQuestion(db, repeat.id);
    return noop(repeat.id, `${repeat.id} already asked and still open\n${pendingLines(q, { now, timezone: ctx.config?.timezone ?? null }).join("\n")}`);
  }

  const id = freshId(db, "questions", "q", now);
  db.prepare(
    `INSERT INTO questions (id, workload_id, kind, name, body, options, allows, default_opt, deadline, deadline_span_ms, state, asked_by, asked_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
  ).run(id, wl.id, kind, name, body, optionsJson, allows ? JSON.stringify(allows) : null, def, deadline, span, by, iso);
  touch(db, wl.id, iso, ctx.sessionId);
  const q = getQuestion(db, id);
  return ok(id, `${id} asked on ${wl.id}; end your message with this line:\n${pendingLines(q, { now, timezone: ctx.config?.timezone ?? null }).join("\n")}`);
}

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
  const word = String(parsed.word).toLowerCase();
  const w = getWorkload(db, q.workload_id);
  if (w?.status === "closed") return noop(id, `${id} is on ${w.id}, closed ${w.closed_at} (${w.status_reason}): closed, nothing to decide`);

  if (!q.options.includes(word)) {
    if (word === "withdraw") return withdrawQuestion(db, id, by, via, iso, now);
    return refused(`${word} is not an option of ${id} (${q.name}); options: ${optionList(q.options)}. Nothing recorded.`);
  }
  if (q.state !== "open") {
    const a = db.prepare("SELECT id, word FROM answers WHERE question_id = ?").get(id);
    if (q.state === "withdrawn") return refused(`${id} was withdrawn${a ? ` (${a.id})` : ""}; ask it again to answer it`);
    if (a && a.word === word) return noop(a.id, `already answered ${word} (${a.id})`);
    return refused(`${id} already answered ${a?.word} (${a?.id}); an answer is final`);
  }
  const an = freshId(db, "answers", "an", now);
  db.prepare("INSERT INTO answers (id, question_id, word, answered_by, answered_at, via) VALUES (?,?,?,?,?,?)").run(an, id, word, by, iso, via);
  db.prepare("UPDATE questions SET state = 'answered', resolved_at = ? WHERE id = ?").run(iso, id);
  touch(db, q.workload_id, iso, ctx.sessionId);
  const allows = q.allows && Object.hasOwn(q.allows, word) ? ` · allows: ${q.allows[word]}` : "";
  return ok(an, `${an} ${word} → ${id} (${q.name})${allows}`);
}

function ceiling(db, parsed, by, iso, now) {
  const w = getWorkload(db, parsed.id);
  if (!w) return refused(`no such workload ${parsed.id}`);
  if (w.status === "closed") return refused(`${parsed.id} is closed (${w.status_reason}); no ceiling to set`);
  const first = db.prepare("SELECT block_usd, block_hours FROM ceilings WHERE workload_id = ? ORDER BY set_at ASC, id ASC LIMIT 1").get(parsed.id);
  const blockUsd = first ? first.block_usd : parsed.usd;
  const blockHours = first ? first.block_hours : parsed.hours;
  const id = freshId(db, "ceilings", "ce", now);
  db.prepare("INSERT INTO ceilings (id, workload_id, usd, hours, block_usd, block_hours, set_by, set_at) VALUES (?,?,?,?,?,?,?,?)").run(id, parsed.id, parsed.usd, parsed.hours, blockUsd, blockHours, by, iso);
  const text = `$${parsed.usd}${parsed.hours ? `/${parsed.hours}h` : ""}`;
  decision(db, parsed.id, "ceiling", `ceiling ${text}`, by, iso, now);
  touch(db, parsed.id, iso);
  return ok(id, `${id} ceiling ${text} on ${parsed.id}${first ? "" : ` (extend adds ${text} each time)`}`);
}

function extendWorkload(db, id, by, iso, now) {
  const w = getWorkload(db, id);
  if (!w) return refused(`no such workload ${id}`);
  if (w.status === "closed") return refused(`${id} is closed (${w.status_reason}); nothing to extend`);
  const cur = db.prepare("SELECT * FROM ceilings WHERE workload_id = ? ORDER BY set_at DESC, id DESC LIMIT 1").get(id);
  if (!cur) return refused(`no ceiling on ${id}; set one with ceiling <usd> [<hours>] ${id}`);
  const usd = cur.usd + cur.block_usd;
  const hours = cur.hours !== null && cur.block_hours !== null ? cur.hours + cur.block_hours : cur.hours;
  const ce = freshId(db, "ceilings", "ce", now);
  db.prepare("INSERT INTO ceilings (id, workload_id, usd, hours, block_usd, block_hours, set_by, set_at) VALUES (?,?,?,?,?,?,?,?)").run(ce, id, usd, hours, cur.block_usd, cur.block_hours, by, iso);
  const text = `$${usd}${hours ? `/${hours}h` : ""}`;
  const de = decision(db, id, "extend", `ceiling extended to ${text}`, by, iso, now);
  touch(db, id, iso);
  return ok(ce, `${ce} ceiling now ${text} on ${id} · ${de}`);
}

function extendQuestion(db, id, by, iso, now) {
  const q = getQuestion(db, id);
  if (!q) return refused(`no such question ${id}`);
  if (q.state !== "open") return refused(`${id} is ${q.state}; nothing to extend`);
  if (!q.deadline) return refused(`${id} has no deadline to extend (ask with --deadline 2h to set one)`);
  const span = q.deadline_span_ms ?? Date.parse(q.deadline) - Date.parse(q.asked_at);
  if (!(span > 0)) return refused(`${id} has no positive deadline span to extend by`);
  const next = nowIso(Date.parse(q.deadline) + span);
  db.prepare("UPDATE questions SET deadline = ? WHERE id = ?").run(next, id);
  const de = decision(db, q.workload_id, "extend", `${id} deadline moved to ${next}`, by, iso, now);
  touch(db, q.workload_id, iso);
  return ok(de, `${de} ${id} deadline now ${next} (${relative(next, now)})`);
}

function decide(db, parsed, by, iso, now, ctx) {
  const text = parsed.textArg.trim();
  if (!text) return refused('decide needs text: decide "<what was decided>"');
  const f = parsed.flags ?? {};
  let wl;
  if (f.wl !== undefined) {
    wl = getWorkload(db, String(f.wl));
    if (!wl) return refused(`no such workload ${f.wl}`);
  } else {
    wl = gateState(db, ctx.cwd).open;
    if (!wl) return refused(`no open workload for ${ctx.cwd}: open "<title>" first, or pass --wl <wl-id>`);
  }
  if (wl.status === "closed") return refused(`${wl.id} is closed (${wl.status_reason}); decisions go on an open workload`);
  const de = decision(db, wl.id, "decide", text, by, iso, now);
  touch(db, wl.id, iso, ctx.sessionId);
  return ok(de, `${de} decided on ${wl.id}: ${text}`);
}
