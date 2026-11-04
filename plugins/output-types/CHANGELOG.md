# Changelog

All notable changes to output-types are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.3.2 - 2026-11-04

### Changed

- `scripts/prune.mjs` is plugin-kit 0.3.3's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged.
- The re-copied prune skips symlinks (a linked `x.log` is never rotated over its `.1`) and a dry run no longer counts an expired `.1` twice: its totals are the real run's (plugin-kit 0.3.3's fix).

## [0.3.1] - 2026-11-04

### Fixed

- `lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.3.0's): the runner waits for
  stdout to drain before it exits, bounded by the hook's deadline (4 s, or 55 s with the judge on),
  so a Stop warning larger than one 64 KiB pipe buffer is no longer cut short; a host that never
  reads gets exit 0 at the deadline and one `stdout not drained` line in errors.log. What the Stop
  check says is unchanged.
- `test/receipts.test.mjs`'s real-runner judge case gives the sleeping judge a 400 ms per-call
  budget, so the logged timeout is the configured number, not one that drifts with elapsed time.

## [0.3.0] - 2026-11-04

### Added

- `hooks/output-types-stop.mjs`, a Stop hook: reads the finished message (`last_assistant_message`
  in the payload, else the last assistant text in the transcript) and names, in one
  `systemMessage`, every `**CLAIM**` without an absolute `file:line` or a command with its result
  (a fence holding the command and its output, or a command, `$ cmd` or code with a space in it,
  with `→ output` on its line or the next; inline code next to a word like "returns" is not one)
  and every `**CITE**` without a URL or a test run with its command; the first five by line,
  then `+N more`. Never `decision: block`. Markdown-bold labels that start a line (after any
  list or quote marker) or are followed by a colon or the line's end count; so does a bold label
  inside a sentence, checked against that sentence and the next line, unless it is only
  mentioned (joined to another label by and/or/comma/slash, quoted or in code, or followed by a
  word like label, means, is or needs). Nothing inside a fenced code block, at any indentation,
  counts. A blank line inside a fence does not end a statement. `OUTPUT_TYPES_CHECK=off` turns
  it off.
- A judge stage, off by default: with `"judge": true` in
  `${XDG_CONFIG_HOME:-~/.config}/output-types/config.json` and a judge command resolved
  (`OUTPUT_TYPES_JUDGE_BIN` → `judgeCommand` in that file → `~/.config/judge/config.json` →
  i-have-audhd's profile), one call per statement that passed the mechanical stage asks whether
  the receipt licenses the sentence; `fail` and unreadable verdicts join the warning; a dispatch
  error is one line in `${XDG_STATE_HOME:-~/.local/state}/output-types/skipped.log` naming the
  source, and the check continues; so is a judge that is on with no command resolved, naming the
  malformed shared file or where it looked. Calls are clamped to the hook's 55 s budget (`timeout: 60` in
  `hooks.json`), counted from the runner's start (`HOOK_RUNNER_STARTED_AT_MS`), so stdin that
  arrives late shortens the judge's time, not the warning's; a judge still running when the
  runner's deadline fires is killed with its process group as the hook exits.
- `lib/receipts.mjs` (labels, statements, receipt shapes, the warning, the config, the judge
  stage), `lib/judge.mjs` and `lib/hook-runner.mjs` (plugin-kit 0.3.0's, vendored byte for byte).
- Tests: `test/receipts.test.mjs`, `test/stop-hook.test.mjs` (the hook as a spawned process:
  fixtures, fault inputs, the runner's deadline, the judge with fake commands, config off by
  default), the Stop step in `test/e2e.test.mjs`, and the vendored-copy check in
  `test/manifest.test.mjs`.
- `evals/manifest.json` declares the Stop hook's two outcomes, proved by
  `evals/stop-unreceipted-warns.scenario.json` (`systemMessage`) and its sibling
  `evals/stop-check-off.scenario.json` (`silent` under `OUTPUT_TYPES_CHECK=off`), so the gate's
  `evals` row covers the new hook.
- `README.md` in the plugin: what it is, a pointer to the full documentation (then in the
  root README's output-types section; since moved into this README), and a
  `## Changes in 0.3.0` entry, so ledger's `gate check` `docs` row finds the release written
  down in the plugin.

### Changed

- The root README's output-types section (now this README): "it delivers, it does not enforce"
  is now "it delivers, and it warns", with the new "The Stop check" section.

## [0.2.2]

### Changed

- The plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares what the
  session-start hook can return (the core as a `systemMessage`, or silence under
  `OUTPUT_TYPES_INJECT=off`), one `evals/<x>.scenario.json` proves each, and the core scenario
  carries a `session` and a `judge` rubric the nightly canary runs under `claude -p` and grades
  with `claude plugin eval`. `e2e/live-run.sh` hands off to plugin-kit's scenario runner.
  `.claude-plugin/plugin.json` declares the one state path (`$XDG_STATE_HOME/output-types`, 30
  days) and `scripts/prune.mjs` prunes it. The skill has a "When this can't run" section.

## [0.2.1]

### Fixed

- A hook fault (contract file missing, unreadable or without its markers, or the hook's own
  module failing to load or loading broken) now appends one line naming the hook file and the
  reason to `${XDG_STATE_HOME:-~/.local/state}/output-types/errors.log`, and the one-line
  warning reaches you as well as the model and says where the reason went.
  `OUTPUT_TYPES_INJECT=off` is read first, so it silences the hook even when the install is
  broken. The hook no longer waits on a stdin pipe its caller leaves open: it reads for at most
  one second, then injects.

## [0.2.0]

### Changed

- Only receipted facts are labeled, as CLAIM or CITE. The GUESS, PMDW, ACTION and QUESTION
  labels, the `<!-- output-types … -->` envelope and the numbered degradation tiers are gone;
  unreceipted statements, actions, questions and degraded coverage are plain prose. The whole
  contract now lives in `skills/output-types/reference.md`, which the skill points at and the
  hook injects from.
