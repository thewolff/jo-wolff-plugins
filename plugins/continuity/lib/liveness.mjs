// lib/liveness.mjs — the one place the pre-compaction-save liveness sentence is written, and
// the only thing that decides which of its three cases a session hears.
//
// Always a string: there is no "nothing to say" case, because silence is the failure mode this
// path was written to end (a save that ran in no session for 34 days, unnoticed). Other
// SessionStart hooks compete for the same injection window, so every case says the least it can:
// one line when the save is healthy, a short block when it is not.
//
// Pure: no filesystem writes, no stdout. The heartbeat read goes through lib/heartbeat.mjs.

import { readHeartbeat } from "./heartbeat.mjs";
import { heartbeatPath } from "./paths.mjs";

// Coarse on purpose: the decision a reader makes off this number is "is that plausible for a
// machine that compacts several times a day", and minutes past the first hour do not inform it.
export function age(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

/**
 * The sentence (or short block) a session should hear. `records` defaults to the heartbeat file
 * under `env`; `now` is injectable so a test can pin an exact age.
 */
export function renderLiveness({ env = process.env, records = readHeartbeat(env), now = Date.now() } = {}) {
  const path = heartbeatPath(env);

  // No record at all: the one case that must never read as healthy, and the case this was
  // written for. It is what 34 days of a dead save looked like from the outside.
  if (!records.length) {
    return (
      "continuity, pre-compaction save liveness: **no pre-compaction save has ever been recorded on this machine.** " +
      `The PreCompact hook writes one heartbeat record per invocation to \`${path}\`, and that file is absent or empty, ` +
      "so either the hook has never been invoked here or it cannot write there. A save that never runs means long " +
      "sessions lose their state at every compaction. Tell the person; do not assume the save works."
    );
  }

  const saves = records.filter((r) => r.event === "PreCompact");
  const lastOk = [...saves].reverse().find((r) => r.outcome === "ok");
  if (lastOk) {
    const when = Date.parse(String(lastOk.at));
    const ago = Number.isFinite(when) ? age(now - when) : `at ${lastOk.at}`;
    return `continuity, pre-compaction save liveness: last successful save ${ago} (${lastOk.at}); the snapshot path is alive.`;
  }

  // The hook has run and has never succeeded. `failed:<reason>` is the useful half; a run that
  // only ever recorded `started` crashed between the two records.
  const last = saves.length ? saves[saves.length - 1] : records[records.length - 1];
  return (
    "continuity, pre-compaction save liveness: **no pre-compaction save has ever succeeded on this machine.** " +
    `The hook has been invoked ${records.length} time${records.length === 1 ? "" : "s"} and the most recent outcome was ` +
    `\`${last.outcome}\` (${last.at}, event \`${last.event}\`). Full log: \`${path}\`. Tell the person.`
  );
}
