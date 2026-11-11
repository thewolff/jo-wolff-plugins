# brb

Type `brb` and walk away. The agent keeps working; every question it would have stopped to ask
you waits in a digest; the five things that cannot wait (a broken main, data loss, a security
finding, spend near a ceiling, a blocker on everything) still come through at once. Type `back`
and read the digest.

**While away, asks are written, not shown.** A question on screen pulls you back to a screen
you left, so since 0.2.0 the agent files each ask with a command
(`node "<plugin>/scripts/brb.mjs" hold --session "<id>" "<item>"`) and its reply says only what
was done, ending `idle: <why>` when nothing is runnable. A reply that still shows a `Needs you`
section or a closing ask is filed by the Stop hook and sent back once, body only. On-fire lines
are the one thing that still reaches you at once.

| | What the agent's reply shows | What you see |
|---|---|---|
| away | first line `brb: still away (<duration>, N held) — say \`back\` to read them`, then the body: what was done, ending `idle: <why>` when nothing is runnable; no `Needs you`, no question, no closing ask | the still-away line at the top of every reply; `brb on fire: …` for a fire; `brb: the agent is idle (<why>); N held` when it stops; on Claude Code, the away band above the prompt: `AWAY 40m · N held`, the held items, a Back button |
| you answer a fire (or anything) while away | your answer handled, then the same shape as away | the hold continues; the away instruction is re-injected on every prompt, and only `back` ends the hold |
| back | the digest, verbatim, as its whole reply: `brb: hold cleared; digest archived to <path>.` then every item the command held and every one the backstop moved, each once; an item it already resolved ends `— resolved: <how>` | that reply, on every surface (terminal, desktop, mobile app); on the surfaces that render hook frames, the same text once more as a hook line; on Claude Code the band stays, now a checklist: `BACK · N to act on`, Done per row, Clear |

