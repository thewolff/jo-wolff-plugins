# Changelog

All notable changes to paired-coding are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 1.4.0 are not
listed.

## 1.6.1 - 2026-11-04

### Changed

- `scripts/prune.mjs` is plugin-kit 0.3.3's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged. Only `*.log` rotates here: its `.jsonl` files are state read back whole.
- The re-copied prune skips symlinks (a linked `x.log` is never rotated over its `.1`) and a dry run no longer counts an expired `.1` twice: its totals are the real run's (plugin-kit 0.3.3's fix).

## [1.6.0] - 2026-11-04

### Added

- A pattern claim needs a pattern source, in learning mode or out of it. When a card's `why`
  carries an affirmative claim of a codebase convention (`PATTERN_CLAIM_PATTERNS` in
  `core/gate.mjs`, matched at word boundaries in any case: a verb of conformity before
  "pattern" or "convention" such as `follows the existing pattern`, `matches the codebase
  pattern`, `per the repo convention`, `consistent with the established pattern`; `the
  pattern in/from/here`, `the pattern used in`, `the convention here`, `how the codebase
  does`, `as`/`like the rest of the codebase`, `pattern-fit`), `sources` must include one
  absolute `file:line` inside the pattern-check receipt directory `<git root>/.pattern-check/`,
  or two or more absolute `file:line` sources at distinct locations inside the repository the
  worktree is in: the path after `.` and `..` collapse plus the line or range, so one citation
  spelled twice is one source. Ordinary prose is no claim (`the pattern introduced by the
  bug`, `the pattern input`, `the anti-pattern used in`, `no existing pattern handles this`),
  and a denial or removal word anywhere before the match in its own clause (`not` but not
  `not only`, `no`, `never`, `without`, `rather than`, `doesn't`, `isn't`, `stop`, `drop`,
  `remove`, …: `PATTERN_CLAIM_NEGATIONS`; typographic apostrophes read as `'`) turns a match
  off. A clause ends at `, ; : ( )`, a sentence-ending `. ! ?`, or ` but `/` and `/` so `/
  ` because ` (`PATTERN_CLAIM_CLAUSE_BREAKS`), so a claim after a denied clause still counts
  (`No migration needed, follows the existing pattern`). Otherwise
  `pair_propose` refuses, quoting the claim as written and naming this session's receipt path
  (`<git root>/.pattern-check/<session id>.md`) and both counts. Paths are compared lexically;
  existence is not checked, as with every `file:line` source.
- `alternatives`, an optional card field: `[{ "design", "chosen" }]` with exactly one
  `chosen: true`, checked for form when given and recorded on the card and in the journal.
  Required for the first card proposed after ask-graham's findings file for this session was
  written (`${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/findings/<session id>.json`,
  looked up under the host adapter's environment, `HOME` from it when it names no
  `XDG_STATE_HOME`, with no fall back to the process's own): then one entry must contain the
  findings' chosen design (whitespace collapsed, case ignored) and, when the findings weighed
  a design they did not choose, at least one entry is not chosen. When that card is recorded
  the pairing state keeps `findingsConsumed: { sessionId, writtenAt }`, and the same findings
  hold no later card of the pairing; a refused card consumes nothing, and a findings file
  written later (a later `writtenAt`) re-arms the check. A marker whose `writtenAt` is not an
  ISO 8601 date or whose `sessionId` is not this session's is ignored (the findings read as
  not consumed) with one `findings-marker-ignored` journal line. The file counts only as this
  session's findings: a regular file (`lstat`, no symlink) of at most 64 KiB
  (`FINDINGS_MAX_BYTES`, the read bounded at that size) holding a JSON object with
  `version: 1`, a `sessionId` equal to this session's, an ISO 8601 `writtenAt`, and
  `alternatives` as a list of `{ design: non-empty string, chosen: boolean }`. Anything else
  (a symlink, a directory, an oversized or unreadable file, non-JSON, another session's
  record, a bad entry) reads as missing with one `errors.log` line under this plugin's state
  base naming the file and what was wrong; nothing is dropped silently, and ask-graham's
  files are never written.
- The card's reply lists `alternatives` with the chosen one marked (`[chosen]`), after the
  planned code, so the learner sees the pattern-fit pick and the better design side by side;
  `pair_learn`'s reply names the pattern-source rule.
