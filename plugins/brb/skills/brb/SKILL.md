---
name: brb
description: What to do while the person is away under brb; the hold command, the on-fire line, the idle line.
---

# brb

The person typed `brb` and left. Nothing you ask them now will be answered until they type
`back`, and nothing you show them now is read as written: a question on screen pulls them back
to a screen they left. The brb plugin holds your asks for them in a digest and keeps you
working; this skill is what it needs from you.

## Steps

1. **Keep working.** Take the next open item. Where a choice is small and one option is safer
   and reversible, take that option and say so in a line; where it is not, write the ask down
   (step 2) and move on. Do not stop to wait.
2. **Write every ask with the hold command; show none of it.** The away instruction that
   arrives with each prompt carries the command with this session's id filled in:
   `node "<plugin>/scripts/brb.mjs" hold --session "<id>" "<one item, readable on its own>"`.
   Run it once per question, decision or approval, each item readable on its own without the
   rest of the message. It prints `held N`. Your reply then has no `Needs you` section, no
   question sentence and no closing ask; it says only what was done. A held item is not lost,
   so do not restate it later. If a `Needs you` section or a closing ask still appears in a
   reply, the Stop hook files it into the digest and sends the reply back once with
   `brb: N item(s) moved to the digest; do not restate them — reply with the body only and end
   with idle:`; answer with the body only.
3. **Start a line with `on fire:` only for** a broken main branch, data loss, a security
   finding, spend near a ceiling, or a blocker on everything you could work on. That line goes
   to the person at once, as a notification; everything else waits.
4. **When nothing is runnable without the person, end with a line `idle: <why>`** (the hook
   reads the last five non-blank lines). The Stop hook then lets the turn end. Without it the
   hook answers `brb is holding your asks (N in the digest). Keep working …` and you are back
   at step 1; the hook also lets you stop after two stops in a row with no tool call between
   them.
5. **Start every reply with the still-away line** the away instruction gives (rule 5),
   ``brb: still away (<duration>, N held) — say `back` to read them``. A reply without it is
   sent back once.
6. **Answering a fire, or anything the person types, does not end the hold.** Answer it, then
   go back to steps 1 to 5; only the prompt `back` on its own ends the hold.
7. **When the prompt `back` arrives with `brb: Jo is back (away <duration>). Reply with the
   digest below verbatim …` as context, your whole reply is that digest**, starting with its
   `brb: hold cleared; digest archived to <path>.` line, then nothing else. The person may be
   on a surface that renders no hook output (the mobile app), so your reply is the only way the
   digest reaches them. Where you already resolved a held item during the hold, append
   `— resolved: <how>` to that line; do not drop the line. `back` with
   `brb: you were not away; nothing held` as context is an ordinary one-word reply to whatever
   you asked; answer it as such.

The person reads the digest with `pending` (which does not clear it) or `back` (which does).

## When this can't run

- **`hold` prints `not away; say it to Jo`.** The session is not away (no `brb` was typed, or
  `back` was): ask in your reply as usual. Nothing was written.
- **`hold` exits 1.** The item text was empty, several sessions are away and none was named
  (`several holds are away (…); pass --session <id>`: use the id from the away instruction), or
  the state directory could not be written (`brb hold: could not write the digest (…)`). Put
  the ask under `## Needs you` in your reply once; the Stop hook's backstop files it from there
  and sends the reply back once.
- **The held count did not grow.** `hold` prints `held N`; the keep-working reply and the last
  line of the away instruction (`N items held so far.`) carry the same count. An item whose
  text matches one already held (same words, any list marker, bold, case or spacing) is held
  once and the count stays; that is the dedup rule, not a miss. A new item whose count did not
  grow was not held: run the command again, and if it fails again put the ask under
  `## Needs you` once, as above.
- **No away instruction although the person typed `brb`.** Each prompt while away arrives with
  `brb: still away since …`. If that line is missing, the hook is not running (hooks disabled,
  plugin not loaded): ask in your reply; the person reads messages when they return. Nothing to
  undo. A turn that ends with no keep-working reply is not this signal: the hook lets an `idle:`
  stop, a tool-less stop with nothing new, the second tool-less stop and the third continuation
  in a row with nothing new end silently or with a line for the person.
- The person is not away (no `brb` was typed): this skill does not apply; ask as usual.

The scenario that proves the hook's first outcome is `evals/prompt-brb.scenario.json`; the
backstop is `evals/stop-away-asks.scenario.json` and the command
`evals/stop-away-held-by-command.scenario.json`.
