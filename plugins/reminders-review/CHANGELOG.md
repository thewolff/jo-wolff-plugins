# Changelog

All notable changes to reminders-review are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases before 0.1.1 are not listed.

## 0.2.2 - 2026-11-04

### Changed

- `prune` ends with the plugin-kit contract line, `pruned: <n> file(s), <bytes> bytes freed[ (dry
  run)]; kept <k>`, after its JSON line; a file it could not remove is named on stderr and the
  exit code stays 0 (the canary reads a non-zero exit as a failed prune).

## [0.2.1] - 2026-11-04

### Changed

- `lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was this plugin's own copy, which
  carried the stdout drain first): the drain is unchanged, and the handler thread's env now also
  carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, and a process group the thread
  registers with `{ kitReap: <pgid> }` is killed when the runner exits. reminders-review's hooks
  register none, so the due-reminders block is unchanged.

## [0.2.0]

### Added

- Due and overdue reminders from the lists you watch (`watch` in the config file, or
  `REMINDERS_REVIEW_WATCH`) come up at session start and at most hourly after, on Claude Code
  and OMP.
- The skill has a "When this can't run" section (`remindctl` missing or not authorized, `rem`
  missing, a list name matching nothing, one `complete` failing, not macOS), and
  `.claude-plugin/plugin.json` declares the state directory and its prune command. ledger
  0.3.5's five-row gate passes on it.
- Before release, review fixes went into the same version: answers larger than one pipe
  buffer (64 KiB) reached the host cut off, as invalid JSON, because the hook runner exited
  before stdout drained; it now waits for the write, but only until its 4-second deadline, and
  logs one errors.log line when the host is not reading. remindctl output is capped at 1 MiB
  per call, and the block at 40 reminders per list and 8 KiB in all. In OMP, a waiting block no
  longer crosses into another session or reaches a subagent. The comma rule for
  `REMINDERS_REVIEW_WATCH` is documented. A long title, failure reason or failure line is cut
  between characters, so an emoji is kept or dropped whole. The README's *Changes* section has
  the rest.

## [0.1.2]

### Added

- Reads the Reminders.app link field with `rem show` when rem is installed, and gives its
  install line once when it is missing. remindctl stays the source for everything else, and
  `remindctl complete` is still the only write.

## [0.1.1]

### Changed

- Shows each reminder's notes and URL. When a reminder has neither, the agent says in one line
  that a Reminders.app link may not have reached it and asks you to paste it, instead of
  working from the title alone.
