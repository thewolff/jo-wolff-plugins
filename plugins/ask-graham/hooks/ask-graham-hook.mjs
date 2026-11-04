#!/usr/bin/env node
// ask-graham-hook.mjs — Claude Code UserPromptSubmit: at intensity every-idea, add one line to the
// turn telling the agent to run ask-graham if the message proposes a new idea.
//
// The skill's description fires only on an explicit "should we build this?" (intensity ask).
// every-idea needs something that sees every message, so this hook resolves the level from the
// prompt's working directory (scripts/intensity.mjs: repo file, then user file, then ask) and,
// only at every-idea, emits NUDGE as additionalContext. At ask it prints nothing.
//
// Whether a message is a new idea is left to the agent: the nudge says what does not count
// (a ticket, a bug, a task in an existing project), that a project task creating a new table, a new
// column on an existing table, a new top-level module, or a new service gets the structure check
// instead, and to ignore it otherwise.
//
// FAIL-OPEN, BUT NOT FAIL-SILENT. Every path exits 0, so a broken hook never blocks a prompt. A
// fault (empty or non-JSON stdin, a config file that names no valid level, a throw) appends one
// line to errors.log and adds one systemMessage line (hooks/fault.mjs), because a silent failure
// reads exactly like level ask.
//
// Contract: JSON on stdin (UserPromptSubmit payload; `cwd` is read). JSON on stdout or nothing.
// OMP does not run this file; omp/ask-graham-omp.ts does the same job there.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NUDGE, resolveIntensity } from "../skills/ask-graham/scripts/intensity.mjs";
import { errText, faults } from "./fault.mjs";

const HOOK_FILE = "ask-graham-hook.mjs";
const context = (text) => ({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });

/**
 * The hook's output for one payload: the JSON to print, or null for none. `opts.fault(reason)` is
 * told about a config file that names no valid level; the level then counts as ask.
 */
export function handle(input, opts = {}) {
  const cwd = typeof input?.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const r = resolveIntensity({ cwd, env: opts.env ?? process.env, home: opts.home });
  if (r.invalid) opts.fault?.(`config ${r.path} names no valid intensity (ask or every-idea), so it counts as ask`);
  return r.level === "every-idea" ? context(NUDGE) : null;
}

/** The whole hook for one stdin text: the JSON to print, or null. Never throws. */
export function run(raw, { env = process.env, home, handleFn = handle } = {}) {
  const f = faults(HOOK_FILE, { env, ...(home ? { home } : {}) });
  let input = {};
  if (typeof raw !== "string" || raw.trim() === "") {
    f.add("stdin was empty, so the intensity was read from the hook's own working directory");
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      input = parsed;
    } catch (e) {
      f.add(`stdin is not a JSON object (${errText(e)}), so the intensity was read from the hook's own working directory`);
    }
  }
  let out = null;
  try {
    out = handleFn(input, { env, home, fault: (reason) => f.add(reason) });
  } catch (e) {
    f.add(`the intensity setting could not be read this turn (${errText(e)}), so it was treated as ask`);
    out = null;
  }
  const warning = f.warning("the prompt went through");
  return warning ? { ...(out ?? {}), systemMessage: warning } : out;
}

function main() {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { raw = ""; }
  let out = null;
  try { out = run(raw); } catch { out = null; } // run never throws; belt and braces for exit 0
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main();
