#!/usr/bin/env node
// pattern-check-stop.mjs — Claude Code Stop: refuse a turn that proposed a plan or design when
// the session has no pattern-check receipt. The refusal names the command that records one.
//
// Claude Code sends Stop hooks `session_id`, `cwd`, `stop_hook_active` and
// `last_assistant_message` (hooks reference, "Stop input"). A refusal is exit 0 plus
// {"decision":"block","reason":...} on stdout; the reason is fed back to Claude as its next
// instruction. Whether the reply proposes a plan is scripts/lib/proposal.mjs, a fixed list of
// signals using ask-graham's nudge wording (a message proposing a new project, feature, or tool).
//
// ONCE PER REPLY. `stop_hook_active` true means Claude Code is already continuing because of a
// stop hook, and the doc says to check it to avoid blocking on a condition that never resolves:
// such a stop passes. As a second guard, the hash of the refused reply is recorded in the state
// directory, and a stop with the same reply text passes. A refusal that cannot be recorded passes
// instead of risking a loop.
//
// MAIN SESSION ONLY. Subagents end on SubagentStop, which this hook is not registered for.
//
// FAIL OPEN, NOT SILENT. Every path exits 0. The plugin's own faults (unreadable state, a config
// that does not parse, a thrown error) let the stop through and print one
// {"systemMessage": "pattern-check: ..."} line. A reply without last_assistant_message cannot
// be classified and passes.
//
// Contract: JSON on stdin (Stop payload). JSON on stdout, or nothing.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordCommand, resolveContext } from "../scripts/lib/context.mjs";
import { proposesPlan } from "../scripts/lib/proposal.mjs";
import { paths, sha256, writeAtomic } from "../scripts/lib/state.mjs";

export function refusalReason({ key, env, signal }) {
  const cmd = recordCommand(key, env);
  return [
    `pattern-check: this reply proposes a plan or design (${signal}), but no pattern-check receipt exists for this session.`,
    "Before finishing, look for the existing patterns in this repository that do the job of each new piece the plan adds (load the pattern-check skill for the method), record the result, then finish the reply:",
    `  ${cmd} < table.md`,
    `or, if the plan adds no new piece:  ${cmd} --no-new-pieces "<reason>"`,
  ].join("\n");
}

const warn = (warnings) => (warnings.length ? { systemMessage: `pattern-check: ${warnings.join("; ")}` } : null);

/** The hook's output for one payload: the JSON to print, or null for none. Throws are the caller's. */
export function handle(input, opts = {}) {
  const ctx = resolveContext(input, opts);
  const { config, base, key, env, warnings } = ctx;
  if (!config.hooks.stop) return warn(warnings);
  if (input?.stop_hook_active === true) return warn(warnings);
  const message = input?.last_assistant_message;
  if (typeof message !== "string") return warn(warnings);
  if (ctx.receiptExists) return warn(warnings);
  const { proposes, signal } = proposesPlan(message);
  if (!proposes) return warn(warnings);

  const record = paths.stop(base, key);
  const hash = sha256(message);
  let last = null;
  try { last = readFileSync(record, "utf8").trim(); } catch { last = null; }
  if (last === hash) return warn(warnings);
  try {
    writeAtomic(record, `${hash}\n`);
  } catch (e) {
    warnings.push(`could not record the refusal (${e.message}), so this stop was allowed rather than risk a loop`);
    return warn(warnings);
  }
  return { ...(warnings.length ? { systemMessage: `pattern-check: ${warnings.join("; ")}` } : {}), decision: "block", reason: refusalReason({ key, env, signal }) };
}

function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
  let out = null;
  try {
    out = handle(input);
  } catch (e) {
    out = { systemMessage: `pattern-check: the Stop hook failed (${e?.message ?? e}); the stop was allowed` };
  }
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main();
