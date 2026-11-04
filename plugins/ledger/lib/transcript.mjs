// transcript.mjs — what ledger reads from a Claude Code session transcript (the JSONL file a hook
// input names as transcript_path), and whether brb holds the session. Read-only, never throws.
//
// "The human wrote" is decided here and only here (0.3.8, #340). Claude Code writes many `user`
// entries the person never typed: tool results, a subagent's `<task-notification>`, a
// `<system-reminder>`, another session's `<agent-message …>`, local command output, the Stop
// hook's own feedback, a subagent hand-back. isHumanPrompt keeps only a typed prompt:
//
//   - a `user` entry, not a sidechain, not `isMeta` (the harness's own lines);
//   - not only tool results;
//   - when the entry carries `origin.kind` (newer Claude Code stamps it on what it injects:
//     `task-notification`, `peer`, `coordinator`), that kind is `human`;
//   - otherwise its text, after any leading `<system-reminder>…</system-reminder>` blocks (a real
//     prompt can carry one), is non-empty and does not start with one of NOT_HUMAN.
//
// brbAway: brb (a sibling plugin) writes ${XDG_STATE_HOME:-~/.local/state}/brb/<session>/away.json
// while the person is away and removes it on `back`. Away = that file is a regular file (not a
// symlink) of at most 64 KiB holding an object with a string `since`: brb's own readAway rule
// (plugins/brb/lib/state.mjs). The path follows brb's stateRoot too: any non-blank XDG_STATE_HOME,
// relative or not, else ~/.local/state.
//
// Both readers are bounded: a symlink or non-regular file is not read, away.json is read only up
// to 64 KiB, and the transcript only in its last 4 MiB, scanned from the end.

import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AWAY_MAX_BYTES = 64 * 1024;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The text of a regular file at `path`, or null (missing, a symlink, not a regular file, an
 * error). `tail` false: the whole file, null when it is larger than `max`. `tail` true: its last
 * `max` bytes, without the partial first line when the read starts mid-file.
 */
function readBounded(path, max, tail) {
  let fd;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, "r");
    const st = fstatSync(fd);
    if (!st.isFile() || (!tail && st.size > max)) return null;
    const len = Math.min(st.size, max);
    const start = st.size - len;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (!n) break;
      got += n;
    }
    const text = buf.toString("utf8", 0, got);
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl < 0 ? "" : text.slice(nl + 1);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export const NOT_HUMAN = [
  "<task-notification>",
  "<system-reminder>",
  "<agent-message",
  "<local-command-stdout>",
  "<local-command-caller>",
  "Another Claude session sent a message:",
  "Stop hook feedback:",
  "[Subagent hand-back]",
];

const LEADING_REMINDER = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>/;

const blocks = (entry) => {
  const c = entry?.message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c.filter((b) => b && typeof b === "object") : [];
};

/** Whether one transcript entry is a prompt the person typed (see the header). */
export function isHumanPrompt(entry) {
  if (!entry || typeof entry !== "object" || entry.type !== "user") return false;
  if (entry.isSidechain === true || entry.isMeta === true) return false;
  const parts = blocks(entry);
  let text = parts
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  if (!text.trim() && parts.some((b) => b.type === "tool_result")) return false;
  const kind = entry.origin && typeof entry.origin === "object" ? entry.origin.kind : undefined;
  if (kind !== undefined) return kind === "human";
  while (LEADING_REMINDER.test(text)) text = text.replace(LEADING_REMINDER, "");
  text = text.trimStart();
  if (!text) return false;
  return !NOT_HUMAN.some((p) => text.startsWith(p));
}

/**
 * Whether the person typed a prompt after `sinceIso`, read from the last 4 MiB of the transcript
 * at `path`, newest entry first: true or false when the file holds `user` entries with
 * timestamps, null when it cannot tell (no path, an unreadable, symlinked or non-regular file, or
 * no timestamped `user` entry at all — another harness's format). Only true is evidence that the
 * person wrote; the Stop hook reads null as "no evidence", never as "yes".
 */
export function humanWroteSince(path, sinceIso) {
  const since = Date.parse(sinceIso);
  if (typeof path !== "string" || !path || !Number.isFinite(since)) return null;
  const raw = readBounded(path, TRANSCRIPT_TAIL_BYTES, true);
  if (raw === null) return null;
  const lines = raw.split("\n");
  let sawUser = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"user"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "user") continue;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    // Entries are appended in time order: the first user entry at or before `since` ends the scan.
    if (at <= since) return false;
    if (isHumanPrompt(entry)) return true;
    sawUser = true;
  }
  return sawUser ? false : null;
}

/** brb's away.json path for a session: brb's stateRoot and sessionKey rules (see the header). */
export function brbAwayPath(sessionId, env = process.env, home = env.HOME || homedir()) {
  const s = typeof sessionId === "string" ? sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "_") : "";
  const key = s && s !== "." && s !== ".." ? s.slice(0, 120) : "no-session";
  const root = env.XDG_STATE_HOME?.trim() ? env.XDG_STATE_HOME : join(home, ".local", "state");
  return join(root, "brb", key, "away.json");
}

/** Whether brb holds this session (see the header for what counts). Any error → false. */
export function brbAway(sessionId, env = process.env) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  const raw = readBounded(brbAwayPath(sessionId, env), AWAY_MAX_BYTES, false);
  if (raw === null) return false;
  try {
    const v = JSON.parse(raw);
    return Boolean(v && typeof v === "object" && typeof v.since === "string");
  } catch {
    return false;
  }
}
