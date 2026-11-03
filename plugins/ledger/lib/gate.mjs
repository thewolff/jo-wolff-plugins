// gate.mjs — the PreToolUse rule: AskUserQuestion is denied while no ledger question is open
// for the folder, so every question the human is asked has a q- row they can answer by typing.
//
// "In scope" means a question whose cwd equals the hook's cwd or is an ancestor of it. There is
// no other PreToolUse rule: what a project allows a tool to do (push, write elsewhere) is the
// project's own business, not the ledger's.

import { openQuestions } from "./commands.mjs";

/**
 * The PreToolUse decision for one hook input: `{ rule, reason }` to deny, null to pass.
 * `cli` is the exact invocation the reason tells the agent to run.
 */
export function evaluate(input, { db, config, cwd, cli = "ledger" }) {
  if (input.tool_name !== "AskUserQuestion" || !config.forcing.denyAskWithoutRow) return null;
  if (openQuestions(db, cwd).length) return null;
  return {
    rule: "denyAskWithoutRow",
    reason: `ledger: ask the question through the ledger first: \`${cli} ask "<body>" --name <short> --options a,b --default a\`, then put the q-id in the question text.`,
  };
}
