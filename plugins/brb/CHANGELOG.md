# Changelog

All notable changes to brb are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.1] - 2026-11-04

### Changed

- `lib/hook-runner.mjs` is plugin-kit 0.3.0's, byte for byte (was 0.2.1's): the handler thread's
  env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, and a process group
  the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits. brb's hooks
  register none, so what they answer is unchanged; the 4 s deadline is unchanged.

## [0.1.0] - 2026-11-04

### Added

- The three words, typed as the whole prompt: `brb` (a note may follow, `brb lunch` or
  `brb, lunch`) starts a hold for the session; `pending` prints the digest and changes nothing;
  `back` archives it to `archive/<when>.md`, ends the hold and prints the archive path first,
  then the digest, capped at 8000 characters. None of them starts a turn while away; `back` and
  `pending` while not away pass through to the agent.
- The away instruction, delivered as `additionalContext` on every prompt while away and again at
  SessionStart: keep working, asks under `## Needs you`, `on fire:` lines only for the five
  on-fire kinds, an `idle: <why>` line when nothing is runnable (a closing ask may follow it).
- The Stop hook while away: Needs-you lines to `digest.md` (restated lines held once; heading
  forms with counts, numbers and emoji; continuation lines joined), on-fire lines surfaced at
  once and before any write (a `systemMessage`, an OSC 9 `terminalSequence`, a best-effort macOS
  notification) and kept out of the digest, then a keep-working answer (Stop hook
  `additionalContext` on Claude Code, `decision: "block"` on OMP), except on an `idle:` line, a
  tool-less `stop_hook_active` continuation with nothing new, `idleStops` (default 2) stops
  with no tool call between them, or three continuations in a row with nothing new whatever
  tools they ran (`nothingNewStops`; a new ask or fire resets it), which bounds an agent that
  calls a tool on every stop and never raises anything or writes `idle:`. Tool calls are
  counted in both Claude Code and OMP transcripts; with no readable transcript every
  continuation counts as tool-less, so a continuation with nothing new is released whatever
  tools it ran. An on-fire cap (`onFireCap`, default 3) that notes when it is passed.
- The OMP extension `omp/brb-omp.ts`: `input` handles the three words without a turn (the reason
  shown as a message when the agent is idle, as a notification while it works),
  `before_agent_start` carries the away instruction, `session_stop` runs the same stop hook
  under `BRB_HARNESS=omp`.
- State under `${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/`, declared and pruned at
  30 days; optional `${XDG_CONFIG_HOME:-~/.config}/brb/config.json`.
- The `brb` skill, the scenarios for every event × outcome, the failure table.
