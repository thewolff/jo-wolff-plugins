# Changelog

All notable changes to paired-coding are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 1.5.0 are described
in the README's *Changes* section.

## [1.5.0] - 2026-11-04

### Added

- Learning mode, enforced by the gate. Off by default; it turns on only when the partner types
  `learning mode on` or `teach me as we go`, and off only when they type `learning mode off`.
  The agent switches it with the new `pair_learn` tool (`on: true` or `false`), journaled as a
  `learning` entry. The flag lives in the pairing state; every `pair_start` and every carried
  session start with it off, and `pair_start`'s reply says so.
- While learning mode is on, `pair_propose` refuses a card without `why` (a non-empty string)
  and `sources` (at least one; each a `{ "url", "passage" }` object, an absolute
  `file:line` or `file:line-line` string, or a string starting `from memory`), naming the first
  bad entry; both are recorded on the card. `pair_done` refuses without `recall`, one question
  on one line, which the `done` journal entry records. "Teach me more" is an open point, so
  `pair_begin` stays refused under the existing open-points rule.
- A Stop warning in learning mode: when a turn closed a change set and the closing message has
  no line starting `Recall:`, the Claude Code Stop hook returns a `systemMessage` and the OMP
  adapter's new `session_stop` handler a warning notice, each naming the journaled question.
  Never a block; each `pair_done` is warned about once (a `recall-check` journal entry).
- MCP and OMP schemas: `pair_learn`; `why` and `sources` on `pair_propose`; `recall` on
  `pair_done`.
- Eval `stop-learning-warns-no-recall` for Stop's new `systemMessage` outcome, set up by
  `evals/learning-done.mjs` through the real verbs.
- Skill: *Learning mode* describes the tool, the fields and the refusals. README: a *Learning
  mode* section with its how-it-fails rows (accidental switch, the flag leaking across sessions,
  a refusal with learning off, invented sources, a skipped recall question, card bloat) and
  what is not in 1.5.0 (a "write this piece yourself" move, spaced recall across sessions).

With learning mode off, every new check is skipped and a session runs exactly as in 1.4.4.
