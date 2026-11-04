// lib/heartbeat.mjs — the pre-compaction save's liveness log: one record per PreCompact
// invocation, and the only writer/reader pair that agrees about it.
//
// Why it exists: the save it observes once ran in no session for 34 days and nothing said so.
// The post-compaction restore unlinks the snapshot it consumed, so the steady state of a working
// save is "no file", byte-identical to the steady state of a dead one. So the save leaves a
// breadcrumb per invocation, and the liveness line (lib/liveness.mjs) reads it back and states
// the age of the last success, or states that there has never been one.
//
// Not the calibration file: that one's writer returns early unless the payload carries a
// positive `token_count` and a stat-able `transcript_path`, so its absence is ambiguous between
// "never fired" and "fired without those fields". Nothing here gates on a payload field.
//
// Two records per invocation, `started` before the attempt and `ok` or `failed:<reason>` after,
// so an invocation that crashed mid-write is distinguishable from one that never happened.
//
// Fail-quiet: a heartbeat that threw would take down the save it exists to observe.

import { readFileSync } from "node:fs";
import { appendBounded } from "./bounded-log.mjs";
import { heartbeatPath, sanitizeSessionId } from "./paths.mjs";

// Trimmed on write (a rename-swap, lib/bounded-log.mjs) so the reader stays trivial and bounded.
// Two records per compaction means 200 lines is about 100 compactions of history, well past the
// week anyone reasons about.
export const HEARTBEAT_MAX_LINES = 200;

/**
 * Append one record. Fields, all present on every record so the reader never branches on shape:
 * at (ISO), event (hook_event_name as received), trigger ("auto", "manual" or ""), session
 * (sanitised), cwd, outcome ("started", "ok", "failed:<reason>", "skipped:<reason>").
 */
export function recordHeartbeat(fields, env = process.env, now = new Date()) {
  try {
    const record = {
      at: now.toISOString(),
      event: String(fields?.event ?? "(none)"),
      trigger: String(fields?.trigger ?? ""),
      session: sanitizeSessionId(fields?.session),
      cwd: String(fields?.cwd ?? ""),
      outcome: String(fields?.outcome ?? "unknown"),
    };
    appendBounded(heartbeatPath(env), JSON.stringify(record), HEARTBEAT_MAX_LINES);
    return true;
  } catch {
    return false;
  }
}

/** Every parseable record, oldest first. A missing or unparseable file is an empty history, which the reader states as "no record", never as healthy. */
export function readHeartbeat(env = process.env) {
  try {
    return readFileSync(heartbeatPath(env), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((r) => r && typeof r === "object");
  } catch {
    return [];
  }
}
