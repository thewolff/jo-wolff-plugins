# Changelog

All notable changes to paired-coding are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 1.5.0 are described
in the README's *Changes* section.

## [1.6.0] - 2026-11-04

### Added

- A pattern claim needs a pattern source, in learning mode or out of it. When a card's `why`
  contains one of `PATTERN_CLAIM_PHRASES` (`core/gate.mjs`; case-insensitive: `pattern used
  in`, `the rest of the codebase`, `convention here`, `how the codebase does`, `existing
  pattern`, `follows the pattern`, `the pattern in`), `sources` must include one absolute
  `file:line` inside the pattern-check receipt directory `<git root>/.pattern-check/`, or two
  or more absolute `file:line` sources inside the repository the worktree is in. Otherwise
  `pair_propose` refuses, naming the phrase, this session's receipt path
  (`<git root>/.pattern-check/<session id>.md`) and both counts. Paths are compared lexically;
  existence is not checked, as with every `file:line` source.
- `alternatives`, an optional card field: `[{ "design", "chosen" }]` with exactly one
  `chosen: true`, checked for form when given and recorded on the card and in the journal.
  Required when ask-graham's findings file for this session exists
  (`${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/findings/<session id>.json`): then one
  entry must contain the findings' chosen design (whitespace collapsed, case ignored) and,
  when the findings weighed a design they did not choose, at least one entry is not chosen.
  A findings file that cannot be read, is not JSON or is not an object reads as missing, with
  one `errors.log` line under this plugin's state base; ask-graham's files are never written.
- The card's reply lists `alternatives` with the chosen one marked (`[chosen]`), after the
  planned code, so the learner sees the pattern-fit pick and the better design side by side;
  `pair_learn`'s reply names the pattern-source rule.
- `lib/card-context.mjs`: the copied path rules (pattern-check's receipt, ask-graham's
  findings; no plugin dependency) and the findings reader, handed to the gate as
  `io.cardContext`. The gate's `patternClaim`, `patternSourceProblem` and
  `alternativesProblem` are pure and exported.
- MCP and OMP schemas: `alternatives` on `pair_propose`.
- Evals: `pre-tool-use-card-pattern-unsourced`, `pre-tool-use-card-pattern-receipt`,
  `pre-tool-use-card-alternatives-missing` and `pre-tool-use-card-alternatives-pass`, each set
  up by `evals/card-checks.mjs` through the real verbs (the setup exits non-zero unless
  `pair_propose` answered as the scenario says), with the findings file written under the
  sandbox's `$XDG_STATE_HOME` and the receipt under the sandbox worktree.
- README: *A pattern claim needs a pattern source* with its how-it-fails rows and *Not in
  1.6.0*; skill: the two fields under *The card* and *Learning mode*.

No new state is written: both checks read sibling plugins' files. A card without a pattern
phrase in `why`, in a session with no findings file, runs exactly as in 1.5.0.

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
