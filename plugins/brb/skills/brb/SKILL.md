---
name: brb
description: What to do while the person is away under brb; the Needs-you digest, the on-fire line, the idle line.
---

# brb

The person typed `brb` and left. Nothing you ask them now will be answered until they type
`back`. The brb plugin holds your asks for them and keeps you working; this skill is the three
things it needs from you.

## Steps

1. **Keep working.** Take the next open item. Where a choice is small and one option is safer
   and reversible, take that option and say so in a line; where it is not, write the ask down
   (step 2) and move on. Do not stop to wait.
2. **Write every ask under `## Needs you`** (a `**Needs you**` line also works), one item per
   line, each readable on its own without the rest of the message. The Stop hook copies those
   lines into the digest that `back` prints; a held item is not lost, so do not repeat it in
   later messages. A `Closing ask:` line travels with them.
3. **Start a line with `on fire:` only for** a broken main branch, data loss, a security
   finding, spend near a ceiling, or a blocker on everything you could work on. That line goes
   to the person at once, as a notification; everything else waits.
4. **When nothing is runnable without the person, end with a literal last line `idle: <why>`.**
   The Stop hook then lets the turn end. Without it the hook answers
   `brb is holding your asks (N in the digest). Keep working …` and you are back at step 1; the
   hook also lets you stop after two stops in a row with no tool call between them.

The person reads the digest with `back` (which clears it) or `pending` (which does not).

## When this can't run

- A stop was answered with `brb Stop failed open: <why>`: the hook let the turn end without
  holding anything; the line is also in `${XDG_STATE_HOME:-~/.local/state}/brb/errors.log`.
  Your Needs-you section is still on screen in your message; say in your next message that the
  hold missed once, and do not count the ask as delivered.
- No `brb is holding your asks` reply ever arrives after a Needs-you section: the hook is not
  running (hooks disabled, plugin not loaded). Keep writing the section; the person reads
  messages when they return. Nothing to undo.
- The person is not away (no `brb` was typed): this skill does not apply; ask as usual.

The scenario that proves the hook's first outcome is `evals/prompt-brb.scenario.json`.
