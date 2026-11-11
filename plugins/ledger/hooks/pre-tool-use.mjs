#!/usr/bin/env node
// pre-tool-use.mjs — PreToolUse: deny AskUserQuestion while no ledger question is open for
// the folder, deny a Bash `git push` / `gh pr create` while the session has no note or outcome,
// and apply the cross-lab review gate (lib/review.mjs) to `git push` / `gh pr create` /
// `gh pr merge` once the note gate lets the command through.
//
// Input read: tool_name, tool_input.command, session_id, cwd, transcript_path (hooks reference
// § PreToolUse input, § Common input fields); a deny's bounce row keeps the command (or the
// AskUserQuestion input) and the transcript path so it can be reproduced. hooks.json spawns this for AskUserQuestion and Bash only.
//
// Output on deny: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":
// "deny","permissionDecisionReason":"…"}}, exit 0. On pass: nothing. The reason names the
// `ledger ask …` or `ledger note …` that lifts the denial.
//
// Bounce ledger (lib/bounces.mjs): a deny inserts a cc_bounces row (rule, tool, prompt_id when
// the input carries one); a later call in the same session that the same rule lets through marks
// that session's open rows of the rule `satisfied`. Fail-open: a failed bounce write is logged
// and never changes the decision.
//
// Review gate (`review.mode`, user file only): off → nothing; advise → allow, with a notice when
// a published commit has no review or has findings; gate → deny those two. The gate checks the
// commits the command itself publishes (lib/review.mjs operationTargets: the repository `git -C`
// selects, each refspec's source, `gh pr create --head`, the head commit of the pull request
// `gh pr merge` names), not the hook cwd's HEAD. Under `gate`, a command whose text alone shows
// the gate cannot check it is denied (lib/review.mjs commandRefusal): a push from a folder the
// gate cannot follow (a `cd` or `-C` that is a variable, a substitution, `~`, a glob, a brace
// expansion or `cd -`; a literal `cd` to a folder that does not exist; `--git-dir`, `--work-tree`, a `GIT_*` setting, a `-c` that steers the push), and a `git push`
// or `gh pr create` that follows, on the same command line, a git command not known to leave HEAD
// alone (`commit`, `rebase`, `merge`, `pull`, `stash branch`, an alias, …). The reason tells the agent to re-issue the push as its own
// `cd /absolute/path && git push …`. Under `advise` both are a notice. When the refs cannot be
// named for another reason (`--all`, a pattern refspec, a remote that does not answer), the call
// is allowed with a notice. Only a deny writes a `reviewGate` bounce row; any allowed gated command
// marks the session's open `reviewGate` rows satisfied. A deny is only given while the store can
// take the write that lifts it (`review`, `waive`); otherwise the call is allowed with a notice.
// Any fault while deciding (git missing or past its deadline, a query that throws) allows the
// call with one systemMessage line; a cwd outside any repository is not gated.
//
// Plugin gate (lib/plugin-gate.mjs; same mode switch): for a published commit in a repository of
// plugins, every plugin changed since the base needs cc_gate_checks rows for that commit with no
// `fail`; none, or a failure, is a deny naming `gate check` and `review waive` as the ways out;
// a waived commit passes. The commits are resolved once for both gates. Only a deny writes a
// `pluginGate` bounce row; an allowed push marks the session's open ones satisfied.
//
// A push is checked by the note gate, the review gate and the plugin gate together: when more
// than one stops it, one deny lists each as a numbered item and writes each bounce row, so the
// agent fixes everything after one deny instead of meeting the next gate after clearing the first.
//
// Fail open: switch off → nothing; store busy/unavailable → allow with one systemMessage line
// and one errors.log line;
// anything thrown → runHook's systemMessage. Never exit 2.

import { runHook, noticeField, invokedDirectly, logError } from "../lib/failopen.mjs";
import { evaluate, gatedRule, pushOperations } from "../lib/gate.mjs";
import { invocation } from "../lib/inject.mjs";
import { withStore, hookConfig } from "../lib/store.mjs";
import { assertWritable } from "../lib/db.mjs";
import { recordBounce, satisfyBounces } from "../lib/bounces.mjs";
import { reviewDecision, operationTargets, commandRefusal, UnknownTarget } from "../lib/review.mjs";
import { pluginGateDecision } from "../lib/plugin-gate.mjs";

export const REVIEW_PR_SUBCOMMANDS = Object.freeze(["create", "merge"]);

/**
 * The push operations of this input and the commits they publish, resolved once for both the
 * review gate and the plugin gate (a remote that hangs is waited on once): null when the input
 * is no push or the review mode is off; { ops, targets } | { ops, unknown: <message> } (the
 * command's refs cannot be named) | { ops, fault: <message> } (git failed; logged) |
 * { ops, refused: <reason> } (gate mode, and the command text alone cannot be checked). In
 * `advise` mode a chained push keeps its targets and carries `chained: <notice>`.
 */
function pushTargets(input, { store, cwd, env }) {
  const mode = store.config.review?.mode ?? "gate";
  if (mode === "off" || input.tool_name !== "Bash") return null;
  const ops = pushOperations(input.tool_input?.command, REVIEW_PR_SUBCOMMANDS);
  if (!ops.length) return null;
  const refusal = commandRefusal(ops, invocation(), cwd);
  if (refusal && mode === "gate") return { mode, ops, refused: refusal.reason };
  const chained = refusal?.kind === "chained" ? refusal.reason.replace(/^ledger: review gate: /, `ledger: review gate (${mode}): `) : null;
  try {
    return { mode, ops, chained, targets: ops.flatMap((op) => operationTargets(op, cwd, { env })) };
  } catch (err) {
    if (err instanceof UnknownTarget) return { mode, ops, unknown: err.message };
    logError("PreToolUse", `review gate: ${err.message}`, env);
    return { mode, ops, fault: err.message };
  }
}

