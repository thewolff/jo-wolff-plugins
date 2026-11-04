#!/usr/bin/env node
// pattern-check-pretooluse.mjs — Claude Code PreToolUse: count the distinct files a session
// touches through Edit, Write, MultiEdit and NotebookEdit (and the obvious shell writes), and from
// the Nth distinct file on, deny those tools and the Bash commands that would commit or publish
// the work, until the session has a pattern-check receipt.
//
// Claude Code sends every hook `session_id` and `cwd`, and PreToolUse adds `tool_name` and
// `tool_input`; for Edit and Write, `tool_input.file_path` is absolute (hooks reference,
// "Common input fields" and "PreToolUse input"). MultiEdit carries `file_path` (and, in older
// payloads, `edits[].file_path`); NotebookEdit carries `notebook_path`. A deny is exit 0 plus
// {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
// "permissionDecisionReason":...}} on stdout; the reason is shown to Claude.
//
// UNDER N IT NEVER FIRES. Files 1 .. N-1 are counted and allowed. The call that would touch the
// Nth distinct file is denied and not counted (it did not touch the file). A path already in the
// session's list is never a new file: the same file edited twenty times counts once.
//
// THE POINTER. On every call, before anything else can fail, the hook records this session's key
// as the current one for the repository (state.mjs writeCurrent), so the CLI, which runs from the
// Bash tool and never sees session_id, can find the session the agent is in. PreToolUse fires on
// the Bash call that runs the CLI, so the pointer is at most one tool call old.
//
// FAIL OPEN, NOT SILENT. Every path exits 0. The plugin's own faults (a state file that does not
// parse, a config that does not, an unwritable state directory, empty or malformed stdin, a
// thrown error) allow the call, print one {"systemMessage": "pattern-check: ..."} line, which
// Claude Code shows to the user, and append one line to <state dir>/errors.log
// (scripts/lib/hookio.mjs). A missing session_id degrades to a per-cwd key with the same kind of
// warning. The agent's omission (no receipt) is the only thing that denies.
//
// Contract: JSON on stdin (PreToolUse payload). JSON on stdout, or nothing.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordCommand, resolveContext } from "../scripts/lib/context.mjs";
import { runHook } from "../scripts/lib/hookio.mjs";
import { matchDeny, writeTargets } from "../scripts/lib/matchers.mjs";
import { normalizePath, readSession, writeCurrent, writeSession } from "../scripts/lib/state.mjs";

export const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Every file path a file-tool call names, as given: file_path, notebook_path, and MultiEdit's edits[].file_path. */
export function filePathsOf(toolInput) {
  const out = [];
  for (const k of ["file_path", "notebook_path"]) {
    if (typeof toolInput?.[k] === "string" && toolInput[k] !== "") out.push(toolInput[k]);
  }
  if (Array.isArray(toolInput?.edits)) {
    for (const e of toolInput.edits) if (typeof e?.file_path === "string" && e.file_path !== "") out.push(e.file_path);
  }
  return out;
}

/** Is the normalized path `p` at or under the repository root? */
export function insideRoot(p, root) {
  const r = normalizePath(root, root);
  return p === r || p.startsWith(`${r}/`);
}

export function denyReason({ count, threshold, key, env, blocked }) {
  const cmd = recordCommand(key, env);
  return [
    `pattern-check: this session has touched ${count} distinct file${count === 1 ? "" : "s"} and the threshold is ${threshold}, but no pattern-check receipt exists for it.`,
    "Before more writes, answer two questions for each new piece you plan to add: what exists already (the existing pattern in this repository that does its job), and how does it fail (what breaks, what the operator sees, what to do next, whether a rerun is safe, what bounds it, what evidence survives). Load the pattern-check skill for the method, then record the result:",
    `  ${cmd} < table.md`,
    `or, if the work adds no new piece:  ${cmd} --no-new-pieces "<reason>"`,
    `Blocked call: ${blocked}.`,
  ].join("\n");
}

const deny = (reason, warnings) => ({
  ...(warnings.length ? { systemMessage: `pattern-check: ${warnings.join("; ")}` } : {}),
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});
const warn = (warnings) => (warnings.length ? { systemMessage: `pattern-check: ${warnings.join("; ")}` } : null);

/**
 * The hook's output for one payload: the JSON to print, or null for none. Throws are the caller's.
 * @param {object} input the PreToolUse payload
 * @param {{ env?: object, home?: string }} opts
 */
export function handle(input, opts = {}) {
  const ctx = resolveContext(input, opts);
  const { config, base, root, key, env, warnings } = ctx;
  if (!config.hooks.preToolUse) return warn(warnings);
  try { writeCurrent(base, root, key); } catch (e) { warnings.push(`could not record the current session for ${root} (${e.message}); the CLI may need --session ${key}`); }
  if (ctx.receiptExists) return warn(warnings);

  const { session, fault } = readSession(base, key, root);
  if (fault) {
    warnings.push(`${fault}; this call was allowed and the counter starts over`);
  }
  const tool = input?.tool_name;
  const toolInput = input?.tool_input ?? {};
  const known = new Set(session.files);
  const threshold = config.threshold;

  let candidates = [];
  let blocked = null;
  if (FILE_TOOLS.has(tool)) {
    candidates = filePathsOf(toolInput).map((p) => normalizePath(p, ctx.cwd));
    blocked = `${tool} ${candidates[0] ?? "(no file_path)"}`;
  } else if (tool === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    // Only shell writes landing inside the repository count or deny; a redirect into the system
    // temp directory is not the work this check guards.
    candidates = writeTargets(command).map((p) => normalizePath(p, ctx.cwd)).filter((p) => insideRoot(p, root));
    blocked = `Bash ${command.length > 200 ? `${command.slice(0, 200)}…` : command}`;
    // Commit, PR and in-repo write forms are denied once the session is held: it reached the
    // threshold (a file-tool call was denied), or shell writes alone brought the count to it.
    if (session.held || known.size >= threshold) {
      const hit = matchDeny(command, config.denyCommands);
      const isWriteForm = hit && ["redirect", "sed -i", "tee"].includes(hit.name);
      if (hit && (!isWriteForm || candidates.length > 0)) {
        return deny(denyReason({ count: known.size, threshold, key, env, blocked: `${blocked} (matched: ${hit.name})` }), warnings);
      }
    }
  } else {
    return warn(warnings);
  }

  const fresh = [...new Set(candidates)].filter((p) => !known.has(p));
  if (fresh.length === 0) return warn(warnings);
  if (known.size + fresh.length >= threshold) {
    // The Nth distinct file: deny, do not count it, and remember that the session is held so
    // the commit and PR backstop applies even to writes the matchers never see.
    if (!session.held) {
      session.held = true;
      session.repo = root;
      try { writeSession(base, session); } catch (e) { warnings.push(`could not write the state file (${e.message})`); }
    }
    return deny(denyReason({ count: known.size, threshold, key, env, blocked }), warnings);
  }
  session.files = [...known, ...fresh];
  session.repo = root;
  try {
    writeSession(base, session);
  } catch (e) {
    warnings.push(`could not write the state file (${e.message}); this call was allowed and not counted`);
  }
  return warn(warnings);
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) runHook({ file: "pattern-check-pretooluse.mjs", event: "PreToolUse", allowed: "this call was allowed", handle: (input) => handle(input) });
