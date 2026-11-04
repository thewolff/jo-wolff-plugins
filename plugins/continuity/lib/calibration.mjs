// lib/calibration.mjs — how big this session's context is in transcript bytes, and, on a host
// that ever reports a real token count, the tokens-per-byte ratio that turns those bytes into a
// better estimate than the fixed one in lib/pressure.mjs.
//
// The measure: the size of the transcript file after its last compaction marker (a line with
// `"subtype":"compact_boundary"`), or the whole file when it has none. The marker is what a
// Claude Code transcript is understood to carry after a compaction; no transcript on the machine
// this was written on had one, so in practice the measure is usually the whole file, and after a
// compaction that does not write a marker it still counts the bytes from before it. The README
// says so.
//
// Calibration: Claude Code's PreCompact payload carries no `token_count` (code.claude.com/docs,
// "PreCompact input": `trigger` and `custom_instructions` only), so on Claude Code nothing is
// ever recorded here and the pressure check uses its fixed bytes-per-token estimate. A host
// adapter that does pass `token_count` with a `transcript_path` gets one record per compaction,
// and the median of those replaces the estimate. Median rather than mean: one anomalous
// observation would drag a mean far enough to matter. Machine-wide on purpose: the ratio is a
// property of how transcripts are encoded, not of one session.

import { openSync, readFileSync, readSync, closeSync, fstatSync } from "node:fs";
import { appendBounded } from "./bounded-log.mjs";
import { calibrationPath } from "./paths.mjs";

export const CALIBRATION_MAX_LINES = 200;
const MARKER = Buffer.from('"subtype":"compact_boundary"');

/**
 * `{ bytes, sinceMarker }` for the transcript at `path`: bytes after the line holding the last
 * compaction marker, or the whole file (`sinceMarker` false). Null when it cannot be read.
 */
export function measureTranscript(path) {
  let fd;
  try {
    fd = openSync(String(path), "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (!n) break;
      read += n;
    }
    const data = buf.subarray(0, read);
    const at = data.lastIndexOf(MARKER);
    if (at < 0) return { bytes: data.length, sinceMarker: false };
    const eol = data.indexOf(0x0a, at);
    return { bytes: eol < 0 ? 0 : data.length - eol - 1, sinceMarker: true };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** Record one {bytes, tokens} from a PreCompact input carrying a real `token_count`; false otherwise. Never throws. */
export function recordCalibration(input, env = process.env) {
  try {
    const tokens = input?.token_count;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return false;
    const m = measureTranscript(input?.transcript_path);
    if (!m || !m.bytes) return false;
    appendBounded(calibrationPath(env), JSON.stringify({ bytes: m.bytes, tokens }), CALIBRATION_MAX_LINES);
    return true;
  } catch {
    return false;
  }
}

/** `{ ratio }` (median tokens per byte over every record) or null when no real token count was ever recorded. */
export function readCalibration(env = process.env) {
  let lines;
  try {
    lines = readFileSync(calibrationPath(env), "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }
  const ratios = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.bytes > 0 && rec.tokens > 0) ratios.push(rec.tokens / rec.bytes);
    } catch {
      /* skip the malformed line */
    }
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  return { ratio: ratios[Math.floor(ratios.length / 2)] };
}
