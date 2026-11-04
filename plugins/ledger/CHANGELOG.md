# Changelog

All notable changes to ledger are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries before 0.3.5 are the
"Changes" section of the README (one line per version) and the "Changes in" paragraphs of the
repository root README's ledger section.

## [0.3.7] - 2026-11-04

### Added

- The pane mod logs one dim transcript line per session,
  `ledger pane: surface=<app|none> placed=<true|false|null>`: the surface Claude Code handed the
  mod at `session.start` and whether the pane is placed. It is written at session start, or at
  the first `turn.complete` fallback when session start faulted before it, and never per turn.
  It tells a Desktop run whether the pane is unplaced or the app gave the mod no surface.

### Fixed

- `/ledger` opens the pane again. The skill was named `ledger`, so a bare `/ledger` resolved
  to the skill's slash command and the mod's `ledger` command never ran. The skill is renamed
  `record` (`skills/record/SKILL.md`, `/ledger:record`); the mod keeps `/ledger`.
- The pane's `turn.complete` fallback no longer repeats Claude's whole reply. The engine's
  default result for that event is `{ text: <the answer> }`, and the mod joined its own line
  onto it, so every turn showed the reply a second time under the
  `ledger+cc-plugin-agents-md:` label. The mod now returns its line alone.
- `doctor` no longer counts a `config <file>: … ignoring it` errors.log line whose notice no
  longer reproduces: it re-runs `loadConfig` from that file's folder and drops the line when the
  notice is gone, reporting `n stale config notice(s) ignored` in the `errors` row instead.
  SessionStart's doctor count uses the same filter. `loadConfig` takes `track: false` so that
  re-read leaves the errors.log database tag alone.
- The `record` skill says questions listed from other folders are informational: the agent
  never puts them under its own *Needs you*, since they belong to another window.
- Several processes opening the same fresh database at once (SessionStart hooks of windows
  started together) no longer fail with `database busy`. Switching a new file to WAL is a step
  SQLite refuses at once rather than waiting out `busy_timeout`, and `open` retried it once
  with no pause, so a racer could lose twice in a row. `open` now retries a busy open up to 5
  times in all with a jittered 25–200 ms pause while `busy_timeout` has not run out (one retry
  always, as before), then throws `busy`. The race test runs eight processes instead of four.

### Changed

- `lib/judge.mjs` is now plugin-kit's shared judge dispatch, copied byte for byte (plugin-kit's
  sameness test diffs it). Ledger's own judge logic (the `cc_judge_cache` cache, the passage
  builder, `ask` for review's "is this finding resolved" and `askWord` for the report's grades)
  moved to `lib/ledger-judge.mjs`, which calls the shared `resolveJudgeCommand`,
  `readSharedConfig`, `dispatch`, `parseAnswer` and `topLevelJsonSpans`. Verdicts, cache keys,
  prompts and the error wording `judge exited <n>` and `judge timed out after <n>s` are
  unchanged. The text after `judge could not start:` is now the error code (`ENOENT`) where it
  was the full message (`spawn /bin/sh ENOENT`).
- The judge command is found in this order: env `LEDGER_JUDGE_BIN`, then `review.judgeCommand`
  in the ledger user file (ledger's own settings first, as before), then `command` in the
  shared judge file `${XDG_CONFIG_HOME:-~/.config}/judge/config.json` (new; written by
  `node lib/judge.mjs setup`), then `enforcement.judgeCommand` in the i-have-audhd profile. A
  shared file that exists but is malformed stops the search before the i-have-audhd profile;
  `doctor` names the file and the parse error, and so does the `unverified` verdict's error
  (`no judge configured (malformed <path>: <error>)`).
- Ledger's diff judge never runs shorter than 60 s; a longer shared `timeoutMs` is honoured.
  `judge setup` writes `timeoutMs: 30000` unless given `--timeout-ms`, and ledger keeps its
  60 seconds over that, because a judge cut off early gives `unverified`, which fails open.
- A judge command that prints a `claude -p --output-format json` envelope
  (`{"type":"result","result":"…"}`) is read through it: the yes/no answer is taken from
  `result`. Before, every such answer was `unverified`.
- `doctor`'s judge row names the i-have-audhd source with a trailing ` (legacy)`, and its
  warning lists all four places it looked.

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
