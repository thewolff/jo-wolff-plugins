# Changelog

All notable changes to the pattern-check plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Earlier releases are described under
"Changelog" in [README.md](README.md#changelog).

## 0.4.1 - 2026-11-04

### Added

- `prune --dry-run`: counts what would go, removes nothing.

### Changed

- `prune` prints the plugin-kit contract line, `pruned: N file(s), B bytes freed[ (dry run)];
  kept K`, and exits 0 when a file cannot be removed (the file is counted as kept and named on
  stderr) instead of 1: the canary reads a non-zero exit as a failed prune.

## 0.4.0 - 2026-11-04

### Added

The receipt gains a `better design` column per piece, after `reason`: `none: <what was weighed>`
(a bare `none` is refused), or the design that beats the pattern-fit one on a stated axis
(fewer moving parts, removes a known failure mode, closes a gap the pattern leaves, or is what
the repository would adopt if starting today) with what it costs over the pattern (the callers
that migrate, a second way to do the thing until the old one goes). Pattern fit stays the
default; the better design is shown beside it, never instead of it. Jo's rule (2026-11-04):
"ask-graham will share solutions based on whether or not it's a pattern in the code base. In
those cases make sure it's capable and encouraged to show both the best solution based on
existing patterns, and another solution which is better/optimal if one exists." ask-graham
0.8.0's `**Alternative:**` line carries the cell.

Two scenarios prove the accept and the refusal: `evals/stop-record-better-design-none.scenario.json`
(a row with `none: <what was weighed>` records and the plan-shaped reply passes) and
`evals/stop-record-without-better-design.scenario.json` (a nine-column row is refused naming the
row and the missing cell; the plan stays held).

### Changed

`record` refuses a row whose `better design` cell is missing (a nine-column 0.3 row), empty, a
bare `none` (or `nothing`, `nothing better`, `no better`, `no better design`; each is accepted
with what was weighed after it), or a placeholder (`-`, `?`, `TBD`, a bare `n/a`, `none: TBD`, `n/a: TBD`, `N/A - TBD`,
`tbd later`, `see above`), naming the row and the column, before it checks the
fail cells. Nothing is written on refusal. The skill's table, its `**Pattern check:**` reply
guidance and its "When this can't run" section carry the column and name the two scenarios. The
lenient parser option is `requireAllColumns: false` (was `requireFailColumns`) and reads the
four-column (0.1, 0.2) and nine-column (0.3) shapes.

Receipts already on disk are not invalidated: `record` validates only the rows it is given, and
the hooks only check that a receipt file exists for the session, so an old receipt still lifts
the hold. The Stop check is unchanged.

## 0.3.2

### Changed

The plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares what the three
hooks can return and eight `evals/<x>.scenario.json` prove them (under the threshold, the third
file held, with a `session` and a `judge` rubric the nightly canary runs under `claude -p` and
grades with `claude plugin eval`, the receipt lifting the hold, a corrupt config warning and
letting the call through; a plan refused without a receipt, passed with one, a report passing;
SessionEnd cleaning its files); `e2e/live-run.sh` hands off to plugin-kit's scenario runner.
`pattern-check prune [--days 30]` removes receipt copies, stop guards and session files older
than that (errors.log and `current/` stay) and prints the bytes freed; the state directory, the
config file and the repository's `.pattern-check/` are declared as state. The skill's "When this
can't run" section names the scenarios.

## 0.3.0

### Added

The receipt gains the five fail columns (`fails how`, `next step`, `restart-safe`, `bounded`,
`evidence kept`), and `record` refuses a row whose fail cells are empty, placeholders, or `n/a`
without a reason; four-column receipts already written still count. The deny and Stop refusal
texts ask both questions: what exists already, and how does it fail.

### Fixed

Bash write forms are read through a shell lexer, fixing two real commands the redirect matcher
miscounted. Hook faults are appended to `errors.log` as well as shown, `hooks.json` sets a 5 s
timeout, and NotebookEdit is counted.

## 0.2.0

### Added

An OMP adapter (`omp/pattern-check-omp.ts`) runs the PreToolUse counter on OMP's `tool_call` and
the Stop refusal on `session_stop`, through the hooks' own functions and state.
