# Changelog

All notable changes to brb are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-11-04

### Added

- The three words, typed as the whole prompt: `brb` (a note may follow) starts a hold for the
  session; `pending` prints the digest and changes nothing; `back` prints it, archives it to
  `archive/<when>.md` and ends the hold. None of them starts a turn.
- The away instruction, delivered as `additionalContext` on every prompt while away and again at
  SessionStart: keep working, asks under `## Needs you`, `on fire:` lines only for the five
  on-fire kinds, a literal `idle: <why>` last line when nothing is runnable.
- The Stop hook while away: Needs-you lines to `digest.md` (restated lines held once), on-fire
  lines surfaced at once (a `systemMessage`, an OSC 9 `terminalSequence`, a best-effort macOS
  notification) and kept out of the digest, then `decision: "block"` sending the agent back to
  work, except on an `idle:` line, a `stop_hook_active` continuation with nothing new, or
  `idleStops` (default 2) stops with no tool call between them. An on-fire cap (`onFireCap`,
  default 3) that notes when it is passed.
- The OMP extension `omp/brb-omp.ts`: `input` handles the three words without a turn,
  `before_agent_start` carries the away instruction, `session_stop` runs the same stop hook
  under `BRB_HARNESS=omp`.
- State under `${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/`, declared and pruned at
  30 days; optional `${XDG_CONFIG_HOME:-~/.config}/brb/config.json`.
- The `brb` skill, the scenarios for every event × outcome, the failure table.
