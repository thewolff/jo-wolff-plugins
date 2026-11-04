// lib/retention.mjs — the bound on what reminders-review leaves on disk, declared in
// .claude-plugin/plugin.json `state` and run by `node scripts/reminders-review.mjs prune`.
//
// What lives under <state> (`${XDG_STATE_HOME:-~/.local/state}/reminders-review`):
//
//   sessions/<session id>.json   the hourly throttle's last check, one tiny file per session
//   errors.log                   one line per hook fault (appended)
//
// prune(dir, { days }) renames errors.log over MAX_LOG_BYTES to errors.log.1, then removes every
// session stamp, errors.log.1 and stray `*.tmp` older than `days`. It never touches the current
// errors.log. Returns `{ rotated, removed, bytes, kept, problems }`; prints nothing; never throws.

import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_LOG_BYTES = 256 * 1024;
export const DEFAULT_RETENTION_DAYS = 30;

const listDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

export function prune(dir, { days = DEFAULT_RETENTION_DAYS, now = Date.now(), maxBytes = MAX_LOG_BYTES, dryRun = false } = {}) {
  const out = { rotated: [], removed: 0, bytes: 0, kept: 0, problems: [] };
  const log = join(dir, "errors.log");
  try {
    if (statSync(log).size > maxBytes) {
      if (!dryRun) renameSync(log, `${log}.1`);
      out.rotated.push(log);
    }
  } catch (err) {
    if (err.code !== "ENOENT") out.problems.push(`could not rotate ${log}: ${err.message}`);
  }
  const sessions = join(dir, "sessions");
  const candidates = [
    `${log}.1`,
    ...listDir(sessions).filter((n) => n.endsWith(".json") || n.endsWith(".tmp")).map((n) => join(sessions, n)),
  ];
  const cutoff = now - days * 86_400_000;
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
