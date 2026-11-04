---
name: disable
description: 'Turn the ledger hooks off for this folder: sets "enabled": false in .ledger.json here (never deletes it).'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" disable)
---

The ledger CLI ran `disable` in this session's working directory. Its output:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" disable`

Report to the person, in one or two lines, whether it worked and the path of the `.ledger.json`
file it wrote or updated, quoted from the output above. If the output starts with `refused`,
quote the reason instead. Do not run anything else.
