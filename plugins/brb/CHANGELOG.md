# Changelog

All notable changes to brb are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.0] - 2026-11-11

### Added

- The returned digest is worked one item at a time. After `back`, a bare number or `brb item N`
  makes the agent reply with that item in full (its whole held text and entry heading) and work
  it; `done N` or `brb done N` ticks it; `brb clear` closes the list, and the agent first replies
  with every item not done in full, verbatim, and the done ones one line each. The words are read
  by the prompt hook (`lib/text.mjs` `digestWord`, `lib/back.mjs` `showItem`, `tickItem`,
  `clearReturned`); with no list open a bare number or `done N` is an ordinary prompt, and while
  away every word is an answer to the agent.
- `checklist.json` carries each item's full text and heading and the archive paths of every
  hold in it. A second hold while a list is open appends its items, keeping the numbers and
  ticks (`lib/state.mjs` `mergeChecklist`). The last tick closes the list.
- The band's rows have a Show button (hotkey: the row number) beside Done. Show, Done and Clear
  send `brb item N`, `brb done N` and `brb clear` as the person's own prompt, after act.mjs
  `open` confirms the same list is still open; while the agent works the word waits for the
  turn to end.
- Evals: `prompt-item-show`, `prompt-done-ticks`, `prompt-clear-shows-open`,
  `prompt-number-home`; tests in `test/returned-digest.test.mjs`.

### Changed

- `back` replies with a numbered list, one line per held item cut at 120 characters, and how to
  work it, instead of the whole digest. The digest is still archived at `back`.
- A hold that held nothing leaves an open list's rows as they are (it still takes that hold's
  number, below).
- `back` writes `checklist.json` before it moves the digest to the archive, and records how many
  of the hold's items are rows (`taken`), so a `back` that fails part way keeps the hold on and
  a second `back` lists every item once (`lib/back.mjs` `endHold`). The count applies only
  while the digest it counted has not reached its archive (`takenArchive`), so items held after
  a `back` that failed at its last step are all added.
- A second hold while a list is open is additive and does not repeat an item: a new item whose
  text matches one still open (not done) is not appended again.
- A band press on the returned digest waiting for the turn to end is dropped when a new hold
  starts, and act.mjs `open` reports no list while away, so a press made before `brb` never
  reaches the agent as an answer during the hold. Each hold gets a number, one higher than any
  before it in the session (away.json `hold`, kept in `hold.seq`, `lib/state.mjs` `nextHold`),
  and an open list takes the number of each hold that ends into it. The word the band sends
  ends ` @<at>#<hold>`, the open list's `at` and number (`mods/band/data.mjs` `pickPrompt`); the
  prompt hook checks both before any away handling, under the session lock it then does the
  press's work in, and blocks the word with `brb: dropped a band press (…)` when a hold is on,
  that list is no longer open, or a hold began and ended since the press. That covers a `brb`
  typed after the band's check and a whole `brb` and `back` before the word arrives. Typed
  without the token the words behave as before.
- A band press whose check cannot run (the session lock held past its 2 s wait) is dropped by
  rule, with `brb: dropped a band press (…): could not check it …` and one errors.log line,
  rather than reaching the agent unchecked. A fault in the press's work after the check still
  fails open. A typed `3`, `done 3` or `brb clear` now checks home and does its work under one
  session lock, so a `brb` landing between them cannot tick or clear the list during the hold.
