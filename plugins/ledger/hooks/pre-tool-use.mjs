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
// HEAD has no review or has findings; gate → deny those two. Every deny or allow-with-notice
// writes a `reviewGate` bounce row; an allow without a notice marks the session's open
// `reviewGate` rows satisfied. A cwd that is not a git repository is not gated. Any fault while
// deciding (git missing, a query that throws) allows the call with one systemMessage line.
//
// Fail open: switch off → nothing; store busy/unavailable → allow with one systemMessage line;
// anything thrown → runHook's systemMessage. Never exit 2.

import { runHook, noticeField, invokedDirectly, logError } from "../lib/failopen.mjs";
import { evaluate, gatedRule, isPushCommand } from "../lib/gate.mjs";
import { invocation } from "../lib/inject.mjs";
import { withStore, hookConfig } from "../lib/store.mjs";
import { assertWritable } from "../lib/db.mjs";
import { recordBounce, satisfyBounces } from "../lib/bounces.mjs";
import { gateDecision, gitHead, headState } from "../lib/review.mjs";

export const REVIEW_PR_SUBCOMMANDS = Object.freeze(["create", "merge"]);

/** The review gate's answer for this input: null (not gated or silent allow) | { deny } | { notice }. */
function reviewGate(input, { store, cwd, sessionId, promptId, now, env }) {
  const mode = store.config.review?.mode ?? "gate";
  if (mode === "off" || input.tool_name !== "Bash" || !isPushCommand(input.tool_input?.command, REVIEW_PR_SUBCOMMANDS)) return null;
  let decision;
  try {
    let repo;
    try {
      repo = gitHead(cwd);
    } catch {
      return null; // not a repository (or no commit yet): nothing to review
    }
    decision = gateDecision(headState(store.db, repo.top, repo.head), mode, invocation());
  } catch (err) {
    logError("PreToolUse", `review gate: ${err.message}`, env);
    return { notice: `ledger: the review gate could not decide (${err.message}); allowed` };
  }
  if (decision.deny || decision.notice) recordBounce(store, { sessionId, rule: "reviewGate", promptId, tool: "Bash", now, env, hook: "PreToolUse" });
  else satisfyBounces(store, { sessionId, rules: ["reviewGate"], now, env, hook: "PreToolUse" });
  return decision.deny || decision.notice ? decision : null;
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
      const review = reviewGate(input, { store, cwd, sessionId, promptId, now, env });
      if (review?.deny) {
        return {
          ...noticeField(store.notices),
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: review.deny },
        };
      }
      const notices = review?.notice ? [...store.notices, review.notice] : store.notices;
      return notices.length ? noticeField(notices) : null;
    }
    // A deny tells the agent to run `ledger ask` or `ledger note`, which write. When the store cannot take a write
    // (read-only file, a lock that outlasts busy_timeout) that advice is a dead end, so the gate
    // passes instead; withStore turns the StoreError into the allow shape with one systemMessage.
    assertWritable(store.db, store.dbPath);
    recordBounce(store, { sessionId, rule: verdict.rule, promptId, tool: input.tool_name ?? null, now, env, hook: "PreToolUse" });
    return {
      ...noticeField(store.notices),
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason },
    };
  });
}

if (invokedDirectly(import.meta.url)) {
  runHook("PreToolUse", (input) => handle(input));
}
