# Final Review and Finish

<!-- owned: agent-system 2.0 row #21, ported by hand onto superpowers v7.0.2 in the as2-skills plugin (2026-11-03). v7 moved the final review and finish here from SKILL.md, so the agent-system 2.0 edits to that text did not merge; this file carries them again: the reviewer prompt and rubric, the reserved-action stop, and the § A4 close in place of the `finishing-a-development-branch` hand-off. Everything else is upstream text. -->

Part of `execute-plan` (see SKILL.md). Every task in the plan is
complete.

The final whole-branch review gets a package too: run
`bash scripts/review-package PLAN_FILE MERGE_BASE HEAD` by its absolute path,
from the working tree you're executing in (MERGE_BASE = the commit the
branch started from, e.g. `git merge-base main HEAD`) and include the
printed path in the final review dispatch, so the final reviewer reads
one file instead of re-deriving the branch diff with git commands. Dispatch
on the most capable available model (see SKILL.md's Model Selection), using
[code-reviewer-prompt.md](../code-reviewer-prompt.md) with the
`code-review-and-quality` skill as its rubric. Point it at
the ledger's deferred-minor and parked lines so it can triage which must be
fixed before merge.

If the final whole-branch review returns findings, dispatch ONE fix subagent
with the complete findings list — not one fixer per finding.
Per-finding fixers each rebuild context and re-run suites; a real
session's final-review fix wave cost more than all its tasks combined.
Then run exactly one scoped re-review of the fix wave
(`bash scripts/review-package PLAN_FILE FIX_BASE HEAD` by its absolute path,
from the working tree you're executing in, over the fix range,
[re-review-prompt.md](../re-review-prompt.md)).
Adjudicate any residual findings as in the fix loop's breaker
(references/fix-loop.md): park with rulings, or rule on the load-bearing
ones and ledger what you decided. Only the reserved actions at the top of
SKILL.md stop you here. There is no second fix wave —
residual load-bearing findings ride the "Rulings I made" list into the
slice's close, where your human partner reads them.

### Finish

Before you delete anything, collect every ledger line containing `Ruling:` —
preflight rulings, parked findings, breaker adjudications, all of them — into
your final message under "Rulings I made", in the order you made them, each
with what it costs if wrong. The list is exhaustive: if the ledger holds a
ruling, the list holds it. That list is the only place the decisions you
took on your human partner's behalf reach them — they read it and rework
whatever you got wrong. A ruling that dies with the workspace was a decision
made in secret.

When the final whole-branch review is clean and its fixes are merged,
delete this plan's workspace (`rm -rf <workspace>`) — the git history is
the record now. Sibling directories belong to other plans; leave them
alone.

<!-- owned: agent-system 2.0 (M6) — upstream hands off to `superpowers:finishing-a-development-branch`, a merge/PR/discard menu that waits for a human answer. Removed: SPEC-2.0.md § A4 owns merge and push (feature-branch push and approved-green-PR merge are not reserved; protected-branch push and deploy are), so the close is mechanical. -->

Close the slice per `git-workflow-and-versioning`: push the feature branch,
open the PR with the "Rulings I made" list in its body, and record the
slice's artifact (the PR) in the ledger. Do not merge from here, and do not
wait for an answer: a merge of an approved, green PR is the orchestrator's
mechanical step, and anything § A4 reserves is a reserved request, never an
action of this skill.
