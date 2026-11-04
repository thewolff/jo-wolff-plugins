#!/usr/bin/env node
// pre-tool-use.mjs — PreToolUse: deny AskUserQuestion while no ledger question is open for
// the folder, deny a Bash `git push` / `gh pr create` while the session has no note or outcome,
// and apply the cross-lab review gate (lib/review.mjs) to `git push` / `gh pr create` /
// `gh pr merge` once the note gate lets the command through.
//
// Input read: tool_name, tool_input.command, session_id, cwd (hooks reference § PreToolUse
// input, § Common input fields). hooks.json spawns this for AskUserQuestion and Bash only.
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
// `gh pr merge` names), not the hook cwd's HEAD; when the command does not say, the call is
// allowed with a notice. Only a deny writes a `reviewGate` bounce row; any allowed gated command
// marks the session's open `reviewGate` rows satisfied. A deny is only given while the store can
// take the write that lifts it (`review`, `waive`); otherwise the call is allowed with a notice.
// Any fault while deciding (git missing or past its deadline, a query that throws) allows the
// call with one systemMessage line; a cwd outside any repository is not gated.
//
// A push is checked by the note gate and the review gate together: when both stop it, one deny
// lists both as numbered items and writes both bounce rows, so the agent fixes everything after
// one deny instead of meeting the second gate only after clearing the first.
//
// Fail open: switch off → nothing; store busy/unavailable → allow with one systemMessage line;
// anything thrown → runHook's systemMessage. Never exit 2.

import { runHook, noticeField, invokedDirectly, logError } from "../lib/failopen.mjs";
import { evaluate, gatedRule, pushOperations } from "../lib/gate.mjs";
import { invocation } from "../lib/inject.mjs";
import { withStore, hookConfig } from "../lib/store.mjs";
import { assertWritable } from "../lib/db.mjs";
import { recordBounce, satisfyBounces } from "../lib/bounces.mjs";
import { reviewDecision } from "../lib/review.mjs";

export const REVIEW_PR_SUBCOMMANDS = Object.freeze(["create", "merge"]);

/** The review gate's answer for this input: null (not gated) | {} (silent allow) | { deny } | { notice }. */
function reviewGate(input, { store, cwd, env }) {
  const mode = store.config.review?.mode ?? "gate";
  if (mode === "off" || input.tool_name !== "Bash") return null;
  const ops = pushOperations(input.tool_input?.command, REVIEW_PR_SUBCOMMANDS);
  if (!ops.length) return null;
  try {
    return reviewDecision(store.db, ops, cwd, mode, { cli: invocation(), env });
  } catch (err) {
    logError("PreToolUse", `review gate: ${err.message}`, env);
    return { notice: `ledger: the review gate could not decide (${err.message}); allowed` };
  }
}

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const ready = hookConfig(env, input, "preToolUse");
  if (!ready) return null;
  const { cfg, cwd } = ready;
  return withStore({ env, now, notices: cfg.notices, cwd, cfg }, "the ledger gate is not enforced for this call", (store) => {
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    const promptId = typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : null;
    const verdict = evaluate(input, { db: store.db, config: store.config, cwd, cli: invocation(), sessionId });
    if (!verdict) {
      const rule = gatedRule(input, store.config);
      if (rule) satisfyBounces(store, { sessionId, rules: [rule], now, env, hook: "PreToolUse" });
    }
    // A push is checked by both gates at once, so one deny names everything still missing.
    const review = reviewGate(input, { store, cwd, env });
    if (verdict || review?.deny) {
      // A deny tells the agent to run `ask`, `note`, `review` or `waive`, which write. When the
      // store cannot take a write (read-only file, a lock that outlasts busy_timeout) that advice
      // is a dead end, so the gate passes instead; withStore turns the StoreError into the allow
      // shape with one systemMessage.
      assertWritable(store.db, store.dbPath);
      if (verdict) recordBounce(store, { sessionId, rule: verdict.rule, promptId, tool: input.tool_name ?? null, now, env, hook: "PreToolUse" });
      if (review?.deny) recordBounce(store, { sessionId, rule: "reviewGate", promptId, tool: "Bash", now, env, hook: "PreToolUse" });
      return {
        ...noticeField(store.notices),
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason(verdict?.reason, review?.deny) },
      };
    }
    if (review) satisfyBounces(store, { sessionId, rules: ["reviewGate"], now, env, hook: "PreToolUse" });
    const notices = review?.notice ? [...store.notices, review.notice] : store.notices;
    return notices.length ? noticeField(notices) : null;
  });
}

/** One deny reason: either gate's own, or both as a numbered list under one `ledger:` line. */
export function denyReason(noteReason, reviewReason) {
  if (!noteReason || !reviewReason) return noteReason ?? reviewReason;
  const body = (r) => r.replace(/^ledger: /, "");
  return `ledger: this push needs two things first, and both are missing:\n1. ${body(noteReason)}\n2. ${body(reviewReason)}`;
}

if (invokedDirectly(import.meta.url)) {
  runHook("PreToolUse", (input) => handle(input));
}
