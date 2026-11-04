# Changelog

All notable changes to plugin-kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases before 0.2.1 are described in
the README's "Changes in" sections.

## [0.2.1] - 2026-11-04

### Changed

The cross-lab reviewer has a review budget (see "Review budget" in the README), so a review loop
ends. Three verdicts, `ship`, `ship-with-limits` and `fix-first`, and `fix-first` only on a
finding whose worst case is data loss, a live-state write outside the plugin's own state, a
crash or hang, wrong-recipient delivery, or a security boundary violation inside the threat
model. The invoking prompt carries a `Threat model:` line, and the reviewer asks for it and
stops without one; findings outside it are `Out of scope`. The repository default is
`Threat model: none — every input is Jo's own; review for correctness and fail-safety, not adversarial inputs`,
which the brief template shows prefilled. Each finding has a one-sentence worst case and a
`new-mechanism` tag, and fixes that add a mechanism are held for Jo. Round 2 verifies the prior
findings only; from round 3 the review is blocking-only. Without an in-scope blocking finding, a
static-only review is now `ship-with-limits`, with `no executable check ran` as its first limit;
an in-scope blocking finding still makes it `fix-first`. Each review opens with a
`## Round <R>` heading, the form the next review's round count reads (a `Round: <R>` line
alone reset the count to round 1), and a prior review with no round heading or `-round<N>` file
name counts as unreadable, so the reset is stated. The release gate, the scaffolder and the
runner are unchanged.
