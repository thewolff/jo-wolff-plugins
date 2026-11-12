// inject.mjs — the text SessionStart hands Claude: owed work (approved, not finished; the
// session's own, then other sessions' in scope as not blocking), held questions (Waiting on you), open
// questions, recent notes, the verb summary, the open and held questions in other folders
// (each with its body, options and default, so the session can record the human's answer to
// one without a lookup), one line when the cross-lab review found problems on HEAD, and, last,
// one doctor line when the cheap health checks find issues. Sections appear in that order and
// only when non-empty. Capped at CAP characters (the doc's limit is 10,000): notes are truncated
// first, never the owed work, the held or open questions, the other-folders block, review or doctor lines.
// The owed section has its own caps (OWED_CAPS) and on `compact` keeps only owed and started.

import { fileURLToPath } from "node:url";
import { elsewhereQuestions, heldHead, heldQuestions, logEntries, openQuestions, pendingLines, renderLog, renderPending } from "./commands.mjs";
import { quickIssues } from "./doctor.mjs";
import { cut, leftover, sessionItems } from "./owed.mjs";
import { relative } from "./time.mjs";
import { findingsLine } from "./review.mjs";

export const CAP = 9000;

/** The absolute path of the CLI, right wherever the plugin is installed. */
export function cliPath() {
  return fileURLToPath(new URL("../scripts/ledger.mjs", import.meta.url));
}

