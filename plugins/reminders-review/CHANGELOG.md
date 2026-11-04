# Changelog

All notable changes to reminders-review are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases before 0.2.1 are described in
the root README's reminders-review section ("Changes in").

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
