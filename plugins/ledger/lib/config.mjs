// config.mjs — where every setting comes from, and the defaults that make a fresh machine work.
//
// Resolution, strongest first, decided separately for each key:
//   1. env: LEDGER_DB sets the database path, LEDGER_ENABLED (true/false/1/0) the switch; only
//      those two keys. LEDGER_CONFIG names the user file to read instead of the default one.
//   2. the project file: the nearest `.ledger.json` in the folder a command or hook binds to or
//      any folder above it, so one file at a workspace root covers every repository under it.
//      Same keys as the user file, plus nothing else.
//   3. the user file: ${XDG_CONFIG_HOME:-~/.config}/ledger/config.json. The XDG variable counts
//      only when it is an absolute path, as the XDG spec says.
//   4. the defaults below. No user name, path, host or repository appears in a default; `~` is
//      expanded at runtime from os.homedir(), and the data directory honours XDG_DATA_HOME when
//      that is absolute.
//
// `enabled` is the switch for every hook and defaults to true: every session records unless a
// project opts out with `ledger disable` (sets `"enabled": false` in `.ledger.json` next to it)
// or a person opts out everywhere with `"enabled": false` in the user file. The CLI works either
// way.
//
// This module never throws. A file that is missing is normal and silent. A file that exists but
// does not parse, or a value of the wrong type, falls back to the default for that key AND
// produces one notice naming the file, so a broken config never reads like a working one. Unknown
// keys are ignored without a notice (forward compatibility).

import { readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** The per-project file's name, looked for in the bound folder and every folder above it. */
export const PROJECT_FILE = ".ledger.json";

/** The shipped defaults; example.config.json is this object verbatim. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  db: "~/.local/share/ledger/ledger.db",
  user: null,
  timezone: null,
  hooks: Object.freeze({ sessionStart: true, preToolUse: true, stop: true, sessionEnd: true, userPromptCommands: true }),
  forcing: Object.freeze({
    denyAskWithoutRow: true,
    stopAskRule: true,
    pushNeedsNote: true,
    stopDecisionRule: true,
    decisionPhrases: Object.freeze(["I decided", "decided to", "assumption:", "assuming", "going with", "instead of", "chose", "I'll go with", "trade-off"]),
  }),
  inject: Object.freeze({ notes: 5, elsewhere: true }),
});

// Type of each leaf, for the wrong-type notice. Nested objects list their leaves.
const SHAPE = {
  enabled: "boolean",
  db: "string",
  user: "string|null",
  timezone: "string|null",
  hooks: { sessionStart: "boolean", preToolUse: "boolean", stop: "boolean", sessionEnd: "boolean", userPromptCommands: "boolean" },
  forcing: { denyAskWithoutRow: "boolean", stopAskRule: "boolean", pushNeedsNote: "boolean", stopDecisionRule: "boolean", decisionPhrases: "string[]" },
  inject: { notes: "integer", elsewhere: "boolean" },
};

/** Every leaf key in dotted form, in SHAPE order. */
export function leafKeys(shape = SHAPE, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(shape)) {
    if (typeof v === "object") out.push(...leafKeys(v, `${prefix}${k}.`));
    else out.push(`${prefix}${k}`);
  }
  return out;
}

function xdgDir(env, home, variable, fallback) {
  const v = env[variable];
  return v && isAbsolute(v) ? v : join(home, fallback);
}

/** The user config file's path. */
export function configPath(env = process.env, home = homedir()) {
  if (env.LEDGER_CONFIG) return env.LEDGER_CONFIG;
  return join(xdgDir(env, home, "XDG_CONFIG_HOME", ".config"), "ledger", "config.json");
}

/** The nearest `.ledger.json` at or above `cwd`, or null. */
export function projectConfigPath(cwd) {
  if (!cwd) return null;
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, PROJECT_FILE);
    let st = null;
    try {
      st = statSync(candidate, { throwIfNoEntry: false });
    } catch {
      /* unreadable parent: keep climbing */
    }
    if (st?.isFile()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The default database path, honouring XDG_DATA_HOME when absolute. */
export function defaultDbPath(env = process.env, home = homedir()) {
  return join(xdgDir(env, home, "XDG_DATA_HOME", join(".local", "share")), "ledger", "ledger.db");
}

/** The state directory for the errors log: ${XDG_STATE_HOME:-~/.local/state}/ledger. */
export function stateDir(env = process.env, home = homedir()) {
  return join(xdgDir(env, home, "XDG_STATE_HOME", join(".local", "state")), "ledger");
}

/** `~` and `~/x` expanded against `home`; anything else unchanged. */
export function expandHome(p, home = homedir()) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function typeOk(expected, value) {
  switch (expected) {
    case "string":
      return typeof value === "string" && value.length > 0;
    case "string|null":
      return value === null || (typeof value === "string" && value.length > 0);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value) && value >= 0;
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim().length > 0);
    default:
      return false;
  }
}

