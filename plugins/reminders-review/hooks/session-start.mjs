#!/usr/bin/env node
// hooks/session-start.mjs — reminders-review's SessionStart hook. Runs under lib/hook-runner.mjs:
// exit 0 always; a fault is one errors.log line and a systemMessage, never a deny or a block.
//
// What it does: for every watched list (lib/due.mjs, WHICH LISTS), reads overdue and today's
// reminders through `remindctl show … --json` and returns the `Due (list <name>): …` block as
// additionalContext. Nothing watched or nothing due → nothing. A remindctl that is missing, not
// authorized, slow (2 s) or answers garbage → one errors.log line and one systemMessage line
// naming the fix; nothing injected. It stamps this session's throttle, so the first prompts of
// the session do not check again within the hour.
//
// handle() runs on a worker thread (the runner's deadline holds whatever it does): it returns a
// plain object and never writes to stdout itself.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { dueCheck } from "../lib/due.mjs";

export function handle(input, deps = {}) {
  return dueCheck("SessionStart", input, deps);
}

if (invokedDirectly(import.meta.url)) runHook("SessionStart", import.meta.url, { plugin: "reminders-review" });