- A `brb clear` block or one item longer than 8000 characters is written whole to
  `export/<when>-<what>.md` (fsync'd, its size checked) before the message that points at it,
  and the message is cut and names that file by absolute path; `brb clear` removes
  `checklist.json` only after the export is on disk, and removes nothing when it cannot be
  written (`lib/state.mjs` `writeExport`, `lib/text.mjs` `cutToExport`). Before, the cut text
  pointed at the last archive only, or at the file being removed.
- Under OMP (`BRB_HARNESS=omp`) nothing changes: the adapter never routes the item words, so
  `back` still replies with the whole digest verbatim and opens no list (`lib/back.mjs`).
- An item clears only when the person ticks it; the agent never marks one done.
- `skills/brb/SKILL.md` steps 7 and 8 describe the list and the item words.

### Removed

- `lib/state.mjs` `toggleChecklistItem` (replaced by the idempotent `tickChecklistItem`).
- act.mjs `done` and `clear` verbs: the band no longer writes ticks itself, so the agent is told
  of each one.
- The band's Undo button: a tick is final once the agent has been told.

## [0.5.0] - 2026-11-10

### Added

- While away, the transcript rows of the hold are kept off the screen: `mods/band/register.mjs`
  registers `ui.render` hooks on `AssistantMessage`, `ToolUse`, `ToolResult` and `ToolGroup`
  (raised on the terminal, Desktop and VS Code) that draw one dim line `held while away · say
  back` per run of hidden rows and an empty Box for the rest of the run. `UserMessage` is watched
  only so your prompt ends a run. The hooks return their own tree and never call `next`, so no
  stored message changes.
- `mods/band/hide.mjs`: the ledger that tells the hold's rows by id (the row sites carry no
  time). Rows drawn, and tool calls started, while home predate the hold; rows first drawn during
  it are hidden; a `ToolGroup` only when none of its calls predates it; at `back` the hold's rows
  join the past, so the next hold hides only its own. Before the first query answers and after a
  failed query no row is hidden and nothing is recorded. A reply with an `on fire:` line (the Stop
  hook's parser, `lib/sections.mjs` `splitNeedsYou`) is never hidden. Ids only, at most 20,000
  per set and none ever dropped: a row's ids are kept all together or not at all (a `ToolGroup`
  that does not fit leaves none of its calls behind); once they do not fit, the ledger is full
  and, for the rest of the conversation, hides only rows it already hid in the current hold (a
  forgotten id is never taken for a new row). No row text is kept.
- On `back` (or any end of the hold) the mod calls `$.ui.invalidate("ui.render")` and every row
  draws as before.
- A switch: `{ "hideRows": "off" }` in `${XDG_CONFIG_HOME:-~/.config}/brb/config.json` turns the
  row hiding off (lib/state.mjs `hideRowsEnabled`, read by `mods/band/query.mjs` on every query,
  carried as `hideRows` in its answer). On with no file or no key; off for `"off"`, `false`, any
  other value, or a file that cannot be read or parsed. Switching it off moves every row hidden so
  far into the past at once, drawn again or not, so switching on again hides only rows first
  drawn after that; the mod redraws the rows whenever it flips.
- The away text: while away the mod appends a fixed instruction (work without narration, hold
  each ask with the hold command, reply only with the still-away line, the body and
  `idle: <why>`) to the environment section of the system prompt (`prompt.section` on
  `env_info_simple` and `env_info_static`), after `$.ui.invalidate("prompt.section")`. Every field
  of the answer the hook got from `next` is kept, its own `breakPromptCache` included, home and
  away; brb adds `breakPromptCache: true` when the away state changed since that section name's
  last answer (tracked per name). A turn that began home and is running when `brb` lands gets the
  same text once as `context` on the main agent's next tool result (`tool.call`), in process.
- A resumed conversation drops a saved away text: the mod records the away state each section
  name last carried in `<state>/brb/<session>/section.json` (`$.fs.write`, only when that state
  changes, so a session never away has no file; `scripts/prune.mjs` ages it out after 30 days
  like the rest). At a name's first answer in a conversation (a `/resume`, a restarted Claude
  Code), a file that says away while the session is home makes that answer carry
  `breakPromptCache: true` once and records home. A session never saved away, a missing,
  unreadable or unparsable file, or one saved away and resumed still away: no break, no throw.
  The section state belongs to one conversation (one object, replaced at `session.end`): a
  resumed conversation's first answer is seeded only from its own section.json, never from what
  an earlier conversation in the same process answered, and a section hook whose section.json
  read finishes after a `/clear` or `/resume` returns core's answer and records or writes nothing.
