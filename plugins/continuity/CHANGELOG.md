# Changelog

All notable changes to continuity are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-11-04

### Added

First release: the compaction-continuity hooks and the handoff skill, ported from the newdle
plugin 0.2.175 and scaffolded with plugin-kit 0.2.1.

- `hooks/pre-compact.mjs`: the pre-compaction save to
  `${XDG_STATE_HOME:-~/.local/state}/continuity/<session_id>.json`, with a heartbeat record per
  invocation and a calibration record per compaction; a `systemMessage` when auto-compaction
  fires with no handoff written.
- `hooks/session-start.mjs`: the post-compaction restore (this session's snapshot only, capped at
  20,000 characters, consumed on read) and the liveness line, `last successful save N minutes
  ago; the snapshot path is alive`, or the bold never-recorded / never-succeeded text.
- `hooks/user-prompt-submit.mjs` and `hooks/stop.mjs`: the context-pressure check, once per
  session on each surface, at `threshold` (default 0.65) of the calibrated compaction target,
  naming `/continuity:handoff`; the Stop block is written only after its once-mark lands.
- `skills/handoff/SKILL.md`: the handoff file shape (`<root>/.ai/handoffs/<date>--<time>--<author>--<lane>.md`,
  five sections, `status: open|consumed|superseded`), the root-resolution order shared with
  `lib/handoffs.mjs`, the "restate before continuing" rule, and a "When this can't run" section.
- `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json`: `threshold`, `pressure`, `liveness`,
  `snapshot`.
- `scripts/prune.mjs`: snapshots and once-marks older than 30 days; `heartbeat.ndjson`,
  `calibration.ndjson` and `errors.log` kept.
- Tests: `test/lib.test.mjs`, `test/hooks.test.mjs` (spawned, inside the runner deadline, with
  one end-to-end session), `test/port.test.mjs` (no `shipyard`, `linear`, `.projects`,
  `newdle-hooks` or home-directory string in anything the plugin runs or loads),
  `test/hook-contract.test.mjs`; twelve `evals/*.scenario.json`.

### Changed from the source

Every workspace-specific path and name was stripped; the table is in the README under
"Ported from newdle 0.2.175". The liveness once-flag moved from `os.tmpdir()` to the state
directory, keyed by session.
