# Changelog

All notable changes to output-types are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.3.3 - 2026-11-23

Release order: update the judge side first (`jev-judge/shape.ts`, `jev.ts`, `jev-judge-all.ts` and its test, outside this repository) and run its test against this build (`OT_RECORD_INTRO equals receipts.mjs RECORD_INTRO` must pass), then install this plugin. A 0.3.3 hook talking to the old `shape.ts` turns every prompt that carries a session record into an unknown shape (exit 2, one skipped.log line). The new `shape.ts` with the 0.3.2 hook is fine: a prompt without a record is unchanged.

### Added

- Zero-label warning on Stop: a reply of 600 or more characters (trimmed) with no labelled statement at all, after 3 or more tool calls in the current turn, gets one `systemMessage`: `output-types: N tool calls this turn, 0 labelled statements. Label what you checked, or say nothing was checked.` ("at least N" when the turn's start is not in the transcript window). The turn starts at the last user entry that is not `isMeta` and is not only tool results. Dispatch and bookkeeping tools (`Agent`, `Task`, `SendMessage`, `TaskStop`, `ToolSearch`, `Skill`, `TodoWrite`, `SubagentHandback`) are not counted. `OUTPUT_TYPES_ZERO_LABEL=off` turns this rule off alone; config keys `zeroLabelMinChars`, `zeroLabelMinToolCalls` and `zeroLabelIgnoreTools` in `${XDG_CONFIG_HOME:-~/.config}/output-types/config.json` tune it. No transcript (OMP, or a missing file) means no warning.
- Session record for the judge: a receipted statement that names a command or a URL gets the newest matching completed Bash or WebFetch call from the transcript window, rendered in the receipts audit's case-receipt format (`[shell command \u2014 <status>]` with `status:` and `exit code:` lines, `unknown` when no code was captured; `[fetched <url> \u2014 …]` with `requested:` and `final:` lines), bounded (shell output 40 head and 20 tail lines, 1200 characters a line, 4000 a block; fetched text 6000; at most 4 calls and 24,000 characters). It goes into the judge prompt as a `<<<RECORD … RECORD <length>>>>` block, the length in the closer. Without a record the prompt is byte-identical to 0.3.2. URLs match on scheme and host case and a dropped fragment only; a redirect's final URL matches too. A closing `)` stays part of a URL a statement names when it balances an `(` in the URL (`https://example.org/Function_(mathematics)`); one that closes prose parentheses around the URL is dropped. A Bash exit code comes only from structured metadata or from the start of an error result (`Exit code N`, as Claude Code writes it, captured in `test/fixtures/cc-bash-exit.jsonl`); an `Exit code N` line in a successful call's output is output, and the record says `exit code: unknown`. A redirect target comes only from WebFetch's `REDIRECT DETECTED` result with a 3xx status, so a page that quotes such a line keeps its requested URL. A fetch that returned HTTP 400 or above is recorded as `status: error` (WebFetch reports a 404 with `is_error` false). WebFetch parsing is tested against results captured from Claude Code 2.1.318 (`test/fixtures/cc-webfetch.jsonl`: a page that loads, a cross-host redirect, a 404, a host that does not resolve).
- `hooks/output-types-subagent-stop.mjs`, registered for `SubagentStop` (timeout 60, no matcher): the receipts check, the judge with session records, and the zero-label rule on the report a subagent delivered. It reads the `SubagentHandback` message from `agent_transcript_path` (with that tool, `last_assistant_message` holds only the closing text), else `last_assistant_message`, else the agent transcript's last assistant text. The zero-label rule has no character floor here, keeps the tool-call floor, and skips Claude Code's internal agents (empty `agent_type`). Its warning: `output-types: the <agent_type> subagent ran N tool calls, 0 labelled statements in its report. Treat its findings as unverified until checked.`
- `lib/transcript.mjs`: the one bounded transcript reader all of the above share, tested against transcripts captured from a real Claude Code run (`test/fixtures/capture-transcripts.sh`, run by hand; `CAPTURE_ONLY=webfetch` runs only the WebFetch capture and exits 3 naming any result kind it did not capture).

### Changed

- On Stop, when the payload has no `last_assistant_message`, the reply checked is the last assistant text with sidechain entries dropped, so a trailing subagent entry is never read as the parent's reply. The exported `extractText` follows the same rule.
- Every transcript read is bounded to the last 16 MiB. `extractText` keeps its name and export but no longer loads the whole file, so a transcript past Node's string limit (about 512 MiB) no longer reads as empty.
- `logSkipped(text, env, now, hook)` takes the hook file to stamp, and `judgeStage` passes `opts.hook` through, so skipped.log lines from the subagent path name `hooks/output-types-subagent-stop.mjs`.
- With the judge on, a statement that names a command or a URL, matches no completed Bash or WebFetch call in the window (or has no readable transcript to match against), and has no absolute `file:line` is not sent to the judge: one skipped.log line says no tool call matched, or that no transcript was readable. In 0.3.2 any judge received such a statement on its text alone; a judge that is not Jev now sees fewer statements. A statement whose newest matching call has no captured result is not judged either (`evidence unavailable: newest matching <tool> call has no captured result`), and an older run is never put in its place. The same rule covers a statement where only some of its commands or URLs matched: without an absolute `file:line` it is not judged on the partial record, and one skipped.log line names each command or URL that matched nothing (`the session record is incomplete: ...`).
- A statement is also not judged on part of its record when a cap left a matched call out: past the record's 4 calls, or past its 24,000 characters. Without an absolute `file:line` it is skipped, and the skipped.log line names each call left out and the cap (`the session record is incomplete: the record holds at most 4 tool calls and left out ...`). With one it is judged, and the record's last lines say how many calls each cap left out.
- When a statement is not sent to the judge and its skipped.log line cannot be written (the state directory is unwritable), the hook still allows the turn and says so: one errors.log line, when that can be written, and a `systemMessage` beginning `output-types Stop failed open: skipped.log could not be written` (`SubagentStop` on the subagent path) that carries each skip reason itself.
- An inline code span that quotes output is no longer read as a command. A span is output when an output word or an arrow comes right before it (`→`, `->`, `=>`, printed, prints, returned, returns, gave, gives, shows, showed, output, outputs, says, said, reads, listed, lists, reported, reports, exited with, exits with), or when it follows an output span joined only by a comma, "and", "or", "plus" or "with" and has no output word of its own after it. A span that is not one of these but whose text is in a matched call's command or captured output is evidence in the record, not a missing command. A `$ ` command is always a command. So `` `npm test` printed `tests 134`, `pass 134` `` and `` `npm test` → `3 tests passed` `` are judged with their record, and `` `git rev-parse HEAD` printed `81e2a0c`, `git status --short` printed `0` `` still names two commands.
- The receipt check accepts a command with an output word and the output quoted in code after it on the same line (`` `npm test` printed `tests 134` ``) as a command and its result. An output word with unquoted output (`` ran `node --test`: it printed 46 pass ``) still needs an arrow.
- A one-word command counts as a receipt when it is explicit: `` `$ pwd` ``, a bare `$ make` line, or the first line of a shell-tagged fence. It matches a Bash call only as a whole word. A bare inline `` `pwd` `` is still not treated as a command.

### Removed

These behaviours of the newdle plugin's old `output-types-guard.mjs` subagent guard are not carried over by the new `SubagentStop` hook:

- Feedback to the subagent through `hookSpecificOutput.additionalContext` asking it to repost its report: the new hook warns the person only, and never keeps a subagent running.
- Its loop brakes (content dedupe, at most 2 nudges per run, state in a temp directory): only needed when the hook makes the subagent continue.
- Its agent allowlist and exempt list: every agent type is checked; the zero-label rule skips only an empty `agent_type`, and its tool-call floor stands in for the exempt list.
- Its exemptions for action-only reports, proposal-only plans and completion phrases: with the tool-call floor these rarely apply; a subagent report of 3 or more tool calls with no labels now warns.
- Its scope gate (`newdle-hooks.json`) and level gate: the hook runs wherever the plugin is installed.
- Its `OUTPUT_TYPES_GUARD=off` switch: use `OUTPUT_TYPES_CHECK=off` (everything) or `OUTPUT_TYPES_ZERO_LABEL=off` (the zero-label rule).

The old guard's entry in `~/.claude/settings.json` is removed separately, after this release is installed and one `SubagentStop` warning from it has been seen.

## 0.3.2 - 2026-11-04

### Changed

- `scripts/prune.mjs` is plugin-kit 0.4.1's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged.
- The re-copied prune skips symlinks (a linked `x.log` is never rotated over its `.1`) and a dry run no longer counts an expired `.1` twice: its totals are the real run's (plugin-kit 0.4.1's fix).

