// lib/bounded-log.mjs — append one line to a line-oriented log and keep only its newest `max`
// lines, for heartbeat.ndjson, calibration.ndjson and errors.log.
//
// The write is a rename-swap: the new content (the kept tail plus the new line) goes to a temp
// file beside the log, named for this process, and is renamed over the log. A rename is atomic on
// one filesystem, so a reader sees the old file or the new one, never a half-written one, and a
// crash mid-write leaves the old file whole. What it does not do is serialise two writers: two
// sessions writing in the same instant each read the same old file, and the second rename wins,
// so one of the two new lines can be lost. That is accepted: these logs are evidence of recent
// activity, every reader treats them as a sample, and a lock that a dead process held would be
// worse than a line lost.
//
// Throws on failure (an unwritable directory); the callers each fail quiet in their own way.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Append `line` (no newline) to `path`, keeping its newest `max` lines. */
export function appendBounded(path, line, max) {
  mkdirSync(dirname(path), { recursive: true });
  let lines = [];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  lines.push(line);
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
