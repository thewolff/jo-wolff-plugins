# Changelog

All notable changes to paired-coding are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 1.5.0 are described
in the README's *Changes* section.

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
  and a denial within four words in the same clause (`not`, `no`, `never`, `without`, `rather
  than`, `doesn't`, `isn't`, …: `PATTERN_CLAIM_NEGATIONS`) turns a match off. Otherwise
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
  written later (a later `writtenAt`) re-arms the check. The file counts only as this
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
  `{ sessionId: string | null, writtenAt: string }`); a malformed one reads as a malformed
  state, like any other field. A state without it reads as before.

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