/** The review gate's answer for this input: null (not gated) | {} (silent allow) | { deny } | { notice }. */
function reviewGate(push, { store, cwd, env }) {
  if (!push) return null;
  try {
    if (push.refused) return { deny: push.refused };
    if (push.fault) return { notice: `ledger: the review gate could not decide (${push.fault}); allowed` };
    if (push.unknown) return { notice: `ledger: the review gate could not tell which commit this command publishes (${push.unknown}); allowed without a review check` };
    const decision = reviewDecision(store.db, push.ops, cwd, push.mode, { cli: invocation(), env, targets: push.targets });
    if (!push.chained || decision.deny) return decision;
    return { ...decision, notice: [decision.notice, push.chained].filter(Boolean).join("\n") };
  } catch (err) {
    logError("PreToolUse", `review gate: ${err.message}`, env);
    return { notice: `ledger: the review gate could not decide (${err.message}); allowed` };
  }
}

/**
 * The plugin gate's answer for this input: null (no push, mode off, or no repository of plugins
 * among the targets) | {} (allow) | { deny } | { notice }. In `advise` mode a deny becomes a
 * notice; a fault is allowed with a notice.
 */
function pluginGate(push, { store, env }) {
  if (!push || push.unknown || push.fault || push.refused) return null;
  try {
    const decision = pluginGateDecision(store.db, push.targets, { cli: invocation() });
    if (decision?.deny && push.mode !== "gate") return { notice: decision.deny.replace(/^ledger: plugin gate: /, `ledger: plugin gate (${push.mode}): `) };
    return decision;
  } catch (err) {
    logError("PreToolUse", `plugin gate: ${err.message}`, env);
    return { notice: `ledger: the plugin gate could not decide (${err.message}); allowed` };
  }
}

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const ready = hookConfig(env, input, "preToolUse");
  if (!ready) return null;
  const { cfg, cwd } = ready;
  return withStore({ env, now, notices: cfg.notices, cwd, cfg, hook: "PreToolUse" }, "the ledger gate is not enforced for this call", (store) => {
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    const promptId = typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : null;
    const verdict = evaluate(input, { db: store.db, config: store.config, cwd, cli: invocation(), sessionId });
    if (!verdict) {
      const rule = gatedRule(input, store.config);
      if (rule) satisfyBounces(store, { sessionId, rules: [rule], now, env, hook: "PreToolUse" });
    }
    // A push is checked by every gate at once, so one deny names everything still missing.
    const push = pushTargets(input, { store, cwd, env });
    const review = reviewGate(push, { store, cwd, env });
    const plugin = pluginGate(push, { store, env });
    if (verdict || review?.deny || plugin?.deny) {
      // A deny tells the agent to run `ask`, `note`, `review` or `waive`, which write. When the
      // store cannot take a write (read-only file, a lock that outlasts busy_timeout) that advice
      // is a dead end, so the gate passes instead; withStore turns the StoreError into the allow
      // shape with one systemMessage.
      assertWritable(store.db, store.dbPath);
      const text = input.tool_name === "Bash" ? input.tool_input?.command : input.tool_name === "AskUserQuestion" ? JSON.stringify(input.tool_input ?? null) : null;
      if (verdict) recordBounce(store, { sessionId, rule: verdict.rule, promptId, tool: input.tool_name ?? null, text, transcriptPath: input.transcript_path, now, env, hook: "PreToolUse" });
      if (review?.deny) recordBounce(store, { sessionId, rule: "reviewGate", promptId, tool: "Bash", text, transcriptPath: input.transcript_path, now, env, hook: "PreToolUse" });
      if (plugin?.deny) recordBounce(store, { sessionId, rule: "pluginGate", promptId, tool: "Bash", text, transcriptPath: input.transcript_path, now, env, hook: "PreToolUse" });
      return {
        ...noticeField(store.notices),
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason(verdict?.reason, review?.deny, plugin?.deny) },
      };
    }
    if (review) satisfyBounces(store, { sessionId, rules: ["reviewGate"], now, env, hook: "PreToolUse" });
    if (plugin) satisfyBounces(store, { sessionId, rules: ["pluginGate"], now, env, hook: "PreToolUse" });
    const notices = [...store.notices, ...[review?.notice, plugin?.notice].filter(Boolean)];
    return notices.length ? noticeField(notices) : null;
  });
}

/** One deny reason: a single gate's own, or each gate's as a numbered list under one `ledger:` line. */
export function denyReason(...reasons) {
  const given = reasons.filter(Boolean);
  if (given.length < 2) return given[0];
  const body = (r) => r.replace(/^ledger: /, "");
  const count = given.length === 2 ? "two things first, and both are" : `${given.length} things first, and all are`;
  return `ledger: this push needs ${count} missing:\n${given.map((r, i) => `${i + 1}. ${body(r)}`).join("\n")}`;
}

if (invokedDirectly(import.meta.url)) {
  runHook("PreToolUse", (input) => handle(input));
}
