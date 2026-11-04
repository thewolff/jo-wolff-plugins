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
   `… ask "<the question, one line>" --name <short> --options a,b[,c] [--default a]` prints a
   `q-` id. Options are the short answers you will map the human's reply onto; the default, when
   you give one, is what you will do if they say nothing. Give no `--default` when you have no
   preference: the ledger invents none, and the human's bare first-option reply is their choice. Add `--ceiling <usd>` when the question is about spending and
   `--about "<what it concerns>"` when the body alone would not place it. For a plan with several
   routes use `--kind plan --allows "a: what a lets you do; b: …"` so each option says what it
   permits. Then ask the human in ordinary words. Do not print the `q-` id, the `pending` line, or
   any ledger syntax to the human; keep the id in your own context.

   **When the human replies, record the answer before anything else:**
   `… answer <q-id> <option>`, with the option their words mean. When their reply is not one of
   the options ("purple" to red or blue), record the human's reply as given:
   `… answer <q-id> "<their reply>"` is stored as a free-form answer. Never withdraw a question
   because the reply was not in the list. If their reply sets the question aside,
   `… withdraw <q-id>`. If it does not answer it at all, ask again in plain words.

   The Stop hook sends back, once per turn, a reply that ends while a question asked before the
   human's latest message still has no answer, naming the ids to answer; and a reply that asks the
   human for a decision (a choice, a should-I, a do-you-want, a confirmation) while no question
   is open for this folder. A greeting or a request for information ("What are we working on?")
   is not a decision and needs no row. Asking the same open question again returns the same id
   (an open row an earlier session left in this folder becomes yours when you ask it; put it to
   the human and record their reply); do not re-ask in new words. Do not use the AskUserQuestion
   tool without an open `q-` row; the hook denies it and the human cannot find the question later.

   **A question you form but should not put to the human yet: `hold`, never drop it.**
   `… ask …` it as usual, then `… hold <q-id>`. It stays unresolved, is listed under *Waiting on
   you* at every session start, and the Stop hook does not chase it. When you do put it to the
   human, `… reopen <q-id>` first, then ask in plain words.

2. **When you decide something without asking: `note`, in the same turn.**
   `… note "<what you chose and why, one line>"` prints an `nt-` id. The last few entries are
   injected at the next session start, so a future thread knows what was settled. The Stop hook
   sends back, once, a reply that states a decision ("I decided", "going with",
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

4. **Before `git push`, `gh pr create` or `gh pr merge`: `… review`, after the last commit.**
   It sends the branch's diff to other labs' models and records their verdicts for HEAD; the
   PreToolUse hook denies the push while HEAD has no review or has blocking or should
   findings (nits only are a pass, with a notice). On findings: fix them, commit, and run
   `… review` again on the new commit; the output names the round. Repeat until it passes.
   When the output says the round cap is reached, stop and ask the human: waive with their
   reason, or continue with `--force-round`. A judge model checks every finding you claim is
   resolved; to override a finding that does not apply, commit, then run
   `… review addressed "<why>"`. When the human says they are prototyping or need the push
   anyway, run `… review waive "<their words>"` with their words as the reason. Never ask them
   to edit the config to get past the gate.

There is no "open" or "close": the folder you are in is the unit of work, and questions and
notes bind to it. A question is in scope in its own folder, in every folder below it, and in
every folder above it, so a session in a parent folder sees the questions asked in its
subfolders (each line names the subfolder).

**When the human asks what is waiting, pending or open: report first.** Run `… pending --all`
and tell them every row in plain words (the question's name, what it asks, its options) before
you do anything else, and ask nothing else in that turn. Do not go on to other work or another
repository until every row has been reported.

## Lines the human types (optional shortcut)

A human who prefers can still type `approve q-…`, `deny q-…`, an option word followed by the id,
`withdraw q-…` or `extend q-…` into a prompt. A hook applies such lines before you see the
prompt, and the numbered results arrive as context: treat `n: ok an-… approve → q-…` as the
answer recorded and act on it; treat `n: refused …` as not recorded and say so. Never ask the
human to type one of these; they are a shortcut, not the flow. `enable` and `disable` are the
human's too (`/ledger:enable`, `/ledger:disable`).

## Reading what you are given

- `… pending` lists the open questions with their ids, for you; do not paste it to the human. `… pending --all` lists every open and held question in the database under its folder.
- The session start lists the questions waiting on the human in other folders in full (folder, then each question's `pending` line). They were asked by another window and are not this folder's work: do not take them up. If the human's prompt answers one, run `… answer <q-id> <option>` from here and say it is recorded. Otherwise, in your first reply, tell the human in one plain line per question that another window is waiting on them (the question's body, its options, its default when it has one); repeating that body does not trip the Stop ask rule. Never show the id.
- A prompt that is just an option word ("local", "Remote.") comes with a line naming the open question that offers it and the `answer` command. If the human meant it as their reply, run that command and say it is recorded; if they meant something else, ignore the line. The hook records nothing on its own.
- An answer may arrive mid-session: a prompt can carry `ledger: answered since your last turn: <name> → <word>`, recorded from another session. Act on it as the human's answer to that question.
- When session start ends with `ledger: doctor reports N issue(s)`, run `… doctor` and tell the human, in plain words, which checks said `warn` or `fail`.
- `… log [N]` is the last N notes, questions and answers for this folder, newest first; read it
  when you resume so you do not re-decide what a note already settled.
- A refused line (`refused no such question q-…`, `refused raise is not an option of q-…;
  options: …`) wrote nothing. A `not a command` line was prose and wrote nothing.
- Everything the ledger prints is the human's record; never paraphrase an id, and never invent
  one.

## When this can't run

- A `refused …` line wrote nothing; the line says why (no such question, not an option, a verb
  that needs its own line). Fix the line and run it again; do not guess at an id.
- `ledger: database busy at <path>; nothing applied` or `… read-only …`: nothing was recorded.
  Say so to the human in one line and ask nothing else through the ledger until
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" doctor` reports the database `ok`; the Stop
  rules stand down on their own while the database is unavailable.
- A hook's `systemMessage` that starts `ledger … failed open` or `ledger: database …`: the
  hook let the call through without its check. Tell the human once; the line is also in
  `~/.local/state/ledger/errors.log`, which `doctor` counts.
- The CLI is missing (`node: … scripts/ledger.mjs: no such file`): the plugin is not installed
  where `CLAUDE_PLUGIN_ROOT` points. Tell the human; do not ask questions through
  `AskUserQuestion` instead, the gate is off and the question would go unrecorded.
- Each of these gates is proved by a scenario under `evals/`: `evals/pre-tool-use-ask-denied.scenario.json`
  (AskUserQuestion with no row is refused), `evals/pre-tool-use-push-denied.scenario.json` (a push with
  no note is refused), `evals/stop-ask-rule.scenario.json` (a turn that asks with no row is refused once),
  `evals/session-start-relay.scenario.json` (the open items are injected). `ledger canary run --plugins ledger`
  replays them nightly and `ledger gate check` fails without a fresh pass.