Built on plugin-kit 0.3.2. Claude Code hooks, a Claude Code mod for the away band, plus an OMP
extension that runs the same hooks. Node 22.13 or later. No other plugin is needed.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install brb@jo-wolff-plugins
```

On OMP, from a shell: `omp plugin marketplace add thewolff/jo-wolff-plugins` then
`omp plugin install brb@jo-wolff-plugins`; [`omp/REGISTRATION.md`](omp/REGISTRATION.md) has
the fallbacks and the exact reversal.

## Usage

Three words, each typed as the whole prompt (any case; trailing `.`, `!` or `?` allowed; `brb, lunch`
and `brb: lunch` carry a note too). `brb` and `pending` start no turn; `back` starts one whose
reply is the digest.

| You type | What happens | What you see |
|---|---|---|
| `brb` or `brb <note>` | the hold begins: `away.json` is written for this session | `brb: holding needs-you items until \`back\`; on-fire items still come through` (the note appended) |
| `pending` | nothing changes | the digest so far, under `brb digest — held since <when>, N items` (`<when>` and each entry's heading in local time, `2026-11-10 5:50 PM PST`) |
| `back` | the digest is archived to `archive/<when>.md`, the hold ends, and the prompt goes through with the digest and `brb: Jo is back (away <duration>). Reply with the digest below verbatim as your whole message, then stop …` as `additionalContext` (plus the digest as a `systemMessage`) | the agent's reply: `brb: hold cleared; digest archived to <path>.` first, then the digest |

An empty digest shows `(nothing held)`. A `back` or `pending` text longer than 8000
characters is cut at a line and ends `… (N more lines; full digest: <path>)`; the archive keeps
every line. Why `back` is answered by the agent and not shown as a hook frame: the Claude
mobile app renders no `UserPromptSubmit` block message, so a `back` typed there archived the
digest and showed nothing; an assistant message renders on every surface. `pending` while not
away is passed to the agent as an ordinary prompt, and `back` while not away too, with
`brb: you were not away; nothing held` as `additionalContext`, so a one-word answer to an
agent's question ("revert or go back?") is not swallowed. A second `brb` while away changes
nothing and is not blocked: you see ``brb: still away since <when> (<duration>); N held. Only
`back` ends the hold; `pending` peeks. Your questions answered while away did not end it.``,
and the agent gets the same line over the away instruction, so it goes back to holding. (On
OMP the adapter shows that line and starts no turn; on `back` it stages the digest context for
the turn and lets the word through, so the agent's reply is the digest there as well.)

Typing anything else while away, an answer to an `on fire:` line included, does not end the
hold: the instruction, whose first line says the hold is still on, rides along with your
prompt. It is a new turn, so the Stop hook's per-turn state in `away.json` (`backstopped`,
`toolLessStops`) starts over; nothing else there changes.

While away, every other prompt you type (or that a scheduled run types) proceeds, carrying the
away instruction below as `additionalContext`; a resume, clear or compaction carries it again
at SessionStart with one line for you (`brb: away since <when>; N held. Type \`back\` to read
them.`).

## The contract

This is the away instruction, exactly as the agent reads it each turn while you are away
(`lib/text.mjs` `awayInstruction`; the first line, rule 5 and the last line carry the live
values, and rule 2 carries the hold command with the plugin's absolute path and this session's
id filled in):

```
brb: still away since <since> (<duration>); <N> held
Jo is away (<note>). Keep working; do not stop to wait for an answer.
While away:
1. Keep working on the next open item. Choose the safer reversible option yourself where a choice is small; where it is not, write the ask down (rule 2) and move to the next item.
2. Every question, decision or approval you need from Jo is written, not shown: run node "<plugin>/scripts/brb.mjs" hold --session "<session>" "<one item, readable on its own>" once per item, then leave it out of your reply. While away a reply has no `Needs you` section, no question sentence and no closing ask; it says only what was done. The command prints `held N`; a held item is not lost, so do not restate it. A Stop hook moves any `Needs you` section or closing ask that still appears into the digest and sends the reply back once.
3. Start a line with `on fire:` only for one of these: a broken main branch, data loss, a security finding, spend near a ceiling, or a blocker on everything you could work on. Those lines reach Jo at once. Anything else waits in the digest.
4. When nothing is runnable without Jo, end the message with a line `idle: <why>`. brb then lets the turn end; without that line a Stop hook sends you back to work.
5. Start every reply with this line, as its first line: brb: still away (<duration>, <N> held) — say `back` to read them. A Stop hook sends a reply without it back once.
6. A fire answered does not end the hold. When Jo replies to a fire or answers a question, answer that, then go back to body-only replies ending `idle: <why>` when nothing is runnable. Jo's reply is not `back`; only the prompt `back` on its own ends the hold.
<N> items held so far.
```

The on-fire kinds mirror agent-system 2.0's surface (`surface/src/batch.ts` `onFire`), so an
agent that already writes for as2 writes the same thing here.

## The hold command

`node "<plugin>/scripts/brb.mjs" hold [--session <id>] "<one item, readable on its own>"`
appends the item to the session's `digest.md` under a timestamp heading, bumps the held count
in `away.json` and prints `held N`. Items are deduplicated by the Stop hook's own rule
(`lib/sections.mjs` `normalizeLine`: list marker, bold, case and spacing dropped), so holding an
item twice, or holding it and then restating it under `## Needs you`, lands it once and prints
the unchanged count. Unquoted words join with one space; `--` ends the flags.

The session is `--session` (the away instruction renders the command with it), else
`BRB_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`, else the one session under the state directory
that is away. Several away and none named → `several holds are away (…); pass --session <id>`
on stderr, exit 1, nothing written. Not away → `not away; say it to Jo`, exit 0, nothing
written: the agent asks in its reply as usual. No item text or an unknown verb → usage, exit 1.
A state directory that cannot be written → the error on stderr, exit 1; the agent falls back
to showing the ask once, and the backstop files it.

The agent's shell has no `CLAUDE_PLUGIN_ROOT`, so the hooks render the command with the
script's absolute path (`lib/text.mjs` `HOLD_SCRIPT`, from the plugin's own location) and the
session id they were given.

## What the Stop hook does while you are away

On every finished message (`hooks/stop.mjs`, the rules in `lib/stop-core.mjs`):

