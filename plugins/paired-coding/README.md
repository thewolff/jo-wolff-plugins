# paired-coding

A plugin for pairing with an agent on code, one change set at a time. The agent drives; you
navigate. Before each change set it shows you a **card** that names the decision inside the
change, the code it touches, the effect it will have and the exact files it will write. It
writes only after the two of you agree on that card, then shows you the real diff.

The problem it addresses is speed. Agent code arrives faster than a person can recognise the
decisions inside it. A plan written up front cannot predict every design choice that
implementation reveals, so a wrong direction is found after a whole feature exists, and you end
the session owning code you did not follow. Pairing moves the decision point to before each
change set is written, while it is still cheap to steer.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install paired-coding@jo-wolff-plugins
```

## What happens when you pair

Ask for it in words: "pair with me", "let's pair on this", "paired coding". The skill
(`skills/paired-coding/SKILL.md`, the single source of the contract) then runs three phases:

1. **Define the work together.** Outcome, constraints, one concrete example of success. Nothing
   is written.
2. **Recon.** The agent explores read-only and proposes a roadmap of change sets, one line each.
3. **Pairing loop.** For each change set: a card, discussion, agreement, the agent makes the
   whole change set, then a read-back with the diff, the check output and what the change
   means.

A change set is the smallest change in code whose effect can be checked on its own. Agreement
is a shared understanding of the behavior, the approach and the boundary, evidenced by you
saying to go ahead in your own turn after the card. A question, a comment that changes the
card, or "looks good" while the card still lists open points keeps the conversation going.
When the agent discovers that the agreed behavior, approach or boundary no longer holds, it
stops and brings a revised card.

## The gate, as designed

A skill can describe the conversation; only a gate at the tool boundary can make "no write
without agreement" true. The design, shared by every host adapter:

- A gate core (`core/`) with no host imports, holding the pairing state: `inactive` until
  `pair_start`, then `closed` between change sets and `open` during one. Missing or damaged
  state reads as `closed`.
- The agent registers each card with `pair_propose` and opens it with `pair_begin`, quoting
  your words of agreement. The gate accepts the quote only if it appears verbatim in a turn
  the host recorded as typed by a person after the card, only if the card has no open points,
  and only if the card's files are unchanged since it was shown. Ending the session with
  `pair_stop` takes a quote of your words the same way.
- While pairing, the host's own write, edit, shell, eval and sub-agent tools are refused. The
  agent writes through `pair_write` and `pair_edit`, which accept only paths inside the open
  change set's boundary, and runs commands through `pair_run`, which runs them in the
  foreground under a macOS Seatbelt profile built from the current state.
- `pair_done` returns the diff of the boundary, computed by the gate. Every card, quote,
  verdict, refusal and diff goes into a journal outside the worktree, under
  `$PAIRED_CODING_STATE_DIR` (default `~/.local/state/paired-coding/<session-id>/`).

## What this enforces, and what it does not

**Nothing is enforced yet.** The gate core and the host adapters for Claude Code and OMP are
not built or verified on any host. Until they are, this plugin is the skill text alone: the
agent follows the contract as conversation, and nothing at the tool boundary stops a write
outside an agreed change set.

| Host | Status today |
|---|---|
| Claude Code | Skill only. Gate not built, not verified |
| OMP | Skill only. Gate not built, not verified |
| Codex | Skill only. Gate not built, not verified |
| Anything else | Skill only, as conversation |

This section changes only when a live session on a host passes the gate's adversarial tests.
Each host will then be listed as verified or unverified, with the test that decided it.

Once built, the gate's limits, by design:

- It cannot tell whether behavior inside the boundary drifted from what was agreed. That is the
  skill's reopen rule and your read of the real diff.
- It is macOS-only, because `pair_run` depends on Seatbelt. Elsewhere `pair_start` will refuse
  and the skill works as conversation only.
- A process that escapes its process group during an open change set keeps its write
  permission. Content snapshots catch such a write at the next snapshot and stop the session;
  they do not prevent the first one. Writes after the final snapshot, and writes inside
  directories excluded from snapshots, are not detected.
- The agent judges when you have agreed. A misread go-ahead can open a change set, but only off
  a real typed turn after a real card, only for the card's files, and with the quote in the
  journal for you to audit.

## License

MIT. See the repository root `LICENSE`.
