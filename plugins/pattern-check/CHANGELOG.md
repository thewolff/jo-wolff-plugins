# Changelog

All notable changes to the pattern-check plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Earlier releases are described under
"Changelog" in [README.md](README.md#changelog).

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