1. **Split the message.** The `Needs you` section (`## Needs you`, `**Needs you**`,
   `Needs you:`, any depth or case; a leading list number or emoji and a trailing count,
   parenthetical or ` — …` are allowed, so `## Needs you (2)`, `**Needs you** — 2 items`,
   `1. **Needs you**` and `### 🔴 Needs you` all open it; it ends at the next heading, bold label
   line or rule). An indented line that is not a list item joins the item above it; a line that
   only says there is nothing (`None.`, `Nothing right now.`) is not an item. Every line starting
   with `on fire:` anywhere in the message (bold, list markers, a `>` quote and a leading emoji
   allowed; `on fire: none`, `nothing` or `n/a` is a status, not a fire). A `Closing ask:` line or
   section, and an `idle: <why>` line among the last five non-blank lines. Needs-you lines
   already held this hold (by the command or an earlier stop) are dropped, so an ask restated
   after a block lands once; a closing ask is held as `closing ask: <text>` under the same rule
   and counted.
2. **Surface the fires first.** New on-fire lines are **not** written to the digest. They come
   back as a `systemMessage` (`brb on fire: <text>`, shown in the transcript), a
   `terminalSequence` carrying an OSC 9 notification (terminals that render it show a banner;
   Claude Code passes the bytes through), and on macOS a best-effort
   `osascript -e 'display notification …'` that is never awaited and never fails the hook. This
   happens before anything is written, so a state directory that cannot be written does not
   swallow a fire. A fire restated on the continuation right after the stop that raised it is
   not repeated; the same fire on a later turn notifies again. Past `onFireCap` fires in one
   hold (default 3) the line still surfaces and the message adds `(on-fire cap of N passed this
   hold: M so far; check the tagging)`.
3. **Hold the asks.** New Needs-you lines go to `digest.md` under a timestamp heading, with the
   closing ask when there is one. The count in `away.json` goes up. If `back` ended the hold
   while the hook ran, nothing is written and the hold stays ended.
4. **The backstop.** If the message showed an ask at all (a Needs-you item or a closing ask,
   new or restated), the stop is blocked once, `decision: "block"` on both harnesses, with
   `brb: N item(s) moved to the digest; do not restate them — reply with the body only and end with \`idle: <why>\`.`
   (N is what the message showed). Once per turn: the block sets `backstopped` in `away.json`,
   and the next stop that is not a continuation (`stop_hook_active` false and a different
   message) clears it, as does every prompt you type while away (`pending` aside), which also
   zeroes the tool-less count. So the reply after the block, restated word for word or not,
   goes through the rules below and cannot loop here, and your next turn is backstopped again
   even if its reply is the same. The backstop also yields once `idleStops`
   tool-less stops have passed (the hard stop below). The same block, under the same
   once-per-turn rule, covers the still-away line: a message with any text whose first
   non-blank line (past `>`, `*`, `_` or a backtick) does not start `brb: still away` is sent
   back with: brb: every reply while away starts with the line ``brb: still away (<duration>, N held) — say `back` to read them``; reply again with that line first.
   (`lib/text.mjs` `firstLineReason`); a message that misses the line and shows asks gets one
   block whose reason carries both sentences. A message with no ask shown and the line first,
   fires or not, is never backstopped.
5. **Send the agent back to work** with the text
   `brb is holding your asks (N in the digest). Keep working on the next open item; if nothing is runnable end with a line \`idle: <why>\`.`
   On Claude Code it goes out as `hookSpecificOutput.additionalContext`; under the OMP adapter
   as `decision: "block"` with that `reason`. The turn ends instead when one of four things is
   true:
   - an `idle:` line is among the message's last five non-blank lines (you see
     `brb: the agent is idle (<why>); N held; type \`back\` to read them.`);
   - `stop_hook_active` is true, the message brought no new Needs-you or on-fire line, **and**
     no tool was called since the previous stop (the guard against a loop that will never
     resolve; nothing is shown). An agent that called tools and has nothing new to ask is still
     working, so it is sent back to work, up to the ceiling below;
   - `idleStops` stops in a row (default 2) came with no tool call between them. The count is
     the tool calls in `transcript_path` after the line recorded at the previous stop: Claude
     Code's `tool_use` blocks in `assistant` rows and OMP's `toolCall` blocks in `message` rows
     with role `assistant`. When the transcript cannot be read (no path, as on OMP with
     `--no-session`, or a missing file), every `stop_hook_active` stop counts as tool-less,
     because nothing proves a tool ran, and a first stop counts as tool-less when its message is
     byte-identical to the previous stop's. A tool call resets the count. You see
     `brb: 2 stops with no tool calls between them; letting the agent stop. N held; …`;
   - three `stop_hook_active` continuations in a row brought nothing new, whatever tools they
     ran (the ceiling for an agent that calls a tool on every stop and never raises anything or
     writes `idle:`). A continuation with a new Needs-you or on-fire line, or a stop that is not
     a continuation, resets the count (`nothingNewStops` in `away.json`). You see
     `brb: released the agent after 3 continuations with nothing new; N held; …`.

