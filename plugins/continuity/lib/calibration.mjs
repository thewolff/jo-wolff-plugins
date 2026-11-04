// lib/calibration.mjs — the bytes-per-token ratio the context-pressure check converts a
// transcript size into a token estimate with.
//
// PreCompact is the only hook event whose input carries `token_count` and `compaction_target`,
// so it is the only place a real ratio can be observed, but it fires at compaction, far too late
// to warn anyone. So the PreCompact hook appends one observation here per compaction, and the
// UserPromptSubmit and Stop hooks convert a cheap `statSync(transcript_path).size` into an
// estimate through the accumulated ratio. Machine-wide rather than per-session, deliberately:
// the ratio is a property of how transcripts are encoded, not of any one session.
//
// Under the state directory and not `os.tmpdir()`: macOS purges tmp on its own schedule, and a
// ratio that evaporates drops the pressure check back to its cold-start silence with no signal
// that anything was lost (measured on the hook this was ported from: four real compactions, and
// no calibration file anywhere).
//
// Median rather than mean: one anomalous observation (a transcript truncated mid-write, a
// session with unusual tool-output density) would drag a mean far enough to matter.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { calibrationPath } from "./paths.mjs";

export const CALIBRATION_MAX_LINES = 200;

/** Append one {bytes, tokens, target} from a PreCompact input; silently nothing when the input lacks the fields. Never throws. */
export function recordCalibration(input, env = process.env) {
  try {
    const tokens = Number(input?.token_count);
    const target = Number(input?.compaction_target);
    if (!Number.isFinite(tokens) || tokens <= 0) return false;
    let bytes = 0;
    try {
      bytes = statSync(String(input?.transcript_path)).size;
    } catch {
      return false;
    }
    if (!bytes) return false;
    const path = calibrationPath(env);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ bytes, tokens, target: Number.isFinite(target) && target > 0 ? target : null })}\n`);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length > CALIBRATION_MAX_LINES) writeFileSync(path, `${lines.slice(-CALIBRATION_MAX_LINES).join("\n")}\n`);
    return true;
  } catch {
    return false;
  }
}

/** `{ ratio, target }` (median tokens per byte, newest target) or null on a machine that has never compacted. */
export function readCalibration(env = process.env) {
  let lines;
  try {
    lines = readFileSync(calibrationPath(env), "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }
  const ratios = [];
  let target = null;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.bytes > 0 && rec.tokens > 0) ratios.push(rec.tokens / rec.bytes);
      if (Number.isFinite(rec.target) && rec.target > 0) target = rec.target;
    } catch {
      /* skip the malformed line */
    }
  }
  if (!ratios.length || !target) return null;
  ratios.sort((a, b) => a - b);
  return { ratio: ratios[Math.floor(ratios.length / 2)], target };
}
