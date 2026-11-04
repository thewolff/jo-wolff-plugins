# Changelog

All notable changes to ledger are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries before 0.3.5 are the
"Changes" section of the README (one line per version) and the "Changes in" paragraphs of the
repository root README's ledger section.

## [0.3.6] - 2026-11-04

### Added

- The plugin gate's sixth check, `docs` (a release is written down). When a plugin's
  `.claude-plugin/plugin.json` version differs from the base commit's, its `CHANGELOG.md` and
  its `README.md` each have a release heading for the new version with text under it, and the
  repository root README names the version for the plugin. A release heading is a heading at
  any level whose text starts with `<ver>`, `[<ver>]`, `Changes in <ver>` or
  `<YYYY-MM-DD> — <ver>`, in either file; the version is a whole token (no `v` prefix, no
  pre-release suffix, brackets balanced), and a heading inside a fenced code block does not
  count. The root README names it in any `-` or `*` bullet starting with the plugin's name, on
  a `Changes in <plugin> <ver>` line, or on a `Changes in <ver>` line under `## <plugin>`. The
  row is `skipped` while the version is unchanged or neither manifest has one, and fails with
  `manifest version missing at head` when the head dropped a version the base had; each
  failure names the file and the heading it wanted. The base manifest and the root README are
  read out of the commits with `git show`, never the checkout. A fence opens with ``` or ~~~
  indented at most three spaces, and a root README bullet inside a fence does not count.
- This file.

### Changed

- `gate check --plugins a,b` resolves the base commit too (the review's default base, or
  `--base`), since the `docs` row compares against it. A `--base` that names no commit exits 1
  with `gate check: --base <ref> is not a commit`, in both modes, instead of a stack trace.
- The push gate denies rows that lack one of the six checks (rows recorded by an older ledger,
  without `docs`), naming the missing check and `gate check` as the way out.
- `ledger help` and the README say six checks.

### Fixed

- The canary prune test accepts either shell's wording for a missing binary (bash's
  `No such file or directory`, dash's `1: … not found`), so the suite passes on Linux. Test
  only; no behaviour change.

## [0.3.5] - 2026-11-04

### Added

- The plugin gate runs five checks, not three: `evals` (an `evals/manifest.json` declaring each
  hook's outcomes, one scenario per event × outcome, and a recent canary pass for the committed
  plugin tree) and `retention` (every path written outside the worktree declared in
  `.claude-plugin/plugin.json` `state`, with a prune command for anything kept a number of days)
  join the three from 0.3.3.
- A canary row keeps `tree_sha`, the committed plugin tree it certifies, and `writes`, the files
  the live run left outside its work directory. After the live runs the canary runs every
  declared `prune` once and records it as a `cc_canary_prunes` row; `--no-prune` skips that pass.
  `canary status` prints the last run, the last pass and the last prune per plugin.
- Every plugin in this repository has an `e2e/live-run.sh` that hands off to plugin-kit's
  scenario runner `lib/live-run.mjs`; the ledger's own scenarios cover its five events.
- Schema 8: two columns on `cc_canary_runs` (`tree_sha`, `writes`) and the `cc_canary_prunes`
  table. A 0.3.3 or 0.3.4 ledger on a schema-8 file runs on the tables both know.