Not away: the hook prints nothing and the stop proceeds.

**Why `additionalContext` for keep-working on Claude Code, and a block for the backstop.** The
hooks reference, fetched 2026-11-04 (https://code.claude.com/docs/en/hooks), Stop decision
control: `additionalContext` is "Non-error feedback for Claude. The conversation continues so
Claude can act on it, but unlike `decision: "block"` it is shown in the transcript as hook
feedback rather than a hook error", and it "keeps the conversation going through the same loop
protections as `decision: "block"`, namely the `stop_hook_active` input and the
8-consecutive-continuation cap, but the transcript labels it `Stop hook feedback` and no hook
error notification is shown". So the routine keep-working answer does not show as a hook
error, and a real `failed open` stays visible. The backstop is the one case where the reply
itself was wrong (it showed an ask), so it is a `decision: "block"` with the reason, the shape
both harnesses treat as "do not end here": the agent answers again with the body only. OMP's
`session_stop` takes `{ decision: "block", reason }` for both.

**The guard and the ceiling.** The guard above releases a continuation only when it is
tool-less and brings nothing new, so a working agent with nothing to ask is sent back to work.
On its own that leaves one unbounded case: an agent that calls trivial tools forever with no
ask, no fire and no `idle:` line, which Claude Code's cap does not end (it resets on each tool
call) and OMP does not cap at all. The ceiling bounds it: three quiet continuations in a row
end the turn. The price is that a working agent that raises nothing is let go after three
quiet steps; any new ask or fire resets the count.

## Away band (Claude Code)

A band above the prompt, drawn by a Claude Code mod (Claude Code 2.1.286 or later, where
plugins can ship mods; `hooks/hooks.json` names the module, `mods/band/register.mjs`), on the
`AbovePrompt` render site. While this session is away it carries the digest:

```
╭──────────────────────────────────────────────────────────────────────╮
│ AWAY 40m · 3 held · lunch                                   [ Back ] │
│ 1 on fire came through · the rest wait for you                       │
│ 1. Create the read-token secret on the org?                          │
│ 2. Billing limit on the org: raise it?                               │
│ 3. Clear the review round                                            │
╰──────────────────────────────────────────────────────────────────────╯
```

- **The headline**, bold, on a gold border and a tinted background: `AWAY <how long> · N held`,
  with ` · <note>` (the `brb <note>` text) only while the headline stays within 40 characters;
  past that the note is dropped. The word AWAY carries the state; the colour never does alone.
- **The sub-line**, muted: `F on fire came through · the rest wait for you`, absent when no fire
  came through.
- **The held items**, numbered, one row each: every item line and closing ask in `digest.md`,
  cut with `…` at the band's width; at most 10 rows, fewer when the band has fewer rows to give,
  then `+N more`.
- **The prompt box** suggests `away 40m — type back` while it is empty (`$.prompt.suggest`; Tab
  takes it). Claude Code shows no suggestion while a turn runs or in a headless session.
- **No emoji**, single-width symbols only.

**After `back` the list stays.** `back` (typed, or the Back button) writes the digest's items to
`checklist.json`, and the band turns into a checklist on a blue border:

```
╭──────────────────────────────────────────────────────────────────────╮
│ BACK · 2 to act on                                         [ Clear ] │
│ 1. Create the read-token secret on the org?                 [ Done ] │
│ 3. Clear the review round                                   [ Done ] │
│ 2. Billing limit on the org: raise it?                      [ Undo ] │  ← struck, dim
╰──────────────────────────────────────────────────────────────────────╯
```

Rows still to act on come first, in their own numbers; done rows follow, struck, while there is
room, and when there is not they fold into one `N done` line. `+N more` counts only the rows still
to act on that did not fit, so a row you have not done is never hidden behind a done one. On a
narrow band (under 26 columns inside the border) each button sits under its text instead of
beside it, and no line runs wider than the band.

