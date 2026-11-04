// lib/consult-history.mjs — the `consult-history` Stop check: a session that picks a thread back
// up without asking ctx what the thread was.
//
// Two triggers, both a deterministic scan of the Claude Code transcript (no judge):
//
//   resume   the first Stop after a SessionStart whose `source` was `resume`, `compact` or
//            `fork` (the SessionStart hook leaves a marker, <state>/resume/<session id>, holding
//            the time the hook started; this check consumes it whether or not it fires), when no
//            entry since that time is a ctx history call;
//   phrase   the final assistant message says "we spoke previously", "earlier you said" or "as
//            discussed" (PHRASES, whole words, any case) and no entry of this turn (since the
//            last user prompt) is a ctx history call.
//
// A ctx history call is a tool_use whose name is the ctx MCP server's search, show_session or
// show_event (Claude Code 2.1.300 and 2.1.317 transcripts under ~/.claude/projects write the
// name as `mcp__ctx__search`: `mcp__<server>__<tool>`, two underscores each; the single-
// underscore shape `mcp__ctx_search` is matched as well), or a Bash tool_use whose command runs
// `ctx search`, `ctx show session` or `ctx show event` (the shell CLI counts: the ctx-first
// guard tells agents to run exactly that).
//
// The message: `resumed without consulting history — \`ctx search '<topic>'\`` where <topic>
// is the first six words of the first user prompt of the window scanned (the prompt that
// resumed the thread; for the phrase trigger, this turn's prompt), single-quoted for the shell.
// A window with no prompt takes the last prompt before it (what the thread was about); a
// transcript with no prompt at all gets a bare `ctx search`, and the message says so.
//
// The switch: ~/.claude/ctx-watch.json `{"checks": {"consult-history": "off" | "warn" | "block"}}`,
// default warn; the flag file ~/.claude/.ctx-watch-off (existence, checked per run) is off
// whatever the file says. A config file that is not JSON, not an object, or names a mode that is
// not one of the three is a fault (one errors.log line) and the default applies.
//
// What the scan reads: entries of `type` user or assistant with `message.content` a string or an
// array of parts; `isSidechain: true` (a subagent's entries in the same file, older Claude Code)
// and `isMeta: true` (the host's own injected user entries) are skipped; a user entry whose parts
// are all tool_result is a tool result, not a prompt; a line that is not JSON is skipped (a torn
// line in a live transcript is not this check's failure). Entries carry `timestamp` (ISO); one
// without is inside every window (the scan errs toward reading it). `last_assistant_message` in
// the payload, when a non-empty string, is the final message; else the transcript's last
// assistant entry with text.
//
// OMP: this plugin ships no OMP adapter and OMP does not run hooks/hooks.json (see
// plugins/i-have-audhd/omp/i-have-audhd-omp.ts, which exists for that reason), so in 0.2.0 this
// check runs under Claude Code only. What an OMP adapter would need is in the README.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CHECK = "consult-history";
export const MODES = Object.freeze(["off", "warn", "block"]);
export const DEFAULT_MODE = "warn";
export const PHRASES = Object.freeze(["we spoke previously", "earlier you said", "as discussed"]);
export const TOPIC_WORDS = 6;
/** The ctx MCP tool names that consult history: `mcp__ctx__search` (what Claude Code writes) or `mcp__ctx_search`. */
export const CTX_TOOL = /^mcp__ctx_{1,2}(?:search|show_session|show_event)$/;
/** A Bash command that consults history through the ctx CLI. */
export const CTX_SHELL = /(?:^|[\s;&|(`])ctx\s+(?:search|show\s+(?:session|event))\b/;
const PHRASE_RE = new RegExp(`\\b(?:${PHRASES.map((p) => p.replace(/\s+/g, "\\s+")).join("|")})\\b`, "i");

const claudeDir = (env) => join(env.HOME || homedir(), ".claude");
/** `~/.claude/ctx-watch.json`. */
export const configPath = (env = process.env) => join(claudeDir(env), "ctx-watch.json");
/** `~/.claude/.ctx-watch-off`: present means the consult-history Stop check is off. The SessionStart line and the launchd timer do not read it. */
export const flagPath = (env = process.env) => join(claudeDir(env), ".ctx-watch-off");

/**
 * The check's mode: the flag file wins (`off`), then `checks["consult-history"]` of the config
 * file, then the default. `{ mode, fault }`: `fault` names a config file that could not be used
 * (the default applied), for errors.log.
 */
export function readMode(env = process.env, { exists = existsSync, read = readFileSync } = {}) {
  if (exists(flagPath(env))) return { mode: "off", fault: null, source: "flag" };
  const path = configPath(env);
  if (!exists(path)) return { mode: DEFAULT_MODE, fault: null, source: "default" };
  let text;
  try {
    text = read(path, "utf8");
  } catch (err) {
    return { mode: DEFAULT_MODE, fault: `${path} could not be read (${err.message}); ${CHECK} runs as ${DEFAULT_MODE}`, source: "default" };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { mode: DEFAULT_MODE, fault: `${path} is not JSON (${err.message}); ${CHECK} runs as ${DEFAULT_MODE}`, source: "default" };
  }
  const checks = json && typeof json === "object" && !Array.isArray(json) ? json.checks : undefined;
  if (checks === undefined) return { mode: DEFAULT_MODE, fault: null, source: "default" };
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) return { mode: DEFAULT_MODE, fault: `${path}: "checks" is not an object; ${CHECK} runs as ${DEFAULT_MODE}`, source: "default" };
  const mode = checks[CHECK];
  if (mode === undefined) return { mode: DEFAULT_MODE, fault: null, source: "default" };
  if (!MODES.includes(mode)) return { mode: DEFAULT_MODE, fault: `${path}: checks.${CHECK} is ${JSON.stringify(mode)}, not one of ${MODES.join(", ")}; it runs as ${DEFAULT_MODE}`, source: "default" };
  return { mode, fault: null, source: "config" };
}

const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
/** `<state>/resume/<session id>`: the marker the SessionStart hook leaves on a resume, compact or fork. */
export const resumeMarkerPath = (dir, sessionId) => join(dir, "resume", safeId(sessionId));
/** A SessionStart `source` that picks a thread back up: a resume, a compaction, or a fork (a resumed thread under a new session id). */
export const isResume = (source) => source === "resume" || source === "compact" || source === "fork";

/** Leave the marker holding `at` (ms). Returns null, or the error. */
export function markResumed(dir, sessionId, at) {
  try {
    mkdirSync(join(dir, "resume"), { recursive: true });
    writeFileSync(resumeMarkerPath(dir, sessionId), `${new Date(at).toISOString()}\n`);
    return null;
  } catch (err) {
    return err;
  }
}

/** Read and remove the marker: its time (ms) or null when there is none; `{ at, error }`. */
export function consumeResumeMarker(dir, sessionId) {
  const path = resumeMarkerPath(dir, sessionId);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { at: null, error: null };
  }
  let error = null;
  try {
    rmSync(path, { force: true });
  } catch (err) {
    error = err;
  }
  const at = Date.parse(text.trim());
  return { at: Number.isFinite(at) ? at : 0, error };
}

/** The transcript's entries, in order; lines that are not JSON objects are skipped. */
export function readTranscript(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object" && !Array.isArray(e)) out.push(e);
    } catch {
      /* a torn line */
    }
  }
  return out;
}

const parts = (e) => {
  const c = e.message?.content ?? e.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c.filter((p) => p && typeof p === "object") : [];
};
const textOf = (e) =>
  parts(e)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
const timeOf = (e) => {
  const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : typeof e.timestamp === "number" ? e.timestamp : NaN;
  return Number.isFinite(t) ? t : null;
};
const skipped = (e) => e.isSidechain === true || e.isMeta === true;
/** A user entry that is a prompt (text, not only tool results). */
export const isPrompt = (e) => e.type === "user" && !skipped(e) && parts(e).some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim()) && !parts(e).some((p) => p.type === "tool_result");
/** True when the entry holds a ctx history call (MCP tool or the CLI through Bash). */
export function isCtxCall(e) {
  if (e.type !== "assistant" || skipped(e)) return false;
  return parts(e).some((p) => {
    if (p.type !== "tool_use" || typeof p.name !== "string") return false;
    if (CTX_TOOL.test(p.name)) return true;
    return p.name === "Bash" && typeof p.input?.command === "string" && CTX_SHELL.test(p.input.command);
  });
}

/** The final assistant text: the payload's, else the transcript's last assistant entry with text. */
export function finalText(payload, entries) {
  if (typeof payload?.last_assistant_message === "string" && payload.last_assistant_message.trim()) return payload.last_assistant_message;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "assistant" || skipped(e)) continue;
    const t = textOf(e);
    if (t.trim()) return t;
  }
  return "";
}

/** The first `TOPIC_WORDS` words of a prompt, one line, for `ctx search '<topic>'`. */
export function topicOf(prompt) {
  return String(prompt ?? "")
    .replace(/<[^>\n]{1,80}>/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TOPIC_WORDS)
    .join(" ")
    .slice(0, 120);
}
/** `'…'` with any `'` inside closed, escaped and reopened. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** The entries at or after `sinceMs` (an entry with no timestamp is inside). */
const since = (entries, sinceMs) => entries.filter((e) => sinceMs === null || timeOf(e) === null || timeOf(e) >= sinceMs);

/**
 * The verdict: `null`, or `{ trigger: "resume" | "phrase", topic, head, command, message }`
 * (`message` is `<head> — \`<command>\``). `resumedAt` is the consumed marker's time (ms) or
 * null; `text` the final message.
 */
export function finding({ entries, resumedAt, text }) {
  const say = (trigger, window, before) => {
    const prompt = window.find(isPrompt) ?? before.findLast(isPrompt);
    const topic = topicOf(prompt ? textOf(prompt) : "");
    const head = trigger === "resume" ? "resumed without consulting history" : `said ${JSON.stringify(trigger)} without consulting history`;
    const command = topic ? `ctx search ${shellQuote(topic)}` : "ctx search";
    const message = topic ? `${head} — \`${command}\`` : `${head} — \`${command}\` (the transcript has no prompt to take a topic from: add one)`;
    return { trigger: trigger === "resume" ? "resume" : "phrase", topic: topic || null, head, command, message };
  };
  if (resumedAt !== null) {
    const window = since(entries, resumedAt);
    const inside = new Set(window);
    if (!window.some(isCtxCall)) return say("resume", window, entries.filter((e) => !inside.has(e)));
  }
  const m = PHRASE_RE.exec(text);
  if (m) {
    let start = entries.length;
    while (start > 0 && !isPrompt(entries[start - 1])) start--;
    const turn = entries.slice(Math.max(0, start - 1));
    if (!turn.some(isCtxCall)) return say(m[0].toLowerCase().replace(/\s+/g, " "), turn, entries.slice(0, Math.max(0, start - 1)));
  }
  return null;
}

/** The last line of a block reason: how to turn it down. */
export const wayOut = () => `Way out: \`touch ~/.claude/.ctx-watch-off\`, or {"checks": {"${CHECK}": "warn"}} in ~/.claude/ctx-watch.json.`;
