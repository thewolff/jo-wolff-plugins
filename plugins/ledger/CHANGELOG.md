# Changelog

All notable changes to ledger are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries before 0.2.1 are the
"Changes" section of the README (one line per version).

## 0.4.2 - 2026-11-12

### Fixed

- The PR-creation review check (`gh pr create`) now checks the branch named by `--head`
  at `refs/heads/<branch>` on the branch's remote (`branch.<head>.remote`, else origin),
  not the branch's upstream merge ref, so a PR is gated on the commit it actually opens.
- `--head` parsing skips the values of other options and stops at `--`, so a value such as
  `--body '--head=x'` no longer counts as a head. Attached short forms (`-Hx`, `-H=x`) are
  read. A repeated `--head` checks every local branch it names, even beside a head containing
  `:` (a fork head); only when every head is a fork head is the call allowed with a notice.

## 0.4.1 - 2026-11-12

### Changed

- A store failure names its SQLite codes. The CLI's `ledger: database <word> at <path>: …`
  line, the StoreError message and the hooks' `errors.log` line end with
  `(sqlite errcode <primary> <NAME>, extended <extended> <NAME>)`, for example
  `(sqlite errcode 8 SQLITE_READONLY, extended 1032 SQLITE_READONLY_DBMOVED)`. node:sqlite
  exposes only the extended code (`err.errcode`; a UNIQUE violation gives 2067, measured on
  Node 24.13), so the primary code is its low byte. Every SQLITE_READONLY variant has primary
  code 8, and only the extended code says which one fired. A hook's `systemMessage` is unchanged.
- Every `errors.log` line carries `ctx={"session","cwd","ppid","parent"}` before its
  ` [db <path>]` tag: the hook input's `session_id` (else `LEDGER_SESSION_ID`, else null), the
  hook input's `cwd` (else the process's), and the parent process's pid and command line from
  `ps -o command= -p <ppid>`. The lookup runs only when a line is written, at most once per
  process, with a 250 ms timeout and the command cut to 200 characters. When ps cannot run the
  field says why, as `? (ps EPERM)` (what a macOS seatbelt profile gives, since ps is setuid),
  `? (ps ENOENT)` or `? (ps timed out after 250 ms)`, and the line is still written.
  `doctor` reads the tag apart from the message, so its counts and stale config notices work
  as before, and lines from 0.4.0 and older still parse.

## 0.4.0 - 2026-11-11

### Added

- Owed work (migration 9: `cc_owed`, `cc_owed_moves`, `cc_sessions.last_owed_block_prompt`).
  `answer` records approved work as owed (`ow-…`), except a `deny` on an approval question
  and a `cancel` on a plan question, which create nothing. `--nothing` records that the reply
  sets nothing in motion, `--work` names the work, `--pointer` says what is doing it.
- Verbs `owe`, `start`, `drop`, `done` and `wait`; `hold <ow-id> "<why>"` defers owed
  work. None of them applies from a typed prompt.
- Stop rule `stopOwedRule`: owed work this session has not started, deferred, dropped,
  finished or linked to an open question blocks the end of a turn once per prompt.
- Stop rule `stopOfferRule`: a reply that offers to do work (eleven sentence patterns,
  question-worded offers included) with no ledger question recording it, by its `--about` or
  its text, blocks the end of a turn once per prompt, even while another question is open.
  While away (brb) the reason says to record the offer and `hold` it.
- Both rules share a second once-per-prompt slot, so the answer, ask and decision rules keep
  theirs. A pass afterwards shows what moved (`ledger: started: …`) once, up to 8 lines.
- Owed work is listed first at session start (never truncated) and on a typed prompt that is
  not a ledger line, in the agent's context only.
- `ledger report` gains an owed section: formal and agent rows, how many answers set nothing
  in motion, and the work deferred now and deferred more than 7 days ago.
- `forcing.stopOwedRule` and `forcing.stopOfferRule` (both default true).
- `test/offer-scan.mjs`, a by-hand scan of past transcripts for how often the offer rule
  would fire.
