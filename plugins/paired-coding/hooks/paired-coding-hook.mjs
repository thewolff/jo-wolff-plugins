#!/usr/bin/env node
// paired-coding-hook.mjs — the Claude Code adapter's hook side. One entry, five events:
//
//   pre-tool-use        first record every queued turn (see below), then refuse the host's tools
//                       while pairing (permissionDecision "deny", which wins over every other
//                       hook's decision), and bind each call of this plugin's pair_* tools to the
//                       session for the MCP server (binding.mjs).
//   user-prompt-submit  record any turn still queued, then queue this one. Claude Code writes the
//                       transcript entry that says who typed it only after this hook returns, so
//                       the turn is judged and handed to the core at the next PreToolUse (which
//                       always precedes any pair_* call) or at Stop, whichever comes first. A
//                       "pair stop" turn is told here only where the receipt will be if the stop
//                       is accepted; the outcome (accepted and written, accepted but the write
//                       failed, or refused) is a note on the event that judges it when that is a
//                       PreToolUse, else on the next UserPromptSubmit or PreToolUse.
//   stop                record every queued turn. A typed "pair stop" in a turn that made no tool
//                       call ends pairing here, before the next turn's first tool call. Either
//                       way a typed stop writes the pair-accepted receipt beside the journal.
//   session-end         reap pair_run process groups, final snapshot, write the pair-accepted
//                       receipt, go inactive. While pairing,
//                       whatever the reason (/clear, /resume, /branch, quit), first leave a carry
//                       marker for the worktree.
//   session-start       with source "clear", "resume" or "fork" and a live carry marker for this
//                       worktree, or source "fork" from a session that is still pairing, activate
//                       the new session closed (core carryClosed). A "startup" stays inert.
//
// Inert until pair_start: for a session with no activation marker every event exits 0 with no
// output and touches no file, except that a call of this plugin's own pair_* tools is bound and
// a cleared, resumed or forked session's start looks for the session it replaced.
//
// Faults (respond, faultReply): every event exits 0, appends one line to errors.log in the state
// base and prints one warning line. PreToolUse fails closed while pairing and for pair_* tools,
// and never blocks a session that is not pairing.

import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CARRIED_PHRASE, PAIR_TOOLS, isStopPhrase } from "../core/gate.mjs";
import { activated, findRoot, loadState, loadStateReport, logFault as logFaultLine, reasonOf, stateBase, withLock } from "../lib/host-io.mjs";
import { RECEIPT_FILE, carryInto, endSession, pairingCarry, pairingOrUncertain, recordTrustedInput, sessionDirFor, takeCarryMarker, verdict, writeCarryMarker } from "../lib/verbs.mjs";
import { bareToolName, hostAllowFor, writeBinding } from "../server/binding.mjs";

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const HERE = dirname(fileURLToPath(import.meta.url));

/** SessionStart sources that replace an earlier session, and how the closed note names it. */
const CARRY_START = new Map([
  ["clear", "when the conversation was cleared"],
  ["resume", "in the session before this one"],
  ["fork", "in the session this one was forked from"],
]);

/** Read the tail of a file (the newest transcript entries are at the end). */
function readTail(path, bytes = 2 * 1024 * 1024) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Read the head of a file (a forked transcript's copied entries come first). */
function readHead(path, bytes = 1024 * 1024) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(fstatSync(fd).size, bytes));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The session a forked session was forked from, read from its transcript, or null. SessionStart
 * input names no parent; Claude Code stamps each entry it copies into a fork with
 * `forkedFrom: { sessionId, messageUuid }`. Waits briefly in case the copy is still being written.
 * @param {unknown} transcriptPath
 */
export function forkParent(transcriptPath, { waitMs = 1000 } = {}) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return null;
  const end = Date.now() + waitMs;
  for (;;) {
    let text = "";
    try { text = readHead(transcriptPath); } catch { /* not written yet */ }
    for (const line of text.split("\n")) {
      if (!line.includes("forkedFrom")) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const id = e?.forkedFrom?.sessionId ?? e?.forkedFromSessionId;
      if (typeof id === "string" && id !== "") return id;
    }
    if (Date.now() > end) return null;
    sleepSync(50);
  }
}

