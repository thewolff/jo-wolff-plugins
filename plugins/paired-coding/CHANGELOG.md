# Changelog

All notable changes to paired-coding are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 1.5.0 are described
in the README's *Changes* section.

## [1.5.0] - 2026-11-04

### Added

- Learning mode in the skill. Off by default; it turns on only when the partner types
  `learning mode on` or `teach me as we go`, and off only when they type `learning mode off`.
  While it is on, the card's decision line gains **Why this approach** (one paragraph) and
  **Sources** (a URL fetched this session with its passage, an absolute `file:line`, or a
  `from memory` mark, which is mandatory when nothing was fetched or read); "teach me more" is an
  open point that keeps the card closed, and each answer adds one sourced layer plus a one-line
  recall question saved with `pair_note`; the read-back after each change set asks one recall
  question. Skill text only: the gate, the `pair_*` tools and the card schema are unchanged, and
  with learning mode off a session runs exactly as in 1.4.4.
- README: a *Learning mode* section with its how-it-fails rows and what is not in 1.5.0 (a
  dedicated sources card field, a "write this piece yourself" move, spaced recall across
  sessions).
