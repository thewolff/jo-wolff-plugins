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
// while the person is away and removes it on `back`. Present and parsable = away.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { xdgDir } from "./config.mjs";

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
 * Whether the person typed a prompt after `sinceIso`, read from the transcript at `path`: true or
 * false when the file holds `user` entries with timestamps, null when it cannot tell (no path, an
 * unreadable file, or no timestamped `user` entry at all — another harness's format).
 */
export function humanWroteSince(path, sinceIso) {
  const since = Date.parse(sinceIso);
  if (typeof path !== "string" || !path || !Number.isFinite(since)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let sawUser = false;
  for (const line of raw.split("\n")) {
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
    sawUser = true;
    if (at > since && isHumanPrompt(entry)) return true;
  }
  return sawUser ? false : null;
}

/** brb's away.json path for a session (brb's own sessionKey rule: anything outside [A-Za-z0-9._-] is `_`). */
export function brbAwayPath(sessionId, env = process.env, home = homedir()) {
  const s = typeof sessionId === "string" ? sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "_") : "";
  const key = s && s !== "." && s !== ".." ? s.slice(0, 120) : "no-session";
  return join(xdgDir(env, home, "XDG_STATE_HOME", join(".local", "state")), "brb", key, "away.json");
}

/** Whether brb holds this session (its away.json exists and parses). Any error → false. */
export function brbAway(sessionId, env = process.env) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  try {
    const v = JSON.parse(readFileSync(brbAwayPath(sessionId, env, env.HOME || homedir()), "utf8"));
    return Boolean(v && typeof v === "object");
  } catch {
    return false;
  }
}