/** The path as it is written on a command line: bare when plain, double-quoted when it needs it. */
export function shellPath(p) {
  return /[\s"'`$\\!*?]/.test(p) ? JSON.stringify(p) : p;
}

/**
 * The exact command text the agent writes for every ledger call. One stable form, so one
 * permission rule covers every write and Claude Code never prompts for a ledger command.
 */
export function invocation(p = cliPath()) {
  return `node ${shellPath(p)}`;
}

/**
 * The one-line allow rule the person adds once to their settings so ledger commands never
 * prompt. Permission rules match the command text as written, and `*` may sit anywhere in a
 * Bash rule (permissions reference § Wildcard patterns). A plugin installed from a marketplace
 * lives under `…/plugins/cache/<marketplace>/ledger/<version>/scripts/ledger.mjs`; the rule
 * replaces the version segment with `*` so a plugin update does not break it. Any other layout
 * (`--plugin-dir`, a checkout) gets the exact path.
 */
export function allowRule(p = cliPath()) {
  const m = /^(.*[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/]ledger[\\/])[^\\/]+([\\/]scripts[\\/]ledger\.mjs)$/.exec(p);
  const pattern = m ? `${m[1]}*${m[2]}` : p;
  // Quote when the real path needs it (the `*` the rule adds is not a reason to quote).
  const quoted = shellPath(p) !== p ? JSON.stringify(pattern) : pattern;
  return `Bash(node ${quoted} *)`;
}

export function verbSummary() {
  return [
    `ledger: questions to the human and decisions made without asking are recorded with the \`ledger\` CLI. Always run it exactly as \`${invocation()} <verb> …\` (that literal path, no alias, no shell variable, no cd) so the one allow rule \`${allowRule()}\` matches and Claude Code never asks about it.`,
    "Verbs: ask \"<body>\" --name <short> --options a,b --default a · answer <q-id> <option> [--nothing | --pointer \"<p>\"] [--work \"<text>\"] · owe \"<work>\" · start <ow-id> \"<pointer>\" · hold <ow-id> \"<why>\" · drop <ow-id> \"<why>\" · done <ow-id> [ref] · wait <ow-id> <q-id> · withdraw <q-id> · extend <q-id> · hold <q-id> · reopen <q-id> · note \"<text>\" · outcome <ref> [q-id] \"<text>\" · pending [--all] · log [N] · review · doctor · bounces · help.",
    "To ask the human: run `ledger ask` first, then ask in plain words. Never show the human a q- id; ids are for you. When the human replies, run `ledger answer <q-id> <option>` with the option their words mean before anything else; a reply that is none of the options is recorded as given with `ledger answer <q-id> \"<reply>\"`, never withdrawn. Asked what is waiting: run `pending --all`, report every row first. Record a choice made without asking with `note`, in the same turn you state it. `git push` and `gh pr create` need one `note` or `outcome` in this session first, and a `ledger review` of HEAD. `ledger help` has the grammar. Recording an answer records the approved work as owed unless you add `--nothing`; owed work blocks the end of a turn until you start, hold, drop or finish it. Work you will not start this turn: record it with `owe`, then hold it with a reason.",
  ].join("\n");
}

/**
 * @returns {{ text: string, sections: string[] }}
 */
export function buildInjection(db, cwd, config, { source = "startup", now = Date.now(), env = process.env, sessionId = null } = {}) {
  const compact = source === "compact";
  const sections = [];

  let owedText = "";
  try {
    owedText = owedSection(db, cwd, sessionId, { compact, now });
  } catch {
    /* the owed section is advisory here; the Stop rule still holds the work */
  }
  if (owedText) sections.push("owed");

  const held = heldQuestions(db, cwd);
  let waitingText = "";
  if (held.length) {
    waitingText = `ledger: Waiting on you (held questions for ${cwd} and the folders below it, oldest first; formed and deferred, not yet put to the human; when you ask one, run \`reopen <q-id>\` first):\n${held.map((q) => `- ${q.name}: ${q.body.replace(/\s+/g, " ").trim()} (${q.id}${q.cwd !== cwd && q.cwd.startsWith(cwd) ? `, in ${q.cwd}` : ""})`).join("\n")}`;
    sections.push("waiting");
  }

  const questions = openQuestions(db, cwd);
  let questionsText = "";
  if (questions.length) {
    questionsText = `ledger: open questions for ${cwd} and the folders below it (for you, not the human: when the human answers one in their own words, record it with \`answer <q-id> <option>\`; that also records approved work as owed (\`--nothing\` if not); never show them the id):\n${renderPending(questions, cwd, { now, timezone: config.timezone ?? null })}`;
    sections.push("questions");
  }

  let notesText = "";
  const n = Number(config.inject?.notes ?? 5);
  if (!compact && n > 0) {
    const rows = logEntries(db, cwd, n);
    if (rows.length) {
      notesText = `ledger: last ${rows.length} entries for ${cwd}:\n${renderLog(rows, cwd, n, { now })}`;
      sections.push("notes");
    }
  }

  const summary = compact ? verbSummary().split("\n")[0] : verbSummary();
  if (summary) sections.push("summary");

  const elsewhereText = config.inject?.elsewhere === false ? "" : elsewhereLine(db, cwd, { now, timezone: config.timezone ?? null });
  if (elsewhereText) sections.push("elsewhere");

  let reviewText = "";
  try {
    reviewText = findingsLine(db, cwd, config, invocation());
  } catch {
    /* the review line is advisory; a fault leaves it out */
  }
  if (reviewText) sections.push("review");

  const doctorText = config.inject?.doctor === false ? "" : doctorLine(db, { env, now });
  if (doctorText) sections.push("doctor");

  const assemble = (notes) => [owedText, waitingText, questionsText, notes, summary, elsewhereText, reviewText, doctorText].filter(Boolean).join("\n\n");
  let text = assemble(notesText);
  if (text.length > CAP) text = assemble(truncate(notesText, Math.max(0, CAP - (text.length - notesText.length))));
  if (text.length > CAP) text = assemble("");
  return { text, sections };
}

/** One line when the cheap doctor checks (schema version, errors.log in the last 7 days) find issues; "" otherwise. */
export function doctorLine(db, { env = process.env, now = Date.now() } = {}) {
  const n = quickIssues(db, { env, now });
  if (!n) return "";
  return `ledger: doctor reports ${n} issue(s); run \`${invocation()} doctor\``;
}

// How many other-folder questions the SessionStart block lists in full before pointing at `pending --all`.
export const ELSEWHERE_MAX = 10;

/**
 * The open and held questions outside the scope of `cwd` (not it, not an ancestor, not under
 * it), grouped under their folder: one `pending` line per question (body, options, default and
 * the q- id, so the session can record the human's reply without a lookup), a held one's line
 * opening with `held` in place of the default word; "" when there are none. Past ELSEWHERE_MAX
 * questions the rest are counted and left to `pending --all`.
 */
export function elsewhereLine(db, cwd, { now = Date.now(), timezone = null } = {}) {
  const groups = elsewhereQuestions(db, cwd);
  if (!groups.size) return "";
  const all = [...groups.values()].flat();
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const out = [
    `ledger: ${plural(all.length, "question")} waiting on the human in ${plural(groups.size, "other folder")} (asked by another window, not this folder's work). If the human's prompt answers one, run \`${invocation()} answer <q-id> <option>\` and say it is recorded. Otherwise, in your first reply, tell the human in one plain line per question that another window is waiting on them: the question's body, its options and its default when it has one. Never show the q- id:`,
  ];
  let shown = 0;
  for (const [folder, questions] of groups) {
    if (shown >= ELSEWHERE_MAX) break;
    out.push(folder);
    for (const q of questions) {
      if (shown >= ELSEWHERE_MAX) break;
      const lines = pendingLines(q, { now, timezone });
      if (q.state === "held") lines[0] = heldHead(lines[0], q);
      out.push(...lines);
      shown++;
    }
  }
  if (shown < all.length) out.push(`… and ${all.length - shown} more; run \`${invocation()} pending --all\` to see them all.`);
  return out.join("\n");
}

/** `block` cut at a line break so that the result, marker included, is at most `max` characters. */
export function truncate(block, max) {
  if (!block || block.length <= max) return block;
  if (max < 40) return "";
  const room = max - MARKER.length;
  const cut = block.lastIndexOf("\n", room);
  return `${block.slice(0, cut > 0 ? cut : room)}${MARKER}`;
}
const MARKER = "\n… (truncated)";

/** How many lines each owed list keeps in the SessionStart injection. */
export const OWED_CAPS = Object.freeze({ owed: 10, started: 5, deferred: 5, others: 5 });

/**
 * The SessionStart owed section: this session's owed, started and deferred items, then items in
 * scope owned by other sessions (listed, not blocking). Bodies cut to 120 characters, pointers
 * and reasons to 80. On `compact` only owed and started. "" when there is nothing.
 */
export function owedSection(db, cwd, sessionId, { compact = false, now = Date.now() } = {}) {
  const mine = sessionId ? sessionItems(db, { sessionId, cwd }) : [];
  const others = compact ? [] : leftover(db, { sessionId, cwd });
  const by = (state) => mine.filter((i) => i.state === state);
  const owed = by("owed");
  const started = by("started");
  const deferred = compact ? [] : by("deferred");
  if (!owed.length && !started.length && !deferred.length && !others.length) return "";
  const more = (items, cap) => (items.length > cap ? [`… and ${items.length - cap} more; run \`${invocation()} pending --all\``] : []);
  const list = (items, cap, line) => [...items.slice(0, cap).map(line), ...more(items, cap)];
  const body = (i) => cut(i.body, 120);
  const waitName = (i) => (i.waits_on ? db.prepare("SELECT name FROM cc_questions WHERE id = ?").get(i.waits_on)?.name ?? i.waits_on : null);
  const out = [];
  if (owed.length || started.length || deferred.length) {
    out.push("ledger: owed work for this session (approved by the human, oldest first); owed items block the end of a turn until each is started, held, dropped or done:");
    out.push(...list(owed, OWED_CAPS.owed, (i) => `- ${body(i)} (${i.id}, owed since ${relative(i.made_at, now)}${waitName(i) ? `, waits on ${waitName(i)}` : ""})`));
    if (started.length) out.push("Started, not done:", ...list(started, OWED_CAPS.started, (i) => `- ${body(i)} (${i.id}, started ${relative(i.changed_at, now)}: ${cut(i.pointer, 80)})`));
    if (deferred.length) out.push("Deferred:", ...list(deferred, OWED_CAPS.deferred, (i) => `- ${body(i)} (${i.id}, deferred ${relative(i.changed_at, now)}: ${cut(i.reason, 80)})`));
  }
  if (others.length) out.push("Owed by other sessions in scope (listed, not blocking; moving one takes it over):", ...list(others, OWED_CAPS.others, (i) => `- ${body(i)} (${i.id}, ${i.state})`));
  return out.join("\n");
}
