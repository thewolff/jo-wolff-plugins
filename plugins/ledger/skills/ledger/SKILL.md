---
name: ledger
description: Keep a durable, id'd record of the questions this thread asks the human and the choices it makes without asking, with the ledger CLI, and read the open items it injects. Use whenever a session has the ledger plugin enabled for the folder and the agent is about to ask the human for a decision or make a choice without asking; also on `/ledger` and when the human types an id-bearing line such as `approve q-…`.
argument-hint: "[ask <body> | note <text> | pending | log | help]"
license: MIT
---

# ledger

The ledger is one SQLite file on the human's machine that records what this thread asked and
what it decided on its own, each row with an id the human can type back. You reach it through
one command, printed at session start as

```
node <plugin dir>/scripts/ledger.mjs <verb> …
```

Run it exactly as printed: that literal path, no alias, no shell variable, no `cd` first. One
allow rule matches that invocation and nothing else, so any other spelling makes Claude Code ask
the human for permission. `… help` prints the whole grammar.

## The two moments

1. **When you need the human's decision: `ask`, then end your message with its `pending` line.**
   `… ask "<the question, one line>" --name <short> --options a,b[,c] --default a` prints a `q-`
   id. Options are the one-word answers the human will type; the default is what you will do if
   they say nothing. Add `--ceiling <usd>` when the question is about spending and
   `--about "<what it concerns>"` when the body alone would not place it. For a plan with several
   routes use `--kind plan --allows "a: what a lets you do; b: …"` so each option says what it
   permits. Put the question and its id in the message, and end the message with the line
   `… pending` prints for it:

   ```
   approve q-mvr3k2p9a1xq  # ship · Ship it? · default approve · also: deny / withdraw
   ```

   The Stop hook sends back, once, a message that asks a question without naming an open
   `q-` id. Asking the same open question again returns the same id; do not re-ask in new words.
   Do not use the AskUserQuestion tool without an open `q-` row; the hook denies it and the
   human cannot find the question later.

2. **When you decide something without asking: `note`, in the same turn.**
   `… note "<what you chose and why, one line>"` prints an `nt-` id. The last few entries are
   injected at the next session start, so a future thread knows what was settled. The Stop hook
   sends back, once, a reply that states a decision ("I decided", "going with", "instead of",
   "assuming", "chose", "trade-off" and the rest of the configured list) when no note was
   recorded during that turn: record the note first, then say it.

3. **Before `git push` or `gh pr create`: one `note` in this session.**
   The PreToolUse hook denies both until the session holds a note; make it say what is being
   pushed and why (`… note "pushing the retry fix to open PR; CI must run it"`). One note per
   session lifts the gate for the rest of the session.

There is no "open" or "close": the folder you are in is the unit of work, and questions and
notes bind to it (a question asked in the repo root is open for its subfolders too).

## The human's words

These are the human's verbs; run them only when the human typed the line or asked you to
record it for them: `approve q-…`, `deny q-…`, any option word followed by the `q-` id,
`withdraw q-…`, `extend q-…`, `enable`, `disable`.

Lines the human types into a prompt that consist only of such id-bearing lines (or `pending`,
`log`, `help`) are applied by a hook before you see the prompt, and the numbered results
arrive as context. Treat `n: ok an-… approve → q-…` as the answer recorded and act on it; treat
`n: refused …` as not recorded and say so. Applying the same line again is harmless: a repeated
answer is `already answered`, not an error.

## Reading what you are given

- `… pending` is the paste-ready block of open questions; copy its lines verbatim.
- `… log [N]` is the last N notes, questions and answers for this folder, newest first; read it
  when you resume so you do not re-decide what a note already settled.
- A refused line (`refused no such question q-…`, `refused raise is not an option of q-…;
  options: …`) wrote nothing. A `not a command` line was prose and wrote nothing.
- Everything the ledger prints is the human's record; never paraphrase an id, and never invent
  one.