## [0.3.1] - 2026-11-04

### Fixed

- `lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.3.0's): the runner waits for
  stdout to drain before it exits, bounded by the hook's deadline (4 s, or 55 s with the judge on),
  so a Stop warning larger than one 64 KiB pipe buffer is no longer cut short; a host that never
  reads gets exit 0 at the deadline and one `stdout not drained` line in errors.log. What the Stop
  check says is unchanged.
- `test/receipts.test.mjs`'s real-runner judge case gives the sleeping judge a 400 ms per-call
  budget, so the logged timeout is the configured number, not one that drifts with elapsed time.

## [0.3.0] - 2026-11-04

### Added

- `hooks/output-types-stop.mjs`, a Stop hook: reads the finished message (`last_assistant_message`
  in the payload, else the last assistant text in the transcript) and names, in one
  `systemMessage`, every `**CLAIM**` without an absolute `file:line` or a command with its result
  (a fence holding the command and its output, or a command, `$ cmd` or code with a space in it,
  with `→ output` on its line or the next; inline code next to a word like "returns" is not one)
  and every `**CITE**` without a URL or a test run with its command; the first five by line,
  then `+N more`. Never `decision: block`. Markdown-bold labels that start a line (after any
  list or quote marker) or are followed by a colon or the line's end count; so does a bold label
  inside a sentence, checked against that sentence and the next line, unless it is only
  mentioned (joined to another label by and/or/comma/slash, quoted or in code, or followed by a
  word like label, means, is or needs). Nothing inside a fenced code block, at any indentation,
  counts. A blank line inside a fence does not end a statement. `OUTPUT_TYPES_CHECK=off` turns
  it off.
- A judge stage, off by default: with `"judge": true` in
  `${XDG_CONFIG_HOME:-~/.config}/output-types/config.json` and a judge command resolved
  (`OUTPUT_TYPES_JUDGE_BIN` → `judgeCommand` in that file → `~/.config/judge/config.json` →
  i-have-audhd's profile), one call per statement that passed the mechanical stage asks whether
  the receipt licenses the sentence; `fail` and unreadable verdicts join the warning; a dispatch
  error is one line in `${XDG_STATE_HOME:-~/.local/state}/output-types/skipped.log` naming the
  source, and the check continues; so is a judge that is on with no command resolved, naming the
  malformed shared file or where it looked. Calls are clamped to the hook's 55 s budget (`timeout: 60` in
  `hooks.json`), counted from the runner's start (`HOOK_RUNNER_STARTED_AT_MS`), so stdin that
  arrives late shortens the judge's time, not the warning's; a judge still running when the
  runner's deadline fires is killed with its process group as the hook exits.
- `lib/receipts.mjs` (labels, statements, receipt shapes, the warning, the config, the judge
  stage), `lib/judge.mjs` and `lib/hook-runner.mjs` (plugin-kit 0.3.0's, vendored byte for byte).
- Tests: `test/receipts.test.mjs`, `test/stop-hook.test.mjs` (the hook as a spawned process:
  fixtures, fault inputs, the runner's deadline, the judge with fake commands, config off by
  default), the Stop step in `test/e2e.test.mjs`, and the vendored-copy check in
  `test/manifest.test.mjs`.
- `evals/manifest.json` declares the Stop hook's two outcomes, proved by
  `evals/stop-unreceipted-warns.scenario.json` (`systemMessage`) and its sibling
  `evals/stop-check-off.scenario.json` (`silent` under `OUTPUT_TYPES_CHECK=off`), so the gate's
  `evals` row covers the new hook.
- `README.md` in the plugin: what it is, a pointer to the full documentation (then in the
  root README's output-types section; since moved into this README), and a
  `## Changes in 0.3.0` entry, so ledger's `gate check` `docs` row finds the release written
  down in the plugin.

