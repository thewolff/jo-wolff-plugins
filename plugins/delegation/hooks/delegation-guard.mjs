#!/usr/bin/env node
// hooks/delegation-guard.mjs — PreToolUse on `Read|Grep|Bash|Agent|Task`: the three
// direct-work nudges, ported from newdle's hooks/delegation-guard.mjs (0.2.175). Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage.
//
// THE CHECKS
//   1. Read of a file over `readLineThreshold` lines (default 1000) with no bounding `limit`
//      → the file belongs with a `reader` subagent. An offset/limit read is judged on what it
//      would read. Inside a `reader` the nudge is circular and is skipped.
//   2. The `streakThreshold`-th (default 6) distinct file or Grep path touched directly since
//      the last subagent spawn → the work belongs with a `builder`. Once per streak; a spawn
//      (`Agent`/`Task`) resets it. Main session only: a subagent has no spawn tool, so the
//      instruction would be unfollowable there.
//   3. A whole-tree search: `find .`/`find /`, a recursive grep/rg with no path, a Grep with no
//      `path` or one that is the cwd → it belongs with a `scout`. Inside a `scout` it is skipped.
//
// HOW IT SPEAKS — config `checks["delegation-guard"]`:
//   "warn"  (default) additionalContext only; the call proceeds. newdle's version answered
//           `ask`, and an `ask` reaches nobody where no human watches (a subagent, `-p`), so
//           the port drops that tier: a nudge that cannot be answered is a deadlock.
//   "block" deny, with the same text plus what to do instead (a bounded slice, a scoped path,
//           a subagent, or carry on and say so).
//   "off"   nothing.
//
// STATE: one append-only JSONL per session at
// `${XDG_STATE_HOME:-~/.local/state}/delegation/guard/<session key>.jsonl` (touch/warned/
// reset events; replayed on each fire, appends are atomic under PIPE_BUF). Files older than a
// day are swept on ~5% of fires. A payload with no session_id and no transcript_path keeps no
// state, so check 2 never fires for it.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows. An unreadable file is not counted (never flagged); a NUL byte in the
// file reads as binary and is not flagged.

import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { loadConfig, stateDir, withFault } from "../lib/config.mjs";
import { commandSurfaces } from "../lib/shell.mjs";

const HOOK = "delegation-guard";
const SPAWN = new Set(["agent", "task"]);
const SHELL = new Set(["bash", "shell"]);
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- answers ----

const warn = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
const deny = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: text } });

/** `mode` is "warn" or "block"; `body` is the finding, `instead` what a blocked caller does next. */
function speak(mode, body, instead) {
  return mode === "block" ? deny(`${body} Refused. ${instead}`) : warn(body);
}

// ---- state ----

function sessionKeyFor(input) {
  if (typeof input.session_id === "string" && input.session_id) return input.session_id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  if (typeof input.transcript_path === "string" && input.transcript_path) return `t-${Buffer.from(input.transcript_path).toString("base64url").slice(0, 120)}`;
  return null;
}

const guardDir = (env) => join(stateDir(env), "guard");
const statePath = (env, key) => join(guardDir(env), `${key}.jsonl`);

function appendEvent(env, key, event) {
  if (!key) return;
  try {
    mkdirSync(guardDir(env), { recursive: true });
    writeFileSync(statePath(env, key), `${JSON.stringify(event)}\n`, { flag: "a" });
  } catch {
    // an unwritable state dir loses the streak, never the call
  }
}

function loadState(env, key) {
  const state = { touched: new Set(), alreadyWarned: false };
  if (!key) return state;
  let lines;
  try {
    lines = readFileSync(statePath(env, key), "utf8").split("\n").filter(Boolean);
  } catch {
    return state;
  }
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "reset") {
      state.touched = new Set();
      state.alreadyWarned = false;
    } else if (e.type === "touch") state.touched.add(e.path);
    else if (e.type === "warned") state.alreadyWarned = true;
  }
  return state;
}

