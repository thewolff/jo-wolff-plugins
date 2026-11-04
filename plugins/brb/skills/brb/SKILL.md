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
4. **When nothing is runnable without the person, end with a line `idle: <why>`**; your closing
   ask may come after it (the hook reads the last five non-blank lines). The Stop hook then lets
   the turn end. Without it the hook answers
   `brb is holding your asks (N in the digest). Keep working …` and you are back at step 1; the
   hook also lets you stop after two stops in a row with no tool call between them.

The person reads the digest with `back` (which clears it) or `pending` (which does not).

## When this can't run

- **The held count did not grow.** The keep-working reply (`brb is holding your asks (N in the
  digest)`) and the last line of the away instruction (`N items held so far.`) both carry the
  count. If you wrote a new ask and the next N you see is the same as before, the ask was not
  held (the hook failed open, or could not write its state). Restate it under `## Needs you` in
  your next message and say the hold missed it once; a missed ask is not marked seen, so the
  restatement lands.
- **No away instruction although the person typed `brb`.** Each prompt while away arrives with
  `brb: Jo is away since …`. If that line is missing, the hook is not running (hooks disabled,
  plugin not loaded): keep writing the section anyway; the person reads messages when they
  return. Nothing to undo. A turn that ends with no keep-working reply is not this signal: the
  hook lets an `idle:` stop, a tool-less stop with nothing new, the second tool-less stop and
  the third continuation in a row with nothing new end silently or with a line for the person.
- The person is not away (no `brb` was typed): this skill does not apply; ask as usual.

The scenario that proves the hook's first outcome is `evals/prompt-brb.scenario.json`.
