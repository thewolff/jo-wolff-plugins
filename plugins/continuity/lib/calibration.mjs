// lib/calibration.mjs — how big this session's context is: the token usage the last main-thread
// reply recorded in the transcript, the transcript's bytes, and, on a host that ever reports a
// real token count, the tokens-per-byte ratio that turns those bytes into a better estimate than
// the fixed one in lib/pressure.mjs.
//
// The usage: Claude Code writes each assistant reply as a transcript line
// `{"type":"assistant","isSidechain":false,"message":{…,"usage":{"input_tokens":…,
// "cache_creation_input_tokens":…,"cache_read_input_tokens":…,…}}}`. The sum of those three is
// what the model was sent on that turn, which is the context size. The newest such line after the
// last compaction marker is used; a sidechain (subagent) reply and a reply whose sum is 0 (a
// synthetic one) are passed over. A line without the cache fields counts `input_tokens` alone.
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
// ever recorded here and the pressure check uses the recorded usage above, or, with none, its fixed
// bytes-per-token estimate. A host
// adapter that does pass `token_count` with a `transcript_path` gets one record per compaction,
// and the median of those replaces the estimate. Median rather than mean: one anomalous
// observation would drag a mean far enough to matter. Machine-wide on purpose: the ratio is a
// property of how transcripts are encoded, not of one session.

import { openSync, readFileSync, readSync, closeSync, fstatSync } from "node:fs";
import { appendBounded } from "./bounded-log.mjs";
import { calibrationPath } from "./paths.mjs";

export const CALIBRATION_MAX_LINES = 200;
const MARKER = Buffer.from('"subtype":"compact_boundary"');
const ASSISTANT = '"type":"assistant"';
const USAGE = '"usage"';

/**
 * `{ bytes, sinceMarker, usageTokens, baselineTokens, epoch, markerAt }` for the transcript at
 * `path`: bytes after the line holding the last compaction marker, or the whole file
 * (`sinceMarker` false); the context size the newest main-thread reply in that span recorded
 * (`usageTokens`) and the oldest one (`baselineTokens`, what the window started at), each null
 * when none did; `epoch`, which compaction window this is (the marker line's `uuid`, else
 * `@<byte offset>` of the marker line, else "start" when there is no marker), and `markerAt`,
 * the marker's `timestamp` in ms (null when there is no marker or it carries none). A transcript
 * is append-only, so a window's epoch does not change when the session is resumed days later.
 * Null when the transcript cannot be read.
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
    if (at < 0) return { bytes: data.length, sinceMarker: false, usageTokens: lastUsage(data, 0), baselineTokens: firstUsage(data, 0), epoch: "start", markerAt: null };
    const sol = data.lastIndexOf(0x0a, at) + 1;
    const eol = data.indexOf(0x0a, at);
    const from = eol < 0 ? data.length : eol + 1;
    const marker = parseLine(data.subarray(sol, eol < 0 ? data.length : eol));
    const stamp = typeof marker?.timestamp === "string" ? Date.parse(marker.timestamp) : NaN;
    return {
      bytes: data.length - from,
      sinceMarker: true,
      usageTokens: lastUsage(data, from),
      baselineTokens: firstUsage(data, from),
      epoch: typeof marker?.uuid === "string" && marker.uuid ? marker.uuid : `@${sol}`,
      markerAt: Number.isFinite(stamp) ? stamp : null,
    };
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

function parseLine(line) {
  try {
    return JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
}

/** The context size a line records when it is a main-thread assistant reply with usage; 0 otherwise. */
function lineUsage(line) {
  if (!line.includes(ASSISTANT) || !line.includes(USAGE)) return 0;
  const rec = parseLine(line);
  if (rec?.type !== "assistant" || rec.isSidechain === true) return 0;
  return usageTokens(rec.message?.usage);
}

/** The context size recorded by the newest main-thread assistant line in `data` at or after `from`; null when none. */
function lastUsage(data, from) {
  let end = data.length;
  while (end > from) {
    const nl = data.lastIndexOf(0x0a, end - 1);
    const start = nl < from ? from : nl + 1;
    const tokens = lineUsage(data.subarray(start, end));
    end = nl < from ? from : nl;
    if (tokens > 0) return tokens;
  }
  return null;
}

/** The context size recorded by the oldest main-thread assistant line in `data` at or after `from`; null when none. */
function firstUsage(data, from) {
  let start = from;
  while (start < data.length) {
    const nl = data.indexOf(0x0a, start);
    const end = nl < 0 ? data.length : nl;
    const tokens = lineUsage(data.subarray(start, end));
    start = end + 1;
    if (tokens > 0) return tokens;
  }
  return null;
}

const count = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** input_tokens + cache_read_input_tokens + cache_creation_input_tokens; an absent cache field counts 0. */
function usageTokens(u) {
  if (!u || typeof u !== "object" || typeof u.input_tokens !== "number") return 0;
  return count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens);
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
