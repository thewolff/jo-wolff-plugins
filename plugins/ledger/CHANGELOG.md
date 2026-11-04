# Changelog

All notable changes to ledger are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries before 0.3.5 are the
"Changes" section of the README (one line per version) and the "Changes in" paragraphs of the
repository root README's ledger section.

## [0.3.6] - 2026-11-04

### Added

- The plugin gate's sixth check, `docs` (a release is written down). When a plugin's
  `.claude-plugin/plugin.json` version differs from the base commit's, its `CHANGELOG.md` has an
  entry for the new version (`## [<ver>]` or `## <ver>`, with text under it), its `README.md` has
  a release heading for it (`## Changes in <ver>`, `### <ver>` or `### <date> — <ver>`, with text
  under it), and the repository root README names the version for the plugin (in its top-level
  bullet, on a `Changes in <plugin> <ver>` line, or on a `Changes in <ver>` line under
  `## <plugin>`). The row is `skipped` while the version is unchanged or the manifest has no
  version; each failure names the file and the heading it wanted. The base manifest and the root
  README are read out of the commits with `git show`, never the checkout.
- This file.

### Changed

- `gate check --plugins a,b` resolves the base commit too (the review's default base, or
  `--base`), since the `docs` row compares against it.
- `ledger help` and the README say six checks.

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
