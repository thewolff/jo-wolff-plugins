---
name: review
description: 'Run the cross-lab review of this branch (ledger review): every configured lab reviews git diff <base>..HEAD and the verdicts are recorded for HEAD.'
argument-hint: "[--base <ref>] [--labs a,b] | status | addressed | waive <why>"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" review:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" review $ARGUMENTS` from this session's working
directory. With no arguments it reviews the branch; `status` shows the rows for HEAD; `addressed`
records that HEAD fixes an earlier commit's findings; `waive "<why>"` lets HEAD through, with the
human's own words as the reason.

Report to the person, briefly: each lab's verdict as printed (`pass`, `findings`, `unavailable`
with its reason), then the findings themselves, grouped by lab, as the output gives them. If the
output starts with `refused`, quote the reason. Do not fix anything unless the person asks.

## When this can't run

- Every lab prints `unavailable: <reason>` (binary missing, no credential, a timeout): the rows
  are recorded as unavailable and the push gate stays shut. Tell the person the reasons as
  printed; `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" doctor` names the binary each lab
  needs. The person decides between fixing the lab and `review waive "<why>"`; never waive on
  your own.
- `refused … not in a git repository` or `… has no commit yet`: there is nothing to review; say so.
- `ledger: database … ` on stderr: the review ran but its rows were not written, so the gate
  will not see it. Quote the line; `ledger doctor` says what is wrong with the database.
- No output at all within a few minutes: the lab's CLI hung past its timeout and was killed; the
  row says `unavailable: timed out`. Run it again once; if it repeats, tell the person.
- The push gate the review feeds is proved by `evals/pre-tool-use-push-denied.scenario.json` (a
  `git push` with no note or outcome in the session is refused, and the reason names the command).
