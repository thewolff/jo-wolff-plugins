// transcript.mjs - every read of a Claude Code JSONL transcript the output-types hooks make, bounded.
// Node builtins only. Pure except for the one read in readTail.
//
// WHY BOUNDED
//   A long session's transcript runs to hundreds of MB, and past Node's string limit (about 512 MiB)
//   a whole-file readFileSync(path, "utf8") throws. Only the last TAIL_BYTES are ever read: the
//   current turn, the last assistant text and recent tool calls all sit at the end.
//
// WHAT A TURN IS
//   A user entry opens a turn when it is not harness-injected (isMeta !== true) and its content is a
//   non-empty string, or an array with at least one part that is not a tool_result. The current turn
//   is every entry after the last such entry. On Stop, sidechain entries (isSidechain === true) are
//   dropped first; on SubagentStop nothing is dropped, because every entry of a subagent transcript is
//   a sidechain entry. When the window holds no turn opener and did not start at offset 0, the count
//   is a lower bound (boundaryFound false).
//
// How it fails: a missing or unreadable file is null from readTail and readSession; a torn or
// non-object line is skipped. Nothing here throws on transcript content.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Bytes read from the end of a transcript; the rest of the file is never touched. */
export const TAIL_BYTES = 16 * 1024 * 1024;

/**
 * Tools that dispatch, deliver or keep books rather than check anything: the zero-label rule does
 * not count them as tool calls. A config key, zeroLabelIgnoreTools, replaces the list.
 */
export const DEFAULT_IGNORE_TOOLS = Object.freeze(["Agent", "Task", "SendMessage", "TaskStop", "ToolSearch", "Skill", "TodoWrite", "SubagentHandback"]);

/**
 * The last `maxBytes` of `path` as lines, or null when the file cannot be opened or read. When the
 * read starts past offset 0 the first (partial) line is dropped. `whole` is true when the read
 * started at 0.
 */
