// report.mjs — `ledger report [--since 7d]`: what the hooks did in the window, graded.
//
// Per rule (the five Stop rules, the two PreToolUse rules and the review gate): how often it
// fired, how many bounces were satisfied, bypassed or are still open, and a grade:
//   biting   the rule sent back work that was then bypassed: bypassed ≥ 3, or more than half of
//            what fired was bypassed
//   silent   sessions ran in the window and the rule never fired
//   fine     otherwise (no sessions at all is fine too: nothing could have fired)
// The mechanical grade is always computed, so a report exists without a judge. When a judge is
// configured (LEDGER_JUDGE_BIN, review.judgeCommand, the shared judge file, or the i-have-audhd profile: lib/ledger-judge.mjs) it reads up to
// JUDGE_TEXTS bounce texts per rule that fired and answers biting, silent or fine; that answer is
// printed beside the mechanical one, never stored. A judge that is missing, fails, or answers
// none of the three words → `judge unavailable: <reason>` for that rule; the mechanical grade
// stands.
//
// Then owed work created in the window, by where the approval came from (an answer, or the
// agent's own `owe`): created, the current state of those items, and answers that set nothing in
// motion. When any item is deferred now: how many, how many went into deferred more than 7 days
// ago, and the parked wake-condition fix in one sentence.
//
// Then: canary runs in the window (per plugin: last status, counts, graded ones), reviews waived
// in the window with their reasons, and the judge's cached answers in the window. Read-only.

import { parseSpan, BOUNCES_DEFAULT_SINCE } from "./bounces.mjs";
import { askWord, judgementsSince } from "./ledger-judge.mjs";
import { nowIso } from "./time.mjs";

export const RULES = Object.freeze(["stopAnswerRule", "stopAskRule", "stopDecisionRule", "stopOwedRule", "stopOfferRule", "denyAskWithoutRow", "pushNeedsNote", "reviewGate", "pluginGate"]);
export const GRADES = Object.freeze(["biting", "silent", "fine"]);
export const JUDGE_TEXTS = 20;
export const JUDGE_QUESTION_RULE = "You are reading the bounces of one enforcement rule in a coding agent's hooks: each is a reply or command the rule sent back, with whether the agent then satisfied the rule or bypassed it. Is the rule biting (it sent back work that was right, so the agent had to bypass it), silent (the texts show it should have fired on more than it did), or fine?";

/** The mechanical grade for one rule's counts. */
export function mechanicalGrade({ fired, bypassed, sessions }) {
  if (fired > 0 && (bypassed >= 3 || bypassed * 2 > fired)) return "biting";
  if (fired === 0 && sessions > 0) return "silent";
  return "fine";
}

/** The rows and counts of the window. Pure reads. */
export function gather(db, { now = Date.now(), since = BOUNCES_DEFAULT_SINCE } = {}) {
  const span = parseSpan(since) ?? parseSpan(BOUNCES_DEFAULT_SINCE);
  const from = nowIso(now - span);
  const sessions = db.prepare("SELECT count(*) AS n FROM cc_sessions WHERE started_at >= ?").get(from).n;
  const bounces = db.prepare("SELECT id, session_id, rule, tool, outcome, at, text FROM cc_bounces WHERE at >= ? ORDER BY at DESC, id DESC").all(from).map((r) => ({ ...r }));
  const names = [...RULES, ...bounces.map((b) => b.rule).filter((r) => !RULES.includes(r))];
  const rules = [...new Set(names)].map((rule) => {
    const rows = bounces.filter((b) => b.rule === rule);
    const counts = { fired: rows.length, satisfied: rows.filter((b) => b.outcome === "satisfied").length, bypassed: rows.filter((b) => b.outcome === "bypassed").length, open: rows.filter((b) => !b.outcome).length };
    return { rule, ...counts, mechanical: mechanicalGrade({ ...counts, sessions }), texts: rows.filter((b) => b.text).slice(0, JUDGE_TEXTS), judge: null, judgeError: null };
  });
  const canary = db.prepare("SELECT id, plugin, at, status, exit_code, duration_ms, grade, graded_by, note, diff, tree_sha FROM cc_canary_runs WHERE at >= ? ORDER BY at DESC, id DESC").all(from).map((r) => ({ ...r }));
  const prunes = db.prepare("SELECT id, plugin, at, path, status, bytes_freed, note FROM cc_canary_prunes WHERE at >= ? ORDER BY at DESC, id DESC").all(from).map((r) => ({ ...r }));
  const waived = db.prepare("SELECT at, head_sha, branch, cwd, reason FROM cc_reviews WHERE verdict = 'waived' AND at >= ? ORDER BY at DESC").all(from).map((r) => ({ ...r }));
  let judgements = [];
  try {
    judgements = judgementsSince(db, now - span).map((r) => ({ ...r }));
  } catch {
    judgements = [];
  }
  return { from, since, span, sessions, rules, owed: gatherOwed(db, { from, now }), canary, prunes, waived, judgements };
}

