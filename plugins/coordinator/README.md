# coordinator

Habits for a session that coordinates other sessions and subagents: briefing, checking what comes
back, relaying the owner's decisions, and keeping a record. The plugin is one skill, `coordinator`,
and two hooks: a per-prompt clock line and a model notice after a model switch.

## What it covers

The skill is written from a long run in which one session coordinated several peer sessions and
subagents for one owner. It covers how to brief a worker, how to read what comes back, how to relay
the owner's decisions without changing them, what a peer session cannot do, which actions the agent
may not take on its own, how to keep the record, and how to treat work that is approved but not
started.

## When it applies

It loads on demand, matched against its description, when a session starts or messages other
sessions or subagents and relays their results to the human. A session that does its own work and
delegates nothing does not need it.

## Install

On Claude Code:

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install coordinator@jo-wolff-plugins
```

The skill runs as `/coordinator:coordinator`.

## Hooks

Both hooks add one line to the model's context (`additionalContext`) and never block. They run on
Claude Code only; the OMP manifest carries no hooks.

| Hook | Event | What it adds | When it is silent |
|---|---|---|---|
| `hooks/clock.mjs` | `UserPromptSubmit` | `The system clock reads 2026-11-11 14:07:41 PST (UTC-08:00), which is 2026-11-11T22:07:41Z, as of this prompt.` | `clock: false` or `off: true` |
| `hooks/model-notice.mjs` | `PostModelSwitch` | `Coordinator notice: this session is running claude-sonnet-5-5 (effort not visible to hooks here). The owner's setting for coordinator sessions is claude-opus-5-5 at medium effort. Switching is suggested (/model, /effort), and the first reply to the owner should say so.` On a switch back: `Coordinator notice: this session is now on claude-opus-5-5. The earlier model notice no longer applies.` | the session's `cwd` is in no listed folder (the default: no folders); the new model matches; `source` is `resume`; the model id is an alias such as `opus` (one `skipped.log` line) |

The clock line runs in every session with the plugin on, including the arrival of a worker's report
or a peer's message, and names its own time because a resumed session replays it unchanged.

The model notice fires only after a switch. Claude Code's SessionStart input carries no model on the
desktop app or the CLI (measured 2026-11-11), so the starting model stays the first reply's job, as
the skill's "Model check" says. The hook input carries no effort level at `PostModelSwitch` either,
so the notice judges the model alone. `PostModelSwitch` needs Claude Code 2.1.251 or later.

## Config

`${XDG_CONFIG_HOME:-~/.config}/coordinator/config.json`, every field optional:

| Field | Default | Meaning |
|---|---|---|
| `off` | `false` | `true` turns both hooks off |
| `folders` | `[]` | absolute paths; the model notice speaks only when the session's `cwd` is one of them or inside one (compared after resolving symlinks) |
| `expectedModel` | `"claude-opus-5-5"` | the model coordinator sessions should run on; the id matches with or without a `-YYYYMMDD` date or a `[1m]` suffix |
| `expectedEffort` | `"medium"` | the effort named in the notice |
| `clock` | `true` | `false` turns off the clock line |

A file that is not JSON, or has a field of the wrong type, is ignored whole: every field takes its
default and a systemMessage names the file and the field.

State: `${XDG_STATE_HOME:-~/.local/state}/coordinator/` holds `errors.log` (hook faults) and
`skipped.log` (switches the notice could not judge), pruned after 30 days by `scripts/prune.mjs`.

## How it fails

The full table is [HOW-IT-FAILS.md](HOW-IT-FAILS.md). In short: a hook that faults (stdin not JSON,
a thrown error, no answer in 4 s) lets the prompt through, writes one `errors.log` line and shows a
`coordinator <event> failed open: …` systemMessage. An unreadable clock gives no line and one
`errors.log` line. A malformed config gives the defaults, so the model notice goes silent. The
behaviour each hook promises is replayed offline by `bash e2e/live-run.sh --no-live`:
`evals/clock-prompt-line.scenario.json`, `evals/clock-off-by-config.scenario.json`,
`evals/model-notice-post-switch-wrong-model.scenario.json`,
`evals/model-notice-post-switch-back-on-expected.scenario.json`,
`evals/model-notice-post-switch-expected.scenario.json`,
`evals/model-notice-post-switch-outside-folder.scenario.json`,
`evals/model-notice-post-switch-resume.scenario.json` and
`evals/model-notice-post-switch-no-folders.scenario.json`.

## Developing

```
cd plugins/coordinator && node --test
cd plugins/coordinator && bash e2e/live-run.sh --no-live
```

`lib/hook-runner.mjs` and `lib/live-run.mjs` are byte copies of plugin-kit's; copy them again
rather than editing them here.

## Changes in 0.2.0

Two hooks: a clock line on every prompt, and a model notice after a model switch inside a configured
folder. The skill's "Model check" and clock sentence now name them. See [CHANGELOG.md](CHANGELOG.md).

## Changes in 0.1.0

First release: the `coordinator` skill. See [CHANGELOG.md](CHANGELOG.md).