export function readTail(path, maxBytes = TAIL_BYTES) {
  if (typeof path !== "string" || !path) return null;
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    return { lines, whole: start === 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** JSON.parse each non-empty line; a torn or non-object line is skipped. */
export function parseEntries(lines) {
  const out = [];
  for (const line of lines ?? []) {
    if (typeof line !== "string" || !line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object" && !Array.isArray(entry)) out.push(entry);
    } catch {
      // a torn line in a JSONL transcript is not this hook's failure
    }
  }
  return out;
}

/**
 * The entries of one transcript, parsed from the tail window, with sidechain entries dropped when
 * `skipSidechain` is true. Null when the file cannot be read.
 */
export function readSession(path, { maxBytes = TAIL_BYTES, skipSidechain = true } = {}) {
  const tail = readTail(path, maxBytes);
  if (!tail) return null;
  let entries = parseEntries(tail.lines);
  if (skipSidechain) entries = entries.filter((e) => e.isSidechain !== true);
  return { entries, whole: tail.whole };
}

const contentOf = (entry) => entry?.message?.content ?? entry?.content;

/** True for a user entry that opens a turn (see WHAT A TURN IS). */
export function isTurnStart(entry) {
  if (!entry || entry.type !== "user" || entry.isMeta === true) return false;
  const content = contentOf(entry);
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((p) => p && typeof p === "object" && p.type !== "tool_result");
}

/** Index of the last turn-opening entry, or -1 when the entries hold none. */
export function turnStartIndex(entries) {
  for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) if (isTurnStart(entries[i])) return i;
  return -1;
}

/** The text of a tool_result part's content: a string, or the text parts of an array joined by newlines. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

// The harness's own marker text at the very start of a tool_result: an interrupt, a rejection, or a
// call cancelled because a parallel sibling failed. Only these exact openings count; a command's own
// output that merely mentions "interrupted" or "cancelled" (say "0 tests cancelled") is output.
const INTERRUPTED = /^(?:\[Request interrupted by user|Interrupted by user|The user doesn't want to (?:proceed|take)|<tool_use_error>Cancell?ed\b)/i;

/** toolUseResult.interrupted when it is a boolean (the structured flag decides); else the harness marker. */
function interruptedOf(contentText, tur) {
  if (tur && typeof tur === "object" && typeof tur.interrupted === "boolean") return tur.interrupted;
  return INTERRUPTED.test(contentText.trimStart());
}

/**
 * Every tool call in `entries`, in order of its tool_use, paired with its result:
 * { id, name, input, at, result: { text, isError, interrupted, exitCode, finalUrl, httpStatus, raw } | null }.
 * A tool_use part repeated across split assistant entries counts once (deduplicated by id). A call
 * whose tool_result is not in `entries` (pending, torn, or past the window) has result null.
 *   text: for Bash, toolUseResult.stdout plus "\n" + stderr when stderr is non-empty (when
 *         toolUseResult is an object with a string stdout), else the tool_result content text; for
 *         WebFetch, toolUseResult.result when it is a string, else the content text.
 *   exitCode: see exitCodeOf: structured metadata, else the start of an error result only; else
 *         null. Claude Code records no code for a Bash call that succeeded.
 *   interrupted: toolUseResult.interrupted when it is a boolean; else true only when the content
 *         opens with the harness's interrupt, rejection or cancellation marker (see INTERRUPTED).
 *   finalUrl: for WebFetch, the redirect target the result names, else toolUseResult.url, else null.
 *         Only inside the "REDIRECT DETECTED" envelope, and only with a 3xx status when one is present.
 *         Claude Code 2.1.318 writes the target as "Redirect URL (from the server's Location header …): <url>"
 *         (captured in test/fixtures/cc-webfetch.jsonl); the bare "Redirect URL: <url>" form also matches.
 *   httpStatus: for WebFetch, toolUseResult.code when it is a number (a 404 arrives with is_error
 *         false and code 404), else null; null for every other tool.
 */
export function toolCallsOf(entries) {
  const calls = [];
  const byId = new Map();
  (entries ?? []).forEach((entry, at) => {
    const content = contentOf(entry);
    if (!Array.isArray(content)) return;
    if (entry.type === "assistant") {
      for (const p of content) {
        if (!p || typeof p !== "object" || p.type !== "tool_use" || typeof p.id !== "string" || byId.has(p.id)) continue;
        const call = { id: p.id, name: String(p.name ?? ""), input: p.input && typeof p.input === "object" ? p.input : {}, at, result: null };
        byId.set(p.id, call);
        calls.push(call);
      }
      return;
    }
    if (entry.type !== "user") return;
    for (const p of content) {
      if (!p || typeof p !== "object" || p.type !== "tool_result") continue;
      const call = byId.get(p.tool_use_id);
      if (!call || call.result) continue;
      call.result = resultOf(call, p, entry.toolUseResult);
    }
  });
  return calls;
}

/**
 * A Bash exit code from structured metadata (an integer toolUseResult.exitCode or .code) when
 * present; else only from the harness's error envelope: an is_error result whose content, or whose
 * string toolUseResult, opens with "Exit code N" ("Error: Exit code N" for the string). A line
 * that looks like one anywhere else is command output. Else null (rendered "unknown").
 */
function exitCodeOf(isError, contentText, tur) {
  if (tur && typeof tur === "object") {
    for (const k of ["exitCode", "code"]) if (Number.isInteger(tur[k])) return tur[k];
  }
  if (!isError) return null;
  const m = /^Exit code (\d+)\b/.exec(contentText) ?? (typeof tur === "string" ? /^Error: Exit code (\d+)\b/.exec(tur) : null);
  return m ? Number(m[1]) : null;
}

function resultOf(call, part, tur) {
  const contentText = resultText(part.content);
  const isError = part.is_error === true;
  let text = contentText;
  let finalUrl = null;
  let httpStatus = null;
  if (call.name === "Bash" && tur && typeof tur === "object" && typeof tur.stdout === "string") {
    text = tur.stdout + (typeof tur.stderr === "string" && tur.stderr ? `\n${tur.stderr}` : "");
  }
  if (call.name === "WebFetch") {
    if (tur && typeof tur === "object" && typeof tur.result === "string") text = tur.result;
    if (tur && typeof tur === "object" && Number.isInteger(tur.code)) httpStatus = tur.code;
    // A redirect target only from the harness's redirect envelope (the result opens with
    // "REDIRECT DETECTED", cc-webfetch.jsonl), and only with a 3xx status when one was captured:
    // a fetched page that quotes a "Redirect URL:" line is page text, not a redirect.
    const envelope = /^\s*REDIRECT DETECTED\b/.test(contentText) && (httpStatus === null || (httpStatus >= 300 && httpStatus < 400));
    const redirect = envelope ? /^\s*Redirect URL\b[^:\n]*:\s*(https?:\/\/\S+)/im.exec(contentText) : null;
    if (redirect) finalUrl = redirect[1];
    else if (tur && typeof tur === "object" && typeof tur.url === "string") finalUrl = tur.url;
  }
  const exitCode = exitCodeOf(isError, contentText, tur);
  const interrupted = interruptedOf(contentText, tur);
  return { text, isError, interrupted, exitCode, finalUrl, httpStatus, raw: part };
}

/**
 * The tool calls of the current turn, ignoring names in `ignore`: { calls, count, boundaryFound }.
 * With no turn opener in the window, the turn is every entry: exact when the window is the whole
 * file, otherwise boundaryFound is false and the count is a lower bound.
 */
export function turnToolCalls(session, { ignore = DEFAULT_IGNORE_TOOLS } = {}) {
  const entries = session?.entries ?? [];
  const start = turnStartIndex(entries);
  const boundaryFound = start >= 0 || session?.whole === true;
  const skip = new Set(ignore ?? []);
  const calls = toolCallsOf(entries.slice(start + 1)).filter((c) => !skip.has(c.name));
  return { calls, count: calls.length, boundaryFound };
}

/** The last assistant text in `entries`; an assistant entry with only tool calls is skipped. "" when none. */
export function lastAssistantText(entries) {
  for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "assistant") continue;
    const content = contentOf(entry);
    if (typeof content === "string" && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text.trim()) return text;
  }
  return "";
}

/** input.message of the last SubagentHandback tool_use after the turn start, or "". */
export function handbackMessage(session) {
  const entries = session?.entries ?? [];
  const after = entries.slice(turnStartIndex(entries) + 1);
  for (let i = after.length - 1; i >= 0; i--) {
    const content = contentOf(after[i]);
    if (after[i]?.type !== "assistant" || !Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const p = content[j];
      if (p && p.type === "tool_use" && p.name === "SubagentHandback" && typeof p.input?.message === "string" && p.input.message.trim()) return p.input.message;
    }
  }
  return "";
}
