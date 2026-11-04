# Changelog

All notable changes to brb are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-11-04

While away, asks are written, not shown: a `## Needs you` section that the Stop hook filed
still rendered on screen, so the person read it and came back, which is the one thing the
hold exists to prevent.

### Added

- `scripts/brb.mjs hold [--session <id>] "<one item, readable on its own>"`: appends the item
  to the session's digest, bumps the held count and prints `held N`. Deduplicated by the Stop
  hook's own rule (`lib/sections.mjs` `normalizeLine` against `away.json` `seen`), so an item
  held here and restated under `## Needs you` lands once. Not away → `not away; say it to Jo`,
  exit 0, nothing written. The session is `--session`, else `BRB_SESSION_ID`, else
  `CLAUDE_CODE_SESSION_ID`, else the one away session; several away and none named → exit 1
  with the ids. The hooks render the command into the away instruction with the script's
  absolute path and the session id (`lib/text.mjs` `holdCommand`, `HOLD_SCRIPT`).
- The Stop hook's backstop (`lib/stop-core.mjs`): a message that still shows an ask (a
  Needs-you item or a closing ask) is filed as before and then blocked once, `decision:
  "block"` on both harnesses, with `brb: N item(s) moved to the digest; do not restate them —
  reply with the body only and end with \`idle: <why>\`.` (`lib/text.mjs` `backstopReason`).
  Once per turn: `away.json` `backstopped` is set by the block and cleared by the next stop that
  is not a continuation, so the reply after the block goes through the release rules; the
  backstop also yields once `idleStops` tool-less stops have passed.
- The still-away line: while away every reply starts with `brb: still away (<duration>, N
  held) — say \`back\` to read them` (away instruction rule 5, `lib/text.mjs`
  `replyFirstLine`), and the backstop blocks a reply with text whose first line is not it,
  once per turn under the same rule as the ask backstop, with `firstLineReason`; a reply that
  misses the line and shows asks gets one block naming both.
- A fire answered does not end the hold (rule 6): Jo's reply to a fire is not `back`; answer
  it, then back to body-only replies and `idle:`. Why: an agent that answered a fire took Jo's
  reply as the end of the hold and went back to chatting.
- Scenarios: `stop-away-working` (the keep-working `additionalContext`), `stop-away-backstop-once`
  (the same message again on the continuation is silent), `stop-away-held-by-command` (an item
  held by the command is not filed twice by the stop); `test/hold.test.mjs`.

### Changed

- The away instruction's rule 2 (`lib/text.mjs` `awayInstruction`) names the hold command and
  says the reply has no `Needs you` section, no question sentence and no closing ask; rule 4 no
  longer invites a closing ask after `idle:`. Its first line is now `brb: still away since
  <since> (<duration>); N held` (`stillAwayLine`, `awayFor`), so every prompt while away says
  the hold is still on; the note moves to line 2. The `brb` skill says the same.
- `back` is answered by the agent, not shown as a hook frame. Why: on 2026-11-04 Jo typed
  `back` from the Claude mobile app; the hook archived the digest (six sections) and blocked
  the prompt with it as the reason, and the app, which renders no `UserPromptSubmit` block
  message, showed nothing. Now `back` while away archives and clears as before but does not
  block: the prompt goes through with `additionalContext` = `brb: Jo is back (away
  <duration>). Reply with the digest below verbatim as your whole message, then stop (end
  with nothing else). If a held item is already resolved, append '— resolved: <how>' to that
  line.` over `brb: hold cleared; digest archived to <path>.` and the digest (`lib/text.mjs`
  `backInstruction`), and the same archive-line-plus-digest as a `systemMessage` for the
  surfaces that render frames. `back` while not away passes through with `brb: you were not
  away; nothing held` as `additionalContext` (`NOT_AWAY_TEXT`) instead of silently. The
  `brb` skill's step 7 says what to do with the context. On OMP the adapter awaits the prompt
  hook on `back` (OMP awaits `input` handlers), stages the hook's context for
  `before_agent_start` (`stagedBack`, cleared by the next input and by `session_stop`), notifies
  the archive line and lets the word through, so the agent's reply is the digest there too;
  `brb` and `pending` are handled as before. `evals/prompt-back` expects `systemMessage`.