Done strikes a row and keeps it (Undo puts it back); the choice is saved in `checklist.json`, so
it survives a restart of the window. The band clears when every row is done, or on Clear. A hold
that held nothing leaves no checklist. Items held while you are home never make one.
**Done is cosmetic: it tells the agent nothing.** The agent learns what you resolved from what
you type, the same as before.

**What the Back button does, per host:**

| host | press Back |
|---|---|
| Claude Code, terminal | the button sends `back` as your own prompt (`$.prompt.submit({ text: "back", asUser: true })`, the same call Claude Code makes for a typed prompt), so the prompt hook ends the hold exactly as `back` typed does and the agent replies with the digest. A toast says `brb: Back pressed, ending the hold` and the band reads `Back pressed · ending the hold` until the hold ends; another press meanwhile sends nothing, even if a refresh fails in between. While the agent is working, the press waits for the turn to end, checks again, and sends `back` only if the same hold is still on: a `back` you typed meanwhile, or a new `brb`, drops the press without a word, so it never ends a hold it was not pressed for and never produces a `you were not away` reply. If Claude Code drops the prompt (for example after Esc stopped a turn), a toast says `brb: Back failed: <reason>; type back`, and the button works again. Click the button, or press `b` while the band has focus (ctrl+x tab moves focus to it); `b` typed in the prompt box is just a letter. |
| Claude Code Desktop | the same call and the same hook. Desktop draws the band: a press in a Desktop session on 2026-11-10 ran the button's action. Where the band is never drawn there is no button: the mod falls back to the one status line of 0.3.x under the prompt (`⚠ brb: away 40m · 3 held · say back`, after back `⚠ brb: back · 2 to act on`), and `back` typed is the way out. |
| `claude -p`, mobile, OMP | no band and no button. OMP has no mod surface; type `back`. The still-away first line of every reply and the hooks' own lines are unchanged. |

**The status line is a fallback only.** Jo called the footer row unusable; the band replaces it.
The mod sets `$.ui.status` only where the band's render site has never been asked to draw, from
the first timer tick on, and clears it the first time the band draws.

**Refresh.** The data is this session's `away.json`, `digest.md` and `checklist.json`,
read out of process by `node mods/band/query.mjs --session <id>` (read-only; each file is
opened once without following a link, and the open descriptor must be a regular file of at most
64 KiB, of which at most 64 KiB + 1 byte is read, so a directory, a link, or a file over 64 KiB,
even one swapped in or grown after the check, is a fault, never a parse; an `away.json` or
`checklist.json` that does not parse is absent). The buttons run `node mods/band/act.mjs
--session <id> back|done <row>|clear`: `back` only reports whether the session is away and since when; `done` and `clear` write through `lib/state.mjs`. The band refreshes at
session start, after each prompt enters (so `brb` and `back` show at once), at the start and end
of each of your turns, after each button press, and every 5 s while away or while a checklist is
up. While home with no checklist the only poll is `$.fs.exists` on `away.json` inside Claude
Code, once a second, which starts a query when the file appears. `session.end` stops both timers
and clears the band. `/clear`, `/resume` and `/branch` end the conversation and start another in
the same window: the mod's `session.start` does not fire again, so it also listens for
`classic.SessionStart` with source `clear`, `resume` or `fork`, and starts over from there, with
one probe and one poll, the new conversation's state, and any answer the last conversation still
had in flight dropped.

**Faults** go the way the hooks' do: a query, an action or a home probe that fails clears the
band and writes one dim transcript line (`brb band: query: …`, `brb band: probe: …`,
`brb band: back: …`) per distinct error; a hook that throws logs one line and passes the event
on; no error reaches Claude Code.

Tests: `node --test` covers the data, view, query and action layers and the mod's timers, buttons
and fallback with an in-memory host (`mods/band/tests/*.test.mjs`); `claude plugin test` from
`plugins/brb` mounts the `AbovePrompt` site through Claude Code's test kit
(`mods/band/tests/band.test.tsx`) for a Desktop session start (no surface, not interactive) and a
terminal one, presses Back, Done and Clear and checks the drawn tree; `evals/manifest.json` lists
the live checks under `manual`.

