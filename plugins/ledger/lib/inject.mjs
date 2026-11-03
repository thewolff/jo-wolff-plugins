// inject.mjs — the text SessionStart hands Claude: open questions, open workloads, recent
// decisions, the gate status, and the one-line verb summary. Sections appear in that order
// and only when non-empty. Capped at CAP characters (the doc's limit is 10,000): decisions are
// truncated first, then workloads, never the open questions.

import { fileURLToPath } from "node:url";
import { gateState, isWithin, openQuestions, renderPending, workloadLine } from "./commands.mjs";
import { relative } from "./time.mjs";

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
    `ledger: this folder's work is recorded with the \`ledger\` CLI. Always run it exactly as \`${invocation()} <verb> …\` (that literal path, no alias, no shell variable, no cd) so the one allow rule \`${allowRule()}\` matches and Claude Code never asks about it.`,
    "Verbs: open \"<title>\" · close <wl-id> <reason> · park <wl-id> <reason> · ask \"<body>\" --name <short> --options a,b --default a · <word> <q-id> · approve/deny <q-id> · withdraw <id> · halt <wl-id> · ceiling <usd> [<h>h] <wl-id> · extend <id> · decide \"<text>\" · pending · stale [N] · help.",
    "Open a workload before the first write, ask through `ledger ask` and end the message with its `pending` line, record choices with `decide`, and `close <reason>` or `park <reason>` before saying done. `ledger help` has the grammar.",
  ].join("\n");
}

/**
 * @returns {{ text: string, sections: string[] }}
 */
export function buildInjection(db, cwd, config, { source = "startup", now = Date.now() } = {}) {
  const compact = source === "compact";
  const state = gateState(db, cwd);
  const sections = [];

  const questions = openQuestions(db, cwd);
  let questionsText = "";
  if (questions.length) {
    questionsText = `ledger: open questions for ${cwd} (answer with the line as shown, e.g. \`approve q-…\`):\n${renderPending(questions, cwd, { now, timezone: config.timezone ?? null })}`;
    sections.push("questions");
  }

  let workloadsText = "";
  const lines = [];
  for (const w of state.openAll) lines.push(workloadLine(db, w, now));
  for (const w of [...(state.halted ? [state.halted] : []), ...state.parked]) {
    lines.push(`${w.id} ${w.title} · ${w.status} (${w.status_reason}) · resume: ledger open ${w.id}`);
  }
  if (lines.length) {
    workloadsText = `ledger: open workloads for ${cwd}:\n${lines.join("\n")}`;
    sections.push("workloads");
  }

  let decisionsText = "";
  const n = Number(config.inject?.decisions ?? 5);
  if (!compact && n > 0) {
    const rows = db
      .prepare(
        `SELECT d.*, w.cwd AS wl_cwd FROM decisions d JOIN workloads w ON w.id = d.workload_id
          ORDER BY d.made_at DESC, d.id DESC`,
      )
      .all()
      .filter((d) => isWithin(cwd, d.wl_cwd))
      .slice(0, n);
    if (rows.length) {
      decisionsText = `ledger: last ${rows.length} decisions:\n${rows.map((d) => `${d.id} ${relative(d.made_at, now)} ${d.kind}: ${d.body.replace(/\s+/g, " ")}`).join("\n")}`;
      sections.push("decisions");
    }
  }

  let gateText = "";
  if (!state.open) {
    const cli = invocation();
    gateText = `No open workload for this folder: pushes, PR creation and writes outside it are denied until \`${cli} open "<title>"\`${state.halted ? ` (${state.halted.id} is halted; \`${cli} open ${state.halted.id}\` resumes it)` : state.parked.length ? ` (or \`${cli} open ${state.parked[0].id}\` to resume)` : ""}.`;
    sections.push("gate");
  }

  const summary = compact ? verbSummary().split("\n")[0] : verbSummary();
  if (summary) sections.push("summary");

  const assemble = (d, w) => [questionsText, w, d, gateText, summary].filter(Boolean).join("\n\n");
  let text = assemble(decisionsText, workloadsText);
  if (text.length > CAP) text = assemble(truncate(decisionsText, Math.max(0, CAP - (text.length - decisionsText.length))), workloadsText);
  if (text.length > CAP) text = assemble("", truncate(workloadsText, Math.max(0, CAP - (text.length - workloadsText.length))));
  if (text.length > CAP) text = assemble("", "");
  return { text, sections };
}

function truncate(block, max) {
  if (!block || block.length <= max) return block;
  if (max < 40) return "";
  const cut = block.lastIndexOf("\n", max - 12);
  return `${block.slice(0, cut > 0 ? cut : max - 12)}\n… (truncated)`;
}
