// stop-core.mjs — what brb does with the agent's final message while Jo is away. One function,
// decideStop(input, deps), shared by hooks/stop.mjs (Claude Code) and, through that hook, by
// omp/brb-omp.ts (OMP spawns the hook with BRB_HARNESS=omp).
//
// HOME (no away.json for the session): null. The hook prints nothing and the stop proceeds.
//
// AWAY, in this order:
//   1. Read the message (lib/sections.mjs): the Needs-you lines, the on-fire lines, the closing
//      ask, an `idle:` line near the end. Held lines already seen this hold are dropped (the
//      agent restates an ask after a block; the digest keeps one copy). On-fire lines are
//      dropped only when the previous stop carried the same fire and this stop is its
//      continuation (stop_hook_active): a restatement after a block. A fire that recurs on a
//      later turn surfaces again.
//   2. New on-fire lines are surfaced first, before anything is written, so an unwritable state
//      directory cannot swallow them: a systemMessage (`brb on fire: <text>`), a
//      terminalSequence (OSC 9 desktop notification; left out under BRB_HARNESS=omp, where the
//      adapter notifies), and on macOS a best-effort `osascript -e 'display notification …'`
//      that never fails the hook (BRB_DESKTOP_NOTIFY=off turns it off, which the tests do). Past
//      `onFireCap` fires in one hold, the line still surfaces and the message says the cap is
//      passed. Fires are not written to the digest.
//   3. Tool-less stops: tool calls in the transcript after the previous stop's recorded line
//      are counted (Claude Code `tool_use` blocks in `assistant` rows; OMP `toolCall` blocks in
//      `message` rows with role assistant); none → toolLessStops + 1, some → 0. With no readable
//      transcript, a stop_hook_active stop counts as tool-less (nothing proves a tool ran), and
//      a first stop counts as tool-less when its message equals the previous stop's.
//   4. Let the turn end (no keep-working answer) when: an `idle:` line is among the message's
//      last five non-blank lines; stop_hook_active is true, the message brought nothing new AND
//      the stop was tool-less (the guard against a loop that will never resolve; a working
//      agent with nothing new is sent back to work); or toolLessStops reached `idleStops`
//      (default 2). Otherwise keep it working with keepWorkingReason(held): on Claude Code as
//      `hookSpecificOutput.additionalContext` (Stop hook feedback, same loop protections as a
//      block, not shown as a hook error); under BRB_HARNESS=omp as `decision: "block"`, the
//      shape OMP's session_stop takes.
//   5. Write: re-read away.json first; a hold that `back` ended while this stop ran is left
//      ended (only the fire output returns). New held lines go to the digest, then away.json.
//      A write that throws is one errors.log line and a systemMessage beside any fire; the stop
//      then proceeds with no keep-working answer.
//
// The 8-continuation cap Claude Code applies resets on each tool call (hooks reference, Stop
// input), so a working agent is never cut off by it; OMP has no cap on explicit blocks, which is
// why the release conditions exist.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { splitNeedsYou, normalizeLine, fireText } from "./sections.mjs";
import { loadConfig, readAway, writeAway, appendDigest } from "./state.mjs";
import { keepWorkingReason } from "./text.mjs";
import { logError } from "./hook-runner.mjs";

const SEEN_CAP = 500;
const OSC_TEXT_CAP = 200;

/** `{ count, lines }` of assistant tool calls (Claude Code `tool_use`, OMP `toolCall`) in the transcript from line `fromLine` on; null when unreadable. */
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
    const assistant = row?.type === "assistant" || (row?.type === "message" && row?.message?.role === "assistant");
    if (!assistant || !Array.isArray(content)) continue;
    for (const part of content) if (part && typeof part === "object" && (part.type === "tool_use" || part.type === "toolCall")) count++;
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
  const continuing = input?.stop_hook_active === true;
  const prev = away.lastStop;

  // 1. What is new in this message.
  const fires = parts.onFire.map((line) => ({ line, key: normalizeLine(fireText(line) ?? line) }));
  const restated = new Set(continuing && Array.isArray(prev?.fires) ? prev.fires : []);
  const newFire = fires.filter((f) => !restated.has(f.key)).map((f) => f.line);
  const seen = new Set(away.seen);
  const newHeld = [];
  for (const line of parts.held) {
    const key = normalizeLine(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    newHeld.push(line);
  }
  away.seen = [...seen].slice(-SEEN_CAP);
  away.held += newHeld.length;

  // 2. Fires, before any write.
  const out = {};
  if (newFire.length) {
    away.onFire += newFire.length;
    const plain = newFire.map((l) => (fireText(l) ?? l).replace(/\*\*|__/g, "").trim());
    const text = `brb on fire: ${plain.join(" | ")}`;
    const capNote = away.onFire > config.onFireCap ? ` (on-fire cap of ${config.onFireCap} passed this hold: ${away.onFire} so far; check the tagging)` : "";
    out.systemMessage = text + capNote;
    if (env.BRB_HARNESS !== "omp") out.terminalSequence = osc9(text);
    desktopNotify("brb: on fire", plain.join(" | "), { env, platform });
  }
  const say = (line) => {
    out.systemMessage = out.systemMessage ? `${out.systemMessage}\n${line}` : line;
  };

  // 3. Tool-less stops.
  const counted = countToolUses(input?.transcript_path, prev?.line ?? 0);
  const messageHash = hash(message);
  let toolLess;
  let line = prev?.line ?? 0;
  if (counted) {
    toolLess = prev !== null && counted.count === 0;
    line = counted.lines;
  } else {
    toolLess = prev !== null && (continuing || prev.hash === messageHash);
  }
  away.toolLessStops = toolLess ? away.toolLessStops + 1 : 0;
  away.lastStop = { at, line, hash: messageHash, transcript: counted !== null, fires: fires.map((f) => f.key) };

  // 4. Keep working or let the turn end.
  const nothingNew = !newHeld.length && !newFire.length;
  const held = `${away.held} held; type \`back\` to read them`;
  let release = null;
  if (parts.idle !== null) release = `brb: the agent is idle${parts.idle ? ` (${parts.idle})` : ""}; ${held}.`;
  else if (continuing && nothingNew && toolLess) release = "";
  else if (away.toolLessStops >= config.idleStops) release = `brb: ${away.toolLessStops} stops with no tool calls between them; letting the agent stop. ${held}.`;

  // 5. Write, unless `back` ended the hold meanwhile.
  try {
    const current = readAway(sessionId, env);
    if (!current || current.since !== away.since) return Object.keys(out).length ? out : null;
    if (newHeld.length) appendDigest(sessionId, { at, lines: newHeld, closingAsk: parts.closingAsk }, env);
    writeAway(sessionId, away, env);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    logError("brb", "Stop", `could not write state: ${why}`, env);
    say(`brb Stop could not write its state (${why}); this message's asks are not held and the stop proceeds.`);
    return out;
  }
  if (release === null) {
    const reason = keepWorkingReason(away.held);
    if (env.BRB_HARNESS === "omp") {
      out.decision = "block";
      out.reason = reason;
    } else {
      out.hookSpecificOutput = { hookEventName: "Stop", additionalContext: reason };
    }
  } else if (release) {
    say(release);
  }
  return Object.keys(out).length ? out : null;
}
