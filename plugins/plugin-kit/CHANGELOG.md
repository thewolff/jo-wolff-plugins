# Changelog

All notable changes to plugin-kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases before 0.2.0 are described in
the README's "Changes in" sections.

## [0.3.0] - 2026-11-04

### Added

- `lib/judge.mjs`: the shared judge dispatch, vendored byte for byte by every plugin that
  judges. One command through `/bin/sh` in its own process group, the prompt on stdin or in place
  of `{prompt}`, stdout only, a hard timeout that reaps the group, never a throw. `json` mode
  returns the last JSON object on stdout (a `claude -p --output-format json` envelope unwrapped)
  or `{ error, detail, stderr }` with `error` one of `timeout`, `nonzero`, `unparseable`,
  `spawn-failed`; `yesno` mode returns `yes`, `no`, or `unverified`.
- `resolveJudgeCommand()`: the command resolved once for every plugin, first found wins, naming
  its source: the plugin's env var → the plugin's own setting → `${XDG_CONFIG_HOME:-~/.config}/judge/config.json`
  `{ "command", "timeoutMs" }` → i-have-audhd's `enforcement.judgeCommand` (legacy, read-only).
- `node lib/judge.mjs setup` (one test call, then the shared file written atomically after a
  yes; `--command`, `--timeout-ms`, `--yes`, `--force`) and `node lib/judge.mjs which`.
- `test/judge.test.mjs`: the resolution order over a fake HOME and XDG_CONFIG_HOME, each failure
  class from a tiny shell command, both parsers, the CLI as a spawned process, and the sameness
  test: every `plugins/*/lib/judge.mjs` and `plugins/*/judge/judge.mjs` outside the allowlist
  (`ledger/lib/judge.mjs`, until ledger's next release) is byte-identical to the kit's.
- `new-plugin.mjs --judge`: the scaffold also gets `lib/judge.mjs`.

### Unchanged

The runner, the agents, and the rest of the scaffold.

## [0.2.1] - 2026-11-04

### Changed

The cross-lab reviewer has a review budget (see "Review budget" in the README), so a review loop
ends. Three verdicts, `ship`, `ship-with-limits` and `fix-first`, and `fix-first` only on a
finding whose worst case is data loss, a live-state write outside the plugin's own state, a
crash or hang, wrong-recipient delivery, or a security boundary violation inside the threat
model. The invoking prompt carries a `Threat model:` line, and the reviewer asks for it and
stops without one; findings outside it are `Out of scope`. The repository default is
`Threat model: none — every input is Jo's own; review for correctness and fail-safety, not adversarial inputs`,
which the brief template shows prefilled. Each finding has a one-sentence worst case and a
`new-mechanism` tag, and fixes that add a mechanism are held for Jo. Round 2 verifies the prior
findings only; from round 3 the review is blocking-only. Without an in-scope blocking finding, a
static-only review is now `ship-with-limits`, with `no executable check ran` as its first limit;
an in-scope blocking finding still makes it `fix-first`. Each review opens with a
`## Round <R>` heading, the form the next review's round count reads (a `Round: <R>` line
alone reset the count to round 1), and a prior review with no round heading or `-round<N>` file
name counts as unreadable, so the reset is stated. The release gate, the scaffolder and the
runner are unchanged.

## [0.2.0] - 2026-11-04

### Changed

The scaffold meets the five-row gate ledger 0.3.5 runs, not the three-row one. New in the
scaffold: `evals/manifest.json`, one `evals/<event>.scenario.json` stub per event,
`scripts/prune.mjs` and a `state` declaration in `plugin.json`, and `lib/live-run.mjs`, the
scenario runner `e2e/live-run.sh` now hands off to (19 files, from 13). The runner replays
every scenario's hook phase in its own sandbox with no model, then under `claude -p` runs the
pinned CLI-contract session and every scenario with a `session`. A `judge` rubric is graded by
`claude plugin eval`: the runner writes a `case.yaml` (the 2.1.318 case schema, JSON body) and
a `scaffold.sh` from the scenario's `setup` under `<plugin>/live-run-cases-<pid>/` (the CLI
takes only a relative `--eval-dir` inside the plugin), runs the eval with `--no-publish --json`
and reads the verdict from the JSON, never the exit code (a case that fails to load exits 0),
and removes the directory whatever happened; the operator-gated tools the scenario's
`allowedTools` names (Bash, Write, Edit, WebFetch, `mcp__*`) are granted with `--allow-tools`.
Live sessions run with `SHELL=/bin/bash` pinned: the CLI snapshots the user's shell at startup
and sources its rc, and given `sh` it falls back to zsh (measured on 2.1.318: `$SHELL` inside
the Bash tool was `/bin/zsh`, with `ZDOTDIR` unset and set alike), so a zsh rc that writes under
the sandbox's `XDG_CONFIG_HOME` (thefuck's settings, measured) read as the plugin's own write;
bash with no rc writes nothing. A judge scenario the eval could not grade (no `claude`, not
logged in, an API error) leaves the run `unavailable` (exit 75), never a pass, even when the
contract session passed. The scaffolder's CLI guard compares real paths on both sides
(`realpathSync` of `argv[1]` and of the module), the fix ledger 0.3.5 and the other plugins
carry for their hooks: node resolves the main module through symlinks, so the earlier string
compare made the scaffolder a silent no-op when reached through one (macOS's `/var/folders`
tmpdir included), exiting 0 with nothing written. `test/live-run.test.mjs` is new; the scaffold
test runs a scaffold end to end in a fresh repository through `ledger gate check` and `ledger
canary run`.
