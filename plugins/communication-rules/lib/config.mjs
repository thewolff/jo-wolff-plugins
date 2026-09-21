// config.mjs — the enforcement object inside the operator profile.
//
// The profile at ~/.claude/communication-rules.json (or $COMMUNICATION_RULES_PROFILE) already
// carries `reader` and `traits` for the session-start injection. Enforcement settings live in
// the SAME file under an optional `enforcement` object, so an operator configures one file:
//
//   {
//     "reader": "…", "traits": ["…"],
//     "enforcement": {
//       "mode": "block",                       // block | warn | off; unset = every rule warns (measured)
//       "judgeCommand": "codex exec --skip-git-repo-check -",
//       "rules": { "name-the-artifact": "warn", "bad-news-first": "warn" }
//     }
//   }
//
// PRECEDENCE, from strongest to weakest:
//   1. the kill-switch file (handled by the hook, before any of this is read)
//   2. enforcement.rules[rule]                  — a per-rule mode
//   3. enforcement.mode, WHEN THE OPERATOR SET IT — an explicit global override
//   4. the measured default                      — warn, for every rule
//
// WHY EVERY RULE DEFAULTS TO WARN (measured 2026-09-21, 304-message house corpus, full
// adjudication): needs-you-first 16/18 flags false-positive (89%), closing-ask-last 17/18
// (94%), conclusion-first 3/3 violations FP at a 92% trigger rate, bad-news-first 10/15
// (67%), do-not-batch-by-label 0 triggers in 50 (unexercised), name-the-artifact 0/4 FP.
// No rule's measured rate supports block-by-default: the cheapest way to satisfy a guard
// that fires on correct output is to stop writing the thing it misreads. Block arms by
// EXPLICIT configuration — enforcement.mode: "block", or enforcement.rules[rule]: "block"
// — and stays one flip away. Findings still land in warnings.log at the default, so the
// signal is collected without the teeth.
//
// A missing file or field is normal and silent. A file that exists but does not parse, or a
// value of the wrong shape, falls back to defaults AND leaves one line in errors.log — a
// config failure reads exactly like a working config otherwise.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendLog } from "./state.mjs";

const MODES = new Set(["block", "warn", "off"]);

// Built-in per-rule modes. EMPTY since the 2026-09-21 corpus measurement (header): no
// rule's false-positive rate supports block-by-default, so the map is kept only as the
// shape a future measurement would refill — one entry per rule that earns block.
const BUILT_IN_MODES = {};

export function defaultProfilePath() {
  const explicit = process.env.COMMUNICATION_RULES_PROFILE;
  if (explicit && explicit.trim()) return explicit.trim();
  return join(homedir(), ".claude", "communication-rules.json");
}

// Never throws. Returns { mode, judgeCommand, rules } with defaults applied.
export function loadEnforcement(path = defaultProfilePath()) {
  const out = { mode: null, judgeCommand: null, rules: {} };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out; // no profile is the normal case, not a failure
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    appendLog("errors.log", `enforcement: profile at ${path} does not parse (${err.message}); defaults apply`);
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    appendLog("errors.log", `enforcement: profile at ${path} is not a JSON object; defaults apply`);
    return out;
  }

  const e = parsed.enforcement;
  if (!e || typeof e !== "object" || Array.isArray(e)) return out; // absent = defaults, normal

  if (e.mode !== undefined) {
    if (typeof e.mode === "string" && MODES.has(e.mode)) out.mode = e.mode;
    else appendLog("errors.log", `enforcement: mode ${JSON.stringify(e.mode)} is not block|warn|off; ignored`);
  }
  if (e.judgeCommand !== undefined && e.judgeCommand !== null) {
    if (typeof e.judgeCommand === "string" && e.judgeCommand.trim()) out.judgeCommand = e.judgeCommand;
    else appendLog("errors.log", `enforcement: judgeCommand ${JSON.stringify(e.judgeCommand)} is not a command string; judge rules inactive`);
  }
  if (e.rules !== undefined && e.rules !== null) {
    if (typeof e.rules === "object" && !Array.isArray(e.rules)) {
      for (const [rule, mode] of Object.entries(e.rules)) {
        if (typeof mode === "string" && MODES.has(mode)) out.rules[rule] = mode;
        else appendLog("errors.log", `enforcement: rules["${rule}"] ${JSON.stringify(mode)} is not block|warn|off; ignored`);
      }
    } else {
      appendLog("errors.log", "enforcement: rules is not an object; ignored");
    }
  }
  return out;
}

export function effectiveMode(config, rule) {
  if (config.rules[rule]) return config.rules[rule];
  if (config.mode) return config.mode;
  return BUILT_IN_MODES[rule] ?? "warn"; // the measured default; block arms by explicit config
}
