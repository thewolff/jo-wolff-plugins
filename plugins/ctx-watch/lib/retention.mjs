// lib/retention.mjs — the bound on what ctx-watch leaves on disk, declared in
// .claude-plugin/plugin.json `state` and run by `tick` (rotation) and `prune` (rotation, then
// the rotated files past their age).
//
// What lives under <state> (`${XDG_STATE_HOME:-~/.local/state}/ctx-watch`):
//
//   state.json                        the episode (one small file, rewritten each tick; kept)
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
// `state.json.<pid>.tmp` a failed write left behind. It never touches state.json, the plist,
// or a current log. `{ rotated, removed, bytes, kept }`; prints nothing itself.

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

/**
 * Rotate, then remove rotated logs older than `days` and stray state temp files.
 * `{ rotated, removed, bytes, kept, problems }`. Never throws.
 */
export function prune(dir, { days = DEFAULT_RETENTION_DAYS, now = Date.now(), maxBytes = MAX_LOG_BYTES, label = LABEL, dryRun = false } = {}) {
  const r = rotateLogs(dir, { maxBytes, label, dryRun });
  const out = { rotated: r.rotated, removed: 0, bytes: 0, kept: 0, problems: [...r.problems] };
  const cutoff = now - days * 86_400_000;
  const candidates = [...logFiles(dir, label).map((p) => `${p}.1`)];
  try {
    for (const name of readdirSync(dir)) if (/^state\.json\.\d+\.tmp$/.test(name)) candidates.push(join(dir, name));
  } catch {
    /* no state directory: nothing to prune */
  }
  for (const p of candidates) {
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs >= cutoff) {
      out.kept++;
      continue;
    }
    try {
      if (!dryRun) rmSync(p, { force: true });
      out.removed++;
      out.bytes += st.size;
    } catch (err) {
      out.kept++;
      out.problems.push(`could not remove ${p}: ${err.message}`);
    }
  }
  return out;
}