## State and config

- `${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/` — `away.json` (since, note, counts, the
  lines seen, whether this turn was backstopped, the previous stop's transcript line and
  fires), `digest.md`, `archive/<when>.md`, `checklist.json` (the last hold's items for the band,
  each with its Done state). A `back-requested` file left by 0.4.0 or 0.4.1 is no longer read;
  prune removes it with the rest.
  Declared in `.claude-plugin/plugin.json` `state`; `node scripts/prune.mjs --days 30` removes
  files older than 30 days (`errors.log` kept), and the nightly canary runs it.
- `${XDG_CONFIG_HOME:-~/.config}/brb/config.json`, optional:
  `{"onFireCap": 3, "idleStops": 2}`. A missing or unparsable file is the defaults; a field that
  is not a non-negative integer is ignored.
- `BRB_DESKTOP_NOTIFY=off` turns off the macOS notification. `BRB_HARNESS=omp` is set by the OMP
  adapter, never by hand; under it the OSC 9 sequence is left out and the keep-working answer is
  `decision: "block"`. `BRB_SESSION_ID` (then `CLAUDE_CODE_SESSION_ID`) names the session for
  `scripts/brb.mjs hold` when `--session` is not passed.

## When this can't run

- **Hooks disabled or the plugin not loaded.** `brb` reaches the model as a prompt and nothing
  is held. The tell: no confirmation line in reply to `brb` (the line
  `evals/prompt-brb.scenario.json` proves). Nothing to undo; the word is just a word to the model.
- **The hold command cannot find its session.** With no `--session`, no `BRB_SESSION_ID` or
  `CLAUDE_CODE_SESSION_ID`, and two or more sessions away on this machine, `hold` refuses
  (`several holds are away (…); pass --session <id>`, exit 1) rather than file the ask under
  the wrong hold. The rendered instruction always carries `--session`, so this takes an agent
  that retyped the command without it; the skill tells it to show the ask once instead, and the
  backstop files it.
- **The desktop notification is untested here.** The `osascript` call is spawned detached and
  ignored; the tests run with `BRB_DESKTOP_NOTIFY=off` and the banner has not been watched for
  on a Mac during this version. `evals/manifest.json` lists it under `manual`. The
  `systemMessage` and the digest do not depend on it.