function sweepStale(env, random = Math.random) {
  if (random() >= 0.05) return;
  try {
    const dir = guardDir(env);
    const cutoff = Date.now() - DAY_MS;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        // next pass
      }
    }
  } catch {
    // no dir yet
  }
}

// ---- check 1 ----

/** Lines in a file read in 64 KiB chunks; null for a missing, unreadable or binary (NUL) file. */
export function lineCount(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(64 * 1024);
    let n = 0;
    let sawByte = false;
    let endsWithNewline = false;
    let bytesRead;
    while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
      sawByte = true;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return null;
        if (buf[i] === 10) n++;
      }
      endsWithNewline = buf[bytesRead - 1] === 10;
    }
    if (!sawByte) return 0;
    return endsWithNewline ? n : n + 1;
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

// ---- check 3 ----

// grep/rg flags whose value is a separate token, so it is not counted as a search path.
const GREP_VALUE_FLAGS = new Set([
  "-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context",
  "--include", "--exclude", "--exclude-dir", "--include-dir", "-g", "--glob", "--iglob",
  "-t", "--type", "-T", "--type-not", "--color", "--colour", "--binary-files", "--replace",
]);

function isBroadSearchSegment(cmd) {
  const c = cmd.replace(/\s+/g, " ").trim();
  const maxdepth = c.match(/-maxdepth\s+(\d+)/);
  const shallowFind = maxdepth && Number(maxdepth[1]) <= 2;
  if (/\bfind\s+(\.|\/|~)(\s|$)/.test(c) && !/\bfind\s+\S*\/\S/.test(c) && !shallowFind) return true;
  const gm = c.match(/\b(grep|rg)\b(.*)$/);
  if (!gm) return false;
  const rest = gm[2] || "";
  // `-r`/`-R` anywhere in a short-flag cluster: `-r`, `-nr`, `-rn`, `-rni` (newdle's regex missed `-rn`).
  const recursive = gm[1] === "rg" || /\s-[A-Za-z]*[rR][A-Za-z]*(?=\s|$)/.test(rest) || /--recursive\b/.test(rest);
  if (!recursive) return false;
  const tokens = rest.split(/\s+/).filter(Boolean);
  const positionals = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      if (GREP_VALUE_FLAGS.has(t) && !t.includes("=")) i++;
      continue;
    }
    positionals.push(t);
  }
  if (positionals.length <= 1) return true;
  return positionals.slice(1).every((p) => p === "." || p === "./");
}

/** True when any simple command in `cmd` is a whole-tree search. */
export function isBroadBashSearch(cmd) {
  return commandSurfaces(cmd).some(isBroadSearchSegment);
}

function isUnscopedGrepPath(rawPath, cwd) {
  const p = String(rawPath ?? "").trim();
  if (!p || p === "." || p === "./") return true;
  try {
    return resolve(cwd, p) === resolve(cwd);
  } catch {
    return false;
  }
}

const toPathList = (raw) => (Array.isArray(raw) ? raw.map(String).filter(Boolean) : String(raw ?? "").trim() ? [String(raw).trim()] : []);

// ---- the hook ----

const BUILDER_INSTEAD =
  "The count is the signal and this fires once per streak, so the next call goes through. If you can dispatch a subagent, hand the remaining work to `builder` (which also resets the streak); if you cannot, re-issue this call and say in your report that the delegation nudge could not be answered.";

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  a warn (additionalContext), a deny, a systemMessage, or null
 */
