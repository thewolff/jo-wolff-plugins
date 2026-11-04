# Changelog

All notable changes to as2-skills are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases before 0.1.3 are described
under "Changes in" in [README.md](README.md).

## 0.1.3 - 2026-11-04

### Added

- `scripts/prune.mjs`, the plugin's prune verb, declared in `.claude-plugin/plugin.json` for
  `$TMPDIR/seo-audit-*` (retention 1 day, was 0 days with no prune). The seo-audit skill's
  Lighthouse run and Chrome render each make one temporary directory there and remove it in
  `finally`; the verb catches the directory a killed process (the 120 s wall clock, a SIGKILL,
  a crash) left behind. It removes every `seo-audit-*` directory under the temp directory older
  than `--days` (default 1) with everything in it, prints
  `pruned: <n> file(s), <bytes> bytes freed[ (dry run)]; kept <k>` last (`--dry-run` counts and
  removes nothing), names on stderr a directory it could not remove and exits 0. Ledger's
  canary runs it nightly and daily. `scripts/prune.test.mjs` drives it.
