---
name: communication-rules
description: Write messages a specific reader can act on — decisions first, one closing ask, no batching by label, no buried questions. Use when reporting to a human, handing work back, resuming a thread, or when an operator profile declares reader traits the default shape should adapt to. Ships with no traits; it reads the ones you declare.
---

# Communication rules

A report and a message are different artifacts. A report is organised for the record; a message
is organised for the one person who has to act on it. This skill is the message half: the shape
that puts what needs a decision where the reader looks first, and keeps it there when the message
is long, late, or bad news.

It ships with **no reader traits**. The default shape below holds for any reader. Anything
reader-specific comes from a profile the operator writes on their own machine — see
*Operator profile* at the end of this file, and `reference.md` for the full schema.

<!-- inject:start -->
**Messages to a person are structured by what they need from the reader, not by what happened.**

- **Needs you first.** Anything requiring a decision, an answer, or an action from the reader goes
  above anything that is merely informative. A blocker or an open question opens the message; it
  never closes it.
- **One closing ask, and it goes last.** If the reader can only do one thing after reading, say
  which. Two asks in one message means the second one is optional in practice.
- **Do not batch by label.** Grouping every question into a questions section and every finding
  into a findings section reads tidily and destroys the reason each item exists. Keep an item with
  the thing it is about; order by what needs the reader, not by kind.
- **State the conclusion before the evidence.** The reader stops reading as soon as they have what
  they need, so the first sentence carries the answer and the rest earns it.
- **Name the file, the command, or the line.** A message about work that names no artifact cannot
  be checked, and cannot be resumed by anyone else.
- **When resuming a thread, restate its content.** Naming the thread is not restating it. The
  reader may not have the earlier message in front of them, and usually does not.
- **Report the thing you did not do.** A skipped step, a refused command, an unverified claim: the
  omissions are the part a reader cannot infer from what is present.
- **Say the bad news in the first sentence of the message it belongs to.** Not after the context
  that explains it. The explanation is still welcome; it goes second.
<!-- inject:end -->

## What enforces this, and what does not

**A Stop hook inspects every substantive final message against these eight rules** (0.2.0;
DEC-040's deferred wiring, built). Three are decided deterministically: needs-you-first,
closing-ask-last, and name-the-artifact (warn mode — a vocabulary check). Five go to a judge
command the operator configures: do-not-batch-by-label, conclusion-first,
restate-resumed-thread, report-what-you-did-not-do, and bad-news-first. A model-graded
check that runs automatically inside a hook is still machinery — a different instrument
with a different error profile, not a non-enforcement. The hook fails open on every error,
blocks ask for corrected lines only, and `~/.claude/.communication-rules-off` disables it
within one turn.

Two boundaries remain honest. *Report what you did not do* is enforced exactly where a todo
list exists — with no tracked plan the violation is silence and no instrument sees it. And
no check decides whether a named artifact is the RIGHT one; that is still judgment, and the
reader's.

`reference.md` carries the scoreboard, every check's contract and options, the judge
machinery, and the config schema.

## The deterministic checks

`checks/needs-you-first.mjs`, `checks/closing-ask-last.mjs`,
`checks/name-the-artifact.mjs` — each a predicate over one message, callable as a library
or CLI. Shared shape, shared narrowness:

1. **They flag misordering or absence-of-artifact, never ceremony.** A message with nothing
   needing the reader, or no closing ask, is correct and never flagged — the cheap way to
   satisfy a check that demanded those is an empty header in the scarcest position.
2. **They have length floors** (200 chars for the first two, 400 plus a report-verb gate
   for name-the-artifact). Short messages are the false-positive population for any
   structural check.

Run them yourself:

```
node plugins/communication-rules/checks/needs-you-first.mjs path/to/message.md
node --test plugins/communication-rules/checks/ plugins/communication-rules/triggers/ plugins/communication-rules/judge/ plugins/communication-rules/hooks/
```

## Operator profile

The reader-specific half lives outside this repository. Write a JSON file with the traits your
reader actually has and point the plugin at it:

```
export COMMUNICATION_RULES_PROFILE=~/.claude/communication-rules.json
```

Default location if that variable is unset: `~/.claude/communication-rules.json`. If no profile
exists, the session-start hook emits the default shape above and one line saying no profile is
configured — a hook that silently does half its job is indistinguishable from one that works.

See `example.communication-rules.json` for a complete, generic example, and `reference.md` for the
schema and for how traits change the emitted text.
