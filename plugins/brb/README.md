# brb

Type `brb` and walk away. The agent keeps working; every question it would have stopped to ask
you waits in a digest; the five things that cannot wait (a broken main, data loss, a security
finding, spend near a ceiling, a blocker on everything) still come through at once. Type `back`
and read the digest.

Built on plugin-kit 0.2.1. Claude Code hooks, plus an OMP extension that runs the same hooks.
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

Three words, each typed as the whole prompt. None of them starts a turn.

| You type | What happens | What you see |
|---|---|---|
| `brb` or `brb <note>` | the hold begins: `away.json` is written for this session | `brb: holding needs-you items until \`back\`; on-fire items still come through` (the note appended) |
| `pending` | nothing changes | the digest so far, under `brb digest — held since <when>, N items` |
| `back` | the digest is archived to `archive/<when>.md` and the hold ends | the digest, then `brb: hold cleared; digest archived to <path>` |

An empty digest shows `(nothing held)`. `back` or `pending` while not away says so and asks for
`brb`. A second `brb` while away says when the hold began and how many items are held.

While away, every other prompt you type (or that a scheduled run types) proceeds, carrying the
away instruction below as `additionalContext`; a resume, clear or compaction carries it again
at SessionStart with one line for you (`brb: away since <when>; N held. Type \`back\` to read
them.`).

## The contract

This is the away instruction, exactly as the agent reads it each turn while you are away
(`lib/text.mjs` `awayInstruction`; the first and last lines carry the live values):

```
brb: Jo is away since <since> (<note>). Keep working; do not stop to wait for an answer.
While away:
1. Keep working on the next open item. Choose the safer reversible option yourself where a choice is small; where it is not, write the ask down (rule 2) and move to the next item.
2. Put every question, decision or approval you need from Jo under a `## Needs you` heading (or a `**Needs you**` line), one item per line, each item readable on its own. brb holds those lines in a digest that Jo reads with `back`; a held item is not lost, so do not repeat it in later messages.
3. Start a line with `on fire:` only for one of these: a broken main branch, data loss, a security finding, spend near a ceiling, or a blocker on everything you could work on. Those lines reach Jo at once. Anything else waits in the digest.
4. When nothing is runnable without Jo, end the message with a literal last line `idle: <why>`. brb then lets the turn end; without that line a Stop hook sends you back to work.
<N> items held so far.
```

The on-fire kinds mirror agent-system 2.0's surface (`surface/src/batch.ts` `onFire`), so an
agent that already writes for as2 writes the same thing here.

## What the Stop hook does while you are away

On every finished message (`hooks/stop.mjs`, the rules in `lib/stop-core.mjs`):

1. **Split the message.** The `Needs you` section (`## Needs you`, `**Needs you**`,
   `Needs you:`, any depth or case; it ends at the next heading, bold label line or rule), every
   line starting with `on fire:` anywhere in the message (bold and list markers allowed), a
   `Closing ask:` line or section, and a trailing `idle: <why>` line. Lines already held this
   hold are dropped, so an ask restated after a block lands once.
2. **Hold the asks.** New Needs-you lines go to `digest.md` under a timestamp heading, with the
   closing ask when there is one. The count in `away.json` goes up.
3. **Surface the fires.** New on-fire lines are **not** written to the digest. They come back as
   a `systemMessage` (`brb on fire: …`, shown in the transcript), a `terminalSequence` carrying
   an OSC 9 notification (terminals that render it show a banner; Claude Code passes the bytes
   through), and on macOS a best-effort `osascript -e 'display notification …'` that is never
   awaited and never fails the hook. Past `onFireCap` fires in one hold (default 3) the line
   still surfaces and the message adds `(on-fire cap of N passed this hold: M so far; check the
   tagging)`.
4. **Send the agent back to work**, `decision: "block"` with the reason
   `brb is holding your asks (N in the digest). Keep working on the next open item; if nothing is runnable end with a line \`idle: <why>\`.`
   **except** when one of three things is true, in which case the turn ends:
   - the message ends with an `idle:` line (you see `brb: the agent is idle (<why>); N held; type \`back\` to read them.`);
   - `stop_hook_active` is true and the message brought no new Needs-you or on-fire line (the
     guard against a loop that will never resolve; nothing is shown);
   - `idleStops` stops in a row (default 2) came with no tool call between them. The count is
     the `tool_use` blocks in `transcript_path` after the line recorded at the previous stop;
     when the transcript cannot be read, a stop whose message is byte-identical to the previous
     stop's counts as tool-less instead. A tool call resets the count. You see
     `brb: 2 stops with no tool calls between them; letting the agent stop. N held; …`.

Not away: the hook prints nothing and the stop proceeds.

## State and config

- `${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/` — `away.json` (since, note, counts, the
  lines seen, the previous stop's transcript line), `digest.md`, `archive/<when>.md`. Declared in
  `.claude-plugin/plugin.json` `state`; `node scripts/prune.mjs --days 30` removes files older
  than 30 days (`errors.log` kept), and the nightly canary runs it.
- `${XDG_CONFIG_HOME:-~/.config}/brb/config.json`, optional:
  `{"onFireCap": 3, "idleStops": 2}`. A missing or unparsable file is the defaults; a field that
  is not a non-negative integer is ignored.
- `BRB_DESKTOP_NOTIFY=off` turns off the macOS notification. `BRB_HARNESS=omp` is set by the OMP
  adapter, never by hand; under it the OSC 9 sequence is left out.

## When this can't run

- **Hooks disabled or the plugin not loaded.** `brb` reaches the model as a prompt and nothing
  is held. The tell: no confirmation line in reply to `brb`. Nothing to undo; the word is just a
  word to the model.
- **The desktop notification is untested here.** The `osascript` call is spawned detached and
  ignored; the tests run with `BRB_DESKTOP_NOTIFY=off` and the banner has not been watched for
  on a Mac during this version. `evals/manifest.json` lists it under `manual`. The
  `systemMessage` and the digest do not depend on it.
- **Claude Code caps stop-hook continuations.** From the hooks reference (quoted in the design
  notes, `agent-scratch/jo-wolff-plugins/hold/COMPARABLES-2026-11-04.md` § Unverified, not re-fetched for this version):
  "Claude Code applies an 8-consecutive-continuation cap: after stop hooks have continued the
  turn eight times in a row, Claude Code overrides the next block and ends the turn. The count
  of consecutive continuations resets each time Claude calls a tool." So a working agent is
  never cut off by the cap; eight blocks with no tool call in between end the turn whatever brb
  says, and brb's own tool-less rule ends it after two. On OMP "explicit `{ decision: "block",
  reason }` refusals … remain blocking until the hook allows completion or the operator
  interrupts" (same notes), which is why the three release rules exist.
- **An unreadable transcript** (rotated, a different path, OMP's session file shape) falls back
  to comparing messages, as above. An unwritable state directory throws into the runner's
  fail-open path: one `errors.log` line, a `systemMessage`, the stop proceeds; the ask was on
  screen in the agent's message and is not lost twice.
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
hooks as spawned processes with fixture stdin and fixture transcripts, the OMP adapter's handlers.
`bash e2e/live-run.sh --no-live` replays the ten `evals/*.scenario.json` offline.

## Changes in 0.1.0

First release: the three words (`brb`, `back`, `pending`), the away instruction on every prompt
and at SessionStart, the Stop hook that holds Needs-you lines, surfaces on-fire lines and sends
the agent back to work until an `idle:` line or two tool-less stops, the OMP adapter, the
`brb` skill. No `/brb` slash command, no masking of the agent's messages, no model-run check.