- **Claude Code caps stop-hook continuations.** From the hooks reference, re-fetched
  2026-11-04 (https://code.claude.com/docs/en/hooks, Stop input): "Claude Code applies an
  8-consecutive-continuation cap: after stop hooks have continued the turn eight times in a row,
  Claude Code overrides the next block and ends the turn. The count of consecutive continuations
  resets each time Claude calls a tool. To raise the cap, set `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`."
  So a working agent is never cut off by the cap; eight continuations with no tool call in
  between end the turn whatever brb says, brb's own tool-less rule ends it after two, and three
  continuations with nothing new end it whatever tools ran. On OMP
  "explicit `{ decision: "block", reason }` refusals … remain blocking until the hook allows
  completion or the operator interrupts" (OMP's extensions doc), which is why the release rules
  exist and why an unreadable transcript counts every continuation as tool-less.
- **An unreadable transcript** (no path, rotated, missing) counts every `stop_hook_active`
  stop as tool-less, as above; `away.json` `lastStop.transcript` is `false`. So without a
  transcript, a continuation with nothing new is released by the guard whatever tools it ran:
  the price of bounding the loop when nothing proves a tool ran. A readable file in a line shape
  that is neither Claude Code's nor OMP's counts zero tool calls, so the agent is let go after
  `idleStops` stops.
- **An unwritable state directory** is one `errors.log` line (`Stop could not write state: …`)
  and a `systemMessage` (`brb Stop could not write its state (…); this message's asks are not
  held and the stop proceeds.`); an on-fire line in the same message still surfaces. The ask is
  on screen in the agent's message.
- **On OMP, a word typed while the agent is working** shows its reason (the confirmation or the
  digest) through `ctx.ui.notify`, not as a transcript message: a custom message sent while OMP
  streams is steered into the agent's context. When the agent is idle it shows as a displayed
  message. Which channel is picked is tested (`displayChannel`); the live path is not.
- **The OMP adapter has not been run in a live omp session** for this version; its handlers
  are tested with a fake runner and one real spawn of the hooks (`omp/brb-omp.test.mjs`).
- **The band has not been watched on Desktop or in a terminal** for this version: its data,
  view, query and action layers run under `node --test`; its hooks and the drawn tree run under
  `claude plugin test` (`mods/band/tests/band.test.tsx`), with the Desktop session start (no
  surface, not interactive) and the terminal one. The kit checks the tree, not how the app paints
  it. The tell that the mod loaded: `/plugin` shows `1 mod active · brb` (Claude Code 2.1.286 or
  later; an older Claude Code ignores `modules` and the hooks still run). The tell that the band
  did not draw: no band after `brb` while the confirmation line did show, and the `⚠ brb:` status
  line appearing within 5 s instead.
- **The band lags the hook** by at most a second for a `brb`, and at most 5 s for a `back`,
  when a prompt's hooks run after the mod's own `prompt.submit` has returned (the mod refreshes
  once after the prompt enters, then probes `away.json` once a second while home and queries
  every 5 s while away). A `brb` typed into a session where the mod is not loaded shows no band
  at all; the hooks hold as before.
- **The Back button needs Claude Code with `asUser` on `$.prompt.submit`** (present in 2.1.318,
  the version this was tested on). On a version without it the prompt may reach the hook wrapped
  in a sentence naming the mod, the hook does not read it as `back`, and the hold stays: type
  `back`.
- **The band is shared and collapsible.** Other mods may draw in the same band (brb keeps their
  tree under its own), a survey takes the band over while it runs, and in the terminal the person
  can collapse it (ctrl+x ctrl+a) without the mod knowing.

## How it fails

Every hook runs under `lib/hook-runner.mjs` and exits 0 whatever happens; a fault is one line in
`${XDG_STATE_HOME:-~/.local/state}/brb/errors.log` and a `systemMessage`. The full table is
[HOW-IT-FAILS.md](HOW-IT-FAILS.md). `test/hook-contract.test.mjs` proves the five fault inputs;
`evals/manifest.json` declares what each hook can answer and `evals/prompt-brb.scenario.json` is
the first scenario that proves it; `e2e/live-run.sh` runs every scenario for the nightly canary;
the `state` field of `.claude-plugin/plugin.json` names what the plugin keeps outside the
worktree and `scripts/prune.mjs` removes what is older than its retention.

## Developing

`node --test` from `plugins/brb/` runs everything: the state round-trip, the splitter, the three
hooks as spawned processes with fixture stdin and fixture transcripts, the hold command as a
spawned process, the OMP adapter's handlers, the band's data, view, query and action layers.
`bash e2e/live-run.sh --no-live` replays the fourteen `evals/*.scenario.json` offline. `claude
plugin test` runs the band mod itself (`mods/band/tests/band.test.tsx`).

## Changes in 0.4.2

The Back button ends the hold itself: it sends `back` as your own prompt
(`$.prompt.submit({ text: "back", asUser: true })`), never awaited, with a toast; at once when the
agent is idle, at the end of the running turn otherwise, and only if the hold it was pressed for
is still on. The band reads `Back pressed · ending the hold` until it ends, and a refused or
dropped prompt shows `brb: Back failed: <reason>; type back`. The `back-requested` marker and the prompt and Stop hooks' handling
of it are gone: one path, the same as `back` typed. The digest's `held since` and each entry's
heading are printed in local time (`2026-11-10 5:50 PM PST`, the machine's zone or `TZ`);
`away.json`, `checklist.json` and the archive names keep ISO times.

## Changes in 0.4.1

`scripts/prune.mjs` is plugin-kit 0.4.1's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged.

## Changes in 0.4.0

The footer status row of 0.3.x is replaced by a band above the prompt. While away it carries the
digest: `AWAY <dur> · N held`, the on-fire count, the held items as a numbered list and a Back
button; the prompt box suggests `away <dur> — type back`. After `back` the band stays as a
checklist (`BACK · N to act on`, Done per row, Clear) from the new `checklist.json`, until every
row is done or Clear. The Back button leaves a `back-requested` marker that the prompt and Stop
hooks honour on their next event. The status line remains only where the band never draws.
The hold, the hooks' outputs at `back`, the OMP adapter and the away instruction are unchanged.

## Changes in 0.3.1

The away badge draws in Claude Desktop. Desktop runs Claude Code headless (`--input-format
stream-json`), so `session.start` carries no surface, and 0.3.0 took that to mean nothing could
draw: it never set the line and never started its timers. Desktop does draw a `ui_status`
message, so the mod now sets the line in every session, Desktop and terminal alike.

## Changes in 0.3.0

The away badge: a Claude Code mod (`mods/badge/`) that pins `⚠ brb: away <elapsed> · [note ·]
N held · say back` (never over 40 characters: the note goes first, then `· say back`) under the
prompt while this session is away, on Desktop and in the terminal, and removes it at `back`.
Read-only (`mods/badge/query.mjs` reads `away.json` through one descriptor, bounded at 64 KiB);
refreshed at session start, after each prompt, at each turn's start and end, and every 5 s while
away. The hooks, the adapter, the hold command and the away instruction are unchanged.

## Changes in 0.2.0

While away, asks are written, not shown. The Stop hook of 0.1.x filed a `## Needs you` section
into the digest but could not take it off the screen, so the question was read, the person was
pulled back and the hold did nothing. Now the away instruction names a hold command
(`scripts/brb.mjs hold`) that writes each ask into the digest, and tells the agent to show no
`Needs you` section, no question and no closing ask; a reply that still shows one is filed and
blocked once (`brb: N item(s) moved to the digest; …`), once per turn, yielding to the
tool-less bound. A closing ask is held and counted like a section line. `pending` and `back`
print the digest as before, from both sources, each item once. `away.json` carries
`backstopped`. The adapter, the release rules and the on-fire path are unchanged.

A fire answered does not end the hold. After a fire broke through and was answered, the agent
read the answer as the end of the hold and went back to chatting, and a second `brb` was
refused as already away. Now the instruction's first line says the hold is still on (with how
long and how many held), rule 6 says Jo's reply is not `back`, every reply starts with a
visible `brb: still away (…) — say \`back\` to read them` line that the backstop enforces once
per turn, and a second `brb` passes through to re-arm the agent instead of being blocked.

`back` is answered by the agent. On 2026-11-04 Jo typed `back` from the Claude mobile app:
the hook archived the digest (six sections) and blocked the prompt, and the app, which renders
no hook frame, showed nothing. Now `back` archives and clears as before but lets the prompt
through with the digest and an instruction to reply with it verbatim as `additionalContext`
(the same text rides a `systemMessage` for the surfaces that render frames), so what you see
is the agent's reply, on every surface. `back` while not away passes through with
`brb: you were not away; nothing held` as context. On OMP the adapter awaits the hook on
`back`, stages its context for `before_agent_start` and lets the word through.

Four races closed after the second Codex review. The OMP adapter waits for the prompt hook's
new-turn reset before an ordinary prompt proceeds (OMP awaits `input` handlers), so the reset
cannot land after the new turn's Stop and wipe its once-per-turn flag. The session lock
(`away.lock`) holds its holder's pid and is taken over only when that pid is dead or the lock
is older than 60 s; a live slow holder is waited on for 2 s and then the caller fails closed
(`hold` exits 1 with `try again in a moment`, the Stop hook takes its write-error path,
`pending` logs and lets the word through). The Stop hook re-reads the record under the lock and
merges, counts and writes there, so an item the hold command files while a stop is computing
is kept, not overwritten. `pending` reads under the lock, so a digest mid-write is never shown.

## Changes in 0.1.1

`lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.2.1's). The handler thread's
env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, a process group
the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits, and the runner
waits for stdout to drain before it exits (bounded by the same deadline), so an answer larger
than one 64 KiB pipe buffer is no longer cut short. brb's hooks
register none, so every hook answers as before, under the same 4 s deadline.

## Changes in 0.1.0

First release: the three words (`brb`, `back`, `pending`), the away instruction on every prompt
and at SessionStart, the Stop hook that holds Needs-you lines, surfaces on-fire lines and sends
the agent back to work (Stop hook feedback on Claude Code, a block on OMP) until an `idle:` line,
two tool-less stops or three continuations with nothing new, the OMP adapter, the `brb` skill.
No `/brb` slash command, no masking of the agent's messages, no model-run check.
