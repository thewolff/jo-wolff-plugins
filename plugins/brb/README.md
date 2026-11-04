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
| away | first line `brb: still away (<duration>, N held) — say \`back\` to read them`, then the body: what was done, ending `idle: <why>` when nothing is runnable; no `Needs you`, no question, no closing ask | the still-away line at the top of every reply; `brb on fire: …` for a fire; `brb: the agent is idle (<why>); N held` when it stops |
| you answer a fire (or anything) while away | your answer handled, then the same shape as away | the hold continues; the away instruction is re-injected on every prompt, and only `back` ends the hold |
| back | | `brb: hold cleared; digest archived to <path>.` then the digest: every item the command held and every one the backstop moved, each once |

Built on plugin-kit 0.3.2. Claude Code hooks, plus an OMP extension that runs the same hooks.
Node 22.13 or later. No other plugin is needed.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install brb@jo-wolff-plugins
```

On OMP, from a shell: `omp plugin marketplace add thewolff/jo-wolff-plugins` then
`omp plugin install brb@jo-wolff-plugins`; [`omp/REGISTRATION.md`](omp/REGISTRATION.md) has
the fallbacks and the exact reversal.

## Usage

Three words, each typed as the whole prompt (trailing `.`, `!` or `?` allowed; `brb, lunch`
and `brb: lunch` carry a note too). None of them starts a turn while away.

| You type | What happens | What you see |
|---|---|---|
| `brb` or `brb <note>` | the hold begins: `away.json` is written for this session | `brb: holding needs-you items until \`back\`; on-fire items still come through` (the note appended) |
| `pending` | nothing changes | the digest so far, under `brb digest — held since <when>, N items` |
| `back` | the digest is archived to `archive/<when>.md` and the hold ends | `brb: hold cleared; digest archived to <path>.` first, then the digest |

An empty digest shows `(nothing held)`. A `back` or `pending` reason longer than 8000
characters is cut at a line and ends `… (N more lines; full digest: <path>)`; the archive keeps
every line. `back` or `pending` while not away is passed to the agent as an ordinary prompt, so
a one-word answer to an agent's question ("revert or go back?") is not swallowed. A second
`brb` while away changes nothing and is not blocked: you see ``brb: still away since <when>
(<duration>); N held. Only `back` ends the hold; `pending` peeks. Your questions answered
while away did not end it.``, and the agent gets the same line over the away instruction, so it
goes back to holding. (On OMP the adapter shows that line and starts no turn.)

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

## State and config

- `${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/` — `away.json` (since, note, counts, the
  lines seen, whether this turn was backstopped, the previous stop's transcript line and
  fires), `digest.md`, `archive/<when>.md`.
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
spawned process, the OMP adapter's handlers. `bash e2e/live-run.sh --no-live` replays the
fourteen `evals/*.scenario.json` offline.

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