/** Read and parse one config file; null when it is missing or unusable (with a notice). */
export function readConfigFile(path, notices) {
  let text = null;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") notices.push(`ledger: config ${path} ignored: ${err.message}`);
    return null;
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      notices.push(`ledger: config ${path} ignored: top level is not an object`);
      return null;
    }
    return value;
  } catch (err) {
    notices.push(`ledger: config ${path} ignored: ${err.message}`);
    return null;
  }
}

/** Shallow-merge one parsed file into `config`, key by key, typed; `label` is its source name. */
function applyFile(config, sources, notices, path, fileValue, label) {
  for (const [key, shape] of Object.entries(SHAPE)) {
    if (!(key in fileValue)) continue;
    const given = fileValue[key];
    if (typeof shape === "object") {
      if (given === null || typeof given !== "object" || Array.isArray(given)) {
        notices.push(`ledger: config ${path}: ${key} must be an object; ignoring it`);
        continue;
      }
      for (const [leaf, expected] of Object.entries(shape)) {
        if (!(leaf in given)) continue;
        if (typeOk(expected, given[leaf])) {
          config[key][leaf] = given[leaf];
          sources[`${key}.${leaf}`] = label;
        } else {
          notices.push(`ledger: config ${path}: ${key}.${leaf} must be ${expected}; ignoring it`);
        }
      }
    } else if (typeOk(shape, given)) {
      config[key] = given;
      sources[key] = label;
    } else {
      notices.push(`ledger: config ${path}: ${key} must be ${shape}; ignoring it`);
    }
  }
}

/** LEDGER_ENABLED as a boolean, or undefined when unset or not one of true/false/1/0. */
function envEnabled(env) {
  const v = String(env.LEDGER_ENABLED ?? "").trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

/**
 * Resolve the effective configuration for the folder `cwd` binds to.
 * @returns {{ config: object, notices: string[], sources: Record<string, string>, path: string, projectPath: string|null }}
 *   `sources` maps each dotted leaf key to `default`, `user file`, `project file`, or `env`.
 */
export function loadConfig({ env = process.env, home = homedir(), cwd = null } = {}) {
  const path = configPath(env, home);
  const projectPath = projectConfigPath(cwd);
  const notices = [];
  const sources = {};
  const config = structuredClone(DEFAULTS);
  for (const k of leafKeys()) sources[k] = "default";

  const userValue = readConfigFile(path, notices);
  if (userValue) applyFile(config, sources, notices, path, userValue, "user file");
  const projectValue = projectPath ? readConfigFile(projectPath, notices) : null;
  if (projectValue) applyFile(config, sources, notices, projectPath, projectValue, "project file");

  if (env.LEDGER_DB) {
    config.db = env.LEDGER_DB;
    sources.db = "env";
  }
  const enabled = envEnabled(env);
  if (enabled !== undefined) {
    config.enabled = enabled;
    sources.enabled = "env";
  }
  if (sources.db === "default") config.db = defaultDbPath(env, home);
  else config.db = expandHome(config.db, home);

  return { config, notices, sources, path, projectPath };
}

/** The display name recorded as the human actor: the configured one, else the OS user name. */
export function userName(config) {
  if (config.user) return config.user;
  try {
    return userInfo().username;
  } catch {
    return "human";
  }
}

/** The effective values and where each came from, one line per leaf key. */
export function describeConfig({ config, sources, path, projectPath = null, shared = null }) {
  const lines = [`user config file: ${path}`, `project config file: ${projectPath ?? `none (no ${PROJECT_FILE} here or above)`}`];
  if (shared !== null) lines.push(`database: ${config.db} (${shared ? "shared file: other tables present, only the cc_ tables are the plugin's" : "own file: only the plugin's cc_ tables"})`);
  for (const key of leafKeys()) {
    const [a, b] = key.split(".");
    const value = b === undefined ? config[a] : config[a][b];
    lines.push(`${key} = ${JSON.stringify(value)}  (source: ${sources[key]})`);
  }
  return lines.join("\n");
}
