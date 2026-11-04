# output-types

A contract for what an agent's report may assert as fact: label only receipted facts, as
`**CLAIM**` (an inspectable receipt) or `**CITE**` (a fetched source or a live test), and leave
everything else as unlabeled prose. The plugin delivers the contract at session start and, since
0.3.0, checks every finished message for a label without a receipt, warning only.

The full documentation (install on Claude Code and OMP, what you get, the Stop check, its judge
stage and off switches, developing the plugin) is the output-types section of the repository
README: [output-types](../../README.md#output-types). Every release is in
[CHANGELOG.md](CHANGELOG.md).

## Changes in 0.3.2

`scripts/prune.mjs` is plugin-kit 0.3.3's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged.

## Changes in 0.3.1

`lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.3.0's): the runner waits for
stdout to drain before it exits, bounded by the hook's deadline (4 s, or 55 s with the judge on),
so a Stop warning larger than one 64 KiB pipe buffer is no longer cut short; a host that never
reads gets exit 0 at the deadline and one `stdout not drained` line in errors.log. What the Stop
check says is unchanged.

## Changes in 0.3.0

The Stop check. Mechanical, every turn: each `**CLAIM**` without an absolute `file:line` or a
command and its result, and each `**CITE**` without a URL or a test run with its command, is named
by line in one `systemMessage`, the first five, then `+N more`. Never `decision: block`. A judge
stage, off by default, runs when `${XDG_CONFIG_HOME:-~/.config}/output-types/config.json` has
`"judge": true` and a judge command resolves. The judge dispatch is plugin-kit 0.3.0's
`lib/judge.mjs`, vendored byte for byte, and the command is configured once for every plugin with
`node lib/judge.mjs setup`. New files: `hooks/output-types-stop.mjs`, `lib/receipts.mjs`,
`lib/judge.mjs`, `lib/hook-runner.mjs`, and this README. `OUTPUT_TYPES_CHECK=off` turns the check
off.