- Who owns owed work: work from an answered question belongs to the session that asked it,
  whichever session recorded the answer; the item is tagged with the asking session when it is
  made. A `start`, `hold`, `drop`, `done` or `wait` by another session takes the item over: it
  then blocks that session, not the asker, and shows in that session's started and deferred
  lists. Other work belongs to the session it is tagged with, whatever its folder. Untagged
  work from an untagged question (no `LEDGER_SESSION_ID`) goes by folder and start time.
- `answer`: a quoted reply or `--work`/`--pointer` value is never read as a flag, and a reply after a bare `--` is recorded literally (`answer q-… -- --nothing`).
- A `start` or `hold` that repeats an item's pointer or reason from another session takes the item over (one move row) instead of reporting a noop.
- `pending` also lists this session's owed work from other folders (` · in <folder>`), and `pending --all` lists every folder's owed work, so the capped owed lists' `pending` pointer shows every item they leave out.
- A `wait` that repeats an item's link to a question from another session (one that adopted the question by repeating `ask`) takes the item over (one `wait` move row) instead of reporting a noop.
- The capped owed lists (SessionStart, UserPromptSubmit, and the Stop list's still-owed lines) point at `pending --all` instead of `pending`, so every item they leave out is reachable even when `LEDGER_SESSION_ID` is not set in the CLI's environment.
- `answer … --work` and `--pointer` take the next argv token as their value even when it starts with `--`, so `--work "--nothing"` through the CLI (where the shell has removed the quotes) records the work instead of reading `--nothing` as a flag.
- The Stop list's overflow line no longer points cut events (done, dropped and the rest) at `pending --all`, which does not list them; it says they show at a later Stop, and only cut still-owed lines point at `pending --all`.

## 0.3.13 - 2026-11-11

### Fixed

- `gate check`'s `visible` row failed a stateless hook on the unwritable-state input whenever
  its output changed between runs. The rule for a hook that logged nothing there compared its
  stdout with the healthy run's byte for byte, so the coordinator plugin's clock hook, which
  prints the time to the second, passed or failed depending on whether the two runs fell in
  the same second (14 of 20 runs failed in one measurement). Now a hook that logged nothing on
  the unwritable-state input also passes when its healthy run wrote nothing in the directories
  that input makes read-only (`<XDG_DATA_HOME>/<plugin>`, `<XDG_STATE_HOME>/<plugin>` and the
  declared state directories), whatever it printed. No manifest key is needed. "Wrote
  nothing" is recorded, not inferred: `lib/write-tracker.cjs` is preloaded into each spawned hook
  (`NODE_OPTIONS=--require`) and logs every path the run tried to write through `fs`, so a lock
  file made and removed within one run counts even where the directory's mtime does not move
  (removing a path that does not exist is not a write), and a write through a symlink counts
  where the link points, not only where it sits. A run the tracker cannot follow (the
  spawned process is not node, a child process or worker thread it started did not load the
  tracker, or it loaded a native addon) has an unknown baseline and gets no such pass.
- A hook that writes state on the healthy input and swallows the unwritable fault (no
  `errors.log` line) still fails, in the state directory and in the data directory alike.
- The write tracker counts a write through a dangling symlink, or a chain of symlinks ending
  at a file that does not exist yet, at the file the write creates. It walks the chain with
  `readlink` (at most 40 hops) only when `realpath` fails, and a loop or a missing directory
  leaves the hook running.
- A lock file made and removed in the state directory within one coarse filesystem tick no
  longer leaves a run the tracker cannot follow reading as unknown. The sandbox sets each
  directory the unwritable input locks to an mtime of 2000-01-01 before the run (one `utimes`
  per directory), so any entry change moves it.

### Changed

- `spawnHook` (`lib/plugin-gate.mjs`) returns `wrote` (true when the tracker recorded a write
  attempt in a directory the unwritable input locks, or the run left an entry or an `errors.log`
  line there; false only when nothing showed and the tracker followed the whole run; null when
  unknown) and `tracking` (`trackedWrites`'s verdict), and takes `baselineWrote`, the healthy
  run's `wrote`.

## 0.3.12 - 2026-11-11

### Changed

- Ledger pane (`mods/pane/register.mjs`): redrawn as one column for a narrow dock (about 290 pt
  in Claude Desktop, 40 columns in a terminal). The age and state ("16m ago · selected") sat in
  a side column beside the question's name and clipped (`16m ag`, `selecte`); they are now their
  own line under the question's text (`on hold · 2h ago` for a held one), and the word
  `selected` is gone: the selected question is the one with buttons.
- Folder groups are headed by the folder's name (`newdle-mobile`), not its absolute path; two
  folders with the same name show one more path segment each (`a/web`, `b/web`). `folderLabels`
  in `mods/pane/data.mjs`.
- No row id and no question `--name` is drawn. A question leads with its text; a question that
  is not selected has one `answer` button with its digit (1 to 9). An answer since your last
  turn shows its question's text and `→ <answer>` or `withdrawn` (the query now returns each
  answer's question body); `(via …)` is no longer shown. After a press the pane says
  `Recorded: <reply>` over the question's text, or `Not recorded` with the CLI's reason with its
  ids taken out (`withoutIds`), in place of the CLI's `recorded: an-… → q-… (name)` line.
- The `options: approve (default) · revise` line under each question is gone; the default
  option's button reads `approve · default` and is the primary button.
- Headings lead with their count: `1 answer since your last turn`, `2 questions waiting in
  other folders` (`in another folder` for one). The empty state is one line; the error state
  is `Can't read the ledger` and the reason.
- The footer is `Esc back to prompt · Ctrl+X X close`; the `/ledger answer <q-id> <reply>`
  form stays in the command's description and the README.
- The Reply field's placeholder is `type your own`, short enough to show whole beside its label
  and the `record` button at the narrow width.
- Indentation is `paddingLeft` on a Box, never leading spaces in a Text.
- Every Text in the pane wraps; none is truncated, so a folder name keeps the parent segment
  that tells it apart (`alpha/…`, `beta/…`) and the recorded question shows in full.
- A question or answer with no text shows `(question text missing)`, never its `--name` or row
  id. The query-error and render-fault lines go through `withoutIds` too.
- `withoutIds` says the CLI's refusals as sentences (`Already answered with green; an answer is
  final`, `This question was withdrawn; …`, `This question is no longer in the ledger`,
  `That reply looks like a cut-short id; nothing was recorded`) and keeps the human's own reply
  whole; any other message loses complete and cut-short ids and the brackets they leave.

### Unchanged

- Polling, refresh points, option presses and Reply recording through the CLI, `/ledger`,
  `/ledger answer`, `/ledger close`, Esc and Ctrl+X, the toast, the fallback transcript line,
  and the session-start text.

## 0.3.11 - 2026-11-10

### Fixed

- Review gate, `review.mode` `gate`: a `git push`, `gh pr create` or `gh pr merge` that runs
  where the gate cannot follow is denied; before, it was allowed with a notice, so
  `W=/some/worktree; cd $W; git push; gh pr create` published an unreviewed commit. Covered: a
  `cd`, `pushd` or `-C` whose folder is a variable, a `$(…)` or backtick substitution, `~`, a
  glob (`*`, `?`, `[…]`), a brace expansion, `cd -` or a bare `cd`; a literal `cd` to a folder
  that does not exist, from inside a repository (the `cd` fails, and after a `;` the push runs
  where the shell already was); `--git-dir`; `--work-tree`; a `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_NAMESPACE` or `GIT_CONFIG*` assignment or export; a `-c` or `--config-env` that sets
  push, remote or branch config. The reason names the way out: the push re-issued as its own
  `cd /absolute/path && git push <remote> <branch>`. A hyphen in a literal folder name was
  never a problem and stays one (`cd /a/story-charts-step1 && git push` resolves); only the
  bare word `-` is unresolved.
- Review gate, `gate` mode: a `git push` or `gh pr create` that follows, on the same command
  line, a command that may change the commit it publishes is denied; before, it was checked against HEAD as it was before the
  line ran, so `git rebase origin/main && git push` and `git commit -m … && git push` published
  a commit no review had seen. The commands: every git subcommand not on a list of ones known to
  leave HEAD and every other ref alone (`HEAD_KEEPERS` in lib/gate.mjs: `add`, `status`,
  `log`, `diff`, `stash`, a listing `branch` or `tag`, a reading `config`, …), so `git commit`,
  `rebase`, `merge`, `cherry-pick`, `revert`, `reset`, `pull`, `checkout`, `switch`, `am`,
  `bisect`, `update-ref`, `symbolic-ref`, `subtree`, `fetch`, and a git alias; plus
  a `stash` other than `list` or `show` (`stash branch` moves HEAD; the rest rewrite
  `refs/stash`, which a refspec can name), a `branch` or `tag` that creates, moves or deletes, a `config` that
  writes, a `submodule` other than `status` or `summary`, a `worktree` other than `list`, a
  `remote` other than a bare one, `show` or `get-url`, a `notes` other than `list` or `show`,
  and `gh pr checkout`. A `branch` or `tag` listing with a pattern (`--list 'v*'`,
  `--contains`, `--merged`, `--points-at`) is a listing and does not refuse the push.
  Git's global options are read, in any shell scope. The reason says to run
  that command first, review the new HEAD, then run the push as its own command. `gh pr merge`
  is refused for this only when it names no pull request (no selector and no full sha to
  `--match-head-commit`): gh then merges the pull request of the branch checked out when it
  runs, so `gh pr checkout 5 && gh pr merge` would be checked against another pull request.

### Changed

- `review.mode` `advise` still never denies: the unfollowable folder keeps its notice, and the
  chained push is checked against HEAD as it is, with a new notice saying what that misses.
- A push whose refs cannot be named for another reason (`--all`, `--mirror`, `--tags`,
  `--branches`, a `:` or pattern refspec, a configured `remote.<name>.push`, `push.default
  matching`, a remote or `gh` that does not answer) is still allowed with a notice in every
  mode. These are named under *Known gaps* in the README.
- `pushOperations` (lib/gate.mjs) operations carry `after`: the first HEAD-moving command
  before them on the command line, or null. `commandRefusal` (lib/review.mjs) is new.
- Six eval scenarios for the above (`evals/pre-tool-use-push-*`).

## 0.3.10 - 2026-11-10

### Changed

- `gate check`'s `survives` row accepts plain-text stdout from a PreCompact hook that exits 0
  and prints under 10,000 characters (`PRECOMPACT_TEXT_MAX` in `lib/plugin-gate.mjs`): Claude
  Code uses a PreCompact hook's plain stdout as instructions for the compaction summary, so it
  is an answer, not a crash. JSON stays valid; every other event keeps the JSON rule; a
  PreCompact text of 10,000 characters or more fails naming its length.
- The `visible` row no longer asks a PreCompact hook for a `systemMessage` on a fault, as it
  never asked SessionEnd: Claude Code discards a PreCompact hook's `systemMessage` and
  `continue` fields. The `errors.log` line is still required.
- The live `session-start-relay` scenario checks that the model's reply names `local`, `remote`
  and `database` anywhere, in its own words, instead of the exact phrase
  `local or remote database`: a live run failed on a correct relay that read "a local or a
  remote database". Test-only; no hook changes.

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
- The gate's `docs` row checks only that the root README names the plugin (`rootReadmeNames`),
  never its version: the root README changes only when a plugin is added, removed or changes
  purpose. Landed in #94 without a bump.

### Fixed

- `canary run --prunes-only` no longer needs the store to open: it is dispatched before
  `openStore`, a store that cannot be opened records no `cc_canary_prunes` row, every prune
  still runs, the exit is the prunes', and stderr ends `…; the prunes ran, their rows were not
  recorded`. Before, an unopenable store exited 2 with no prune run.
- Each `canary` action accepts only its own switches: `canary run --dry-run` was accepted and
  ran the real prunes; it is now the usage line, exit 2, with nothing opened or run. Every
  `canary` usage error is exit 2 (was 1).
- The gate's `retention` row runs each prune in a throwaway HOME, XDG config/state/data/cache
  roots and TMPDIR of its own (removed after), keeping only PATH from the gate's environment: a
  prune that ignores `--dry-run` could otherwise remove the caller's real state, `LEDGER_DB`
  and any `*_STATE_DIR` / `*_DB` override included.
- The pane draws in Claude Desktop. Desktop runs Code headless, so `session.start` arrives with
  `surface: null`, and `mods/pane/register.mjs` set `draws = surface !== null`, so the poll
  timer, the refresh and the pane never started there. The gate is gone: the timer and the
  refresh always start and the pane opens from the snapshot on every surface; where nothing is
  placed (`claude -p`, a narrow screen) the end-of-turn fallback block covers it as before.
  `mods/pane/tests/pane.test.tsx` starts the session with `surface: null, isInteractive: false`
  and with `surface: "terminal"` and expects the query, the pane and the poll in both; the
  "surface null → nothing" expectations are gone. The placement line still says `surface=none`
  on Desktop.

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

### Fixed

- The hooks' direct-invocation guards compare real paths, the fix the i-have-audhd and
  ask-graham scripts needed: a hook reached through a symlink (macOS's `/var/folders` tmpdir,
  where `gate check` snapshots the plugin) otherwise never ran.

## [0.3.4]

With plugin-kit 0.1.1: two fixes to what 0.3.3 shipped.

### Fixed

- The canary no longer hands its `e2e/live-run.sh` the caller's `LEDGER_*` environment; a
  `LEDGER_DB` in the shell that ran `ledger canary run` outranked the script's throwaway config
  and pointed the seeded question and the headless session at the real store (the scripts,
  ledger's and the kit's template, also `unset` those keys for a run by hand).
- plugin-kit's `new-plugin` scaffolds into the `plugins/` of the git repository the cwd is in,
  found with `git rev-parse --show-toplevel`, instead of the directory above the kit (which,
  installed from the marketplace, was the plugin cache); a cwd in no repository is refused
  naming `--dest`.

## [0.3.3]

The fault-tolerance gate and the feedback loop.

### Added

- `ledger gate check` runs the repository test bar's checks (three then; five since 0.3.5; six
  since 0.3.6) on every plugin changed since the base of a repository of plugins (can't break
  the session: each hook on five fault inputs; failures visible: an `errors.log` line and a
  `systemMessage`, and an `<x>.unavailable.txt` fixture beside every `<x>.txt`; text says what
  to do: a "When this can't run" section in every skill and agent, a backtick command in every
  deny text), records the rows for the committed tree it checked, and the push gate denies a
  push or PR without rows or with a failed check, naming `gate check` and `review waive` as the
  ways out. The labs read the author's pattern-check receipt before the diff and tag a stated
  failure path the code lacks, or a silent one the receipt lacks, `[blocking] fault-tolerance:`.
- Three verbs tell whether the hooks are doing anything: `canary run` runs every plugin's
  `e2e/live-run.sh` under `claude -p` nightly (`canary install` writes the launchd plist and
  prints the bootstrap line); `report` grades a week of bounces per rule, with a cached judge
  overlay; `digest` posts the week's report as a comment on the configured `owner/repo#number`
  issue (`digest install` likewise), and session start says when it is overdue.
- Session end writes a decision-log entry in the `/wrap-up` shape under the repository's
  `.ai/decision-log/` when the session answered or noted anything, and session start injects
  the newest and the open or durable entries where the newdle plugin's hook will not.
- Session start withdraws questions asked more than `sweep.autoWithdrawDays` ago (7) whose
  session has ended, and `doctor` counts stale ones.
- Bounces keep the text that fired the rule and the transcript path; `bounces` shows them;
  `review judge <key>` shows a cached answer.
- A session-start question from another window is relayed to the human in one plain line
  (never its id), an `ask` with no `--default` invents none, and every hook's store failure now
  leaves an `errors.log` line beside its message.
- Schema 7 adds `cc_judge_cache`, `cc_canary_runs`, `cc_gate_checks` and two `cc_bounces`
  columns; the README's "Inspecting the database" section says what an older ledger does with
  a schema-7 file.
- The new `plugin-kit` plugin scaffolds a plugin that passes the gate on day one.

## [0.3.2]

### Added

- A side pane for Claude Code Desktop. The ledger mod opens a pane listing the questions still
  open in other folders and the answers recorded since your last turn, and
  `/ledger answer <id> <reply>` (or the pane's own buttons and reply field) records through the
  ledger CLI without spending a model turn. Where no pane can draw (`claude -p`, narrow
  terminals, OMP) the same information lands as one block in the transcript. See the README,
  "Ledger pane (Desktop)", for the two-window test.

## [0.3.1]

Three fixes from the first live sessions on 0.3.0, each from a bounce that had no way out.

### Fixed

- An `ask` that repeats a question still open from an earlier session or an untagged CLI run in
  the same folder (same text, same set of options in any order) now adopts that row (its
  session id and asked-at move to the asking session; its options and default stay) instead of
  writing nothing; before, the session had no row of its own and the Stop ask rule sent every
  reply back with "this session has no open question row".
- The ask rule itself now stands down on any question open for the folder (this session's, or
  one in the cwd or a parent of it), and it fires only on a question that asks for a decision:
  a request ("should I", "do you want", "ready to"), an explicit choice ("whether", "do you
  prefer", an option list after a comma or colon), or a wh-question carrying one ("How should
  we proceed?"). A greeting or a request for information ("What are we working on?", "Which
  file holds the config?", "Are the logs compressed or uncompressed?") needs no row; a "why"
  question never does.
- Session start now lists the questions waiting in other folders in full, folder by folder
  with each question's `pending` line (default, id, name, body, the other options; a held one
  marked `held`), so a session can record the human's answer to one of them without a lookup;
  before, it only counted them. And a prompt that is just an option word of an open question
  ("local", "Remote.") gives Claude one line naming that question and the `answer` command, as
  a hint only: nothing is recorded until Claude runs it.
- In the review gate: the `glm` lab no longer has a built-in `omp` profile. It runs with no
  `--profile` (omp's base profile) unless `review.profiles.glm` names one; before, the default
  was `agent-system-2`, and a user file with `"profiles": {"glm": ""}` (rejected by the
  loader, which wants a non-empty string) silently ran every GLM review under that profile.

## [0.3.0]

The ledger checks itself and records its own bounces.

### Added

- `ledger doctor` prints one `ok`, `warn` or `fail` line per check (the database opens
  read-write, the schema version is current, which config layer set `db` and `enabled`,
  `hooks.json` lists every event, `errors.log` lines in the last 7 days per hook, bounces left
  open for more than a day) and exits 1 only when a check fails; it never writes the database.
  Session start adds one last line, `ledger: doctor reports N issue(s)`, when the cheap subset
  of those checks (schema version, recent `errors.log` lines) finds something;
  `inject.doctor: false` turns it off.
- Every Stop block and PreToolUse deny now writes a row to a new `cc_bounces` table, marked
  `satisfied` when the remedy happens later in the session and `bypassed` at session end
  otherwise, and `ledger bounces [--since 7d]` counts them per rule, so the rules that only get
  walked past can be found and retired. A bounce marked `bypassed` at SessionEnd turns
  `satisfied` when the same session resumes and does the remedy.
- A cross-lab review gate now stands in front of `git push`, `gh pr create` and `gh pr merge`:
  `ledger review` sends the branch's diff to the labs in `review.labs` (`codex`, `kimi`,
  `claude`, and `glm` through `omp`) in parallel and records each verdict for the HEAD commit
  in a new `cc_reviews` table; the push is denied while HEAD has no review or has findings, a
  lab that cannot run is named and left out, and `ledger review waive "<reason>"` lets a commit
  through with the human's reason on record. `review.mode` (`gate` by default, or `advise`, or
  `off`) is read from the user config file only. Findings carry a severity (`blocking`,
  `should`, `nit`); nits alone let the push through with a notice. Each reviewed commit is a
  numbered round, and past `review.maxRounds` (default 3) the review stops and says to ask the
  human. A judge model checks every claim that a finding is resolved, whether a later review
  dropped it, listed it again only as a nit, or the agent ran `review addressed "<why>"`; a
  `no` keeps the gate closed, and a judge that cannot answer counts the finding resolved and
  says so. A lab that is skipped or unavailable keeps its findings open on the new commit, and
  `review addressed` is refused while HEAD has findings of its own. The judge is
  `review.judgeCommand`, or the i-have-audhd plugin's `enforcement.judgeCommand`; its passage
  is capped at 8 kB and says when it was cut. Reviewers run without tools, from an empty
  scratch folder, with an allowlisted environment.
- The gate checks the commit a command actually publishes (`cd` and `git -C` folders, each in
  its own shell scope, refspecs, git's own choice when no refspec is given, the branch
  `gh pr create --head` names as the remote has it now, read with a `git ls-remote` that cannot
  prompt and is killed with its helpers after 5 seconds, the pull request `gh pr merge` names,
  pushes inside `$(…)`), and allows with a notice when it cannot tell, including a `-c` or
  `GIT_CONFIG*` setting that steers the push and a remote that does not answer in 5 seconds; a
  merge not bound with `--match-head-commit` gets a notice naming the commit checked.
  `review --base` narrows only the diff the labs read, and a later review of an older commit
  clears nothing found on a newer one.
- Session start now also shows the open and held questions asked in folders under the
  session's folder, each naming its folder, and `pending` lists them the same way.
- A push missing both a note and a review is denied once, naming both.

### Changed

- Opening a 0.2.3 database migrates it to schema version 6 by creating new tables; no existing
  table is touched.
- The Stop ask rule now catches a question mid-line ("Should I …? I'd say yes."); the decision
  rule stands down when the reply asks a question recorded that turn, and `instead of` left the
  default phrase list.
- `errors.log` lines carry the database they were written against, and `doctor` counts only
  its own.

## [0.2.3]

### Added

- One database shared by every folder is now readable across folders. `ledger pending --all`
  lists every open and held question in the database, grouped under the path of the folder it
  was asked in, oldest first within a folder. Session start adds one line when questions are
  waiting on you outside the session's folder (not the folder, a parent or a subfolder of it):
  how many, in how many other folders, and the `pending --all` command to see them. The line is
  kept after a compaction; set `inject.elsewhere` to `false` to turn it off. `ledger pending`
  without `--all` is unchanged.
- An answer now reaches the session that asked while it is still open: when a question is
  answered or withdrawn from another session or folder, the asking session's next prompt
  carries one line saying so (`answered since your last turn: <name> → <word>`), once. Set
  `inject.answers` to `false` to turn it off.

### Changed

- Opening a 0.2.2 database migrates it to schema version 5 in place by adding two columns; no
  table is rebuilt.

## [0.2.2]

### Changed

- An `outcome` lifts the push gate the same as a `note`, so one
  `ledger outcome <ref> "<what and why>"` per push is enough. The Stop hook's decision rule
  still wants a `note` in the turn that states the decision.
- A reply that is none of a question's options is recorded as given:
  `ledger answer <q-id> "<reply>"` stores it as a free-form answer (up to 200 characters), and
  `log` shows it as `answered (freeform)`, so a question is no longer withdrawn because your
  reply was off the list. A prompt line such as `approve q-…` still applies exact options only,
  so a typo never becomes an answer.
- Opening a 0.2.1 database migrates it to schema version 4 in place, rebuilding `cc_answers`
  and keeping every row.

## [0.2.1]

### Changed

- You never type a question id. The agent asks in plain words and records your reply with
  `ledger answer`; the Stop hook sends a turn back once when you replied and the answer is not
  recorded, and no longer requires a reply to name its row (`approve q-…` typed into a prompt
  still works as a shortcut).
- The hooks are on by default, with `/ledger:enable` and `/ledger:disable` to set a folder's
  switch.
- A question the agent forms but defers is `held` (`ledger hold`, `ledger reopen`), never
  dropped, and is listed as *Waiting on you* at session start;
  `ledger outcome <ref> [q-id] "<text>"` records what a decision produced (a PR, a commit, a
  path).
- Opening a 0.2.0 database migrates it to schema version 3 in place, keeping every row. A
  database at a configured `db` path that fails to open as SQLite (corrupt, or not a database)
  is reported and left exactly as it is; only the plugin's own default file is moved aside to
  `<path>.corrupt-<stamp>` and recreated.
