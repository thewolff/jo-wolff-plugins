# Changelog

All notable changes to continuity are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
  naming `/continuity:handoff`. On Claude Code the context is estimated from the transcript's
  bytes since its last compaction marker, / 4; a calibrated ratio replaces the constant once a
  host has passed a real `token_count`. The Stop block is written only after its once-mark lands,
  and not at all once this session has written a handoff.
- `skills/handoff/SKILL.md`: the handoff file shape (`<root>/.ai/handoffs/<date>--<time>--<author>--<lane>.md`,
  five sections, `status: open|consumed|superseded`), the root-resolution order shared with
  `lib/handoffs.mjs`, the "restate before continuing" rule, and a "When this can't run" section.
- `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json`: `threshold` (a JSON number in (0, 1)),
  `contextTokens`, `pressure`, `liveness`, `snapshot`; a problem is named once per session.
- `scripts/prune.mjs`: snapshots and once-marks older than 30 days; `heartbeat.ndjson`,
  `calibration.ndjson` and `errors.log` kept, each trimmed to 200 lines on write by a
  rename-swap. Runs from a path with a space in it or through a symlink.
- Tests: `test/lib.test.mjs`, `test/hooks.test.mjs` (spawned, inside the runner deadline, with
  one end-to-end session), `test/port.test.mjs` (no `shipyard`, `linear`, `.projects`,
  `newdle-hooks` or home-directory string in anything the plugin runs or loads),
  `test/hook-contract.test.mjs`; twelve `evals/*.scenario.json`.

### Changed from the source

Every workspace-specific path and name was stripped; the table is in the README under
"Ported from newdle 0.2.175". The liveness once-flag moved from `os.tmpdir()` to the state
directory, keyed by session.