/** Owed work in the window, per origin, and the deferred items now. Pure reads. */
export function gatherOwed(db, { from, now = Date.now() }) {
  const items = db.prepare("SELECT origin, state FROM cc_owed WHERE made_at >= ?").all(from);
  const row = (origin) => {
    const mine = items.filter((i) => i.origin === origin);
    const n = (state) => mine.filter((i) => i.state === state).length;
    return { created: mine.length, owed: n("owed"), started: n("started"), done: n("done"), deferred: n("deferred"), dropped: n("dropped") };
  };
  const notApproved = db.prepare("SELECT count(*) AS n FROM cc_owed_moves WHERE kind = 'nothing' AND at >= ?").get(from).n;
  const weekAgo = nowIso(now - 7 * 86_400_000);
  const deferred = db
    .prepare("SELECT o.id, (SELECT max(m.at) FROM cc_owed_moves m WHERE m.owed_id = o.id AND m.to_state = 'deferred') AS since FROM cc_owed o WHERE o.state = 'deferred'")
    .all()
    .map((r) => ({ ...r }));
  return {
    formal: { ...row("answer"), notApproved },
    agent: row("agent"),
    deferredNow: deferred.length,
    deferredOld: deferred.filter((d) => d.since && d.since < weekAgo).length,
  };
}

export const PARKED_FIX = "If deferrals are piling up, the parked fix is a wake condition on every deferral (next prompt, a question answered, or a date), after which the item blocks again; it was set aside for stage 1 on 2026-11-11.";

/** The owed section of the report. */
export function renderOwed(owed, from) {
  if (!owed) return [];
  const { formal, agent } = owed;
  const lines = [];
  if (!formal.created && !agent.created && !formal.notApproved) lines.push("no owed work in the window");
  else {
    lines.push(`owed work since ${from}, by where the approval came from:`);
    lines.push(`${pad("source", 16)} ${pad("created", 8)} ${pad("owed", 5)} ${pad("started", 8)} ${pad("done", 5)} ${pad("deferred", 9)} ${pad("dropped", 8)} not approved`);
    const line = (name, r, na) => `${pad(name, 16)} ${pad(r.created, 8)} ${pad(r.owed, 5)} ${pad(r.started, 8)} ${pad(r.done, 5)} ${pad(r.deferred, 9)} ${pad(r.dropped, 8)} ${na}`;
    lines.push(line("formal (answer)", formal, formal.notApproved));
    lines.push(line("agent (owe)", agent, "-"));
  }
  if (owed.deferredNow) lines.push(`deferred owed work: ${owed.deferredNow} item(s) deferred now, ${owed.deferredOld} of them deferred more than 7 days ago. ${PARKED_FIX}`);
  return lines;
}

/** The passage the judge reads for one rule: up to JUDGE_TEXTS bounce texts with their outcome. */
export function judgePassage(r) {
  return [`Rule: ${r.rule}. Fired ${r.fired}, satisfied ${r.satisfied}, bypassed ${r.bypassed}, open ${r.open}.`, ...r.texts.map((b, i) => `--- bounce ${i + 1} (${b.outcome ?? "open"}, ${b.tool ?? "Stop"}, ${b.at}) ---\n${b.text}`)].join("\n");
}

/** Ask the judge for every rule that fired and has texts; fills `judge` / `judgeError` in place. */
export async function overlayJudge(data, { config, env = process.env, judge = askWord } = {}) {
  for (const r of data.rules) {
    if (!r.fired) continue;
    if (!r.texts.length) {
      r.judgeError = "no bounce texts kept (rows from before 0.3.3)";
      continue;
    }
    const a = await judge({ config, env, passage: judgePassage(r), question: JUDGE_QUESTION_RULE, words: [...GRADES] });
    r.judge = a.answer;
    r.judgeError = a.error;
  }
  return data;
}

