// stop-core.mjs — what brb does with the agent's final message while Jo is away. One function,
// decideStop(input, deps), shared by hooks/stop.mjs (Claude Code) and, through that hook, by
// omp/brb-omp.ts (OMP spawns the hook with BRB_HARNESS=omp).
//
// HOME (no away.json for the session): null. The hook prints nothing and the stop proceeds.
//
// AWAY, in this order:
//   1. Read the message (lib/sections.mjs): the Needs-you lines, the on-fire lines, the closing
//      ask, a trailing `idle:` line. Lines already seen this hold are dropped (the agent restates
//      an ask after a block; the digest keeps one copy).
//   2. New held lines → one digest entry (timestamp, the lines, the closing ask). New on-fire
//      lines → surfaced at once and NOT written to the digest: a systemMessage, a terminalSequence
//      (OSC 9 desktop notification; left out under BRB_HARNESS=omp, where the adapter notifies),
//      and on macOS a best-effort `osascript -e 'display notification …'` that never fails the
//      hook (BRB_DESKTOP_NOTIFY=off turns it off, which the tests do). Past `onFireCap` fires in
//      one hold, the line still surfaces and the message says the cap is passed.
//   3. Tool-less stops: tool_use blocks in the transcript after the previous stop's recorded line
//      are counted; none → toolLessStops + 1, some → 0. An unreadable transcript falls back to
//      comparing this message with the previous stop's (unchanged → tool-less).
//   4. Let the turn end (no block) when: the message ends with an `idle:` line; stop_hook_active
//      is true and the message brought nothing new (the guard against a loop that will never
//      resolve); or toolLessStops reached `idleStops` (default 2). Otherwise block with
//      keepWorkingReason(held). Every path writes away.json back.
//
// The 8-continuation cap Claude Code applies resets on each tool call (hooks reference, Stop
// input), so a working agent is never cut off by it; OMP has no cap on explicit blocks, which is
// why the three release conditions exist.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { splitNeedsYou, normalizeLine } from "./sections.mjs";
import { loadConfig, readAway, writeAway, appendDigest } from "./state.mjs";
import { keepWorkingReason } from "./text.mjs";

const SEEN_CAP = 500;
const OSC_TEXT_CAP = 200;

/** `{ count, lines }` of assistant tool_use blocks in the transcript from line `fromLine` on; null when unreadable. */
export function countToolUses(transcriptPath, fromLine = 0) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const start = Number.isInteger(fromLine) && fromLine >= 0 && fromLine <= lines.length ? fromLine : 0;
  let count = 0;
  for (let i = start; i < lines.length; i++) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = row?.message?.content;
    if (row?.type !== "assistant" || !Array.isArray(content)) continue;
    for (const part of content) if (part && typeof part === "object" && part.type === "tool_use") count++;
  }
  return { count, lines: lines.length };
}

/** OSC 9 notification: `ESC ] 9 ; text BEL`, control characters dropped, text capped. */
export function osc9(text) {
  const clean = String(text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, OSC_TEXT_CAP);
  return `\u001b]9;${clean}\u0007`;
}

/** The AppleScript for a desktop notification, with the body and title quoted for AppleScript. */
export function appleScript(title, body) {
  const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
  return `display notification "${q(body)}" with title "${q(title)}"`;
}

/** Best-effort macOS notification; never throws, never waits. */
function desktopNotify(title, body, { env, platform }) {
  if (platform !== "darwin" || env.BRB_DESKTOP_NOTIFY === "off") return false;
  try {
    const child = spawn("osascript", ["-e", appleScript(title, body)], { detached: true, stdio: "ignore", env });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const hash = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

/**
 * @param input  the Stop payload: session_id, transcript_path, stop_hook_active, last_assistant_message
 * @param deps   env, now (→ ISO string), platform; all optional
 * @returns the hook's JSON output, or null when home
 */
export function decideStop(input, { env = process.env, now = () => new Date().toISOString(), platform = process.platform } = {}) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  const away = readAway(sessionId, env);
  if (!away) return null;
  const config = loadConfig(env);
  const message = typeof input?.last_assistant_message === "string" ? input.last_assistant_message : "";
  const at = now();
  const parts = splitNeedsYou(message);

  // 1. What is new in this message.
  const seen = new Set(away.seen);
  const fresh = (lines) => {
    const out = [];
    for (const line of lines) {
      const key = normalizeLine(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
  };
  const newFire = fresh(parts.onFire);
  const newHeld = fresh(parts.held);
  away.seen = [...seen].slice(-SEEN_CAP);

  // 2. Digest and fires.
  if (newHeld.length) {
    appendDigest(sessionId, { at, lines: newHeld, closingAsk: parts.closingAsk }, env);
    away.held += newHeld.length;
  }
  const out = {};
  if (newFire.length) {
    away.onFire += newFire.length;
    const plain = newFire.map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__/g, ""));
    const text = `brb on fire: ${plain.join(" | ")}`;
    const capNote = away.onFire > config.onFireCap ? ` (on-fire cap of ${config.onFireCap} passed this hold: ${away.onFire} so far; check the tagging)` : "";
    out.systemMessage = text + capNote;
    if (env.BRB_HARNESS !== "omp") out.terminalSequence = osc9(text);
    desktopNotify("brb: on fire", plain.join(" | "), { env, platform });
  }

  // 3. Tool-less stops.
  const prev = away.lastStop;
  const counted = countToolUses(input?.transcript_path, prev?.line ?? 0);
  const messageHash = hash(message);
  let toolLess;
  let line = prev?.line ?? 0;
  if (counted) {
    toolLess = prev !== null && counted.count === 0;
    line = counted.lines;
  } else {
    toolLess = prev !== null && prev.hash === messageHash;
  }
  away.toolLessStops = toolLess ? away.toolLessStops + 1 : 0;
  away.lastStop = { at, line, hash: messageHash, transcript: counted !== null };

  // 4. Block or let the turn end.
  const nothingNew = !newHeld.length && !newFire.length;
  const held = `${away.held} held; type \`back\` to read them`;
  let release = null;
  if (parts.idle !== null) release = `brb: the agent is idle${parts.idle ? ` (${parts.idle})` : ""}; ${held}.`;
  else if (input?.stop_hook_active === true && nothingNew) release = "";
  else if (away.toolLessStops >= config.idleStops) release = `brb: ${away.toolLessStops} stops with no tool calls between them; letting the agent stop. ${held}.`;
  writeAway(sessionId, away, env);
  if (release === null) {
    out.decision = "block";
    out.reason = keepWorkingReason(away.held);
  } else if (release) {
    out.systemMessage = out.systemMessage ? `${out.systemMessage}\n${release}` : release;
  }
  return Object.keys(out).length ? out : null;
}
