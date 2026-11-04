# Changelog

All notable changes to paired-coding are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 1.5.0 are described
in the README's *Changes* section.

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

With learning mode off, every new check is skipped and a session runs exactly as in 1.4.4.
