# Changelog

All notable changes to output-types are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases before 0.3.0 are described in
the root README's output-types section ("Changes in").

## [0.3.0] - 2026-11-04

### Added

- `hooks/output-types-stop.mjs`, a Stop hook: reads the finished message (the last assistant
  text in the transcript, or `last_assistant_message` in the payload) and names, in one
  `systemMessage`, every `**CLAIM**` without an absolute `file:line` or a command with its result
  and every `**CITE**` without a URL or a test run with its command; the first five by line,
  then `+N more`. Never `decision: block`. Only markdown-bold labels at a line start or inline
  count; nothing inside a fenced code block does. `OUTPUT_TYPES_CHECK=off` turns it off.
- A judge stage, off by default: with `"judge": true` in
  `${XDG_CONFIG_HOME:-~/.config}/output-types/config.json` and a judge command resolved
  (`OUTPUT_TYPES_JUDGE_BIN` → `judgeCommand` in that file → `~/.config/judge/config.json` →
  i-have-audhd's profile), one call per statement that passed the mechanical stage asks whether
  the receipt licenses the sentence; `fail` and unreadable verdicts join the warning; a dispatch
  error is one line in `${XDG_STATE_HOME:-~/.local/state}/output-types/skipped.log` naming the
  source, and the check continues. Calls are clamped to the hook's 55 s budget (`timeout: 60` in
  `hooks.json`).
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

### Changed

- The root README's output-types section: "it delivers, it does not enforce" is now "it
  delivers, and it warns", with the new "The Stop check" section.
