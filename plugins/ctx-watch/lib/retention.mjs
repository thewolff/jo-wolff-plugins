// lib/retention.mjs — the bound on what ctx-watch leaves on disk, declared in
// .claude-plugin/plugin.json `state` and run by `tick` (rotation) and `prune` (rotation, then
// the rotated files past their age).
//
// What lives under <state> (`${XDG_STATE_HOME:-~/.local/state}/ctx-watch`):
//
//   state.json                        the episode (one small file, rewritten each tick; kept)
//   state.lock                        held for a few file operations by each state.json writer
//   popups/<token>.json               one popup supervisor's outcome, one small file per popup
//   errors.log                        one line per hook fault or ignored state file (appended)
//   checks.log                        one line per consult-history finding (appended by the Stop hook)
//   resume/<session id>               the SessionStart hook's resume marker, consumed by the next Stop
//   sessions/<session id>.json        the mid-session hook's latch (what this session was told), a few bytes
//   sessions/<session id>.json.lock   held for a few file operations by a hook claiming that latch
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
// prune(dir, { days }) rotates, then removes every `*.1` older than `days`, every
// `popups/<token>.json` older than `days`, every `resume/<id>` marker older than `days` (a
// session that never reached a Stop), every `sessions/<id>.json` latch and `.json.lock` older
// than `days` (a latch is rewritten only when the session is told something, so an old one is a
// session long over; a lock is held for milliseconds, so an old one is a crashed hook's), and
// any `state.json.<pid>.tmp`, `state.lock.<pid>.stale`, `popups/<token>.json.<pid>.tmp` or
// `sessions/<id>.json.<pid>.tmp` a failed write or a crashed lock takeover left behind.
// It never touches state.json, state.lock, the plist, or a current log,
// and never removes:
//   - a `.1` this same prune just rotated: its mtime is the old log's, but a running tick may
//     still hold it open (rotation renames under launchd's descriptor), so `--days 0` keeps it;
//   - the outcome of the popup state.json has pending, however old: the next tick settles it;
//   - a temp file whose `<pid>` is a running process: that write is in flight.
// `dryRun` rotates and removes nothing but plans on the directory as rotation would leave it
// (a `.1` about to be replaced is the fresh rotation, not the old file), so its result is the
// real run's. `{ rotated, removed, removedPaths, bytes, kept, problems }`; prints nothing itself.

import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { LABEL } from "./launchd.mjs";
import { readState, statePath, running } from "./state.mjs";

export const MAX_LOG_BYTES = 256 * 1024;
export const DEFAULT_RETENTION_DAYS = 30;

/** The logs ctx-watch rotates under `dir`. */
export function logFiles(dir, label = LABEL) {
  return [join(dir, "errors.log"), join(dir, "launchd", `${label}.out.log`), join(dir, "launchd", `${label}.err.log`), join(dir, "checks.log")];
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

/** A leftover in <state>: a failed `state.json` write's temp file, or a crashed lock takeover's set-aside lock; `<pid>` is its writer. */
export const TEMP_FILE = /^state\.(?:json\.(\d+)\.tmp|lock\.(\d+)\.stale)$/;
/** In <state>/popups: an outcome (`<token>.json`, group 1) or a failed outcome write's temp file (group 2 its pid). */
export const OUTCOME_FILE = /^([A-Za-z0-9_-]{1,100})\.json(?:\.(\d+)\.tmp)?$/;

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
      if (m) candidates.push({ path: join(dir, name), pid: Number(m[1] ?? m[2]) });
    }
  } catch {
    /* no state directory: nothing to prune */
  }
  // The pending popup's outcome is the next tick's to read; the state file is read quietly (no errors.log line from a prune).
  const current = readState(statePath(undefined, dir), { log: () => {} }).popupPending?.token ?? null;
  try {
    for (const name of readdirSync(join(dir, "popups"))) {
      const m = OUTCOME_FILE.exec(name);
      if (!m) continue;
      if (m[2] !== undefined) candidates.push({ path: join(dir, "popups", name), pid: Number(m[2]) });
      else if (m[1] === current) out.kept++;
      else candidates.push({ path: join(dir, "popups", name), pid: null });
    }
  } catch {
    /* no popup has run */
  }
  try {
    for (const name of readdirSync(join(dir, "resume"))) candidates.push({ path: join(dir, "resume", name), pid: null });
  } catch {
    /* no resume marker has been left */
  }
  try {
    for (const name of readdirSync(join(dir, "sessions"))) {
      const pid = /\.json\.(\d+)\.tmp$/.exec(name)?.[1];
      candidates.push({ path: join(dir, "sessions", name), pid: pid === undefined ? null : Number(pid) });
    }
  } catch {
    /* no session has been told anything */
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
