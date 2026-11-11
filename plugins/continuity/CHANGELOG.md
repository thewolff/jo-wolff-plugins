# Changelog

All notable changes to continuity are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.4.0 - 2026-11-10

### Changed

- The handoff ask (UserPromptSubmit) and the Stop block fire at an absolute ask point instead of
  0.65 × 200,000. The point is `askTokens` (new; default 175,000, under the 200,000 tokens at
  which Desktop's idle compaction applies), or, when unset and `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`
  is set, that value minus `askMarginTokens`. It is never below the compaction window's first
  recorded usage plus `askMarginTokens` (new; default 40,000), so a session that opens at
  120,000 to 140,000 tokens (Desktop) is not asked on its first turn, and neither is the first
  turn after a compaction.
- Asks re-arm. `promptWarned` and `stopBlocked` in `sessions/<session>.json` are now
  `{ epoch, tokens, at, by }`, keyed by the compaction window (the last `compact_boundary`
  line's `uuid`, else its byte offset). A compaction starts the count over; within a window the
  next ask comes after a further `reaskStepTokens` (new; default 150,000). A 0.3 flags file
  (bare timestamps) counts as an earlier window and is re-armed.
- A handoff carrying this session's id silences the ask only when it was written after the
  window's compaction marker and after the last ask; the next step counts from the size it
  silenced.
- On Claude Code, `hooks/pre-compact.mjs` prints fixed plain-text instructions (about 1,000
  characters) on every compaction, asking the summary to end with a `## Handoff` section (In
  flight, Ruled out, Still open, Next step), instead of a JSON `systemMessage` that Claude Code
  discards from PreCompact. `lib/hook-runner.mjs` prints a string answer as plain text.
- The no-handoff notice for an auto or idle compaction moves to `hooks/session-start.mjs` after
  the compaction (a `systemMessage`). The restore's no-handoff line points at the summary's
  `## Handoff` section.
- Under OMP nothing changes for the person: the adapter sets `CONTINUITY_HOST=omp`, and
  `hooks/pre-compact.mjs` answers JSON there as before, with no summary instructions.
- `threshold` and `contextTokens` are kept for existing config files: when either is set and
  `askTokens` is not, the ask point is their product (each defaulting to its 0.3 value). The
  margin and the re-ask step apply either way.
- A set auto-compact window is honoured (`lib/autocompact.mjs`): `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
  else `autoCompactWindow` in the project local, project, then user settings file, per model
  under `modelSettings` before the top level. The default ask point and the re-ask come no later
  than `askMarginTokens` before the point Claude Code compacts at (the window less 33,000, or
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` of it when earlier). The 33,000 is measured, not documented:
  on Claude Code 2.1.321 with a 300,000 window for claude-fable-5-2, session eacf7986 compacted
  automatically on 2026-11-10 at 7:03 PM PST at `preTokens` 267,109, 32,891 before the window.
  With a 300,000 window that is an ask at 175,000 and another at 227,000. An `askTokens` or
  `threshold` the person set is not lowered. The ask names the size of the next ask instead of
  the step.
- With a modelled compaction point, the baseline floor never pushes the first ask past
  `askMarginTokens` before it: a window that already opened past that point is asked on its
  next turn. A 200,000 window (compaction at 167,000) whose session opened at 130,000 was
  otherwise first asked at 170,000, after the compaction.
- A re-ask at the margin point comes only when that point is past the last ask, so
  `askMarginTokens: 0` no longer blocks Stop twice at the same size.
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` with no window set (or `"auto"`) applies to a native 1M
  model's 1,000,000 default window (the Fable models, Sonnet 5 and later, Haiku 5.5 and later,
  Opus 4.7 and later). Other models, and `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, are not modelled.
- A transcript's `message.model` matches its `modelSettings` entry through Bedrock
  (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) and Vertex (`claude-sonnet-4-5@20250929`)
  spellings, `[1m]`, a date suffix and case. An exact `modelSettings` key wins over one that only
  names the same Claude model. Any id that is not a Claude spelling (a custom gateway model)
  matches only its exact key, so `gateway-v1` and `gateway-v2` keep separate windows. Aliases
  and ARNs are not resolved.
- A compaction marker is only a top-level `{"type":"system","subtype":"compact_boundary"}` line.
  The same text nested in a tool input or result no longer starts a new window or moves its
  baseline, and a `uuid` over 128 characters is not stored as the window's epoch.

## 0.3.1 - 2026-11-04

### Changed

- `scripts/prune.mjs` is plugin-kit 0.4.1's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged.
- The re-copied prune skips symlinks (a linked `x.log` is never rotated over its `.1`) and a dry run no longer counts an expired `.1` twice: its totals are the real run's (plugin-kit 0.4.1's fix).