/**
 * The one session entrypoint whose `sdk` prompts are trusted. Claude Desktop sends what its
 * partner types in the app's composer through the SDK, so Claude Code marks those entries
 * `promptSource: "sdk"`, `origin.kind: "human"` and `entrypoint: "claude-desktop"`. A programmatic
 * `claude -p` or Agent SDK driver writes the same `sdk`/`human` pair but `entrypoint: "sdk-cli"`,
 * so the entrypoint, read from the prompt's own entry, is what tells the two apart.
 */
const DESKTOP_ENTRYPOINT = "claude-desktop";

/**
 * Where a submitted prompt came from, read from the transcript entry Claude Code writes for it.
 * UserPromptSubmit itself carries no source: it also fires for background-task notifications,
 * scheduled (cron) prompts, SDK/`-p` prompts, and messages absorbed into a running turn (those
 * reuse the running turn's prompt_id). Trusted only when exactly one `user` entry carries this
 * prompt_id, its text equals the prompt, its `origin.kind` is `human`, and its `promptSource` is
 * `typed`, or is `sdk` with that same entry's `entrypoint` `claude-desktop` (DESKTOP_ENTRYPOINT).
 * The entry is written after UserPromptSubmit returns, so this runs from the next PreToolUse and
 * waits briefly for it. No such entry, or a missing or other entrypoint on an `sdk` prompt,
 * means untrusted, so a format change fails closed.
 * @param {string} transcriptPath
 * @param {string} promptId
 * @param {string} prompt
 * @returns {{ trusted: boolean, source: string, promptSource?: string, origin?: string, entrypoint?: string }}
 */
export function promptOrigin(transcriptPath, promptId, prompt, { waitMs = 2000 } = {}) {
  if (typeof transcriptPath !== "string" || typeof promptId !== "string" || promptId === "" || typeof prompt !== "string") {
    return { trusted: false, source: "claude:no-prompt-id" };
  }
  const end = Date.now() + waitMs;
  for (;;) {
    const same = [];
    let otherText = false;
    try {
      for (const line of readTail(transcriptPath).split("\n")) {
        if (!line.includes(promptId)) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e?.type !== "user" || e.promptId !== promptId || typeof e.message?.content !== "string") continue;
        if (e.message.content === prompt) same.push(e);
        else otherText = true;
      }
    } catch { /* transcript not written yet */ }
    if (same.length > 0) {
      const entry = same[same.length - 1];
      const promptSource = typeof entry.promptSource === "string" ? entry.promptSource : "unknown";
      const origin = typeof entry.origin?.kind === "string" ? entry.origin.kind : "unknown";
      const entrypoint = typeof entry.entrypoint === "string" ? entry.entrypoint : "unknown";
      const typed = promptSource === "typed" || (promptSource === "sdk" && entrypoint === DESKTOP_ENTRYPOINT);
      const trusted = same.length === 1 && typed && origin === "human";
      return { trusted, source: trusted ? "interactive" : `claude:${promptSource}/${origin}`, promptSource, origin, entrypoint };
    }
    // The running turn's own entry has different text: this message was absorbed mid-turn.
    if (otherText) return { trusted: false, source: "claude:mid-turn" };
    if (Date.now() > end) return { trusted: false, source: "claude:no-transcript-entry" };
    sleepSync(50);
  }
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `paired-coding: ${reason}`,
    },
  };
}

const PENDING = "pending";
const PENDING_FILE = "inputs.jsonl";

/** UserPromptSubmit: queue the turn. Its provenance is not on disk yet. */
export function queueInput(dir, input) {
  const pdir = join(dir, PENDING);
  withLock(pdir, () => {
    const item = {
      promptId: typeof input.prompt_id === "string" ? input.prompt_id : "",
      text: typeof input.prompt === "string" ? input.prompt : "",
      transcriptPath: typeof input.transcript_path === "string" ? input.transcript_path : "",
      at: Date.now(),
    };
    appendFileSync(join(pdir, PENDING_FILE), `${JSON.stringify(item)}\n`, { mode: 0o600 });
  });
}

