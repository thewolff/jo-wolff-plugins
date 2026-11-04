---
name: new-plugin
description: Start a new plugin in this repository so it meets the test bar (can't break the session, failures visible, text says what to do when it can't) before its first rule is written. Use when asked to create, scaffold or start a plugin, or to add hooks to a plugin that has none.
---

# New plugin

Scaffold a plugin from plugin-kit's templates, then fill in the three things only the author
knows: the rule each hook enforces, the skill's steps, and the how-it-fails rows. Everything the
repository test bar checks mechanically is in place from the first commit, and `ledger gate
check` passes on the scaffold as written.

## Steps

1. Settle the name (lowercase kebab, the thing it does: `pattern-check`, not `pc`), the hook
   events it needs (`PreToolUse`, `Stop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
   `PostToolUse`, `SubagentStop`, `PreCompact`, `Notification`, `PermissionRequest`), and one
   sentence for the person: what it does and the rule its hooks enforce. Ask when any of the three
   is open; do not invent an event list.
2. Run the scaffolder from inside the repository the plugin is for (any directory in it):
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/new-plugin.mjs" <name> --events <A,B> --description "<sentence>"`
   It writes `<that repository's toplevel>/plugins/<name>/` (the toplevel is
   `git rev-parse --show-toplevel` of the cwd; never the kit's own checkout or the marketplace
   cache it runs from) and prints the files. `--dest <plugins dir>` names another destination
   directory; a cwd in no git repository is refused naming `--dest`. It also refuses an existing
   directory, a name that is not kebab, or an unknown event, with the reason on stderr; fix the
   argument and run it again. Nothing is overwritten.
3. Write the rule. In each `hooks/<event>.mjs`, replace `return null` with the hook's logic; the
   header comment says what the runner does for you (exit 0 always, the errors.log line, the
   4 s deadline) and what the handler owes: a missing or unreadable input is "no rule applies",
   never a deny; every deny or block text names the command that gets the person out, in
   backticks. Say what each hook does in its header comment's "What it does" line.
4. Write the skill: `skills/<name>/SKILL.md` has the frontmatter and the required "When this
   can't run" section with two bullets already; add the steps and one bullet per way the skill's
   own commands fail.
5. Fill `HOW-IT-FAILS.md`: one row per piece (each hook, each file read, each program shelled
   out to), with how it fails, where that is visible, and what the person does. Delete the
   parenthesised example rows that do not apply.
6. For every program the plugin shells out to, capture its real output both ways into
   `test/fixtures/<x>.txt` and `<x>.unavailable.txt` (the README there says how); the tests
   replay those, and the gate refuses a `.txt` without its sibling.
7. Give `e2e/live-run.sh` the plugin's own claim at step 2 (the one thing only a live model run
   can prove); the contract and the hook-ran check are already there.
8. Run `node --test` in the plugin, then `node "<ledger plugin>/scripts/ledger.mjs" gate check
   --plugins <name>` from the repository; both green before the first push. Add the marketplace
   entry (`.claude-plugin/marketplace.json` at the root: name, source, the one sentence) and a
   line in the root README when it is ready to publish.

The runner is copied, not shared: `plugins/<name>/lib/hook-runner.mjs` belongs to the new plugin.
A later change to plugin-kit's copy reaches it only by copying again, on purpose; an installed
plugin never depends on a sibling plugin being installed.

## When this can't run

- The scaffolder printed `new-plugin: <reason>` and exit 1: nothing was written. The reason is
  one of: the cwd is in no git repository (run it from inside the repository the plugin is for,
  or pass `--dest <plugins dir>`), the directory exists (pick another name, or move the old one
  aside yourself; the script never deletes), the name is not kebab, an event is not in the list,
  no `--events`. Fix the argument and run it again; do not create the files by hand from memory.
- The scaffolder is missing (`no such file … scripts/new-plugin.mjs`): plugin-kit is not
  installed where `CLAUDE_PLUGIN_ROOT` points. Tell the person; the templates are in
  `plugins/plugin-kit/templates/` in the repository and can be copied by hand with `{{name}}`
  and the per-hook `{{event}}`, `{{file}}`, `{{quiet}}` filled in, the runner from
  `plugins/plugin-kit/lib/hook-runner.mjs`.
- `node --test` in the new plugin fails on `hook-contract.test.mjs` after you wrote the rule: the
  failing line names the hook and the fault input; the handler is denying or throwing on a fault
  instead of allowing. Treat the missing input as "no rule applies" and return null.
- `ledger gate check` fails `says`: the line names the SKILL.md without the section or the
  `file:line` of a deny text with no backtick command; add the section or the command.
