#!/usr/bin/env node
// post-tool-use.mjs — PostToolUse and PostToolUseFailure on Bash: when the command ran
// `git commit`, record the branch it committed to as owed work until it lands (lib/branches.mjs).
// Both events, because a line such as `git commit … && npm test` that fails after committing
// reaches PostToolUseFailure; a commit that did not happen leaves nothing unlanded, so nothing
// is recorded.
//
// Input read: tool_name, tool_input.command, tool_response (stdout, stderr) or error, session_id,
// cwd, agent_type (hooks reference
// § PostToolUse input, § Common input fields; agent_type is present inside a subagent).
//
// Hot path: every Bash call reaches this script, so the command text is matched for `git` and
// `commit` before the config is read or the store opened; git runs only for a commit.
//
// Output: nothing. Fail open: switch off (`hooks.postToolUse`, `branches.enabled`) → nothing;
// store busy or unavailable → one systemMessage line and one errors.log line; a git fault (git
// missing, a timeout) → one errors.log line, nothing recorded; anything thrown → runHook's
// systemMessage. Never exit 2.

import { runHook, invokedDirectly, logError } from "../lib/failopen.mjs";
import { withStore, hookConfig } from "../lib/store.mjs";
import { transaction } from "../lib/db.mjs";
import { commitDirs, inspectCommit, mayCommit, recordBranch, BRANCH_BY } from "../lib/branches.mjs";
import { nowIso } from "../lib/time.mjs";

/**
 * The text the command printed, where `git commit` writes its `[<branch> <sha>]` line: Bash's
 * tool_response stdout and stderr (or the response itself when it is a string), and on
 * PostToolUseFailure the `error` text.
 */
export function commandOutput(input) {
  const r = input.tool_response;
  const parts = typeof r === "string" ? [r] : r && typeof r === "object" ? [r.stdout, r.stderr, r.output] : [];
  if (typeof input.error === "string") parts.push(input.error);
  return parts.filter((p) => typeof p === "string").join("\n");
}

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  if (input.tool_name !== "Bash" || !mayCommit(input.tool_input?.command)) return null;
  const ready = hookConfig(env, input, "postToolUse");
  if (!ready || ready.cfg.config.branches?.enabled === false) return null;
  const { cfg, cwd } = ready;
  const dirs = commitDirs(input.tool_input.command, cwd);
  if (!dirs.length) return null;
  const hook = input.hook_event_name === "PostToolUseFailure" ? "PostToolUseFailure" : "PostToolUse";
  const output = commandOutput(input);
  const seen = [];
  for (const dir of dirs) {
    try {
      for (const s of inspectCommit(dir, output)) if (!seen.some((x) => x.gitDir === s.gitDir && x.branch === s.branch)) seen.push(s);
    } catch (err) {
      logError(hook, `branch check in ${dir}: ${err.message}`, env);
    }
  }
  if (!seen.some((s) => s.status.state === "unpushed" || s.status.state === "pushed")) return null;
  return withStore({ env, now, notices: cfg.notices, cwd, cfg, hook }, "the commit's branch was not recorded", (store) => {
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    const agent = typeof input.agent_type === "string" && input.agent_type ? ` (subagent ${input.agent_type})` : "";
    const iso = nowIso(now);
    transaction(store.db, () => {
      for (const s of seen) recordBranch(store.db, s, { cwd, sessionId, by: `${BRANCH_BY}${agent}`, iso, now });
    }, store.dbPath);
    return store.notices.length ? { systemMessage: store.notices.join("\n") } : null;
  });
}

if (invokedDirectly(import.meta.url)) {
  runHook("PostToolUse", (input) => handle(input));
}
