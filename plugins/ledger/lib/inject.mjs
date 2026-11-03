// inject.mjs — the text SessionStart hands Claude: open questions, recent notes, and the verb
// summary. Sections appear in that order and only when non-empty. Capped at CAP characters (the
// doc's limit is 10,000): notes are truncated first, never the open questions.

import { fileURLToPath } from "node:url";
import { logEntries, openQuestions, renderLog, renderPending } from "./commands.mjs";

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
    "Verbs: ask \"<body>\" --name <short> --options a,b --default a · <word> <q-id> · approve/deny <q-id> · withdraw <q-id> · extend <q-id> · note \"<text>\" · pending · log [N] · help.",
    "Ask through `ledger ask` and end the message with its `pending` line; record a choice made without asking with `note`, in the same turn you state it. `git push` and `gh pr create` need one `note` in this session first. `ledger help` has the grammar.",
  ].join("\n");
}

/**
 * @returns {{ text: string, sections: string[] }}
 */
export function buildInjection(db, cwd, config, { source = "startup", now = Date.now() } = {}) {
  const compact = source === "compact";
  const sections = [];

  const questions = openQuestions(db, cwd);
  let questionsText = "";
  if (questions.length) {
    questionsText = `ledger: open questions for ${cwd} (answer with the line as shown, e.g. \`approve q-…\`):\n${renderPending(questions, cwd, { now, timezone: config.timezone ?? null })}`;
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

  const assemble = (notes) => [questionsText, notes, summary].filter(Boolean).join("\n\n");
  let text = assemble(notesText);
  if (text.length > CAP) text = assemble(truncate(notesText, Math.max(0, CAP - (text.length - notesText.length))));
  if (text.length > CAP) text = assemble("");
  return { text, sections };
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
