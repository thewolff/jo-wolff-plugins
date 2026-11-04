// lib/pressure.mjs — how full is this session's context, as a fraction of the compaction
// target, estimated from the transcript's size and the calibration file (lib/calibration.mjs).
//
// Cold start is deliberately silent: before the first compaction on a machine there is no
// observed ratio, and a fabricated bytes-per-token constant would produce false "you're nearly
// full" warnings on fresh sessions. A warning you learn to dismiss is worse than none.

import { statSync } from "node:fs";
import { readCalibration } from "./calibration.mjs";

/**
 * `{ pct, estimated, target }` when the estimate is at or past `threshold` × target; null when
 * the machine is uncalibrated, the transcript cannot be measured, or the estimate is under.
 */
export function pressure(input, { threshold, env = process.env } = {}) {
  const cal = readCalibration(env);
  if (!cal) return null;
  let bytes = 0;
  try {
    bytes = statSync(String(input?.transcript_path)).size;
  } catch {
    return null;
  }
  if (!bytes) return null;
  const estimated = bytes * cal.ratio;
  if (estimated < cal.target * threshold) return null;
  return { pct: Math.round((estimated / cal.target) * 100), estimated, target: cal.target };
}

/** The text that asks for a handoff; the same on both surfaces, with the way out in backticks. */
export function handoffRequest(pct) {
  return (
    `continuity: this session is roughly ${pct}% of the way to auto-compaction. Before it ends, run \`/continuity:handoff\` ` +
    "to write the judgment layer to `.ai/handoffs/` in the repository: what you were in the middle of, what you already ruled " +
    "out, what is still uncertain. The next session inherits that file and nothing else beyond the repository itself; " +
    "mechanical state (branch, diff, touched files, recent asks) is saved automatically at compaction and is not what gets lost. " +
    "If there is genuinely nothing in flight worth passing on, a short session or a finished task, say so in one line and stop. " +
    "This fires once per session either way."
  );
}