### Changed

- The root README's output-types section (now this README): "it delivers, it does not enforce"
  is now "it delivers, and it warns", with the new "The Stop check" section.

## [0.2.2]

### Changed

- The plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares what the
  session-start hook can return (the core as a `systemMessage`, or silence under
  `OUTPUT_TYPES_INJECT=off`), one `evals/<x>.scenario.json` proves each, and the core scenario
  carries a `session` and a `judge` rubric the nightly canary runs under `claude -p` and grades
  with `claude plugin eval`. `e2e/live-run.sh` hands off to plugin-kit's scenario runner.
  `.claude-plugin/plugin.json` declares the one state path (`$XDG_STATE_HOME/output-types`, 30
  days) and `scripts/prune.mjs` prunes it. The skill has a "When this can't run" section.

## [0.2.1]

### Fixed

- A hook fault (contract file missing, unreadable or without its markers, or the hook's own
  module failing to load or loading broken) now appends one line naming the hook file and the
  reason to `${XDG_STATE_HOME:-~/.local/state}/output-types/errors.log`, and the one-line
  warning reaches you as well as the model and says where the reason went.
  `OUTPUT_TYPES_INJECT=off` is read first, so it silences the hook even when the install is
  broken. The hook no longer waits on a stdin pipe its caller leaves open: it reads for at most
  one second, then injects.

## [0.2.0]

### Changed

- Only receipted facts are labeled, as CLAIM or CITE. The GUESS, PMDW, ACTION and QUESTION
  labels, the `<!-- output-types … -->` envelope and the numbered degradation tiers are gone;
  unreceipted statements, actions, questions and degraded coverage are plain prose. The whole
  contract now lives in `skills/output-types/reference.md`, which the skill points at and the
  hook injects from.
