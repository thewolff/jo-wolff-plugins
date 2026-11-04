// judge-setup.mjs — what the setup tool and the session-start fallback notice share: which
// checks need a judge, and whether the operator has made a judge choice at all.
//
// THE STATES of enforcement.judgeCommand in the profile, then the shared judge file:
//   unset  the key is absent (or there is no profile) AND the shared file names no command:
//          nobody has chosen. The session-start hook shows its one-time notice naming the
//          shared setup (`node lib/judge.mjs setup`) and this plugin's own tools/setup.mjs.
//   shared the key is absent but ${XDG_CONFIG_HOME:-~/.config}/judge/config.json names a
//          command: the shared judge applies. No notice.
//   none   the key is null: the operator chose no override of their own. No notice; the shared
//          file applies when it names a command, else the judge checks are off (skipped.log).
//   set    any other value. No notice; lib/config.mjs decides whether the value is usable and
//          logs to errors.log when it is not.
//   unreadable  the profile exists but does not parse, or the key is absent or null and the
//          shared file exists but is malformed: no notice, because the operator has clearly
//          configured something. The inject hook already says the profile did not parse; for
//          the shared file it logs one fault naming the parse problem (sharedProblem below).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHECK_IDS } from "./rules.mjs";
import { readSharedConfig } from "./judge.mjs";

// The five Stop-hook checks that run only with a judge (skills/i-have-audhd/reference.md,
// the check table's "judge" instruments). Seven others are deterministic and always run;
// links-judge also needs a judge but is off until the profile names it, so a missing judge
// turns nothing off there and it is not counted here.
export const JUDGE_RULES = [
  "do-not-batch-by-label",
  "conclusion-first",
  "restate-resumed-thread",
  "report-what-you-did-not-do",
  "bad-news-first",
];
export const TOTAL_CHECKS = CHECK_IDS.length;

export const SETUP_SCRIPT = fileURLToPath(new URL("../tools/setup.mjs", import.meta.url));
// The vendored shared judge dispatch, whose `setup` verb writes the shared file.
export const SHARED_JUDGE_SCRIPT = fileURLToPath(new URL("../lib/judge.mjs", import.meta.url));
export const SHARED_SETUP_COMMAND = `node ${SHARED_JUDGE_SCRIPT} setup`;

// Never throws. Returns "unset" | "shared" | "none" | "set" | "unreadable".
export function judgeChoiceState(path, env = process.env) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return sharedState(env);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
  const e = parsed.enforcement;
  if (!e || typeof e !== "object" || Array.isArray(e) || !("judgeCommand" in e)) return sharedState(env);
  if (e.judgeCommand !== null) return "set";
  // null defers to the shared file, so its malformation is a fault; anything else is "none".
  return sharedState(env) === "unreadable" ? "unreadable" : "none";
}

// The shared file's say when the profile has none: "shared", "unreadable", or "unset".
function sharedState(env) {
  const { config, malformed } = readSharedConfig({ env });
  if (malformed) return "unreadable";
  return typeof config?.command === "string" && config.command.trim() ? "shared" : "unset";
}

// `<path>: <error>` when the shared file exists and cannot be used, else null.
export function sharedProblem(env = process.env) {
  return readSharedConfig({ env }).malformed;
}

// The fallback notice for someone who installed the plugin and never ran either setup.
export function judgeNotice(env = process.env) {
  const { path } = readSharedConfig({ env });
  return (
    `i-have-audhd: no judge is configured (no enforcement.judgeCommand in the profile and no command in ${path}), ` +
    `so ${JUDGE_RULES.length} of its ${TOTAL_CHECKS} checks are off (${JUDGE_RULES.join(", ")}). ` +
    `To configure one judge for every plugin that judges, run \`${SHARED_SETUP_COMMAND}\` in a terminal; ` +
    `to pick one for this plugin alone, or to choose none and stop this notice, run \`node ${SETUP_SCRIPT}\`. ` +
    `This notice shows once.`
  );
}
