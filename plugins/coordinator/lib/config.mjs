// config.mjs — the coordinator plugin's one config file, its defaults, and the skipped.log.
//
// FILE: `${XDG_CONFIG_HOME:-~/.config}/coordinator/config.json`. Missing = defaults. Present and
// malformed (not JSON, not an object, a field of the wrong type) or unreadable for any reason but
// absence (permissions, a directory in its place) = defaults for every field, plus
// `fault` naming what was wrong, so the hook that loaded it can say so in a systemMessage; a typo
// in the file must never silently turn the model notice on for the wrong folders.
//
// FIELDS
//   off            true turns every hook off.
//   folders        absolute paths; the model notice speaks only when the session's cwd is one of
//                  them or inside one (both sides compared after realpath). Default [], so the
//                  notice is silent until a folder is listed.
//   expectedModel  the minimum model for coordinator sessions; a switch to a lower model draws the
//                  notice (family order haiku < sonnet < opus < fable, then version). Default
//                  `claude-opus-5-5`.
//   modelFamilyRank model families lowest first, lowercase strings. Default
//                  ["haiku","sonnet","opus","fable"]. A family not listed is never judged (no
//                  notice), so a new release stays silent until it is added here.
//   expectedEffort the effort level named in the notice, and compared when the host puts
//                  `effort.level` in the hook input. Default `medium`.
//   clock          false turns off the per-prompt clock line. Default true, in every session.
//
// SKIPPED LOG: `${XDG_STATE_HOME:-~/.local/state}/coordinator/skipped.log`, one line
// `<iso> <hook> <why>` each time a hook was awake and chose not to judge (an alias where a model
// id was expected). errors.log is for faults.

import { accessSync, appendFileSync, constants, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DEFAULT_FAMILY_RANK } from "./model-notice.mjs";

export const DEFAULTS = Object.freeze({
  off: false,
  folders: Object.freeze([]),
  expectedModel: "claude-opus-5-5",
  modelFamilyRank: DEFAULT_FAMILY_RANK,
  expectedEffort: "medium",
  clock: true,
});

/** `${XDG_CONFIG_HOME:-~/.config}/coordinator/config.json`. */
export function configPath(env = process.env, home = homedir()) {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || home, ".config"), "coordinator", "config.json");
}

/** `${XDG_STATE_HOME:-~/.local/state}/coordinator`. */
export function stateDir(env = process.env, home = homedir()) {
  return join(env.XDG_STATE_HOME || join(env.HOME || home, ".local", "state"), "coordinator");
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
  } catch (err) {
    if (err?.code === "ENOENT") return { config: { ...DEFAULTS }, path, fault: null };
    return { config: { ...DEFAULTS }, path, fault: `${path} could not be read (${err?.code ?? err?.message}); using defaults` };
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
  for (const key of ["off", "clock"]) {
    if (parsed[key] === undefined) continue;
    if (typeof parsed[key] === "boolean") out[key] = parsed[key];
    else bad.push(`${key} must be true or false`);
  }
  for (const key of ["expectedModel", "expectedEffort"]) {
    if (parsed[key] === undefined) continue;
    if (typeof parsed[key] === "string" && parsed[key].trim()) out[key] = parsed[key].trim();
    else bad.push(`${key} must be a non-empty string`);
  }
  if (parsed.modelFamilyRank !== undefined) {
    if (Array.isArray(parsed.modelFamilyRank) && parsed.modelFamilyRank.length && parsed.modelFamilyRank.every((f) => typeof f === "string" && /^[a-z]+$/.test(f))) out.modelFamilyRank = [...parsed.modelFamilyRank];
    else bad.push("modelFamilyRank must be a non-empty array of lowercase family names");
  }
  if (parsed.folders !== undefined) {
    if (Array.isArray(parsed.folders) && parsed.folders.every((s) => typeof s === "string" && isAbsolute(s))) out.folders = [...parsed.folders];
    else bad.push("folders must be an array of absolute paths");
  }
  if (bad.length) return { config: { ...DEFAULTS }, path, fault: `${path}: ${bad.join("; ")}; using defaults` };
  return { config: out, path, fault: null };
}

/** Null when the state directory can be written (made if missing); else a message naming it and why. Never throws. */
export function stateFault(env = process.env, home = homedir()) {
  const dir = stateDir(env, home);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return null;
  } catch (err) {
    return `the state directory ${dir} is not writable (${err?.code ?? err?.message}), so faults cannot be logged there`;
  }
}

/** Append `<iso> <hook> <why>` to skipped.log; never throws. */
export function logSkipped(hook, why, env = process.env, home = homedir()) {
  try {
    const dir = stateDir(env, home);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "skipped.log"), `${new Date().toISOString()} ${hook} ${String(why).replace(/\s+/g, " ")}\n`);
  } catch {
    // an unwritable state directory loses the trace, never the prompt
  }
}

/** Merge a config fault into a hook's answer as a systemMessage (null stays null only when there is no fault). */
export function withFault(out, fault, hook) {
  if (!fault) return out;
  const msg = `coordinator ${hook}: config ignored: ${fault}`;
  return out ? { ...out, systemMessage: out.systemMessage ? `${out.systemMessage}\n${msg}` : msg } : { systemMessage: msg };
}
