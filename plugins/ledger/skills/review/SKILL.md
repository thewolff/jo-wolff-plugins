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
