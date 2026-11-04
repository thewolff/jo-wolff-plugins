# Changelog

All notable changes to ledger are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries before 0.3.5 are the
"Changes" section of the README (one line per version) and the "Changes in" paragraphs of the
repository root README's ledger section.

## 0.3.9 - 2026-11-04

### Added

- `canary run --prunes-only`, the daily job: no live run, no `cc_canary_runs` row, every
  declared prune run before and independently of any database write (a `cc_canary_prunes` row
  is still attempted; one that cannot be written is `not recorded: <reason>` on the line). One
  line per prune, `prune <plugin>: <its last stdout line>`; exit 0 when every prune ran, 1
  naming a prune that failed or could not start.
- `canary install --prunes-only` writes `com.jo-wolff-plugins.ledger-prunes.plist` (daily at
  10:00 by default) beside the nightly plist and prints its bootstrap line.
- `canary prune --dry-run`.

### Changed

- `canary prune` prints the plugin-kit contract line last,
  `pruned: <n> file(s), <bytes> bytes freed[ (dry run)]; kept <k>`; a file that cannot be
  removed is named on stderr and counted as kept, exit 0.
- A full `canary run` whose store cannot be written runs the declared prunes before it exits 2.
- The gate's `retention` row runs every declared prune command once with `--dry-run` and fails
  naming one that exits non-zero, cannot start, hangs past 60 s, or ends with any line but the
  contract's.

## [0.3.8] - 2026-11-04

### Fixed

- The Stop hook told the agent "the human has written since you asked these questions" when
  the human had not: a subagent's `<task-notification>` or a `<system-reminder>` starts a new
  turn with a new `prompt_id`, and a new `prompt_id` was all the check looked at, so the agent
  invented a reply (jo-issues #340). The hook now reads the transcript and counts only a prompt
  the person typed (`lib/transcript.mjs` `isHumanPrompt`: not tool results only, not `isMeta`,
  `origin.kind` `human` when stamped, else text that after any leading `<system-reminder>`
  blocks does not start with `<task-notification>`, `<system-reminder>`, `<agent-message`,
  `<local-command-stdout>`, `<local-command-caller>`, `Another Claude session sent a message:`,
  `Stop hook feedback:` or `[Subagent hand-back]`). Only that prompt is evidence: a missing,
  unreadable or symlinked transcript, or one with no timestamped `user` entry, sends no answer
  nag. The hook reads at most the transcript's last 4 MiB and scans all of it: an entry older
  than the question is skipped, never ends the scan, and a complete line that starts exactly at
  the 4 MiB cut is kept (only a line cut in half is dropped).
- While brb holds the session (`${XDG_STATE_HOME:-~/.local/state}/brb/<session_id>/away.json`
  is a regular file of at most 64 KiB holding an object with a string `since`, brb's own rule,
  at brb's own path for any non-blank `XDG_STATE_HOME`), the Stop hook no longer asks for an
  answer, and a reply that asks a question with no row is sent back with "record it with
  `ask`, then `hold`" instead of "ask in plain words". Read-only; a symlink or any error reads
  as not away.
- `hold <q-id>` recorded the answer `hold` when the question listed `hold` as an option (the
  option word was matched before the verb). `hold` and `reopen` now always change state and
  never answer; `answer <q-id> hold` still answers with that option.

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