/**
 * What the agent is told once a queued "pair stop" turn has been judged (stopOutcome): the
 * receipt the gate wrote, or that none was. `r` is recordTrustedInput's result for that turn.
 */
export function stopOutcome(r, dir) {
  const path = join(dir, RECEIPT_FILE);
  if (r.stopped !== true) return `paired-coding: the "pair stop" turn was not accepted: Claude Code's transcript does not show your partner typed it. Pairing is still on and no receipt was written for it; if ${path} exists it is an older stop's, not this turn's. Name no receipt for this turn.`;
  if (r.receipt) return `paired-coding: pairing has ended: your partner typed pair stop and the gate wrote the pair-accepted receipt to ${r.receipt}. Name that path in your closing summary; it records which change sets your partner agreed to and pair_done closed, and it does not say the code works. The gate no longer refuses host tools; pairing starts again only if your partner asks for it and you call pair_start.`;
  return `paired-coding: pairing has ended: your partner typed pair stop, but the pair-accepted receipt could not be written; the journal records receipt-failed with the reason. No receipt exists for this stop, and if ${path} exists it is an older stop's: say in your closing summary that no receipt was written. The gate no longer refuses host tools.`;
}

/**
 * PreToolUse: judge every queued turn, oldest first, and hand each to the core. Runs before the
 * tool's own verdict, so a turn typed before a card is recorded before that card exists, and a
 * turn typed after it is recorded before pair_begin reaches the server. Claude Code writes a
 * turn's transcript entry only after UserPromptSubmit returns, so any queued entry, older ones
 * included, may still be on its way. The batch shares one deadline: each turn waits only for
 * what is left of `waitMs`, and every turn is read at least once even after it passes.
 * Returns the outcome note (stopOutcome) of every judged turn that was the stop phrase, for the
 * caller to surface on this event or stash for the next (stashNotices).
 */
export function resolvePending(dir, { waitMs = 2000 } = {}) {
  const pdir = join(dir, PENDING);
  const path = join(pdir, PENDING_FILE);
  const notices = [];
  withLock(pdir, () => {
    let lines;
    try {
      lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    } catch {
      return;
    }
    const items = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const deadline = Date.now() + waitMs;
    items.forEach((it) => {
      const o = it
        ? promptOrigin(it.transcriptPath, it.promptId, it.text, { waitMs: Math.max(0, deadline - Date.now()) })
        : { trusted: false, source: "claude:unreadable-queue-entry" };
      const text = typeof it?.text === "string" ? it.text : "";
      const r = recordTrustedInput({
        sessionDir: dir,
        text,
        source: o.source,
        meta: { promptId: it?.promptId, promptSource: o.promptSource, origin: o.origin, entrypoint: o.entrypoint, submittedAt: it?.at },
      });
      // A stop turn judged after pairing already ended (an earlier queued stop took it) gets no note.
      if (isStopPhrase(text) && r.active) notices.push(stopOutcome(r, dir));
    });
    rmSync(path, { force: true });
  });
  return notices;
}

const NOTICES_FILE = "notices.jsonl";

/** Keep outcome notes an event cannot carry (Stop) for the next event that can. */
function stashNotices(dir, notices) {
  if (notices.length === 0) return;
  const pdir = join(dir, PENDING);
  withLock(pdir, () => {
    appendFileSync(join(pdir, NOTICES_FILE), `${notices.map((n) => JSON.stringify(n)).join("\n")}\n`, { mode: 0o600 });
  });
}

/** Take (read and delete) the stashed outcome notes. */
function takeNotices(dir) {
  const pdir = join(dir, PENDING);
  const path = join(pdir, NOTICES_FILE);
  return withLock(pdir, () => {
    let text;
    try { text = readFileSync(path, "utf8"); } catch { return []; }
    rmSync(path, { force: true });
    return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((n) => typeof n === "string");
  });
}

