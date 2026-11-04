# Changelog

All notable changes to the ask-graham plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Earlier releases are described under
"Release notes" in [README.md](README.md#release-notes).

## 0.8.2 - 2026-11-04

### Changed

- `scripts/prune.mjs` is plugin-kit 0.3.3's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged.

## 0.8.1 - 2026-11-04

### Added

The Claude Code Stop hook writes a findings file per session,
`${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/findings/<session id>.json`, whenever the turn's
reply carries a `**Verdict:**` or `**Structure check:**` line: `version`, `sessionId`,
`writtenAt`, `kind`, `ask`, `verdict`, `alternative`, `alternatives` (the chosen design,
`chosen: true`, which is the verdict line's one-line why stored verbatim, so consumers compare by
containment; and the `**Alternative:**` design, `chosen: false`, unless the line is a none-form)
and `found` (the `**Found:**` items), plus `cwd`. Written through a temp file and a rename, mode
0600, overwritten per session, whether or not the Stop check runs or blocks when the Stop payload
carries `last_assistant_message`; without it, `stop-check off` skips the transcript and nothing is
written. A later turn with neither line leaves the file in place: consumers apply a file to the
first decision after `writtenAt`; the file is not retracted by later turns. Other plugins may read
it (paired-coding 1.6.0's cards draw on it); ask-graham reads nothing back. The parser is
`skills/ask-graham/scripts/findings.mjs`; README "Findings on disk" has the shape.

The parser takes a Verdict line in every form the Stop check takes (bold optional, any case, and
inside a fence when there is none outside one), so a reply that passes the check as a verdict
always writes findings. A Verdict line whose verdict word is not one of the four adds no chosen
design. None-forms add `not applicable` and `no alternative`, and no longer catch `None of …` or
`nothing-…` designs. Wrapper marks are dropped only when the same mark closes the value, and an
unchosen design that opens with a code span loses that span's backticks.

### Changed

`scripts/prune.mjs` resolves the state directory with the hooks' rule (`XDG_STATE_HOME` counts
only when absolute), so it prunes the directory the hooks write; findings files age out after 30
days with the block records. The `state` declaration (`$XDG_STATE_HOME/ask-graham`, 30 days)
already covers `findings/`. `stripFences` (`verdict.mjs`) closes a fence at a fence of the same
character at least as long as the opener (CommonMark 0.31.2), not only one of equal length.

### How it fails

A findings write that fails (EACCES, ENOSPC, a file where the directory should be) is one
`errors.log` line and the usual one-line `systemMessage`; the Stop check's decision is unchanged
and the turn is never blocked for it. A reply with no label lines writes nothing and logs nothing.

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
better design, its axis and its cost, or `none: <what was weighed>`. Step 5's fewer-lines rule
still picks the default; the alternative is shown either way, never dropped for losing the pick.
The structure check carries the line only when its second-pattern flag fires. pattern-check 0.4.0's
`better design` column is what the line carries when that plugin is installed.

Two live scenarios prove the two shapes: `evals/session-alternative-shown.scenario.json` (three
scripts parse config by hand; a shared loader is better and costs a migration) and
`evals/session-alternative-none.scenario.json` (one loader already serves every script, and the
prompt leaves only the settings loader open: `none` with what was weighed).
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

## 0.7.2 - 2026-11-04

### Changed

The plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares what the two hooks
can return and four `evals/<x>.scenario.json` prove them (the every-idea nudge and the quiet
prompt at `ask`; the Stop check blocking a reply with no verdict, with a `session` and a `judge`
rubric the nightly canary runs under `claude -p` and grades with `claude plugin eval`, and
letting one with a verdict through); `e2e/live-run.sh` hands off to plugin-kit's scenario
runner. The state directory (`$XDG_STATE_HOME/ask-graham`, 30 days) is declared and
`scripts/prune.mjs` prunes it; the skill has a "When this can't run" section.

### Fixed

`scripts/upkeep.mjs` compared `import.meta.url` with `file://${process.argv[1]}` as strings, and
node resolves the main module through symlinks, so reached through one it did nothing and exited
0; the guard now compares real paths.

## 0.7.1 - 2026-11-03

### Fixed

The Stop check reads the reply from the Stop payload's `last_assistant_message`, and no longer
takes Claude Code's telemetry entries as the newest entry of the conversation, which had let a
reply with no verdict through and blocked one that had a verdict. An unreadable block record now
lets the stop through. The Claude Code hooks no longer fail silently: a fault still lets the
prompt or stop through, and now lands in `errors.log` with the hook file and reason and shows one
warning line.

## 0.7.0 - 2026-10-28

### Added

The structure check. Its reply opens with `**Structure check:**` and then a `**Found:**` or
`**No similar:**` line, which the Stop check requires in place of a verdict line. The every-idea
nudge names the structure check.

