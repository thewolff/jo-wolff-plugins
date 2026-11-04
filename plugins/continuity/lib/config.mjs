// lib/config.mjs — `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json`, read by every hook.
//
//   { "threshold": 0.65, "contextTokens": 200000, "pressure": "on", "liveness": "on", "snapshot": "on" }
//
//   threshold      the fraction of `contextTokens` at which the context-pressure check speaks (a
//                  JSON number strictly between 0 and 1; a string or an array is a problem, not a
//                  number; the default is the one the newdle hook shipped)
//   contextTokens  the context size the estimate is compared against: a positive JSON integer,
//                  default 200000 (the context window of the models this was written against)
//   pressure       "off" silences the UserPromptSubmit warning and the Stop block
//   liveness       "off" silences the liveness line
//   snapshot       "off" stops the PreCompact save and the post-compaction restore
//
// How it fails: a missing file is the defaults. A file that does not parse, is not an object, or
// carries a value of the wrong shape is the defaults for that value, with `problem` naming the
// file and what was wrong; the hook that read it says so once in a systemMessage. Unknown keys
// are ignored. Nothing here throws.

import { readFileSync } from "node:fs";
import { configPath } from "./paths.mjs";

export const DEFAULTS = Object.freeze({ threshold: 0.65, contextTokens: 200000, pressure: "on", liveness: "on", snapshot: "on" });
const SWITCHES = ["pressure", "liveness", "snapshot"];

/** `{ config, path, problem }`: `config` always complete; `problem` null when the file was absent or whole. */
export function readConfig(env = process.env) {
  const path = configPath(env);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { config: { ...DEFAULTS }, path, problem: null };
    return { config: { ...DEFAULTS }, path, problem: `${path} could not be read (${err?.code ?? err?.message}); using the defaults` };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { config: { ...DEFAULTS }, path, problem: `${path} does not parse (${err.message}); using the defaults` };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { config: { ...DEFAULTS }, path, problem: `${path} is not a JSON object; using the defaults` };
  const config = { ...DEFAULTS };
  const wrong = [];
  if ("threshold" in json) {
    const t = json.threshold;
    if (typeof t === "number" && Number.isFinite(t) && t > 0 && t < 1) config.threshold = t;
    else wrong.push(`threshold must be a number between 0 and 1, not ${JSON.stringify(t)}`);
  }
  if ("contextTokens" in json) {
    const n = json.contextTokens;
    if (Number.isInteger(n) && n > 0) config.contextTokens = n;
    else wrong.push(`contextTokens must be a positive whole number, not ${JSON.stringify(n)}`);
  }
  for (const key of SWITCHES) {
    if (!(key in json)) continue;
    if (json[key] === "on" || json[key] === "off") config[key] = json[key];
    else wrong.push(`${key} must be "on" or "off", not ${JSON.stringify(json[key])}`);
  }
  return { config, path, problem: wrong.length ? `${path}: ${wrong.join("; ")}; using the default for each` : null };
}