- A second `brb` while away is no longer blocked: it passes through with ``brb: still away since
  <since> (<duration>); N held. Only `back` ends the hold; `pending` peeks. Your questions
  answered while away did not end it.`` as a `systemMessage` and at the head of the agent's
  context (`alreadyAwayText`), and changes nothing on disk; on OMP the adapter shows that line
  and starts no turn.
- A closing ask is held (`closing ask: <text>`), deduplicated and counted like a section line;
  before, it rode along only when the same message had a new Needs-you line and was not counted.
- `stop-away-asks` and `stop-away-asks-omp` expect `deny` (the backstop); `stop-away-on-fire`
  raises its fire outside a `Needs you` section; `prompt-other-while-away` looks for the new
  rule 2. Every away Stop scenario's message starts with the still-away line.
- README: the contract in one paragraph up top, the hold command, the backstop, a "what you
  see" table. The marketplace description and the root README row say the same.

### Fixed

- The backstop resets per human turn: every prompt while away except `pending` clears `backstopped` and `toolLessStops` in `away.json` (prompt hook `newTurn`). On OMP the adapter runs the prompt hook for ordinary text and waits for it before the prompt proceeds (OMP awaits `input` handlers; `newTurnHandler`), so the reset is on disk before the turn starts: a Stop of the new turn cannot run ahead of it, and it cannot land after that Stop and wipe the once-per-turn flag (Codex R2, B1; the earlier background spawn could do both).
- `hold`, `brb`, `back`, the new-turn reset, the Stop hook's read-merge-write and `pending`'s read are serialized per session by `away.lock` (`lib/state.mjs` `withAwayLock`: O_EXCL create holding `<pid> <token>`, 2 s wait) with a re-read inside it, so a `back` between hold's read and its write prints `not away; say it to Jo` and writes nothing instead of recreating the hold. A lock is taken over only when its holder's pid is dead (`kill(pid, 0)` → ESRCH) or the lock is older than 60 s; a live slow holder is waited on for the 2 s and then the caller fails closed (`hold`: `brb: the hold is locked (<path>, held by pid N); try again in a moment`, exit 1; the Stop hook: its write-error path; `pending`: logged, the word proceeds). Takeover is a rename then a remove, and release removes the lock only while it still holds the caller's token, so two waiters cannot each remove the other's fresh lock (Codex R2, B2; the earlier lock was age-only at 10 s and could displace a live holder).
- The Stop hook merges under the lock (`lib/stop-core.mjs` `decideStop`): the record is re-read inside `withAwayLock` and the digest merge, counts, backstop flag and write all happen there, so an item the hold command files while a stop is computing is in `seen` and counted once, not overwritten by the stop's stale copy (Codex R2, S1; before, the state was computed from a read taken before the lock). The fire output still comes from the first read, before the lock, so a locked state directory cannot swallow a fire.
- `pending` reads the record and the digest under the lock, so a digest a writer is mid-way through (lines appended, count not yet written) is never shown (Codex R2, S2).

### Unchanged

- `pending` prints the digest as before, and `back`'s text is the same digest; its entries
  now come from both sources, each once. The on-fire path, the release rules (`idle:`, the
  guard, `idleStops`, three quiet
  continuations) and `lib/hook-runner.mjs` (plugin-kit 0.3.2's, byte for byte; the kit's 0.3.2
  did not touch it).

## [0.1.1] - 2026-11-04

### Changed

- `lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.2.1's): the handler thread's
  env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, a process group
  the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits, and it now
  waits for stdout to drain before it exits, bounded by the same deadline, so an
  answer larger than one 64 KiB pipe buffer is no longer cut short (a host that never reads gets
  exit 0 at the deadline and one `stdout not drained` errors.log line). brb's hooks
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
