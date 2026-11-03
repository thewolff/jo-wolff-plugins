---
name: ledger
description: Keep a durable, id'd record of this thread's work with the ledger CLI (workloads, questions to the human, decisions, ceilings), and read the open items it injects. Use whenever a session has the ledger plugin installed and the agent is about to write to a folder, ask the human for a decision, make a choice without asking, or say that work is done; also on `/ledger` and when the human types an id-bearing line such as `approve q-…`.
argument-hint: "[open <title> | ask <body> | pending | stale | help]"
license: MIT
---

# ledger

The ledger is one SQLite file on the human's machine that records what this thread did and
what it is waiting on, each row with an id the human can type back. You reach it through one
command, printed at session start as

```
node <plugin dir>/scripts/ledger.mjs <verb> …
```

Run it exactly as printed: that literal path, no alias, no shell variable, no `cd` first. One
allow rule matches that invocation and nothing else, so any other spelling makes Claude Code ask
the human for permission. `… help` prints the whole grammar.

## The four moments

1. **Before the first write to a folder: `open`.**
   `… open "<what you are doing>" [--stakes throwaway|normal|production]` prints a `wl-` id.
   Until a workload is open for the folder (or a parent of it), the hooks deny `git push`,
   `gh pr create`, and writes outside the folder; the deny reason gives the command. The session
   start injection lists workloads already open here; `… open wl-…` resumes a parked or halted
   one instead of opening a second.

2. **When you need the human's decision: `ask`, then end your message with its `pending` line.**
   `… ask "<the question, one line>" --name <short> --options a,b[,c] --default a` prints a `q-`
   id. Options are the one-word answers the human will type; the default is what you will do if
   they say nothing. For a plan with several routes use `--kind plan --allows "a: what a lets
   you do; b: …"` so each option says what it permits. Put the question and its id in the
   message, and end the message with the line `… pending` prints for it:

   ```
   approve q-mvr3k2p9a1xq  # ship · Ship it? · default approve · also: deny / withdraw
   ```

   The Stop hook sends back, once, a message that asks a question without naming an open
   `q-` id. Asking the same open question again returns the same id; do not re-ask in new words.
   Do not use the AskUserQuestion tool without an open `q-` row; the hook denies it and the
   human cannot find the question later.

3. **When you decide something without asking: `decide`.**
   `… decide "<what you chose and why, one line>"` prints a `de-` id. The last few decisions are
   injected at the next session start, so a future thread knows what was settled.

4. **Before you say the work is done: `close` or `park`.**
   `… close wl-… <reason>` when it is finished (open questions on it are withdrawn and listed);
   `… park wl-… <reason>` when you are stopping with work left. The Stop hook sends back, once, a
   message that calls an open `wl-` id done, finished, shipped, landed, merged or closed. The
   session-end hook parks whatever is still open, with the reason `session ended`.

## The human's words

These are the human's verbs; run them only when the human typed the line or asked you to
record it for them: `approve q-…`, `deny q-…`, any option word followed by the `q-` id,
`withdraw q-…`, `halt wl-…`, `ceiling <usd> [<hours>] wl-…`, `extend wl-…`, `extend q-…`.

Lines the human types into a prompt that consist only of such id-bearing lines (or `pending`,
`stale`, `help`) are applied by a hook before you see the prompt, and the numbered results
arrive as context. Treat `n: ok an-… approve → q-…` as the answer recorded and act on it; treat
`n: refused …` as not recorded and say so. Applying the same line again is harmless: a repeated
answer is `already answered`, not an error.

## Reading what you are given

- `… pending` is the paste-ready block of open questions; copy its lines verbatim.
- `… stale [N]` lists open or parked workloads untouched for N days with the line that clears
  each; on a new session, close or park what is yours and leave the rest.
- A refused line (`refused no such question q-…`, `refused raise is not an option of q-…;
  options: …`) wrote nothing. A `not a command` line was prose and wrote nothing.
- Everything the ledger prints is the human's record; never paraphrase an id, and never invent
  one.
