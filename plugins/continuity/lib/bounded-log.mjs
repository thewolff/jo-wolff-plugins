// lib/bounded-log.mjs — append one line to a line-oriented log and keep it bounded, for
// heartbeat.ndjson, calibration.ndjson and errors.log.
//
// Every write is a plain append (one `appendFileSync` of the line and its newline). Only when the
// file has grown past 2 × `max` lines is it trimmed to its newest `max` by a rename-swap: the
// kept tail goes to a temp file beside the log, named for this process, and is renamed over the
// log. A rename is atomic on one filesystem, so a reader sees the old file or the new one, never a
// half-written one, and a crash mid-trim leaves the old file whole. What it does not do is
// serialise writers: a line another session appends between this writer's read and its rename is
// lost. That window opens once in every `max` writes, at the trim, not on every write. It is
// accepted: these logs are evidence of recent activity, every reader treats them as a sample, and
// a lock that a dead process held would be worse than a line lost.
//
// Throws on failure (an unwritable directory); the callers each fail quiet in their own way.

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Append `line` (no newline) to `path`; past 2 × `max` lines, trim it to the newest `max`. */
export function appendBounded(path, line, max) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length <= 2 * max) return;
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, `${lines.slice(-max).join("\n")}\n`);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the temp file was never made, or cannot be removed either */
    }
    throw err;
  }
}
