# Changelog

All notable changes to continuity are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.1] - 2026-11-04

### Changed

- `lib/hook-runner.mjs` is plugin-kit 0.3.0's, byte for byte (was 0.2.1's): the handler thread's
  env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, and a process group
  the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits. continuity's
  hooks register none, so what they answer is unchanged; the 4 s deadline is unchanged.

## [0.1.0] - 2026-11-04

### Added

First release: the compaction-continuity hooks and the handoff skill, ported from the newdle
plugin 0.2.175 and scaffolded with plugin-kit 0.2.1.

- `hooks/pre-compact.mjs`: the pre-compaction save to
  `${XDG_STATE_HOME:-~/.local/state}/continuity/<session_id>.json`, with a heartbeat record per
  invocation, and a calibration record per compaction when the host passes a real `token_count`;
  a `systemMessage` when auto-compaction fires with no handoff written. Every git call runs at
  once inside one 2 s budget; a field git did not answer is saved as `(unknown: …)`, and an
  unanswered `git status` never renders as `(clean)`.
- `hooks/session-start.mjs`: the post-compaction restore (this session's snapshot only, capped at
  20,000 characters, consumed on read), a `this compaction's state was not restored` line naming
  the session's recorded save outcome when there is nothing to restore, and the liveness line led
  by the newest save's result: `last successful save N minutes ago`, `the last save failed …;
  the last success was …`, or the bold never-recorded / never-succeeded text.
- `hooks/user-prompt-submit.mjs` and `hooks/stop.mjs`: the context-pressure check, once per
  session on each surface, at `threshold` (default 0.65) of `contextTokens` (default 200,000),
  naming `/continuity:handoff`. On Claude Code the context size is the token usage the newest
  main-thread reply since the last compaction marker recorded (`input_tokens +
  cache_read_input_tokens + cache_creation_input_tokens`). With no recorded usage it falls back
  to the transcript's bytes since the marker, / 8, and the warning says `(estimate)`; a
  calibrated ratio replaces that constant once a host has passed a real `token_count`. The Stop block is written only after its once-mark lands,
  and not at all once this session has written a handoff.
- `skills/handoff/SKILL.md`: the handoff file shape (`<root>/.ai/handoffs/<date>--<time>--<author>--<lane>.md`,
  five sections, `status: open|consumed|superseded`), the root-resolution order shared with
  `lib/handoffs.mjs`, the "restate before continuing" rule, and a "When this can't run" section.
- `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json`: `threshold` (a JSON number in (0, 1)),
  `contextTokens`, `pressure`, `liveness`, `snapshot`; a problem is named once per session.
- `scripts/prune.mjs`: snapshots and once-marks older than 30 days; `heartbeat.ndjson`,
  `calibration.ndjson` and `errors.log` kept; each write appends, and a file past 400 lines is
  trimmed to its newest 200 by a rename-swap. Runs from a path with a space in it or through a symlink.
- Tests: `test/lib.test.mjs`, `test/hooks.test.mjs` (spawned, inside the runner deadline, with
  one end-to-end session), `test/port.test.mjs` (no `shipyard`, `linear`, `.projects`,
  `newdle-hooks` or home-directory string in anything the plugin runs or loads),
  `test/hook-contract.test.mjs`; twelve `evals/*.scenario.json`.

### Changed from the source

Every workspace-specific path and name was stripped; the table is in the README under
"Ported from newdle 0.2.175". The liveness once-flag moved from `os.tmpdir()` to the state
directory, keyed by session.
