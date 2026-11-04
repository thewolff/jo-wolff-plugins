# Changelog

All notable changes to the ask-graham plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Earlier releases are described under
"Release notes" in [README.md](README.md#release-notes).

## 0.8.0 - 2026-11-04

### Added

The reply shows the better design beside the pattern-fit one. Jo's rule (2026-11-04): "ask-graham
will share solutions based on whether or not it's a pattern in the code base. In those cases make
sure it's capable and encouraged to show both the best solution based on existing patterns, and
another solution which is better/optimal if one exists." Step 4's second-pattern flag still makes
the design use the repo's pattern or say why it cannot; now, when a design beats the pattern-fit
one on a stated axis (fewer moving parts, removes a known failure mode, closes a gap the pattern
leaves, or is what the repo would adopt if starting today), the reply shows it too, with what it
costs over the pattern (the callers that migrate, a second way to do the thing until the old one
goes). The completed-check template gains an `**Alternative:**` line after `**Red flags:**`: the
better design, its axis and its cost, or `none` with what was weighed. Step 5's fewer-lines rule
still picks the default; the alternative is shown either way, never dropped for losing the pick.
The structure check carries the line when its second-pattern flag fires. pattern-check 0.4.0's
`better design` column is what the line carries when that plugin is installed.

Two live scenarios prove the two shapes: `evals/session-alternative-shown.scenario.json` (three
scripts parse config by hand; a shared loader is better and costs a migration) and
`evals/session-alternative-none.scenario.json` (one loader already serves every script: `none`).
They have no hook phase: the Stop check is unchanged and does not block a reply that lacks the
line, so the line is encouraged by the skill and graded by the canary, not enforced by a hook.

## 0.7.3 - 2026-11-04

### Changed

Closes the loophole where a turn could end on the comparables question and skip the judgment:
three runs in a row asked only that question, never naming the ask (step 1) or answering the gate
questions (step 3). A waiting reply now needs a `**Ask:**` line and a `**Gate questions**` block
with all five bullets above the question; the Stop check blocks it once otherwise, naming what is
missing. Jo's rule (2026-11-04: "you can't skip step 1"). Verdict replies and the structure check
are unchanged. The check is shared, so OMP's `session_stop` applies it too.

The sources file is now enforced, not remembered. Asked "how are you going to enforce not ignoring
the sources file" (Jo, 2026-11-04), the plugin now parses your
`${XDG_CONFIG_HOME:-~/.config}/ask-graham/sources.md`: the every-idea nudge lists each source, and
a full check with that file present must read it, run or read each source in the same turn, and
report each one under `**Local search:**`, or the stop is blocked once naming the first one missed
(see [Your own open-work sources](README.md#your-own-open-work-sources)). Nothing about any
particular machine ships: the plugin names no command or path of its own. Without a sources file
nothing changes.

### Fixed

Fixes from review of the sources check. A source skipped because its listed command writes, or
because research was declined for a remote-only source, is proved by its `**Local search:**` line
marking it *unreachable* with that reason; before, the check demanded the very run the skill
forbids. The reason has to be a stated policy reason, not a keyword: an error that contains one
(`error writing lockfile`, `request declined: HTTP 403`) still needs the attempted call. A result
line now proves only the source whose whole label it carries:
`Held decisions: nothing found` no longer satisfies a `Decisions` source, and a status word inside
a label (`Found items`) is not read as the status. The standing "Delegate the search" rule now says
the configured sources stay in the parent session while everything else may be delegated.

