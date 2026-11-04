// config.mjs — the plugin's one config file, its defaults, and the skipped.log.
//
// FILE: `${XDG_CONFIG_HOME:-~/.config}/delegation/config.json`. Missing = defaults. Present
// and malformed (not JSON, not an object, a field of the wrong type) = defaults for every
// field, plus `fault` naming what was wrong, so the hook that loaded it can say so once in a
// systemMessage; a typo in the file must never silently widen or narrow a gate.
//
// FIELDS
//   off                  true turns every hook and the OMP adapter off; nothing is checked.
//   builderClass         agent names whose spawns are builder-class (gate 4, gate 2, the stop
//                        warning). Compared on the bare name: trimmed, lower-cased, any
//                        `plugin:` or `dir/` prefix dropped.
//   requireHowItFails    gate 1: a spawn needs a `## How it fails` heading.
//   requireSpiralBound   gate 4: a builder-class spawn also needs `## Spiral bound`.
//   requirePatternCheck  gate 2: a builder-class spawn needs this session's pattern-check receipt.
//   checks               the ported guards, each `off`, `warn` or `block`:
//                          delegation-guard     warn (newdle's ask/deny is `block`)
//                          worktree-spawn-guard warn (newdle's deny is `block`)
//                          repo-rules-inject    on (`off` or anything else; it never decides)
//   readLineThreshold    delegation-guard check 1 (default 1000 lines)
//   streakThreshold      delegation-guard check 2 (default 6 distinct files)
//   rulesBudget          repo-rules-inject's largest additionalContext (default 9000 chars)
//
// SKIPPED LOG: `${XDG_STATE_HOME:-~/.local/state}/delegation/skipped.log`, one line
// `<iso> <hook> <why>` each time a gate let a call through because it could not judge it (the
// payload had no prompt, the cwd is in no git repository, the session id is unusable). It is
// the trace that the gate was awake and chose not to decide; errors.log is for faults.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = Object.freeze({
  off: false,
  builderClass: Object.freeze(["builder", "beefy-builder", "task", "sonic", "general-purpose"]),
  requireHowItFails: true,
  requireSpiralBound: true,
  requirePatternCheck: true,
  checks: Object.freeze({ "delegation-guard": "warn", "worktree-spawn-guard": "warn", "repo-rules-inject": "on" }),
  readLineThreshold: 1000,
  streakThreshold: 6,
  rulesBudget: 9000,
});

const CHECK_VALUES = new Set(["off", "warn", "block", "on"]);

/** `${XDG_CONFIG_HOME:-~/.config}/delegation/config.json`. */
export function configPath(env = process.env, home = homedir()) {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || home, ".config"), "delegation", "config.json");
}

/** `${XDG_STATE_HOME:-~/.local/state}/delegation`. */
export function stateDir(env = process.env, home = homedir()) {
  return join(env.XDG_STATE_HOME || join(env.HOME || home, ".local", "state"), "delegation");
}

/**
 * Load the config. Never throws.
 * @returns {{ config: object, path: string, fault: string|null }} `fault` names the problem when
 *   the file exists and is unusable; every field is then its default.
 */
export function loadConfig(env = process.env, home = homedir()) {
  const path = configPath(env, home);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { config: { ...DEFAULTS }, path, fault: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { config: { ...DEFAULTS }, path, fault: `${path} is not JSON (${err.message}); using defaults` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { config: { ...DEFAULTS }, path, fault: `${path} is not a JSON object; using defaults` };
  }
  const bad = [];
  const out = { ...DEFAULTS };
  for (const key of ["off", "requireHowItFails", "requireSpiralBound", "requirePatternCheck"]) {
    if (parsed[key] === undefined) continue;
    if (typeof parsed[key] === "boolean") out[key] = parsed[key];
    else bad.push(`${key} must be true or false`);
  }
  if (parsed.builderClass !== undefined) {
    if (Array.isArray(parsed.builderClass) && parsed.builderClass.every((s) => typeof s === "string")) out.builderClass = parsed.builderClass.map((s) => s.trim().toLowerCase()).filter(Boolean);
    else bad.push("builderClass must be an array of strings");
  }
  for (const key of ["readLineThreshold", "streakThreshold", "rulesBudget"]) {
    if (parsed[key] === undefined) continue;
    if (Number.isInteger(parsed[key]) && parsed[key] > 0) out[key] = parsed[key];
    else bad.push(`${key} must be a positive integer`);
  }
  if (parsed.checks !== undefined) {
    if (parsed.checks && typeof parsed.checks === "object" && !Array.isArray(parsed.checks)) {
      const checks = { ...DEFAULTS.checks };
      for (const [name, value] of Object.entries(parsed.checks)) {
        if (!(name in DEFAULTS.checks)) bad.push(`checks.${name} is not a check`);
        else if (typeof value === "string" && CHECK_VALUES.has(value)) checks[name] = value;
        else bad.push(`checks.${name} must be off, warn or block`);
      }
      out.checks = checks;
    } else bad.push("checks must be an object");
  }
  if (bad.length) return { config: { ...DEFAULTS }, path, fault: `${path}: ${bad.join("; ")}; using defaults` };
  return { config: out, path, fault: null };
}

/** Append `<iso> <hook> <why>` to skipped.log; never throws. */
export function logSkipped(hook, why, env = process.env, home = homedir()) {
  try {
    const dir = stateDir(env, home);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "skipped.log"), `${new Date().toISOString()} ${hook} ${String(why).replace(/\s+/g, " ")}\n`);
  } catch {
    // an unwritable state directory loses the trace, never the call
  }
}

/** Merge a config fault into a hook's answer as a systemMessage (null stays null only when there is no fault). */
export function withFault(out, fault, hook) {
  if (!fault) return out;
  const msg = `delegation ${hook}: config ignored: ${fault}`;
  return out ? { ...out, systemMessage: out.systemMessage ? `${out.systemMessage}\n${msg}` : msg } : { systemMessage: msg };
}
