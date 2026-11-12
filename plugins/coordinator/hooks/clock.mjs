#!/usr/bin/env node
// hooks/clock.mjs — the coordinator plugin's UserPromptSubmit hook. Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage, never a
// block.
//
// What it does: adds one additionalContext line with the system clock, in the machine's zone and
// in UTC, on every prompt in every session with the plugin on (a worker's report and a peer's
// message arrive as prompts too, so they get an arrival time). It states a fact; what to do with
// it (stamp handoff blocks from it) is the skill's. `clock: false` or `off: true` in the config
// turns it off. The line names its own time because a resumed session replays it stale.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// ${XDG_STATE_HOME:-~/.local/state}/coordinator/errors.log and allows. An unreadable clock or a
// zone Intl cannot format → no line and one errors.log line. A `TZ` Intl rejects → the line in UTC
// (what the runtime reads) plus a systemMessage naming the zone. A malformed config → the defaults
// (the clock on) plus a systemMessage naming the file.

import { runHook, invokedDirectly, logError } from "../lib/hook-runner.mjs";
import { loadConfig, stateFault, withFault } from "../lib/config.mjs";

const HOOK = "clock";

const pad = (n) => String(n).padStart(2, "0");

/** `UTC-08:00` from Intl's `GMT-08:00` (or `GMT` alone, which is UTC+00:00). */
function utcOffset(date, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /^GMT([+-]\d{2}:\d{2})?$/.exec(name);
  if (!m) throw new Error(`cannot read the UTC offset of ${timeZone ?? "the local zone"} (${name})`);
  return `UTC${m[1] ?? "+00:00"}`;
}

/**
 * The clock line for `date`, in `timeZone` (default: the machine's).
 * @throws when `date` is invalid or the zone cannot be formatted
 */
export function clockLine(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error("the system clock returned an invalid date");
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const local = `${parts.year}-${parts.month}-${parts.day} ${pad(parts.hour)}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
  const utc = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `The system clock reads ${local} (${utcOffset(date, timeZone)}), which is ${utc}, as of this prompt.`;
}

/** The `TZ` value when it is set and Intl rejects it (the runtime then reads UTC), else null. */
function rejectedZone(tz) {
  if (typeof tz !== "string" || !tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.replace(/^:/, "") });
    return null;
  } catch {
    return tz;
  }
}

/**
 * @param {object} input  the UserPromptSubmit payload; only hook_event_name is read
 * @returns {object|null}  an additionalContext, a systemMessage, or null
 */
export function handle(input, { env = process.env, now = () => new Date(), timeZone } = {}) {
  const { config, fault } = loadConfig(env);
  if (config.off || !config.clock || input?.hook_event_name !== "UserPromptSubmit") return withFault(null, fault, HOOK);
  const badZone = timeZone === undefined ? rejectedZone(env.TZ) : null;
  let line;
  try {
    line = clockLine(now(), timeZone);
  } catch (err) {
    logError("coordinator", "UserPromptSubmit", `${HOOK}: ${err.message}`, env);
    return withFault(null, fault, HOOK);
  }
  let out = withFault({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: line } }, fault, HOOK);
  const notes = [];
  if (badZone) notes.push(`coordinator clock: TZ ${JSON.stringify(badZone)} is not a time zone Intl accepts; the clock line is in UTC`);
  const unwritable = stateFault(env);
  if (unwritable) {
    logError("coordinator", "UserPromptSubmit", `${HOOK}: ${unwritable}`, env);
    notes.push(`coordinator clock: ${unwritable}`);
  }
  if (!notes.length) return out;
  return { ...out, systemMessage: [out.systemMessage, ...notes].filter(Boolean).join("\n") };
}

if (invokedDirectly(import.meta.url)) runHook("UserPromptSubmit", import.meta.url, { plugin: "coordinator" });
