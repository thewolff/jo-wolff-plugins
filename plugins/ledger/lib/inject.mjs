// inject.mjs — the text SessionStart hands Claude: held questions (Waiting on you), open
// questions, recent notes, the verb summary, one line counting the open and held questions in
// other folders, one line when the cross-lab review found problems on HEAD, and, last, one
// doctor line when the cheap health checks find issues. Sections appear in that order and only
// when non-empty. Capped at CAP characters (the doc's limit is 10,000): notes are truncated
// first, never the held or open questions, the other-folders, review or doctor lines.

import { fileURLToPath } from "node:url";
import { elsewhereCount, heldQuestions, logEntries, openQuestions, renderLog, renderPending } from "./commands.mjs";
import { quickIssues } from "./doctor.mjs";
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
    "Verbs: ask \"<body>\" --name <short> --options a,b --default a · answer <q-id> <option> · withdraw <q-id> · extend <q-id> · hold <q-id> · reopen <q-id> · note \"<text>\" · outcome <ref> [q-id] \"<text>\" · pending [--all] · log [N] · review · doctor · bounces · help.",
    "To ask the human: run `ledger ask` first, then ask in plain words. Never show the human a q- id; ids are for you. When the human replies, run `ledger answer <q-id> <option>` with the option their words mean before anything else; a reply that is none of the options is recorded as given with `ledger answer <q-id> \"<reply>\"`, never withdrawn. Asked what is waiting: run `pending --all`, report every row first. Record a choice made without asking with `note`, in the same turn you state it. `git push` and `gh pr create` need one `note` or `outcome` in this session first, and a `ledger review` of HEAD. `ledger help` has the grammar.",
  ].join("\n");
}

/**
 * @returns {{ text: string, sections: string[] }}
 */
export function buildInjection(db, cwd, config, { source = "startup", now = Date.now(), env = process.env } = {}) {
  const compact = source === "compact";
  const sections = [];

  const held = heldQuestions(db, cwd);
  let waitingText = "";
  if (held.length) {
    waitingText = `ledger: Waiting on you (held questions for ${cwd} and the folders below it, oldest first; formed and deferred, not yet put to the human; when you ask one, run \`reopen <q-id>\` first):\n${held.map((q) => `- ${q.name}: ${q.body.replace(/\s+/g, " ").trim()} (${q.id}${q.cwd !== cwd && q.cwd.startsWith(cwd) ? `, in ${q.cwd}` : ""})`).join("\n")}`;
    sections.push("waiting");
  }

  const questions = openQuestions(db, cwd);
  let questionsText = "";
  if (questions.length) {
    questionsText = `ledger: open questions for ${cwd} and the folders below it (for you, not the human: when the human answers one in their own words, record it with \`answer <q-id> <option>\`; never show them the id):\n${renderPending(questions, cwd, { now, timezone: config.timezone ?? null })}`;
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

  const elsewhereText = config.inject?.elsewhere === false ? "" : elsewhereLine(db, cwd);
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

  const assemble = (notes) => [waitingText, questionsText, notes, summary, elsewhereText, reviewText, doctorText].filter(Boolean).join("\n\n");
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

/**
 * One line when open or held questions exist outside the scope of `cwd` (not it, not an ancestor,
 * not under it); "" when there are none.
 */
export function elsewhereLine(db, cwd) {
  const { count, folders } = elsewhereCount(db, cwd);
  if (!count) return "";
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `ledger: ${plural(count, "question")} waiting on you in ${plural(folders, "other folder")}; run \`${invocation()} pending --all\` to see them.`;
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
