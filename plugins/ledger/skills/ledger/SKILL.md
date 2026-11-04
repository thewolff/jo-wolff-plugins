---
name: ledger
description: Keep a durable, id'd record of the questions this thread asks the human and the choices it makes without asking, with the ledger CLI, and read the open items it injects. Use whenever a session has the ledger plugin enabled for the folder and the agent is about to ask the human for a decision, has just received the human's reply to one, or makes a choice without asking; also on `/ledger`.
argument-hint: "[ask <body> | note <text> | pending | log | help]"
license: MIT
---

# ledger

The ledger is one SQLite file on the human's machine that records what this thread asked and
what it decided on its own, each row with an id. The ids are yours: the human never sees or
types one. You reach it through
one command, printed at session start as

```
node <plugin dir>/scripts/ledger.mjs <verb> …
```

Run it exactly as printed: that literal path, no alias, no shell variable, no `cd` first. One
allow rule matches that invocation and nothing else, so any other spelling makes Claude Code ask
the human for permission. `… help` prints the whole grammar.

## The two moments

1. **When you need the human's decision: `ask`, then ask in plain words.**
   `… ask "<the question, one line>" --name <short> --options a,b[,c] --default a` prints a `q-`
   id. Options are the short answers you will map the human's reply onto; the default is what you
   will do if they say nothing. Add `--ceiling <usd>` when the question is about spending and
   `--about "<what it concerns>"` when the body alone would not place it. For a plan with several
   routes use `--kind plan --allows "a: what a lets you do; b: …"` so each option says what it
   permits. Then ask the human in ordinary words. Do not print the `q-` id, the `pending` line, or
   any ledger syntax to the human; keep the id in your own context.

   **When the human replies, record the answer before anything else:**
   `… answer <q-id> <option>`, with the option their words mean. If their reply sets the question
   aside, `… withdraw <q-id>`. If it does not answer it at all, ask again in plain words.

   The Stop hook sends back, once per turn, a reply that ends while a question asked before the
   human's latest message still has no answer, naming the ids to answer; and a reply that asks the
   human something while this session has no open question row. Asking the same open question
   again returns the same id; do not re-ask in new words. Do not use the AskUserQuestion tool
   without an open `q-` row; the hook denies it and the human cannot find the question later.

   **A question you form but should not put to the human yet: `hold`, never drop it.**
   `… ask …` it as usual, then `… hold <q-id>`. It stays unresolved, is listed under *Waiting on
   you* at every session start, and the Stop hook does not chase it. When you do put it to the
   human, `… reopen <q-id>` first, then ask in plain words.

2. **When you decide something without asking: `note`, in the same turn.**
   `… note "<what you chose and why, one line>"` prints an `nt-` id. The last few entries are
   injected at the next session start, so a future thread knows what was settled. The Stop hook
   sends back, once, a reply that states a decision ("I decided", "going with", "instead of",
   "assuming", "chose", "trade-off" and the rest of the configured list) when no note was
   recorded during that turn: record the note first, then say it.

   When the decision or an answered question produces something concrete, record it:
   `… outcome <ref> [q-id] "<what it produced>"`, where `ref` is the PR URL, commit or path.
   An outcome is a record, not a substitute for the `note` a stated decision needs.

3. **Before `git push` or `gh pr create`: one `note` or `outcome` in this session.**
   The PreToolUse hook denies both until the session holds one; make it say what is being
   pushed and why (`… note "pushing the retry fix to open PR; CI must run it"`, or
   `… outcome <ref> "<what and why>"` once the ref exists). One per session lifts the gate for
   the rest of the session.

There is no "open" or "close": the folder you are in is the unit of work, and questions and
notes bind to it (a question asked in the repo root is open for its subfolders too).

## Lines the human types (optional shortcut)

A human who prefers can still type `approve q-…`, `deny q-…`, an option word followed by the id,
`withdraw q-…` or `extend q-…` into a prompt. A hook applies such lines before you see the
prompt, and the numbered results arrive as context: treat `n: ok an-… approve → q-…` as the
answer recorded and act on it; treat `n: refused …` as not recorded and say so. Never ask the
human to type one of these; they are a shortcut, not the flow. `enable` and `disable` are the
human's too (`/ledger:enable`, `/ledger:disable`).

## Reading what you are given

- `… pending` lists the open questions with their ids, for you; do not paste it to the human.
- `… log [N]` is the last N notes, questions and answers for this folder, newest first; read it
  when you resume so you do not re-decide what a note already settled.
- A refused line (`refused no such question q-…`, `refused raise is not an option of q-…;
  options: …`) wrote nothing. A `not a command` line was prose and wrote nothing.
- Everything the ledger prints is the human's record; never paraphrase an id, and never invent
  one.
