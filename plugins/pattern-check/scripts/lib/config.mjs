// config.mjs — the plugin's settings: the user file, a per-repo override, and the defaults.
//
// Two files, both optional:
//   user   ${XDG_CONFIG_HOME:-$HOME/.config}/pattern-check/config.json
//   repo   the nearest .pattern-check.json in the working directory or any directory above it
//
// Every key is read separately: the repo file wins for a key it sets, the user file for a key the
// repo file leaves out, the default otherwise. `denyCommands` is the one additive key: the two
// lists are concatenated, because a repo adding a matcher should not have to repeat the user's.
//
// FAULTS NEVER THROW. A file that does not parse, or a key of the wrong shape, falls back to the
// default for that key and is reported in `faults` (one line each). The hooks print those lines
// as a warning and allow the call: a broken config must read as "the plugin is misconfigured",
// never as "the agent did the check".
//
// XDG_CONFIG_HOME counts only when it is an absolute path, as the XDG spec says.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const DEFAULTS = Object.freeze({
  threshold: 3,
  denyCommands: Object.freeze([]),
  receiptDir: ".pattern-check",
  hooks: Object.freeze({ preToolUse: true, stop: true }),
});

export const REPO_FILE = ".pattern-check.json";

/** The user config file's path. */
export function userConfigPath(env = process.env, home = homedir()) {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "pattern-check", "config.json");
}

/** The nearest .pattern-check.json at or above `cwd`, or null. */
export function repoConfigPath(cwd) {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, REPO_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Reads one file into { values, faults }. A missing file is normal: empty values, no fault.
function readLayer(path, label) {
  const faults = [];
  if (!path || !existsSync(path)) return { values: {}, faults };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    faults.push(`${label} config ${path} is not valid JSON (${e.message}); using defaults`);
    return { values: {}, faults };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    faults.push(`${label} config ${path} is not a JSON object; using defaults`);
    return { values: {}, faults };
  }
  const values = {};
  if ("threshold" in parsed) {
    const t = parsed.threshold;
    if (Number.isInteger(t) && t >= 1) values.threshold = t;
    else faults.push(`${label} config ${path}: threshold must be an integer >= 1, got ${JSON.stringify(t)}; using ${DEFAULTS.threshold}`);
  }
  if ("denyCommands" in parsed) {
    const d = parsed.denyCommands;
    if (Array.isArray(d) && d.every((s) => typeof s === "string")) {
      const ok = [];
      for (const s of d) {
        try { new RegExp(s); ok.push(s); } catch (e) { faults.push(`${label} config ${path}: denyCommands entry ${JSON.stringify(s)} is not a valid regular expression (${e.message}); skipped`); }
      }
      values.denyCommands = ok;
    } else {
      faults.push(`${label} config ${path}: denyCommands must be an array of strings; ignored`);
    }
  }
  if ("receiptDir" in parsed) {
    const r = parsed.receiptDir;
    if (typeof r === "string" && r.trim() !== "" && !isAbsolute(r) && !r.split(/[\\/]/).includes("..")) values.receiptDir = r.trim();
    else faults.push(`${label} config ${path}: receiptDir must be a relative path without "..", got ${JSON.stringify(r)}; using ${DEFAULTS.receiptDir}`);
  }
  if ("hooks" in parsed) {
    const h = parsed.hooks;
    if (h && typeof h === "object" && !Array.isArray(h)) {
      const hooks = {};
      for (const k of ["preToolUse", "stop"]) {
        if (k in h) {
          if (typeof h[k] === "boolean") hooks[k] = h[k];
          else faults.push(`${label} config ${path}: hooks.${k} must be true or false, got ${JSON.stringify(h[k])}; using ${DEFAULTS.hooks[k]}`);
        }
      }
      values.hooks = hooks;
    } else {
      faults.push(`${label} config ${path}: hooks must be an object; ignored`);
    }
  }
  return { values, faults };
}

/**
 * The effective settings for a working directory.
 * @returns {{ threshold: number, denyCommands: string[], receiptDir: string, hooks: { preToolUse: boolean, stop: boolean }, faults: string[], sources: { user: string|null, repo: string|null } }}
 */
export function resolveConfig({ cwd, env = process.env, home = homedir() } = {}) {
  const userPath = userConfigPath(env, home);
  const repoPath = cwd ? repoConfigPath(cwd) : null;
  const user = readLayer(userPath, "user");
  const repo = readLayer(repoPath, "repo");
  const pick = (k) => (k in repo.values ? repo.values[k] : k in user.values ? user.values[k] : DEFAULTS[k]);
  return {
    threshold: pick("threshold"),
    denyCommands: [...(user.values.denyCommands ?? []), ...(repo.values.denyCommands ?? [])],
    receiptDir: pick("receiptDir"),
    hooks: {
      preToolUse: repo.values.hooks?.preToolUse ?? user.values.hooks?.preToolUse ?? DEFAULTS.hooks.preToolUse,
      stop: repo.values.hooks?.stop ?? user.values.hooks?.stop ?? DEFAULTS.hooks.stop,
    },
    faults: [...user.faults, ...repo.faults],
    sources: { user: existsSync(userPath) ? userPath : null, repo: repoPath },
  };
}
