# Changelog

All notable changes to plugin-kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases before 0.1.2 are described in
the README's "Changes in" sections.

## [0.4.0] - 2026-11-04

The brb badge and the ledger pane drew nothing in Claude Desktop: both gated on the session's
surface, and Desktop starts a session as `surface: null, isInteractive: false`. What Desktop
did draw, the status line, is a 32-character grey footnote in the footer. No public guide shows
how a mod looks in either host, so each plugin found these by shipping them.

### Added

- `skills/new-mod/SKILL.md`: pick the surface by the signal, write for both hosts without
  gating on `e.surface`, make it readable (single-width symbols, colour never alone, the first
  32 characters carry the point), register in the engine's validated shape, prove it with the
  real terminal and Desktop `session.start` payloads, and ship it. The status line is a fallback
  only until the `AbovePrompt` render hook has been called once in the session, then cleared
  (brb 0.4.0's rule); a terminal user who collapses the band is not detectable, so anything
  the person has to answer also raises a toast.
- `skills/new-mod/reference.md`: every surface, element and render site by host, the limits
  that shape a drawing, and the session payload per host, each row with its receipt.
- `templates/mod/register.mjs`: a hooks module with the poll, the band, the fallback status
  line and once-per-message fault logging. One `begin()` runs from `session.start` and from
  `classic.SessionStart` filtered to `clear`, `resume` and `fork`, so `/clear`, `/resume` and
  `/branch` (which fire `session.end` but not `session.start`) restart the poll and drop the
  last conversation's band; the skill's step 4 states the rule. `clip()` cuts at the last space
  that fits and gives nothing for a width of 0 or less; the band stacks its button below about
  12 columns of room; the dismiss button's label names its hotkey. The scaffolder does not copy it.
- `test/mod-template.test.mjs`: drives the template with a fake `on` and `$` through start,
  band, `session.end` and `classic.SessionStart` for each of the three sources and both host
  payloads, and checks `clip()` and the button at narrow widths.

## [0.3.2] - 2026-11-04

### Changed

- `test/judge.test.mjs`: `NOT_YET_VENDORED` is empty. ledger 0.3.7 ships the kit's
  `lib/judge.mjs` byte for byte, so its copy is diffed like every other. `lib/judge.mjs` is
  unchanged. The README's "Shared judge" section says nothing is allowlisted.

## [0.3.1] - 2026-11-04

### Fixed

- `lib/hook-runner.mjs` waits for stdout to drain before it exits: an answer larger than one
  pipe buffer (64 KiB) no longer reaches the host cut at 65,536 bytes when stdout is a pipe the
  host has not read yet (asynchronous pipe writes, macOS). The wait is bounded by the same
  deadline, at least 50 ms (`DRAIN_MIN_MS`) so the deadline's own message gets its write; a
  host that never reads gets exit 0 at the deadline and one errors.log line, `stdout not
  drained within <n> ms: the host is not reading it; the rest of a <n>-byte answer was
  dropped`; EPIPE is a `stdout write failed` line and exit 0, never exit 1. The injectable
  `write` option is now `write(text, done)`. Ported from reminders-review 0.2.0's copy; 0.3.0's
  handler env and process-group reaping are unchanged.
- `test/hook-runner.test.mjs`: a 300,000-byte answer through a host that pauses after every
  chunk arrives whole with exit 0 inside the deadline; an 8 MiB answer to a host that never
  reads exits 0 at the deadline with the one `stdout not drained` line.

## [0.3.0] - 2026-11-04

### Added

- `lib/judge.mjs`: the shared judge dispatch, vendored byte for byte by every plugin that
  judges. One command through `/bin/sh` in its own process group, the prompt on stdin or in place
  of `{prompt}`, stdout only, a hard timeout that reaps the group, never a throw. `json` mode
  returns the last JSON object on stdout (a `claude -p --output-format json` envelope unwrapped)
  or `{ error, detail, stderr }` with `error` one of `timeout`, `nonzero`, `unparseable`,
  `spawn-failed`; `yesno` mode returns `yes`, `no`, or `unverified`.
- `resolveJudgeCommand()`: the command resolved once for every plugin, first found wins, naming
  its source: the plugin's env var → the plugin's own setting → `${XDG_CONFIG_HOME:-~/.config}/judge/config.json`
  `{ "command", "timeoutMs" }` → i-have-audhd's `enforcement.judgeCommand` (legacy, read-only).
  A shared file that exists but is malformed stops the search before the legacy profile
  (`readSharedConfig()` reports it), so a typo never swaps in an older command silently.
- `node lib/judge.mjs setup` (one test call, then the shared file written atomically after a
  yes, other keys kept; `--command`, `--timeout-ms`, `--yes`, `--force`; a malformed shared file
  is refused unless `--force`, which replaces it whole) and `node lib/judge.mjs which` (a
  `malformed: <path>: <error>` line first when the shared file is malformed).
- `test/judge.test.mjs`: the resolution order over a fake HOME and XDG_CONFIG_HOME, each failure
  class from a tiny shell command, both parsers, the CLI as a spawned process, and the sameness
  test: every `plugins/*/lib/judge.mjs` and `plugins/*/judge/judge.mjs` outside the allowlist
  (`ledger/lib/judge.mjs`, until ledger's next release) is byte-identical to the kit's.
- `new-plugin.mjs --judge`: the scaffold also gets `lib/judge.mjs`.

### Changed

- `lib/hook-runner.mjs`: the handler thread's env carries `HOOK_RUNNER_STARTED_AT_MS` and
  `HOOK_RUNNER_DEADLINE_MS`, so a handler budgets from the runner's clock, not its own late
  start; a process group the thread registers (`{ kitReap: <pgid> }`, which `lib/judge.mjs`
  posts inside a runner that sets `workerData.kitReap`) is SIGKILLed when the runner exits, so a
  judge still running at the deadline does not outlive the hook.

### Unchanged

The agents, and the rest of the scaffold.

## [0.2.2] - 2026-11-04

### Added

- The scaffold writes `CHANGELOG.md` (Keep a Changelog, with the `## [0.1.0]` entry) beside the
  README's `## Changes in 0.1.0`, from `templates/CHANGELOG.md` (20 files, from 19). A
  scaffolded plugin's first version is written down in the two places ledger 0.3.6's
  `gate check` `docs` row reads from the plugin; the repository README's bullet is the
  author's, and goes in before the plugin's first `gate check`, since the row fails a new
  plugin without it.

### Changed

- The `release-gate` agent's version-match step (check 4) wants the three things the `docs` row
  wants, read by the row's rule: a release heading for the version with text under it in
  `CHANGELOG.md` and in the README, where a release heading is a heading at any level whose
  text starts with `<version>`, `[<version>]`, `Changes in <version>` or
  `<date> — <version>` (so `## [<version>]`, `## <version>`, `## Changes in <version>`,
  `### <version>` and `### <date> — <version>` count in either file); and the root README
  naming the version in a `-` or `*` bullet starting with the plugin's name, on a
  `Changes in <name> <version>` line, or on a `Changes in <version>` line under `## <name>`.
  The checklist is stricter than the row in one place: it also fails a README heading for a
  version newer than `plugin.json`'s.
- The new-plugin skill, the README and the scaffold's `next:` line put the root README bullet
  (naming 0.1.0) before the first `gate check`, and keep the marketplace entry for publish time.

## [0.2.1] - 2026-11-04

### Changed

The cross-lab reviewer has a review budget (see "Review budget" in the README), so a review loop
ends. Three verdicts, `ship`, `ship-with-limits` and `fix-first`, and `fix-first` only on a
finding whose worst case is data loss, a live-state write outside the plugin's own state, a
crash or hang, wrong-recipient delivery, or a security boundary violation inside the threat
model. The invoking prompt carries a `Threat model:` line, and the reviewer asks for it and
stops without one; findings outside it are `Out of scope`. The repository default is
`Threat model: none — every input is Jo's own; review for correctness and fail-safety, not adversarial inputs`,
which the brief template shows prefilled. Each finding has a one-sentence worst case and a
`new-mechanism` tag, and fixes that add a mechanism are held for Jo. Round 2 verifies the prior
findings only; from round 3 the review is blocking-only. Without an in-scope blocking finding, a
static-only review is now `ship-with-limits`, with `no executable check ran` as its first limit;
an in-scope blocking finding still makes it `fix-first`. Each review opens with a
`## Round <R>` heading, the form the next review's round count reads (a `Round: <R>` line
alone reset the count to round 1), and a prior review with no round heading or `-round<N>` file
name counts as unreadable, so the reset is stated. The release gate, the scaffolder and the
runner are unchanged.

## [0.2.0] - 2026-11-04

### Changed

The scaffold meets the five-row gate ledger 0.3.5 runs, not the three-row one. New in the
scaffold: `evals/manifest.json`, one `evals/<event>.scenario.json` stub per event,
`scripts/prune.mjs` and a `state` declaration in `plugin.json`, and `lib/live-run.mjs`, the
scenario runner `e2e/live-run.sh` now hands off to (19 files, from 13). The runner replays
every scenario's hook phase in its own sandbox with no model, then under `claude -p` runs the
pinned CLI-contract session and every scenario with a `session`. A `judge` rubric is graded by
`claude plugin eval`: the runner writes a `case.yaml` (the 2.1.318 case schema, JSON body) and
a `scaffold.sh` from the scenario's `setup` under `<plugin>/live-run-cases-<pid>/` (the CLI
takes only a relative `--eval-dir` inside the plugin), runs the eval with `--no-publish --json`
and reads the verdict from the JSON, never the exit code (a case that fails to load exits 0),
and removes the directory whatever happened; the operator-gated tools the scenario's
`allowedTools` names (Bash, Write, Edit, WebFetch, `mcp__*`) are granted with `--allow-tools`.
Live sessions run with `SHELL=/bin/bash` pinned: the CLI snapshots the user's shell at startup
and sources its rc, and given `sh` it falls back to zsh (measured on 2.1.318: `$SHELL` inside
the Bash tool was `/bin/zsh`, with `ZDOTDIR` unset and set alike), so a zsh rc that writes under
the sandbox's `XDG_CONFIG_HOME` (thefuck's settings, measured) read as the plugin's own write;
bash with no rc writes nothing. A judge scenario the eval could not grade (no `claude`, not
logged in, an API error) leaves the run `unavailable` (exit 75), never a pass, even when the
contract session passed. The scaffolder's CLI guard compares real paths on both sides
(`realpathSync` of `argv[1]` and of the module), the fix ledger 0.3.5 and the other plugins
carry for their hooks: node resolves the main module through symlinks, so the earlier string
compare made the scaffolder a silent no-op when reached through one (macOS's `/var/folders`
tmpdir included), exiting 0 with nothing written. `test/live-run.test.mjs` is new; the scaffold
test runs a scaffold end to end in a fresh repository through `ledger gate check` and `ledger
canary run`.

## [0.1.2]

### Added

Two agents, `cross-lab-reviewer` (a Codex review of the branch) and `release-gate` (the release
checklist, report-only): the Codex review brief and the release checklist that were written by
hand for each plugin release, as files. Neither runs code from the checkout unless the invoking
prompt says `execute: <sha>` for the exact head sha, and then only in a credential-free `env -i`;
both check one snapshot of the head sha, written blob by blob with `git cat-file` and checked
blob by blob against its id. The release gate reports `ledger gate check` unavailable rather than
run it against live `HEAD`. The scaffolder and the runner are unchanged; the README's "Changes
in 0.1.2" has the rest.
