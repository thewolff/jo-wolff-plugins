---
name: paired-coding
description: "Pair with the user on a code change: you drive, they navigate, and each change set is written only after they agree to its card. Use when the user asks to pair, for example 'pair with me', 'let's pair on this', 'paired coding', or when a pairing session is already running. A request to fix, explain, or check in before a step, worded without pairing, is ordinary work."
license: MIT
---

# Paired coding

You and your partner build a change together, one **change set** at a time. You are the
**driver**: you read, propose, write and run. Your partner is the **navigator**: they steer,
catch design errors early, and decide when each change set goes ahead. The goal is that your
partner understands the code while it is written and catches a wrong direction before a whole
feature is built on it.

Every write belongs to an agreed change set. The **card** is how a change set is proposed, and
**agreement** on the card is the only thing that opens it.

## Phases

Start pairing with `pair_start` before phase 1, so the gate holds writes from the first turn.

1. **Define the work together.** Agree the outcome, the constraints, and one concrete example
   of success. Write nothing. *Done when* all three are stated and your partner has confirmed
   them.
2. **Recon.** Explore read-only, yourself, and propose a **roadmap**: an ordered list of change
   sets, one line each. Keep it with `pair_note`, which appends to the pairing journal outside
   the worktree. The roadmap is a route; each change set still needs its own card and
   agreement. *Done when* the roadmap is in the journal and your partner has seen it.
3. **Pairing loop.** Repeat until the roadmap is done or your partner stops.
   1. **Card.** Propose the next change set (see *The card*) and register it with
      `pair_propose`, passing the same fields. *Done when* the card is registered and shown,
      every field filled.
   2. **Discussion.** Your partner comments, asks for more, steers, skips or stops. Answer, and
      revise the card. Every revision is a new card: register it again and show it again.
      *Done when* the card has no open points and your partner has agreed (see *What agreement
      means*), or they skip or stop.
   3. **Agreement.** Open the change set with `pair_begin`, passing the card id and a verbatim
      quote of your partner's words of agreement from their turn after the current card. If the
      gate refuses the card as stale, register it again and show it again.
   4. **Make it.** Complete the whole change set: the code, a focused test where the behavior
      warrants one, and the checks. Work straight through the mechanical steps. Write with
      `pair_write` and `pair_edit`, and run commands with `pair_run`. *Done when* every check
      in the boundary has run and passes, or a reopen trigger fired.
   5. **Read-back.** Call `pair_done` and show the diff it returns, the check output, two lines
      on what the change means, and any roadmap revision. *Done when* all four are shown; then
      the next card.

When the roadmap is done or your partner stops, and no change set is open, call `pair_stop`
with a verbatim quote of your partner's words ending the session, then give a closing summary.

## The unit

One **minimally verifiable change set**: the smallest set of changes, in code and not only in
tests or artifacts, whose effect can be checked on its own.

- A playback-fallback fix, its regression test and the check run are one change set.
- A rename across twelve files with no behavior change is one change set.
- A new storage contract is its own change set, separate from the fix that needs it.
- A behavior change and a refactor are two change sets.

Your partner can resize the unit at any card.

## The card

Short by default. When your partner says "show more", expand any field.

- **Why now:** one line tying it to the roadmap.
- **The decision inside it:** the choice your partner might disagree with, stated plainly. This
  line is why pairing exists; write it first and make it specific.
- **Current code:** the smallest excerpt of what the change set touches.
- **Proposed effect:** what behaves differently afterward.
- **Boundary:** the exact files it will write, as worktree-relative paths, globs, or `dir/` for
  a whole subtree, and the checks it will run.
- **Open points:** anything you need your partner to settle. Agreement waits until every open
  point is settled.

When the gate reports files changed since the last read-back, put that list at the top of the
next card and ask your partner which changes are theirs. A change your partner does not
recognise ends the session.

## What agreement means

Agreement is a shared understanding of three things, reached in conversation: the intended
**behavior**, the **approach**, and the **boundary**. It is evidenced by your partner saying, in
their own turn after the current card, to go ahead, in whatever words.

These stay discussion, and the card stays closed:

- a question;
- a comment that changes the card: revise it, register it, show it again, and agree on the
  revision;
- "looks good" while the card still lists open points: ask about each open point;
- silence;
- anything said before the current card was shown.

The quote you pass to `pair_begin` is the evidence. Quote the words that carry the go-ahead,
exactly as your partner typed them.

## When agreement reopens

Stop, show what you found, and return to discussion with a revised card when:

- discovery changes the agreed **behavior**;
- the approach **materially expands**: a file outside the boundary, a new dependency, a new
  public interface, a storage or schema contract, or removal of existing behavior;
- a check fails and the fix lies outside the agreed approach;
- the actual diff differs from what the card said.

A gate refusal that says "outside the agreed boundary; reopen" is this rule firing: reopen.

A failing check whose fix stays inside the agreed approach and boundary (a typo, an import, a
test assertion off by the agreed behavior's own definition) is part of making the change set.
Fix it, keep going, and show it in the read-back.

## Tools while pairing

While pairing is active, the gate allows read-only tools and the `pair_*` tools. Write through
`pair_write` and `pair_edit`, run every command through `pair_run`, and do recon yourself in
this session. The host's own write, edit, shell, eval and sub-agent tools are refused, and so is
any tool the gate does not know.

When the `pair_*` tools are not installed, the contract holds as conversation. Run every phase
as written, keep the roadmap in the conversation, and hold every write to the agreed boundary
yourself: use the host's tools only inside an open change set, and show the real diff of the
boundary files from version control in the read-back.

## XP practices: purpose kept, mechanism changed

Pair programming practices assumed two roughly equal humans. Each purpose stays; the mechanism
fits a human navigator and a model driver.

| Practice | Purpose kept | Mechanism here |
|---|---|---|
| Driver and navigator | The driver programs out loud; the navigator catches design errors early | You drive; the card's "decision inside it" line is the out-loud part; your partner navigates |
| Test first | Clarify behavior and get fast evidence | Agree the failing example inside the change set when behavior changes; trivial edits carry no ceremonial test |
| Simple design, refactoring | Smallest thing that works; cleanup kept separate | Behavior changes and refactors are separate change sets |
| Sustainable pace | Protect human judgment | Your partner can resize the unit, pause or stop at any card |
| Collective ownership | Code someone can maintain | Your partner's understanding of the code is the goal; the read-back's two lines serve it |
