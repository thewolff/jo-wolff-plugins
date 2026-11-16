# Changelog

All notable changes to coordinator are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.2.1 - 2026-11-12

### Changed

- README: the model notice reads `effort.level` when the `PostModelSwitch` input carries one and
  fires on a passing model whose effort is not `expectedEffort`
  (`lib/model-notice.mjs` `decide`); the README said it judged the model alone, and the 0.2.0
  entry below said "Model-only". The `expectedEffort` config row says the same.
- README and HOW-IT-FAILS: a `TZ` that `Intl` rejects gives the clock line in UTC plus a
  `systemMessage` naming the zone. This came in after the 0.2.0 docs, with "diagnose a rejected
  TZ", and was not written down.
- README: an OMP install line. On OMP only the skill loads; the hooks are Claude Code only.
- The 0.2.0 entry's config key list names `modelFamilyRank`.

## 0.2.0 - 2026-11-11

### Added

- `hooks/clock.mjs` (UserPromptSubmit): one line with the system clock, local and UTC, on every
  prompt. `clock: false` turns it off.
- `hooks/model-notice.mjs` (PostModelSwitch): inside a folder listed in the config, a switch onto
  a model below `expectedModel` adds one notice line, and a switch back to at least that model says
  the earlier notice no longer applies. `expectedModel` is a minimum: family order is haiku,
  sonnet, opus, fable, then major and minor version within a family. The family order is the `modelFamilyRank` config key; a family not in it is not judged. Model-only: the hook input carries no effort level. `expectedModel`
  may carry a `[1m]` suffix or a date; both sides are normalised before the match.
- `lib/config.mjs` and `${XDG_CONFIG_HOME:-~/.config}/coordinator/config.json` (`off`, `folders`,
  `expectedModel`, `modelFamilyRank`, `expectedEffort`, `clock`), the state directory with `scripts/prune.mjs`, eight
  scenarios under `evals/`, `e2e/live-run.sh`, and `HOW-IT-FAILS.md`.
- The clock hook names an unwritable state directory in a `systemMessage` (and one `errors.log`
  line when the log can still be appended to); an unreadable config file is a fault, not a silent
  default; `scripts/prune.mjs` names an unreadable directory on stderr; a family missing from
  `modelFamilyRank` makes a cross-family comparison "not judged" rather than a mismatch; the
  canary checks the clock line in the hook's own `hook_response`, requires the session to end in a
  completed `result` event, and fails when the scenario helper is missing. A `skipped.log` that
  cannot be written is named in the model hook's `systemMessage`.
- A switch onto at least `expectedModel` from an alias the hook could not judge (`claude-sonnet-5-5`
  then `opus` then `claude-opus-5-5`) says the earlier notice no longer applies. The canary runs
  `claude -p` with `--setting-sources ""`, and a non-zero exit naming a rate limit or an
  overloaded API is exit 75, the same as a zero exit whose result event names one.

### Changed

- The skill's "Model check" says the hook reports later switches; the clock sentence names the
  clock line as the source; "When this can't be done" covers the hooks being silent.

## 0.1.0 - 2026-11-11

### Added

- The `coordinator` skill: how a session that coordinates other sessions and subagents for one
  owner briefs workers, checks what comes back, relays the owner's decisions, and keeps a record.
- No hooks, scripts or OMP extension. The plugin is the one skill.