- `lib/card-context.mjs`: the copied path rules (pattern-check's receipt, ask-graham's
  findings; no plugin dependency) and the validated, bounded findings reader (`findingsPath`,
  `readFindings`, `cardContext`, which requires the adapter's `env`), handed to the gate as
  `io.cardContext`. The gate's `patternClaim`, `patternSourceProblem`, `alternativesProblem`
  and `applicableFindings` are pure and exported.
- MCP and OMP schemas: `alternatives` on `pair_propose`.
- Evals: `pre-tool-use-card-pattern-unsourced`, `pre-tool-use-card-pattern-receipt`,
  `pre-tool-use-card-alternatives-missing` and `pre-tool-use-card-alternatives-pass`, each set
  up by `evals/card-checks.mjs` through the real verbs (the setup exits non-zero unless
  `pair_propose` answered as the scenario says), with the findings file written under the
  sandbox's `$XDG_STATE_HOME` and the receipt under the sandbox worktree.
- README: *A pattern claim needs a pattern source* with its how-it-fails rows and *Not in
  1.6.0*; skill: the two fields under *The card* and *Learning mode*.

### Changed

- Pairing state gains the optional `findingsConsumed` field (`null` or
  `{ sessionId: string | null, writtenAt: string }`); one of the wrong shape reads as a
  malformed state, like any other field, and a well-shaped one `pair_propose` cannot trust is
  ignored, as above. A state without it reads as before.

The checks read sibling plugins' files only. A card whose `why` makes no pattern claim, in a
session with no findings file, runs exactly as in 1.5.0.

## [1.5.0] - 2026-11-04

### Added

- Learning mode, enforced by the gate. Off by default; the skill has the agent turn it on only
  when the partner types `learning mode on` or `teach me as we go`, and the gate refuses to turn
  it off unless the partner's latest typed turn contains `learning mode off`. The agent switches
  it with the new `pair_learn` tool (`on: true` or `false`), journaled as a `learning` entry.
  The flag lives in the pairing state; every `pair_start` and every carried session start with
  it off, and `pair_start`'s reply says so.
- While learning mode is on, `pair_propose` refuses a card without `why` (a non-empty string)
  and `sources` (at least one; each a `{ "url", "passage" }` object whose URL parses as
  `http(s)` with a host, an absolute `file:line` or `file:line-line` string with a line of 1 or
  more, or a string starting `from memory`; no control characters), naming the first bad entry;
  both are recorded on the card. `pair_done` refuses without `recall`, one question on one line,
  which the `done` journal entry records. "Teach me more" is an open point, so `pair_begin`
  stays refused under the existing open-points rule.
- A Stop warning in learning mode: when a turn closed a change set and the closing message has
  no recall line (`Recall:` in any case, after an optional quote, list or heading marker, bold
  or italics allowed), the Claude Code Stop hook returns a `systemMessage` and the OMP adapter's
  new `session_stop` handler a warning notice, each naming the journaled question. Never a
  block; each `pair_done` is warned about once (a `recall-check` journal entry), and only a
  `pair_learn` that changes the flag restarts the count. Without the host's closing message,
  both read the turn back no further than the newest user entry.
- MCP and OMP schemas: `pair_learn`; `why` and `sources` on `pair_propose`; `recall` on
  `pair_done`.
- Eval `stop-learning-warns-no-recall` for Stop's new `systemMessage` outcome, set up by
  `evals/learning-done.mjs` through the real verbs; `stop-judges-queued-turn` names it as its
  sibling, as ledger's evals row requires of a silent scenario.
- Skill: *Learning mode* describes the tool, the fields and the refusals. README: a *Learning
  mode* section with its how-it-fails rows (accidental switch, the agent switching it off, the
  flag leaking across sessions, a refusal with learning off, invented sources, a skipped recall
  question, a continued Stop, card bloat) and what is not in 1.5.0 (a "write this piece
  yourself" move, spaced recall across sessions).
- README (docs): each learning-mode how-it-fails row names what proves it, the
  `evals/<x>.scenario.json` or, where no scenario can, the test by name, or says nothing does;
  ledger's `says` row requires the section to name a scenario.

With learning mode off, every new check is skipped and a session runs exactly as in 1.4.4.

## [1.4.4]

### Changed

- The plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares what each of
  the five hooks can return and nine `evals/<x>.scenario.json` prove them (the write denied and
  the inert hook at PreToolUse, the pairing-on and stop-queued prompts, the fresh and
  carried-over session start, the session end leaving its carry, the Stop hook judging a queued
  turn; scenarios that need pairing on run `evals/pair-start.mjs`, the same `pair_start` verb
  the MCP server exposes), with the typed-agreement path and `pair stop` listed under
  `manual`; `e2e/live-run.sh` hands off to plugin-kit's scenario runner.
- Every refusal now ends with the standing way out: pairing ends when your partner types
  `pair stop` as a whole message.
- The journal directory (`~/.local/state/paired-coding`, 30 days, pruned by `scripts/prune.mjs`)
  and the per-run temp directories are declared as state, and the skill has a "When this can't
  run" section.

## [1.4.3]

### Fixed

- The ledger and pattern-check plugins keep working while pairing is on. Each ends a reply with
  a Stop hook that demands its CLI run (`ledger.mjs ask`, `pattern-check.mjs record`); with the
  host shell refused and `pair_run` fencing every write outside the agreement, those runs failed
  (`EPERM` on `<worktree>/.pattern-check/`, "database read-only" on the ledger's SQLite file)
  and the reply could neither finish nor be let go. Now `pair_run` may write that state in both
  phases, boundary or no boundary, under every sandbox: the ledger's database with its `-wal`
  and `-shm` sidecars at `~/.agent-system-2/ledger.db`, at the ledger's default
  `~/.local/share/ledger/ledger.db`, and wherever `LEDGER_DB`, the ledger's config file or the
  nearest `.ledger.json` points it; `<worktree>/.pattern-check/`; and `~/.local/state/ledger/`
  and `~/.local/state/pattern-check/`. One list (`lib/sibling-state.mjs`) feeds the Seatbelt
  profile, the bubblewrap binds and the Landlock rules, so the three grant the same paths. A
  carve-out never reaches the worktree root, `.git`, the state directory or a protected path,
  is dropped when it sits above one of them, and before every run the tree under a carve-out
  directory is looked at on every backend, every entry of it, within a budget (a hard-linked
  file, an entry that cannot be read, a `.git` entry, a mount point there, or a tree too large
  to finish looking at refuses the run by name); snapshots leave `.pattern-check/` out, so a
  receipt written there is not drift at `pair_done`.
- While pairing, ledger and pattern-check calls go through `pair_run`: the host shell stays
  refused for every command (the host runs it outside the fence, with its own environment), and
  the refusal for a sibling call says to run the same command with `pair_run`, where the kernel
  decides where its writes land. Before launching one, `pair_run` refuses by name a call whose
  shape no hook demands (anything but `node <script> <subcommand> …` with the script
  `ledger.mjs` or `pattern-check.mjs`, spelled plainly, existing and resolving inside
  `~/.claude/plugins/cache/jo-wolff-plugins/` or `~/.claude/plugins/marketplaces/`, and a
  subcommand among `ask`, `answer`, `note`, `outcome`, `pending`, `doctor`; `open`, `record`,
  `status`; a `--cwd`, `--config` or `--db` argument; `disable`, which writes a product
  `.ledger.json`) and one that, worked out the way the CLI does from the worktree root and the
  environment the run gets, would write outside the carve-outs (the ledger's database from
  `LEDGER_DB`, the nearest `.ledger.json` or the user config; pattern-check's `receiptDir`
  under the nearest `.git` root; a config file planted inside a carve-out directory; a
  backslash in any path, which the CLIs keep as a filename character), naming the destination
  and the config that named it. The run's environment is the host's less `NODE_OPTIONS`,
  `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_V8_COVERAGE`, `NODE_REDIRECT_WARNINGS` and
  `NODE_COMPILE_CACHE`, on every host, through one function. The README's gate section has the
  full table and the Linux limits (a grant there needs an existing inode).
- On Claude Code, `SessionEnd` removes the state directory of a session that never called
  `pair_start` (it held only queued typed input and stashed notices), under the session lock
  and after a second look for the activation marker, so a `pair_start` landing as the session
  ends is kept, and the lock is released only by its holder (a token file named by the holder's
  pid inside the lock, removed before the lock directory, which the kernel keeps while anything
  else is inside; a release that cannot remove its token fails instead of reporting success),
  so no release lets go of another holder's lock. A lock is taken over only when the pid its
  token names is not running and the lock is stale, by removing that one token by name; a lock
  whose holder is still running is never evicted on its age, and the wait fails naming the pid
  and the recovery command, `node <plugin>/bin/pair.mjs unlock --stale <lock directory>`, which
  makes the same check. That command acts only on paired-coding's own lock directories inside
  the state base (any other path, or a symlink out of it, exits 2 untouched); its refusal of a
  running pid explains pid reuse and never advises ending a process, and `--force` clears a
  reused pid's lock only when that pid's command line names neither `paired-coding` nor
  `pair-server`. A token naming the waiting process itself is reported as a non-reentrant lock
  attempt. A release failure the locked work's error cannot carry (a frozen error) goes to
  `errors.log`, and the work's error is thrown unchanged. A session that paired keeps its
  directory, journal and receipt included, and a directory that will not go is one warning and
  one `errors.log` line, never a failed end.

## [1.4.2]

### Fixed

- A fault in any hook appends one line to `errors.log` in the plugin's state directory and
  shows one warning, and never blocks a session that is not pairing. While pairing, for
  `pair_*` tools, or when the gate cannot tell whether pairing is on, the tool is still
  refused, and the refusal names the tool and the way out (`pair stop`, or disabling the
  plugin). The OMP adapter's `tool_call` handles these faults the same way.

## [1.4.1]

### Changed

- A prompt typed in the Claude Desktop app counts as typed. Any other programmatic prompt is
  still refused as untrusted.

## [1.4.0]

### Added

- Every card shows the planned code before you agree, unprompted, and `pair_propose` takes it
  as a `proposedCode` field on both hosts.
