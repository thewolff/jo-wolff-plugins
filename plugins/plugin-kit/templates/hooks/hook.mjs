#!/usr/bin/env node
// hooks/{{file}} — the {{name}} plugin's {{event}} hook. Runs under lib/hook-runner.mjs: exit 0
// always; a fault is one errors.log line and a systemMessage, never a deny or block.
//
// What it does: (write the rule here, one sentence, and its deny or block text if it has one).
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s (handle() runs on a worker
// thread; the runner's timer on the main thread fires whatever it is doing) → the runner logs it
// to ${XDG_STATE_HOME:-~/.local/state}/{{name}}/errors.log and allows. Anything this hook reads
// (a config file, a state file) that is missing or unreadable → treat as "no rule applies" and
// return null; say so in a systemMessage only when the person needs to know.
//
// Deny or block text, when there is one, names the command that gets the person out of it,
// in backticks: `{{name}}: <what stopped and why>; run \`<command>\` to <fix>`.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  the hook's JSON output, or null for "nothing to say"
 */
export function handle(input, { env = process.env } = {}) {
  void input;
  void env;
  return null;
}

if (invokedDirectly(import.meta.url)) runHook("{{event}}", import.meta.url, { plugin: "{{name}}", quiet: {{quiet}} });
