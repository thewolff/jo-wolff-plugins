// gate.mjs — the PreToolUse rules, pure given a db:
//
//   denyAskWithoutRow  AskUserQuestion is denied while no ledger question is open for the
//                      folder, so every question the human is asked has a q- row they can
//                      answer by typing. "In scope" means a question whose cwd equals the
//                      hook's cwd or is an ancestor of it.
//   pushNeedsNote      a Bash command that runs `git push` or `gh pr create` is denied while
//                      the session has no `note` row: what is being pushed, and why, is on the
//                      record before it leaves the machine. One note in the session lifts it.
//
// Nothing else is gated: what a project allows a tool to do otherwise is the project's own
// business, not the ledger's.

import { openQuestions, sessionNotes } from "./commands.mjs";

/**
 * The PreToolUse decision for one hook input: `{ rule, reason }` to deny, null to pass.
 * `cli` is the exact invocation the reason tells the agent to run; `sessionId` the hook's.
 */
export function evaluate(input, { db, config, cwd, cli = "ledger", sessionId = null }) {
  const forcing = config.forcing ?? {};
  if (input.tool_name === "AskUserQuestion") {
    if (forcing.denyAskWithoutRow === false) return null;
    if (openQuestions(db, cwd).length) return null;
    return {
      rule: "denyAskWithoutRow",
      reason: `ledger: ask the question through the ledger first: \`${cli} ask "<body>" --name <short> --options a,b --default a\`, then put the q-id in the question text.`,
    };
  }
  if (input.tool_name === "Bash") {
    if (forcing.pushNeedsNote === false) return null;
    if (!isPushCommand(input.tool_input?.command)) return null;
    if (sessionNotes(db, { sessionId, cwd }).length) return null;
    return {
      rule: "pushNeedsNote",
      reason: `ledger: record what this push is before pushing: \`${cli} note "<what this push is and why>"\` (one note in this session lifts the gate).`,
    };
  }
  return null;
}

// Global git options that take a separate argument, so `git -C dir push` is still a push.
const GIT_OPT_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);

/**
 * True when any simple command in `command` (split on newlines, `&&`, `||`, `;`, `|`) is
 * `git push …` or `gh pr create …`, with a path or `command`/`\` prefix on the binary and
 * git's global options tolerated. A string that does not look like either is not a push.
 */
export function isPushCommand(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  for (const segment of command.split(/\n|&&|\|\||;|\|/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || tokens[0] === "command" || tokens[0] === "env")) tokens.shift();
    if (!tokens.length) continue;
    const bin = tokens[0].replace(/^\\/, "").split("/").pop();
    if (bin === "gh") {
      if (tokens[1] === "pr" && tokens[2] === "create") return true;
      continue;
    }
    if (bin !== "git") continue;
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      i += GIT_OPT_WITH_ARG.has(tokens[i]) ? 2 : 1;
    }
    if (tokens[i] === "push") return true;
  }
  return false;
}
