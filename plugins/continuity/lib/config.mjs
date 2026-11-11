// lib/config.mjs — `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json`, read by every hook.
//
//   { "askTokens": 175000, "askMarginTokens": 40000, "reaskStepTokens": 150000, "pressure": "on",
//     "liveness": "on", "snapshot": "on", "rules": "on", "notesDir": ".ai/decision-log", "notesCount": 5 }
//
//   askTokens        the context size, in tokens, at which the context-pressure check first asks
//                    for a handoff in a compaction window (a positive JSON integer). Unset, it is
//                    `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` minus `askMarginTokens` when that
//                    variable is set (Claude Code's idle-compaction threshold, raised to 100,000
//                    when lower), else 175,000. lib/pressure.mjs askPoint() resolves it.
//   askMarginTokens  how far past the window's first recorded usage the context must grow before
//                    the first ask (a whole number, 0 or more; default 40,000): the ask point is
//                    never below that, so a session that starts large is not asked on turn one
//   reaskStepTokens  how much further the context must grow, in the same compaction window,
//                    after an ask or a handoff before the next ask (a positive integer; default
//                    150,000)
//   threshold, contextTokens
//                    the 0.3 settings, kept for an existing config file: when either is set and
//                    `askTokens` is not, the ask point is `threshold` × `contextTokens` (each
//                    defaulting to its old value, 0.65 and 200,000). `askTokens` wins over both;
//                    the margin and the re-ask step apply either way. threshold is a JSON number
//                    strictly between 0 and 1 (a string or an array is a problem, not a number);
//                    contextTokens a positive JSON integer
//   pressure         "off" silences the UserPromptSubmit ask and the Stop block
//   liveness         "off" silences the liveness line
//   snapshot         "off" stops the PreCompact save and the post-compaction restore
//   rules            "off" stops the post-compaction re-inlining of the rules files on the cwd's walk
//   notesDir         the durable-notes directory the post-compaction restore lists, relative to the
//                    git root (the cwd when there is none) unless absolute; a non-empty string
//   notesCount       how many of its newest entries to list: a whole number from 0 (the probe is
//                    off) to 100
//
// How it fails: a missing file is the defaults. A file that does not parse, is not an object, or
// carries a value of the wrong shape is the defaults for that value, with `problem` naming the
// file and what was wrong; the hook that read it says so once in a systemMessage. Unknown keys
// are ignored. Nothing here throws.

import { readFileSync } from "node:fs";
import { configPath } from "./paths.mjs";

// `askTokens`, `threshold` and `contextTokens` are null when the file does not set them: whether
// they were set is what decides the ask point (lib/pressure.mjs askPoint()).
export const DEFAULTS = Object.freeze({ askTokens: null, askMarginTokens: 40000, reaskStepTokens: 150000, threshold: null, contextTokens: null, pressure: "on", liveness: "on", snapshot: "on", rules: "on", notesDir: ".ai/decision-log", notesCount: 5 });
const SWITCHES = ["pressure", "liveness", "snapshot", "rules"];
export const NOTES_COUNT_MAX = 100;

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
  const whole = (key, min, what) => {
    if (!(key in json)) return;
    const n = json[key];
    if (Number.isInteger(n) && n >= min) config[key] = n;
    else wrong.push(`${key} must be ${what}, not ${JSON.stringify(n)}`);
  };
  whole("askTokens", 1, "a positive whole number");
  whole("askMarginTokens", 0, "a whole number, 0 or more");
  whole("reaskStepTokens", 1, "a positive whole number");
  if ("threshold" in json) {
    const t = json.threshold;
    if (typeof t === "number" && Number.isFinite(t) && t > 0 && t < 1) config.threshold = t;
    else wrong.push(`threshold must be a number between 0 and 1, not ${JSON.stringify(t)}`);
  }
  whole("contextTokens", 1, "a positive whole number");
  if ("notesDir" in json) {
    const d = json.notesDir;
    if (typeof d === "string" && d.trim()) config.notesDir = d;
    else wrong.push(`notesDir must be a non-empty string, not ${JSON.stringify(d)}`);
  }
  if ("notesCount" in json) {
    const n = json.notesCount;
    if (Number.isInteger(n) && n >= 0 && n <= NOTES_COUNT_MAX) config.notesCount = n;
    else wrong.push(`notesCount must be a whole number from 0 to ${NOTES_COUNT_MAX}, not ${JSON.stringify(n)}`);
  }
  for (const key of SWITCHES) {
    if (!(key in json)) continue;
    if (json[key] === "on" || json[key] === "off") config[key] = json[key];
    else wrong.push(`${key} must be "on" or "off", not ${JSON.stringify(json[key])}`);
  }
  return { config, path, problem: wrong.length ? `${path}: ${wrong.join("; ")}; using the default for each` : null };
}

/**
 * True when the hook was spawned by the OMP adapter (omp/continuity-omp.ts sets
 * `CONTINUITY_HOST=omp`). OMP reads every hook's stdout as JSON and shows `systemMessage` to the
 * person, so the PreCompact hook keeps its JSON answer there; on Claude Code it prints the
 * compaction-summary instructions as plain text instead.
 */
export const onOmp = (env = process.env) => env?.CONTINUITY_HOST === "omp";