const context = (hookEventName, notes) => ({ hookSpecificOutput: { hookEventName, additionalContext: notes.join("\n") } });

/**
 * The hook's decision for one event. Returns the JSON to print, or null for no output.
 * @param {string} event
 * @param {Record<string, any>} input
 * @param {{ env?: Record<string, string | undefined>, waitMs?: number }} [opts]
 */
export function handle(event, input, opts = {}) {
  const env = opts.env ?? process.env;
  const dir = sessionDirFor(input?.session_id, env);
  if (event === "pre-tool-use") {
    const name = bareToolName(input);
    if (!dir) return PAIR_TOOLS.includes(name) ? deny(`${name} is refused: the session id is unusable, so pairing cannot bind this call; start a new Claude Code session and call ${name} again`) : null;
    // A throw from here on reaches respond(), which fails closed while pairing and open otherwise.
    // A stop judged here (or stashed by an earlier Stop event) is reported alongside this
    // tool's result, or inside the refusal when pairing is still on.
    // The degraded-read fault is taken before queued turns are judged: judging one saves the
    // state, and the saved (still closed) state no longer reads as a fault of this event.
    const on = activated(dir);
    const early = on ? loadStateReport(dir).fault : null;
    const notices = on ? [...takeNotices(dir), ...resolvePending(dir, { waitMs: opts.waitMs })] : [];
    const v = verdict(name, { sessionDir: dir, allow: hostAllowFor(input) });
    const fault = v.degraded ?? early;
    // A state read as degraded (closed) is a fault too: warned and logged once, after the last
    // step that can throw, so the outer catch never logs it a second time.
    const warned = (out) => (fault ? { ...(out ?? {}), systemMessage: degradedWarning(env, event, input, dir, fault) } : out);
    if (!v.allow) return warned(deny([...notices.map((n) => n.replace(/^paired-coding: /, "")), v.reason ?? "refused while pairing"].join(" ")));
    if (PAIR_TOOLS.includes(name)) {
      writeBinding(stateBase(env), input.tool_use_id, {
        sessionId: input.session_id,
        tool: name,
        cwd: input.cwd,
        transcriptPath: input.transcript_path,
      });
    }
    return warned(notices.length ? context("PreToolUse", notices) : null);
  }
  if (event === "session-start") {
    // The session this one replaced was pairing: its end left a carry marker for this worktree
    // (session-end below: /clear, /resume, /branch, or a quit followed by --resume), or this is
    // a fork of a session that is still pairing (the /fork background copy, --fork-session).
    // Either way the new session starts closed instead of inert. A fresh launch ("startup")
    // never takes the marker, so quitting and starting a new conversation stays inert.
    const source = input?.source;
    if (!dir || !CARRY_START.has(source) || typeof input?.cwd !== "string") return null;
    const root = realpathSync.native(findRoot(input.cwd));
    let carry = takeCarryMarker(stateBase(env), root);
    let from = carry?.from ?? null;
    if (!carry && source === "fork") {
      from = forkParent(input.transcript_path, { waitMs: opts.waitMs });
      const parentDir = from && from !== input.session_id ? sessionDirFor(from, env) : null;
      carry = parentDir ? pairingCarry(parentDir) : null;
    }
    if (!carry) return null;
    const r = carryInto({ sessionId: input.session_id, sessionDir: dir, root, exclusions: carry.exclusions ?? undefined, protect: carry.protect ?? [], from, reason: source });
    if (!r.ok) {
      // Refused because this session is already pairing: it is gated already, nothing to say.
      if (activated(dir) && loadState(dir).phase !== "inactive") return null;
      // The session this one replaced was pairing, and this one is not: say so, never silently.
      const reason = `pairing was on ${CARRY_START.get(source)} but could not carry over (${r.reason ?? "no reason given"})`;
      const logged = logFault(env, "session-start", input, reason);
      const warning = `paired-coding: ${reason}, so host write, edit, shell and sub-agent tools are NOT refused in this session. ${logged}`;
      return { systemMessage: warning, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${warning} Tell your partner this in one line before anything else; to pair again, they ask and you call pair_start.` } };
    }
    const note = `paired-coding: pairing was on ${CARRY_START.get(source)}, so ${CARRIED_PHRASE}: this session has no card and no change set, and host write, edit, shell and sub-agent tools are refused. Tell your partner that pairing carried over closed, then wait for their answer. If they want to keep pairing, call pair_start and propose the next card; to end it, they type pair stop. Do not call pair_start before they answer.`;
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } };
  }
  if (!dir || !activated(dir)) return null;
  if (event === "user-prompt-submit") {
    // Turns still queued from earlier (a turn that ended with no tool call) are judged first,
    // and the outcome of any stop among them, or stashed by the Stop event, is reported here.
    // As in PreToolUse: the degraded-read fault is taken before queued turns are judged.
    const early = loadStateReport(dir).fault;
    const notices = [...takeNotices(dir), ...resolvePending(dir, { waitMs: opts.waitMs })];
    const { state, fault: late } = loadStateReport(dir);
    const fault = late ?? early;
    if (state.phase === "inactive") return notices.length ? context("UserPromptSubmit", notices) : null;
    queueInput(dir, input);
    const note = isStopPhrase(input?.prompt)
      ? `paired-coding: this turn asks to end pairing. Whether your partner typed it is decided from Claude Code's transcript at your next tool call or when this turn ends, whichever comes first; it is not decided yet. If the stop is accepted, the gate writes the pair-accepted receipt to ${join(dir, RECEIPT_FILE)} and tells you so in a later note (with your next tool result, or at the start of the next turn); if it is refused, or the receipt cannot be written, a note says that instead. Until that note arrives, your closing summary says the receipt is not yet confirmed and where it will be if the stop is accepted; do not name an older receipt as this one. The receipt records which change sets your partner agreed to and pair_done closed, and it does not say the code works. You cannot end pairing yourself.`
      : state.carried
        ? `paired-coding: ${CARRIED_PHRASE} after a session change. If your partner has not answered yet, tell them pairing carried over closed and wait; call pair_start only once they say to keep pairing. Only your partner ends pairing, by typing pair stop as a whole message.`
        : "paired-coding: pairing is on. Only words from a turn your partner typed at the keyboard can be quoted to pair_begin; whether this turn counts is decided from Claude Code's transcript before your next tool call. Only your partner ends pairing, by typing pair stop as a whole message.";
    const out = context("UserPromptSubmit", [...notices, note]);
    return fault ? { ...out, systemMessage: degradedWarning(env, event, input, dir, fault) } : out;
  }
  if (event === "stop") {
    // The turn ended. A turn with no tool call never reached PreToolUse, so judge its queued
    // input now: a typed stop takes effect before the next turn's first tool call. This event
    // carries no context to the agent without reopening the turn, so a stop's outcome is kept
    // for the next event that does (the next UserPromptSubmit or PreToolUse).
    stashNotices(dir, resolvePending(dir, { waitMs: opts.waitMs }));
    return null;
  }
  if (event === "session-end") {
    // The marker goes first: SessionEnd hooks share a short budget, and a cancelled hook must
    // still leave the next session closed. It is left for every reason, quitting included; only
    // a session that replaces this one (clear, resume, fork) takes it, within its expiry.
    // Reaping and the final snapshot come after.
    const carry = pairingCarry(dir);
    if (carry) writeCarryMarker(stateBase(env), { root: carry.root, from: input.session_id, exclusions: carry.exclusions, protect: carry.protect });
    endSession({ sessionDir: dir });
    return null;
  }
  return null;
}

/** The hook's own file, for errors.log lines that have no deeper frame. */
const HOOK_FILE = "hooks/paired-coding-hook.mjs";

/** The plugin file and line a fault was thrown from, read from its stack, or the hook file. */
function whereOf(err) {
  const plugin = join(HERE, "..");
  const frames = err instanceof Error && typeof err.stack === "string" ? err.stack.split("\n") : [];
  for (const line of frames) {
    const m = /\((?:file:\/\/)?(\/[^)]+?):(\d+):\d+\)$/.exec(line) ?? /at (?:file:\/\/)?(\/\S+?):(\d+):\d+$/.exec(line);
    if (m && m[1].startsWith(plugin)) return `${relative(plugin, m[1])}:${m[2]}`;
  }
  return HOOK_FILE;
}

/** The shared logger, with the hook's file as the default place. */
const logFault = (env, event, input, reason, where = HOOK_FILE) => logFaultLine(env, event, input, reason, where);

/** Whether the session named by `input` is pairing, for a fault path; uncertain reads as pairing. */
function pairingOrUnknown(input, env) {
  let dir;
  try {
    dir = sessionDirFor(input?.session_id, env);
  } catch {
    return true;
  }
  return dir ? pairingOrUncertain(dir) : false;
}

/** One errors.log line and the warning for a session state the gate read as degraded (closed). */
function degradedWarning(env, event, input, dir, reason) {
  const logged = logFault(env, event, input, `session state degraded (${reason}) in ${dir}`);
  return `paired-coding: the session state in ${dir} could not be read as saved (${reason}), so the gate treats pairing as on with the card closed. ${logged} Your partner ends pairing by typing pair stop.`;
}

/**
 * What the hook prints when `handle` throws: one errors.log line and one warning line
 * (systemMessage) for every event. PreToolUse fails closed while the session is pairing, or for
 * this plugin's own pair_* tools, and naming the tool and the way out; otherwise the tool call
 * goes ahead. A session that never paired is never blocked by the gate's own fault.
 */
export function faultReply(event, input, env, err) {
  const reason = reasonOf(err);
  const where = whereOf(err);
  const logged = logFault(env, event, input, reason, where);
  const head = `paired-coding: the ${event || "(no event)"} hook failed at ${where}: ${reason}. ${logged}`;
  if (event === "pre-tool-use") {
    const name = bareToolName(input) || "(unnamed tool)";
    if (PAIR_TOOLS.includes(name) || pairingOrUnknown(input, env)) {
      return {
        systemMessage: `${head} ${name} was refused because the gate fails closed while pairing.`,
        ...deny(`${name} is refused: the gate's hook failed (${reason}) and fails closed while pairing. ${logged} Tell your partner; the way out is for them to type pair stop as a message of its own, and if the gate stays broken, to turn the plugin off with /plugin disable paired-coding.`),
      };
    }
    return { systemMessage: `${head} ${name} went ahead: this session is not pairing, so the gate stays out of the way.` };
  }
  const what = {
    "user-prompt-submit": "This turn was not queued for the typed-input check, so it cannot be quoted to pair_begin or end pairing.",
    stop: "Queued turns were not judged; a typed pair stop in this turn takes effect at the next tool call or turn.",
    "session-end": "The final snapshot, the reap of pair_run processes or the pair-accepted receipt may not have completed; the journal beside the session state says which.",
    "session-start": "If this session replaced one that was pairing, pairing did not carry over and host tools are not refused.",
  }[event] ?? "";
  return { systemMessage: what ? `${head} ${what}` : head };
}

/** `handle`, with every fault turned into faultReply's answer. Never throws. */
export function respond(event, input, opts = {}) {
  const env = opts.env ?? process.env;
  try {
    return handle(event, input, opts);
  } catch (err) {
    return faultReply(event, input, env, err);
  }
}

function main() {
  const event = process.argv[2] ?? "";
  let raw = "";
  let input;
  try {
    raw = readFileSync(0, "utf8");
    input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`stdin is JSON but not an object (${raw.trim().slice(0, 40)})`);
  } catch (err) {
    // No session can be told apart, so nothing is gated: the call goes ahead, loudly.
    const reason = raw.trim() === "" ? "stdin was empty" : `stdin is not a hook event object: ${reasonOf(err)}`;
    const logged = logFault(process.env, event, {}, reason);
    process.stdout.write(JSON.stringify({ systemMessage: `paired-coding: the ${event || "(no event)"} hook could not read its input (${reason}), so it did nothing. ${logged}` }));
    process.exit(0);
  }
  const out = respond(event, input);
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main();
