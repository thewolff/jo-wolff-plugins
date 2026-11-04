---
name: enable
description: 'Turn the ledger hooks on for this folder: sets "enabled": true in .ledger.json here.'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" enable)
---

The ledger CLI ran `enable` in this session's working directory. Its output:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" enable`

Report to the person, in one or two lines, whether it worked and the path of the `.ledger.json`
file it wrote or updated, quoted from the output above. If the output starts with `refused`,
quote the reason instead. Do not run anything else.

## When this can't run

- The output is empty, or starts with `ledger:` naming a path it could not write: say so to the
  person in one line, quoting the output; `.ledger.json` was not written. They can create it by
  hand with `{"enabled": true}` in the folder.
- The output says `database …`: `enable` never touches the database, so that line is a notice
  from the config layer; the switch still took effect if the `.ledger.json` path is printed.
- The hooks coming back on is proved by `evals/session-start-relay.scenario.json` (SessionStart
  injects the open items); its sibling `evals/session-start-disabled.scenario.json` is the off state.
