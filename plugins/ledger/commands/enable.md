---
description: 'Turn the ledger hooks on for this folder: sets "enabled": true in .ledger.json here.'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" enable)
---

The ledger CLI ran `enable` in this session's working directory. Its output:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" enable`

Report to the person, in one or two lines, whether it worked and the path of the `.ledger.json`
file it wrote or updated, quoted from the output above. If the output starts with `refused`,
quote the reason instead. Do not run anything else.