## [0.3.0] - 2026-11-04

### Added

An OMP adapter, so the save and the restore run under OMP as well as Claude Code. Until now
OMP seats kept newdle's pre-compaction save; this replaces it for them.

- `omp/continuity-omp.ts`, loaded by OMP through `package.json` `omp.extensions` (with
  `.omp-plugin/plugin.json`). It imports nothing from the hooks: it spawns the same two hook
  files as stdin-JSON CLIs, so one implementation and one test suite serve both hosts and the
  state (same directory, same snapshot file, same caps, same once-marks) is shared.
  - `session_before_compact` → `hooks/pre-compact.mjs`, with a PreCompact payload built from the
    event: `trigger` (`auto` while an `auto_compaction_start` is in flight, else `manual`),
    `custom_instructions`, and the three host fields `lib/snapshot.mjs` reads from a
    transcript-less host: `intents` (the user texts of the messages the compaction discards, the
    last five, 500 characters each), `file_operations` (the host's read / written / edited paths
    with counts, 6,000 characters), `token_count`. No `transcript_path`. The hook's
    `systemMessage` goes to `ctx.ui.notify`. The handler never cancels a compaction.
  - `session_compact` → `hooks/session-start.mjs` with `source: "compact"`; its
    `additionalContext` (snapshot, rules section, durable notes, liveness line) reaches the agent
    through `pi.sendMessage` as a hidden `continuity-restored` message. Once per compaction
    entry: a repeated `session_compact` for the entry a session last restored or is restoring
    sends nothing; a new entry restores again. That memory is bounded: one entry id per session,
    recorded only when a restore starts, dropped on `session_shutdown`, at most 64 sessions.
  - A `session_compact` with no `session_before_compact` before it (OMP's manual handoff and
    snapcompact frame rescue run no pre-event) is unpaired: the restore runs only when a snapshot
    for the session is on disk, and otherwise nothing is sent, so a host-written handoff is never
    followed by a "save failed, reconstruct" line for a save that never ran. A save whose
    compaction was cancelled pairs with nothing: an aborted `auto_compaction_end` or pre-event
    signal deletes its mark, and a mark pairs only with an entry committed on the branch leaf the
    save ran on.
  - The spawn sets `CLAUDE_PROJECT_DIR` to the session's cwd and `CONTINUITY_HOST_RULES` to
    `CLAUDE.md,AGENTS.md`, the two names OMP's context-file providers load into the system prompt,
    which a compaction keeps: the walk names those as kept by the host and inlines a
    `CLAUDE.local.md` at the same levels, which OMP does not load.
  - Budgets: 8 s per spawn against the runner's 4 s deadline and OMP's 30 s handler timeout; the
    child's process group is killed when it passes. Fail open: every fault is one
    `omp-adapter <hook>: …` line in `errors.log`.
  - Node resolution as brb's adapter: `CONTINUITY_NODE`, else the host binary unless it is Bun,
    else the first `node` on PATH or in the usual places.
- `omp/continuity-omp.test.mjs`: the payload builder, the budgets pinned against
  `lib/hook-runner.mjs` `DEADLINE_MS`, each handler's fail-open path with a fake runner, the five
  registrations and the auto/manual bookkeeping, `spawnHook` on junk / non-zero / hang / echo
  children, one save-then-restore round trip through the real hooks, the restore once per
  compaction entry (sequential and concurrent repeats, a new entry, another session), the
  unpaired `session_compact` cases, the bounded dedup memory (10,000 entries in one session, 100
  sessions, `session_shutdown`), a cancelled save followed by a host-only handoff (auto abort,
  aborted signal, cancelled `/compact`), and a launch directory holding `CLAUDE.md` and
  `CLAUDE.local.md`.
- `evals/pre-compact-omp-payload.scenario.json`: the save on the payload the adapter sends
  (fifteen scenarios in all).
- README "Under OMP": the event mapping, the rules names OMP loads, the once-per-entry restore,
  the lifecycle exclusions (manual handoff, snapcompact rescue), the budgets, and the table of
  what newdle's OMP save did that this does (the unconditional save with the host fields, the
  in-session restore through `sendMessage`, fail open) and does not (the one-time compaction
  cancel, the in-session compaction contribution, the `~/.omp` archive copy, the "no record
  recovered" message, the project-directory and seat gates).

### Changed

- `.claude-plugin/plugin.json`, `.omp-plugin/plugin.json`, `package.json`: 0.3.0; the
  description names the OMP adapter.
- `lib/repo-rules.mjs`: `CONTINUITY_HOST_RULES` (comma-separated file names), when set, narrows
  the launch-directory skip to those names. Unset, as on Claude Code, the walk is unchanged.
- Nothing in the hooks, the config keys or the state layout.

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
