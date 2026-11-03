// config.mjs — where every setting comes from, and the defaults that make a fresh machine work.
//
// Resolution, strongest first, decided separately for each key:
//   1. env: LEDGER_DB sets the database path (only that key). LEDGER_CONFIG names the config
//      file to read instead of the default one.
//   2. the user file: ${XDG_CONFIG_HOME:-~/.config}/ledger/config.json. The XDG variable counts
//      only when it is an absolute path, as the XDG spec says.
//   3. the defaults below. No user name, path, host or repository appears in a default; `~` is
//      expanded at runtime from os.homedir(), and the data directory honours XDG_DATA_HOME when
//      that is absolute.
//
// This module never throws. A file that is missing is normal and silent. A file that exists but
// does not parse, or a value of the wrong type, falls back to the default for that key AND
// produces one notice naming the file, so a broken config never reads like a working one. Unknown
// keys are ignored without a notice (forward compatibility).

import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

/** The shipped defaults; example.config.json is this object verbatim. */
export const DEFAULTS = Object.freeze({
  db: "~/.local/share/ledger/ledger.db",
  user: null,
  timezone: null,
  hooks: Object.freeze({ sessionStart: true, preToolUse: true, stop: true, sessionEnd: true, userPromptCommands: true }),
  forcing: Object.freeze({
    denyPush: true,
    denyPrCreate: true,
    denyWritesOutsideCwd: true,
    denyAskWithoutRow: true,
    stopAskRule: true,
    stopDoneRule: true,
  }),
  inject: Object.freeze({ decisions: 5 }),
  stale: Object.freeze({ days: 7 }),
});

// Type of each leaf, for the wrong-type notice. Nested objects list their leaves.
const SHAPE = {
  db: "string",
  user: "string|null",
  timezone: "string|null",
  hooks: { sessionStart: "boolean", preToolUse: "boolean", stop: "boolean", sessionEnd: "boolean", userPromptCommands: "boolean" },
  forcing: {
    denyPush: "boolean",
    denyPrCreate: "boolean",
    denyWritesOutsideCwd: "boolean",
    denyAskWithoutRow: "boolean",
    stopAskRule: "boolean",
    stopDoneRule: "boolean",
  },
  inject: { decisions: "integer" },
  stale: { days: "integer" },
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
    default:
      return false;
  }
}

/**
 * Resolve the effective configuration.
 * @returns {{ config: object, notices: string[], sources: Record<string, string>, path: string }}
 *   `sources` maps each dotted leaf key to `default`, `file`, or `env`.
 */
export function loadConfig({ env = process.env, home = homedir() } = {}) {
  const path = configPath(env, home);
  const notices = [];
  const sources = {};
  const config = structuredClone(DEFAULTS);
  for (const k of leafKeys()) sources[k] = "default";

  let fileValue = null;
  let text = null;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") notices.push(`ledger: config ${path} ignored: ${err.message}`);
  }
  if (text !== null) {
    try {
      fileValue = JSON.parse(text);
      if (fileValue === null || typeof fileValue !== "object" || Array.isArray(fileValue)) {
        notices.push(`ledger: config ${path} ignored: top level is not an object`);
        fileValue = null;
      }
    } catch (err) {
      notices.push(`ledger: config ${path} ignored: ${err.message}`);
    }
  }

  if (fileValue) {
    for (const [key, shape] of Object.entries(SHAPE)) {
      if (!(key in fileValue)) continue;
      const given = fileValue[key];
      if (typeof shape === "object") {
        if (given === null || typeof given !== "object" || Array.isArray(given)) {
          notices.push(`ledger: config ${path}: ${key} must be an object; using defaults for it`);
          continue;
        }
        for (const [leaf, expected] of Object.entries(shape)) {
          if (!(leaf in given)) continue;
          if (typeOk(expected, given[leaf])) {
            config[key][leaf] = given[leaf];
            sources[`${key}.${leaf}`] = "file";
          } else {
            notices.push(`ledger: config ${path}: ${key}.${leaf} must be ${expected}; using default`);
          }
        }
      } else if (typeOk(shape, given)) {
        config[key] = given;
        sources[key] = "file";
      } else {
        notices.push(`ledger: config ${path}: ${key} must be ${shape}; using default`);
      }
    }
  }

  if (env.LEDGER_DB) {
    config.db = env.LEDGER_DB;
    sources.db = "env";
  }
  if (sources.db === "default") config.db = defaultDbPath(env, home);
  else config.db = expandHome(config.db, home);

  return { config, notices, sources, path };
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
export function describeConfig({ config, sources, path }) {
  const lines = [`config file: ${path}`];
  for (const key of leafKeys()) {
    const [a, b] = key.split(".");
    const value = b === undefined ? config[a] : config[a][b];
    lines.push(`${key} = ${JSON.stringify(value)}  (source: ${sources[key]})`);
  }
  return lines.join("\n");
}
