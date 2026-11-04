# Changelog

All notable changes to continuity are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-11-04

### Added

The two pieces the 0.1.0 port left out of the source hook, generic, in `lib/repo-rules.mjs`,
both on the SessionStart that follows a compaction and never on a fresh start:

- `## Repo rules re-inlined` in the restore block: per directory from the payload's cwd up to
  the walk root, `CLAUDE.md` (with `CLAUDE.local.md` after it) else `AGENTS.md`, inlined root
  first, nearest last. The root is the git root (the nearest `.git` entry at or above the cwd),
  or the nearest directory above it holding a rules file (searched up to, not including, the home
  directory and `/`), or the cwd alone when there is no git root. The cwd is resolved through its
  symlinks first; a rules file that is a symlink to a path outside the root is skipped and named;
  a file reached twice is inlined once; a level at or above `CLAUDE_PROJECT_DIR` is skipped and
  named as the host's. Caps in bytes on the whole rendered section (headings, paths, markers and
  skip lines included): 8,000 per file, 9,000 for the section, and never more than what the
  snapshot and the notes list leave of the 20,000-character restore guard (the rules give way
  first). The smallest files land whole and the largest are cut on a UTF-8 character boundary to
  one shared allowance with a `(truncated at N bytes; the file is M bytes, read it for the rest)`
  marker, N the bytes shown; a file whose share would be under 200 bytes is skipped; every
  skipped file is one `- skipped <path>: <why>` line, as many as fit and then a count of the rest;
  a walk that found nothing says so; a section with no room for its heading is left out and
  named in the systemMessage. `@path` imports are not expanded.
- `## Durable notes` in the restore block: the newest `notesCount` (default 5) regular files of
  `notesDir` (default `.ai/decision-log`, relative to the git root of the cwd resolved through
  its symlinks, or that cwd when there is none) by modification time, an equal time broken by
  name descending (Linux file times are coarse, so a burst of writes shares one), one filename per line, with
  the line that the notes directory and the rules files are the source of truth and the restored
  snapshot is only the safety net. An absent directory is one line saying so. The whole section
  counts against the restore guard, fitted before the rules; short of room it lists fewer names,
  then none, then is left out and named in the systemMessage.
- Config keys `rules` (`"on"` or `"off"`), `notesDir` (a non-empty string) and `notesCount` (a
  whole number from 0, which drops the section, to 100); a wrong value is named once per session
  like the others.
- Tests: the walk (nested levels, `CLAUDE.md` over `AGENTS.md`, the local file's place, the
  workspace root and the home-directory stop, the cwd-only root, the launch-directory skip,
  symlink safety), the caps (bytes, largest cut first, the marker, the floor, the caller's
  budget, the whole rendered section within the budget at every budget with long paths and many
  skips), the probe (mtime order, the count, a missing or empty directory, the rendered budget,
  the root of a symlinked nested cwd) in `test/lib.test.mjs`; the block's presence only after a
  compaction, its order, the whole block within the guard, the 9,000-byte section, the left-out
  sections, a symlinked nested cwd and each config switch in `test/hooks.test.mjs`; `evals/session-start-restore-rules.scenario.json`
  and `evals/session-start-restore-notes.scenario.json` (fourteen scenarios in all).

### Changed

- `hooks/session-start.mjs` after a compaction with nothing to restore still gives the two
  sections above, after the `not restored` line. `"snapshot": "off"` skips the save and the
  restore as before and not the two sections; `"rules": "off"` and `"notesCount": 0` are theirs.
- The 20,000-character restore guard covers the whole post-compaction context. The restore's
  heading, handoff notice and `TRUNCATED` notice are now counted inside it, as are the liveness
  line and a config-problem line, where 0.1.x capped the snapshot body alone and added the
  framing on top, so a restore could exceed the guard. A snapshot that fits whole with its framing is
  consumed as before; one that does not is cut on a character boundary (never half a surrogate
  pair), says how many characters are shown, and is kept. Tests: a snapshot body one under, at,
  one over and far over the guard, alone and with the rules, notes and liveness line wanting
  room, and the exact fit, in `test/lib.test.mjs` and `test/hooks.test.mjs`.

## [0.1.1] - 2026-11-04

### Changed

- `lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.2.1's): the handler thread's
  env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, a process group
  the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits, and it now
  waits for stdout to drain before it exits, bounded by the same deadline, so an
  answer larger than one 64 KiB pipe buffer is no longer cut short (a host that never reads gets
  exit 0 at the deadline and one `stdout not drained` errors.log line). continuity's
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