const pad = (s, n) => String(s).padEnd(n);

export function render(data) {
  const lines = [`ledger report since ${data.from} (${data.since}) · ${data.sessions} session(s)`, ""];
  lines.push(`${pad("rule", 18)} ${pad("fired", 6)} ${pad("satisfied", 10)} ${pad("bypassed", 9)} ${pad("open", 5)} grade`);
  for (const r of data.rules) {
    const judge = r.judge ? `judge: ${r.judge}` : r.judgeError ? `judge unavailable: ${r.judgeError}` : r.fired ? "judge: not asked" : "";
    lines.push(`${pad(r.rule, 18)} ${pad(r.fired, 6)} ${pad(r.satisfied, 10)} ${pad(r.bypassed, 9)} ${pad(r.open, 5)} ${r.mechanical}${judge ? ` (${judge})` : ""}`);
  }
  lines.push("");
  const owedLines = renderOwed(data.owed, data.from);
  if (owedLines.length) lines.push(...owedLines, "");
  const c = data.canary;
  const n = (st) => c.filter((r) => r.status === st).length;
  lines.push(`canary: ${c.length} run(s): pass ${n("pass")}, fail ${n("fail")}, unavailable ${n("unavailable")}`);
  const byPlugin = new Map();
  for (const r of c) if (!byPlugin.has(r.plugin)) byPlugin.set(r.plugin, r);
  for (const [plugin, r] of byPlugin) {
    const runs = c.filter((x) => x.plugin === plugin);
    const graded = runs.filter((x) => x.grade);
    lines.push(`  ${pad(plugin, 16)} last ${r.status} #${r.id} ${r.at}${r.note ? ` (${r.note})` : ""}${r.diff ? ", differs from the last pass" : ""} · ${runs.length} run(s)${graded.length ? `, graded: ${graded.map((x) => `#${x.id} ${x.grade}`).join(", ")}` : ""}`);
  }
  const p = data.prunes ?? [];
  const freed = p.reduce((s, r) => s + (r.bytes_freed ?? 0), 0);
  lines.push(`retention: ${p.length} prune run(s), ${freed} bytes freed${p.some((r) => r.status === "fail") ? `, ${p.filter((r) => r.status === "fail").length} failed` : ""}`);
  const byPath = new Map();
  for (const r of p) if (!byPath.has(`${r.plugin} ${r.path}`)) byPath.set(`${r.plugin} ${r.path}`, r);
  for (const [, r] of byPath) lines.push(`  ${pad(r.plugin, 16)} ${r.path} last ${r.status} #${r.id} ${r.at}${r.bytes_freed !== null ? ` ${r.bytes_freed} bytes freed` : ""}${r.status !== "pass" && r.note ? ` (${r.note})` : ""}`);
  lines.push("");
  lines.push(`reviews waived: ${data.waived.length}`);
  for (const w of data.waived) lines.push(`  ${w.at} ${w.head_sha.slice(0, 7)}${w.branch ? ` ${w.branch}` : ""} · ${w.reason ?? "(no reason)"} · ${w.cwd}`);
  lines.push("");
  const yes = data.judgements.filter((j) => j.answer === "yes").length;
  lines.push(`judge answers: ${data.judgements.length} (${yes} yes, ${data.judgements.length - yes} no)`);
  for (const j of data.judgements.slice(0, 20)) lines.push(`  ${j.at ?? "(no time)"} ${j.answer.padEnd(3)} ${j.key}`);
  return lines.join("\n");
}

/** `ledger report [--since <N>d|<N>h]`: { code, text, data }. The judge is asked unless `judge: false`. */
export async function runReport({ db, config, env = process.env, now = Date.now(), since = BOUNCES_DEFAULT_SINCE, judge = true, judgeFn = askWord }) {
  const data = gather(db, { now, since });
  if (judge) await overlayJudge(data, { config, env, judge: judgeFn });
  return { code: 0, text: render(data), data };
}

export function parseReportArgs(tokens) {
  const usage = "usage: report [--since <N>d|<N>h] [--no-judge]";
  let since = BOUNCES_DEFAULT_SINCE;
  let judge = true;
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === "--no-judge") judge = false;
    else if (a === "--since" && tokens[i + 1] !== undefined) since = tokens[++i];
    else if (a.startsWith("--since=")) since = a.slice(8);
    else return { error: usage };
    if (!parseSpan(since)) return { error: usage };
  }
  return { since, judge };
}