export function handle(input, { env = process.env, random = Math.random } = {}) {
  const { config, fault } = loadConfig(env);
  const mode = config.checks[HOOK];
  if (config.off || mode === "off") return null;
  const done = (out) => withFault(out, fault, HOOK);

  const tool = String(input?.tool_name ?? "");
  const lower = tool.toLowerCase();
  const ti = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const key = sessionKeyFor(input ?? {});
  const agentType = String(input?.agent_type ?? "").split(/[:/]/).pop();
  const inSubagent = Boolean(input?.agent_type || input?.agent_id);

  sweepStale(env, random);

  if (SPAWN.has(lower)) {
    appendEvent(env, key, { type: "reset" });
    return done(null);
  }

  if (SHELL.has(lower)) {
    const cmd = String(ti.command ?? "");
    if (agentType !== "scout" && cmd.trim() && isBroadBashSearch(cmd)) {
      return done(speak(mode,
        `delegation-guard: this looks like a whole-tree search (${cmd.trim().slice(0, 160)}). A search spanning more than one directory belongs with a \`scout\` subagent, which keeps the parent context clean.`,
        "Re-run it scoped to a single directory (a scoped search is not gated), or spawn `scout` for the broad version; if neither is open to you, report that the broad search was refused and what you were looking for."));
    }
    return done(null);
  }

  if (tool === "Read") {
    const rawPath = typeof ti.file_path === "string" ? ti.file_path : "";
    if (!rawPath) return done(null);
    const filePath = resolve(cwd, rawPath);
    const state = loadState(env, key);
    const alreadyTouched = state.touched.has(filePath);
    const hitsThreshold = state.touched.size + 1 >= config.streakThreshold;
    if (!inSubagent && !alreadyTouched) appendEvent(env, key, { type: "touch", path: filePath });

    const n = lineCount(filePath);
    const limit = Number(ti.limit);
    const effective = Number.isFinite(limit) && limit > 0 && n !== null ? Math.min(n, limit) : n;
    if (agentType !== "reader" && effective !== null && effective > config.readLineThreshold) {
      return done(speak(mode,
        `delegation-guard: \`${rawPath}\` is ${n} lines, over the ${config.readLineThreshold}-line threshold. A file this size belongs with a \`reader\` subagent rather than in the parent context, unless this is a single-line lookup.`,
        "Read a bounded slice instead (pass `offset` and `limit`; the threshold is judged on what you read), or spawn `reader` for the whole file; if neither is open to you, report which file you needed and why."));
    }
    if (!inSubagent && !alreadyTouched && hitsThreshold && !state.alreadyWarned) {
      appendEvent(env, key, { type: "warned" });
      const files = [...state.touched, filePath];
      return done(speak(mode,
        `delegation-guard: you have touched ${files.length} distinct files directly this streak (${files.join(", ")}). Work across several files belongs with a \`builder\` subagent (or \`beefy-builder\` for larger work); spawning one resets this count.`,
        BUILDER_INSTEAD));
    }
    return done(null);
  }

  if (tool === "Grep") {
    const rawPaths = toPathList(ti.path ?? ti.paths);
    const unscoped = rawPaths.length === 0 || rawPaths.every((p) => isUnscopedGrepPath(p, cwd));
    if (agentType !== "scout" && unscoped) {
      return done(speak(mode,
        "delegation-guard: this Grep has no subdirectory scoping it, so it searches the whole tree. A multi-directory search belongs with a `scout` subagent.",
        "Re-issue it with a `path` naming a subdirectory (a scoped Grep is not gated), or spawn `scout` for the whole tree; if neither is open to you, report that the unscoped search was refused and what you were looking for."));
    }
    if (!inSubagent) {
      const state = loadState(env, key);
      for (const rawPath of rawPaths) {
        const filePath = resolve(cwd, rawPath);
        if (state.touched.has(filePath)) continue;
        const hitsThreshold = state.touched.size + 1 >= config.streakThreshold;
        state.touched.add(filePath);
        appendEvent(env, key, { type: "touch", path: filePath });
        if (hitsThreshold && !state.alreadyWarned) {
          appendEvent(env, key, { type: "warned" });
          const files = [...state.touched];
          return done(speak(mode,
            `delegation-guard: you have touched ${files.length} distinct paths directly this streak (${files.join(", ")}). Work across several files belongs with a \`builder\` subagent (or \`beefy-builder\` for larger work); spawning one resets this count.`,
            BUILDER_INSTEAD));
        }
      }
    }
    return done(null);
  }

  return done(null);
}

if (invokedDirectly(import.meta.url)) runHook(HOOK, import.meta.url, { plugin: "delegation" });