- Tests: `mods/band/tests/hide.test.mjs` (the away window, runs, the on-fire exemption, the end
  of a hold, the section's cache rule); `register.test.mjs` (rows replaced while away and drawn
  after back, a failed query, a faulting hook, `session.end`, the section, the mid-turn
  reminder); `band.test.tsx` under `claude plugin test` (rows mounted in a Desktop and a terminal
  session, an empty Box accepted, rows redrawn after back, the section, the reminder, the
  `hideRows` switch, another hook's cache break). `test/state.test.mjs` and `query.test.mjs`
  cover `hideRows` read from config.json. `register.test.mjs` and `band.test.tsx` cover the
  resume: saved away and resumed home breaks once, then never; never away, missing, unreadable
  or corrupt file: no break; an away predecessor followed by a home resume with a missing,
  corrupt or home marker: no break; an old conversation's read finishing after `/resume`: the new
  conversation still breaks once and only its own answer records it home.

### Not covered

- Permission prompts (not a render site), Desktop's own task rows, and possibly the terminal's
  in-flight streaming preview still show while away. A MessageDisplay hook is deferred until a
  live test shows streaming text leaks.

## [0.4.2] - 2026-11-10

### Changed

- The Back button ends the hold itself. `mods/band/register.mjs` runs `act.mjs back` (now
  read-only: is the session away, and since when?) and then `$.prompt.submit({ text: "back",
  asUser: true })`, the call Claude Code makes for a typed prompt, so
  `hooks/user-prompt-submit.mjs` ends the hold exactly as for `back` typed. A press is bound, the
  moment it is accepted, to the hold the band drew (its `since`), and every check, the first
  included, must report that same hold. Idle, it is sent at once; while a turn runs (the turn
  events, or before any, the band's `isWorking`), the press waits for that turn's end, asks
  act.mjs again, and sends only if the same hold is still on, so a `back` typed meanwhile or a
  new `brb` drops the press without a word. The call is never awaited. A toast says `brb: Back pressed, ending
  the hold`; the band reads `Back pressed · ending the hold` until a query sees the hold gone, and
  further presses send nothing (a failed query does not re-arm it); a refused or dropped prompt
  toasts `brb: Back failed: <reason>; type back` and the button works again, except one from an
  earlier conversation, which says nothing. In 0.4.1 a press only left a marker that waited for
  the next prompt or stop, so with the agent idle nothing happened.
- The digest's `held since` and each entry's heading print local time (`2026-11-10 5:50 PM PST`,
  `lib/state.mjs` `localTime`, the zone from `TZ` or the machine). `away.json`, `checklist.json`
  and archive file names keep ISO times.

### Removed

- The `back-requested` marker: `lib/state.mjs` `requestBack`, `backRequested`, `takeBackRequest`,
  `backRequestPath`; its handling in `hooks/user-prompt-submit.mjs`, `hooks/stop.mjs` and
  `lib/back.mjs`; `backRequested` in `mods/band/query.mjs`; the `back` prompt-box suggestion after
  a press. A marker left on disk by 0.4.0 or 0.4.1 is ignored.

## [0.4.1] - 2026-11-10

### Changed

- `scripts/prune.mjs` is plugin-kit 0.4.1's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged.
- The re-copied prune skips symlinks (a linked `x.log` is never rotated over its `.1`) and a dry run no longer counts an expired `.1` twice: its totals are the real run's (plugin-kit 0.4.1's fix).

## [0.4.0] - 2026-11-04

The footer status row was the wrong surface. Jo, 2026-11-04, on the 0.3.x badge in Desktop:
"completely unusable" (a grey footnote cut at 32 characters beside the model picker), and, on the
list that `back` wiped from view: "bad UX to make that list disappear". 0.4.0 moves the hold into
a band above the prompt and keeps the list there after `back`.

### Added

- `mods/band/` (replaces `mods/badge/`): a Claude Code mod drawing the `AbovePrompt` band. While
  away: a gold-bordered band, bold headline `AWAY <dur> · N held` (` · <note>` while the headline
  stays within 40 characters), the muted `F on fire came through · the rest wait for you` line
  when F > 0, the held items numbered (at most 10 rows, then `+N more`, cut with `…` at the band's
  width) and a Back button; the empty prompt box suggests `away <dur> — type back`.
- After `back`: the band stays as a checklist on a blue border, `BACK · N to act on`, a Done
  button per row (struck and dim once done, Undo puts it back) and Clear. It clears when every
  row is done or on Clear. Done is cosmetic; the agent is told nothing.
- `checklist.json` in the session directory, written by `back` from the digest's items
  (`lib/back.mjs` `endHold`, shared by both hooks). A hold that held nothing writes none; holds
  while home never make one. `lib/state.mjs`: `digestItems`, `readChecklist`, `writeChecklist`,
  `toggleChecklistItem`, `clearChecklist`, `requestBack`, `backRequested`, `takeBackRequest`.
- The Back button: a mod cannot run a hook, so it leaves a `back-requested` marker
  (`mods/band/act.mjs back`) and suggests `back` in the prompt box. `hooks/user-prompt-submit.mjs`
  honours the marker on the next prompt, whatever it says, exactly as `back`; `hooks/stop.mjs`
  honours it at the next stop by ending the hold and blocking that stop once with the digest. A
  stale marker while home is removed.

### Changed

- The band restarts with the conversation: `/clear`, `/resume` and `/branch` fire `session.end`
  and then `classic.SessionStart` (source `clear`, `resume`, `fork`), never `session.start` again,
  so the mod listens for both and starts over (one probe, one poll, the band from the new
  conversation's state, the fallback line armed again); an answer from the last conversation that
  lands after the restart is dropped.
- The checklist puts rows still to act on first (in their own numbers), done rows after them while
  there is room, then one `N done` line; `+N more` counts only rows still to act on, so an open row
  and its Done button are never hidden behind done rows.
- Every drawn line fits the band's width: a finite width is clamped at 0, the headline is capped
  at 40 characters, and below 26 inner columns each button goes under its text.
- `$.ui.status` is a fallback only: set where the band's render site is never asked to draw
  (from the first timer tick), cleared the first time the band draws.
- The 5 s poll runs while away or while a checklist is up; the 1 s `$.fs.exists` probe only when
  home with no checklist. `session.end` cancels both timers.

### Removed

- `mods/badge/` (register, data, query and their tests).

## [0.3.1] - 2026-11-04

The badge never showed in Claude Desktop (live report, 2026-11-04). Desktop runs Claude Code
headless (`--input-format stream-json`), so `session.start` carries `surface: null`; 0.3.0 read
that as "nothing draws" and never set the status line or started its timers. Desktop does draw
the line: it renders the `ui_status` message that `$.ui.status` sends.

### Fixed

- `mods/badge/register.mjs`: no surface gate. Every session queries at start, installs the 1 s
  home probe and the 5 s away poll, refreshes at each prompt and main turn, and sets the line
  with `$.ui.status`. Where no host draws `ui_status` (`claude -p`, OMP) the call goes nowhere,
  as before.
- Tests: `mods/badge/tests/badge.test.tsx` and `mods/badge/tests/register.test.mjs` start the
  session as Desktop does (`surface: null, isInteractive: false`) and as the terminal does
  (`surface: "terminal"`) and assert the line is set in both; the "surface null → nothing" test
  is gone. `badge.test.tsx` now runs under `claude plugin test`.

## [0.3.0] - 2026-11-04

A badge while you type into a session you left. A person who comes back to a Desktop window
and starts typing had no sign that the hold was still on: the agent would carry on writing its
asks into the digest while they expected to be asked. Now the hold is on screen where the typing
happens.

### Added

- The away badge, a Claude Code mod (`hooks/hooks.json` `modules` → `mods/badge/register.mjs`;
  Claude Code 2.1.286 or later, where plugins can ship mods). While this session is away, brb's
  status line under the prompt reads `⚠ brb: away 40m · lunch · 12 held · say back`, never more
  than 40 characters: when the line would pass 40 the `brb <note>` text is dropped whole, then
  `· say back`, and a count too long even for that is cut with `…`; home, the line is removed.
  The data is this session's `away.json`, read out of process by
  `node mods/badge/query.mjs --session <id>` (`mods/badge/query.mjs`, read-only; it prints
  `{ ok, away, since, note, held, onFire }` or `{ ok: false, error }` and always exits 0;
  `away.json` is opened once without following a link, the open descriptor must be a regular
  file of at most 64 KiB, and at most 64 KiB + 1 byte is read from it, so a directory, a link
  or a file over 64 KiB, even one swapped in or grown after the check, is a fault, never a
  parse; `lib/state.mjs` `parseAway` is the parsing half of `readAway`, shared by both). The
  badge refreshes at session start, after each prompt enters (so `brb` and `back` show at
  once), at each main turn's start and end, and every 5 s while away; while home the only poll
  is `$.fs.exists` on `away.json` inside Claude Code once a second, which starts a query when
  the file appears. A probe that fails (the session id or `$.fs.exists` refused) is caught in
  the timer, clears the badge and logs one `brb badge: probe: …` line per distinct error.
  `mods/badge/data.mjs` holds the pure parts (the snapshot read back, the line, the duration
  format, the `away.json` path).
- Tests: `mods/badge/tests/data.test.mjs`, `mods/badge/tests/query.test.mjs` and
  `mods/badge/tests/register.test.mjs` under `node --test` (home, away, the held count moving,
  another session's hold, the directory, link and oversized faults, a file replaced or grown
  after the check, the 40-character line for every note and count, the two timers, a refused
  probe); `mods/badge/tests/badge.test.tsx` for `claude plugin test`
  (the status line set and cleared, the refresh points, the poll and the probe, the fault
  inputs), written in the style of the ledger pane's test and not run by this version's
  author. `evals/manifest.json` `manual` names the Desktop check.

### Unchanged

- The hooks, the OMP adapter, the hold command and the away instruction. The badge draws
  wherever Claude Code hands the mod a surface (Desktop, the terminal, VS Code); where none is
  (`claude -p`, OMP), nothing new shows; the hooks' own lines (`brb: away since …; N held` at
  SessionStart, the confirmation at `brb`) cover it.

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
