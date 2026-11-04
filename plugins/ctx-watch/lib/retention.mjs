// lib/retention.mjs — the bound on what ctx-watch leaves on disk, declared in
// .claude-plugin/plugin.json `state` and run by `tick` (rotation) and `prune` (rotation, then
// the rotated files past their age).
//
// What lives under <state> (`${XDG_STATE_HOME:-~/.local/state}/ctx-watch`):
//
//   state.json                        the episode (one small file, rewritten each tick; kept)
//   popup.json                        the popup supervisor's last outcome (one small file; kept)
//   errors.log                        one line per hook fault or ignored state file (appended)
//   launchd/<label>.plist             the timer (kept: the person bootstrapped it)
//   launchd/<label>.out.log           launchd appends every tick's summary line here
//   launchd/<label>.err.log           and anything the tick printed on stderr
//
// rotateLogs(dir) renames each log over MAX_LOG_BYTES to `<name>.1` (replacing the last `.1`),
// so a log is at most MAX_LOG_BYTES plus one tick's lines, and the pair at most twice that.
// launchd opens StandardOutPath fresh for each run of the job, so the next tick writes to a new
// file; the tick that rotated finishes its line in the renamed one. errors.log is appended by
// the hook runner with no handle kept open, so it rotates the same way.
//
// prune(dir, { days }) rotates, then removes every `*.1` older than `days` and any
// `state.json.<pid>.tmp` / `popup.json.<pid>.tmp` a failed write left behind. It never touches
// state.json, popup.json, the plist, or a current log, and never removes:
//   - a `.1` this same prune just rotated: its mtime is the old log's, but a running tick may
//     still hold it open (rotation renames under launchd's descriptor), so `--days 0` keeps it;
//   - a temp file whose `<pid>` is a running process: that write is in flight.
// `dryRun` rotates and removes nothing but plans on the directory as rotation would leave it
// (a `.1` about to be replaced is the fresh rotation, not the old file), so its result is the
// real run's. `{ rotated, removed, removedPaths, bytes, kept, problems }`; prints nothing itself.

import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { LABEL } from "./launchd.mjs";

export const MAX_LOG_BYTES = 256 * 1024;
export const DEFAULT_RETENTION_DAYS = 30;

/** The logs ctx-watch rotates under `dir`. */
export function logFiles(dir, label = LABEL) {
  return [join(dir, "errors.log"), join(dir, "launchd", `${label}.out.log`), join(dir, "launchd", `${label}.err.log`)];
}

const sizeOf = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
};

/** Rename each log over `maxBytes` to `<log>.1` (or, `dryRun`, only name it); `{ rotated: [paths], problems: [messages] }`. Never throws. */
export function rotateLogs(dir, { maxBytes = MAX_LOG_BYTES, label = LABEL, dryRun = false } = {}) {
  const rotated = [];
  const problems = [];
  for (const p of logFiles(dir, label)) {
    const size = sizeOf(p);
    if (size === null || size <= maxBytes) continue;
    try {
      if (!dryRun) renameSync(p, `${p}.1`);
      rotated.push(p);
    } catch (err) {
      problems.push(`could not rotate ${p}: ${err.message}`);
    }
  }
  return { rotated, problems };
}

/** A write's temp file: `state.json.<pid>.tmp` (writeState) or `popup.json.<pid>.tmp` (the popup supervisor). */
export const TEMP_FILE = /^(?:state|popup)\.json\.(\d+)\.tmp$/;

/** Whether `pid` names a running process (EPERM: running, someone else's). */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Rotate, then remove rotated logs older than `days` and stray temp files; see the header for
 * what is never removed. `{ rotated, removed, removedPaths, bytes, kept, problems }`. Never throws.
 */
export function prune(dir, { days = DEFAULT_RETENTION_DAYS, now = Date.now(), maxBytes = MAX_LOG_BYTES, label = LABEL, dryRun = false } = {}) {
  const r = rotateLogs(dir, { maxBytes, label, dryRun });
  const out = { rotated: r.rotated, removed: 0, removedPaths: [], bytes: 0, kept: 0, problems: [...r.problems] };
  const cutoff = now - days * 86_400_000;
  // Rotated by this call: kept, whatever its mtime, and (dry run) standing in for the old `.1`.
  const justRotated = new Set(r.rotated.map((p) => `${p}.1`));
  const candidates = logFiles(dir, label).map((p) => ({ path: `${p}.1`, pid: null }));
  try {
    for (const name of readdirSync(dir)) {
      const m = TEMP_FILE.exec(name);
      if (m) candidates.push({ path: join(dir, name), pid: Number(m[1]) });
    }
  } catch {
    /* no state directory: nothing to prune */
  }
  for (const { path, pid } of candidates) {
    if (justRotated.has(path) || (pid !== null && running(pid))) {
      out.kept++;
      continue;
    }
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.mtimeMs >= cutoff) {
      out.kept++;
      continue;
    }
    try {
      if (!dryRun) rmSync(path, { force: true });
      out.removed++;
      out.removedPaths.push(path);
      out.bytes += st.size;
    } catch (err) {
      out.kept++;
      out.problems.push(`could not remove ${path}: ${err.message}`);
    }
  }
  return out;
}
