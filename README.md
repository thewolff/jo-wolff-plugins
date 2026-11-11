# jo-wolff-plugins

A marketplace of plugins for Claude Code and OMP about working with an agent: what its output is
made of, what shape that output arrives in, when it may write code at all, whether it has looked
for what the repository already has, whether the thing is worth building in the first place,
going through your reminders with it, keeping a record of what it did and asked, and a vendored
set of engineering skills.

This file is an index. It changes only when a plugin is added, removed, or its purpose changes.
Each plugin's own `README.md` documents it, and each plugin's `CHANGELOG.md` records every
release; versions live there and in each plugin's `.claude-plugin/plugin.json`, not here.

## Plugins

| Plugin | What it does |
|---|---|
| [output-types](plugins/output-types/README.md) | Labels only receipted facts, as CLAIM or CITE with the receipt that earns the label, and warns at Stop about any label that has no receipt. |
| [i-have-audhd](plugins/i-have-audhd/README.md) | Teaches the agent how to write to someone who is ADHD and autistic, with the research behind each rule, and warns at Stop when a message buries what the reader needs. |
| [paired-coding](plugins/paired-coding/README.md) | Pairs the agent with you one change set at a time, behind a gate at the tool boundary that refuses every write you have not agreed to. |
| [ask-graham](plugins/ask-graham/README.md) | Answers "should we build X?" with one engineer's stated judgment and a single verdict, when you ask or on every new idea. |
| [pattern-check](plugins/pattern-check/README.md) | Makes the agent find the existing pattern for each new piece of big work and record reuse, replace or new, and holds writes, commits and PRs until that receipt exists. |
| [reminders-review](plugins/reminders-review/README.md) | Goes through your open Apple Reminders one at a time: the agent answers, confirms before acting, and closes a reminder only when you say yes. |
| [ledger](plugins/ledger/README.md) | Keeps a durable record of the questions the agent asks you and the choices it makes without asking, in one SQLite file, and gates a push on it. |
| [as2-skills](plugins/as2-skills/README.md) | Ships the 22 engineering skills of agent-system 2.0, vendored from four upstream skill packs at pinned releases. |
| [plugin-kit](plugins/plugin-kit/README.md) | Scaffolds a new plugin that meets this repository's test bar on day one, and keeps the libraries and agents the other plugins vendor. |
| [ctx-watch](plugins/ctx-watch/README.md) | Notices when the ctx daemon is dead, unsupervised or stale, or its semantic index is not ready, repairs it, and says so at session start and in a macOS popup. |
| [delegation](plugins/delegation/README.md) | Teaches the agent the brief a subagent is handed and refuses a spawn whose brief lacks a required section; ships the general agents and guards. |
| [continuity](plugins/continuity/README.md) | Keeps a long session's state across compaction: a snapshot saved before and restored after, a liveness line on every start, and a handoff skill. |
| [brb](plugins/brb/README.md) | Lets you type `brb` and walk away: the agent keeps working, every ask waits in a digest, and only an on-fire finding comes through at once. |

## Install

On Claude Code:

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install output-types@jo-wolff-plugins
/plugin install i-have-audhd@jo-wolff-plugins
/plugin install paired-coding@jo-wolff-plugins
/plugin install ask-graham@jo-wolff-plugins
/plugin install reminders-review@jo-wolff-plugins
/plugin install pattern-check@jo-wolff-plugins
/plugin install ledger@jo-wolff-plugins
/plugin install as2-skills@jo-wolff-plugins
/plugin install plugin-kit@jo-wolff-plugins
/plugin install ctx-watch@jo-wolff-plugins
/plugin install delegation@jo-wolff-plugins
/plugin install continuity@jo-wolff-plugins
/plugin install brb@jo-wolff-plugins
```

On OMP, from a shell:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install output-types@jo-wolff-plugins
omp plugin install i-have-audhd@jo-wolff-plugins
omp plugin install paired-coding@jo-wolff-plugins
omp plugin install ask-graham@jo-wolff-plugins
omp plugin install reminders-review@jo-wolff-plugins
omp plugin install pattern-check@jo-wolff-plugins
omp plugin install ledger@jo-wolff-plugins
omp plugin install as2-skills@jo-wolff-plugins
omp plugin install plugin-kit@jo-wolff-plugins
omp plugin install ctx-watch@jo-wolff-plugins
omp plugin install delegation@jo-wolff-plugins
omp plugin install continuity@jo-wolff-plugins
omp plugin install brb@jo-wolff-plugins
```

Inside a running OMP session the commands are `/marketplace add` and `/marketplace install`, with
the same arguments. `/plugin install` inside OMP installs nothing. What each plugin runs on each
host is in *What runs where* below.

To update, update each harness separately. On OMP, refresh the marketplace first, because
`omp plugin upgrade` installs the version in OMP's cached copy of it:

```
claude plugin update <plugin>@jo-wolff-plugins
omp plugin marketplace update jo-wolff-plugins
omp plugin upgrade <plugin>@jo-wolff-plugins
```

Then relaunch OMP sessions. OMP's own install wins over Claude Code's for the same plugin, so
updating Claude Code alone leaves OMP on the older copy. `node scripts/check-omp-install.mjs`
compares the two installs and prints the commands for any plugin that differs (exit 1).

## How the plugins fit together

### One turn, start to end

**Session start.** output-types injects the CLAIM and CITE labels; i-have-audhd the message
skeleton and its rule headings; ledger the questions waiting on you and its last notes; ctx-watch
a line when the ctx daemon is dead, unsupervised or stale or its semantic index is not ready;
reminders-review overdue and today's reminders. delegation injects a short block with the brief
skeleton inline, so the session knows the brief's shape before its first spawn. After a
compaction, continuity restores this session's snapshot and leads with a liveness line on its
newest save. While you are away, brb repeats the away instruction.

**A prompt.** ask-graham adds its one-line nudge at level `every-idea`; i-have-audhd hands back
the last message's warn findings once; ledger relays answers recorded in other sessions. Typed as
the whole prompt, `brb`, `back` and `pending` go to brb, and none of them starts a turn while
away. Past its ask point (175,000 tokens by default, and 40,000 past where the window started),
continuity asks for a handoff naming `/continuity:handoff`, again every 150,000 tokens more, and
afresh after each compaction.

**A tool call.** pattern-check holds writes, `git commit` and `gh pr create` past its file
threshold until `.pattern-check/<session>.md` exists. ledger holds `AskUserQuestion` until the
question is on a ledger row, and `git push` / `gh pr create` until the session has a note or
outcome and, in a plugin repository, `ledger gate check` passes. paired-coding refuses writes you
have not agreed to; in learning mode a card also needs `why` and `sources`. delegation warns on
oversized reads, long direct streaks and worktree spawns from a dirty tree, and injects the rules
files of a directory the session did not load.

**A spawn.** delegation refuses an `Agent`/`Task` (OMP: `task`) brief with no `## How it fails`
heading; a builder-class brief also needs `## Spiral bound` and the session's pattern-check
receipt. Read-only agents (scout, reader, research and the rest of `readOnlyAgents`) skip the
last two. The refusal carries the missing section as a fill-in template.

**A subagent stops.** delegation warns, never blocks, when a builder-class report does not end
with `Stopped because: acceptance met | bound hit | told to stop`. A failed `SendMessage` becomes
a block saying the message was not delivered.

**Stop.** i-have-audhd runs its checks on the finished message and warns by default. output-types
warns on every CLAIM without a `file:line` or command and every CITE without a URL; its judge
stage is off by default. ask-graham blocks once on a missing verdict or sources line;
pattern-check once on a plan with no receipt; ledger on a decision asked outside the ledger.
paired-coding warns in learning mode when a closed change set has no `Recall:` line. ctx-watch
warns when a resumed or compacted session reaches its first stop without a `ctx search`. At the
same ask point, continuity blocks once per step so the agent writes the handoff.

**Compaction.** continuity saves a snapshot of the session, git state included, before it, asks
Claude Code's compaction summary for a `## Handoff` section, and after an auto or idle
compaction says so when no handoff file was written.

**Away.** Between `brb` and `back`, the agent writes each ask into brb's digest with
`scripts/brb.mjs hold` and shows none of it; brb's Stop hook files any `## Needs you` section
or closing ask that still appears and sends the reply back once, surfaces `on fire:` lines at
once, and sends the agent back to work until it writes `idle:`, stops twice with no tool call,
or runs three continuations in a row that raise nothing new.

**End.** ledger stamps the session and may write a decision-log entry; pattern-check keeps the
receipt and removes its working files.



### What they share

- **The judge command.** plugin-kit's `lib/judge.mjs` resolves one command (the plugin's env
  var, its own setting, `~/.config/judge/config.json`, then i-have-audhd's
  `enforcement.judgeCommand`), and output-types, i-have-audhd and ledger vendor it byte for
  byte (i-have-audhd's own setting is that same `enforcement.judgeCommand`, so for it the
  profile comes first).
- **The receipt.** output-types defines what earns a CLAIM or CITE and warns at Stop when a
  label lacks one; pattern-check's receipt is the `.pattern-check/<session>.md` file, which
  delegation's spawn gate requires before a builder-class spawn. ask-graham writes each verdict
  or structure check to `ask-graham/findings/<session id>.json` for other plugins to read, and
  paired-coding reads that file and pattern-check's receipt when they are present.
- **"How it fails" and "When this can't run".** as2-skills writes the section into every skill,
  ledger's `says` row fails a skill or agent without one, and delegation's spawn gate refuses a
  brief without `## How it fails`.
- **The hook runner and the scenario runner.** plugin-kit's `lib/hook-runner.mjs` is copied into
  ctx-watch, reminders-review, output-types, delegation, continuity and brb, so their hooks fail
  open; its `lib/live-run.mjs` is what every plugin's `e2e/live-run.sh` hands off to, and
  ledger's canary runs those.

### What runs where

Claude Code runs each plugin's `hooks/hooks.json`. OMP reaches a plugin only through an extension
listed under `omp.extensions` in its `package.json`, installed through `.omp-plugin/plugin.json`.

| Plugin | Claude Code hooks (`hooks/hooks.json`) | OMP (`.omp-plugin` + extension) |
|---|---|---|
| output-types | SessionStart, Stop | none; the skill only (see *Install on OMP* in its README) |
| i-have-audhd | SessionStart, UserPromptSubmit, Stop | `omp/i-have-audhd-omp.ts`: `session_start`, `before_agent_start`, `session_stop` |
| paired-coding | SessionStart, UserPromptSubmit, PreToolUse, Stop, SessionEnd | `omp/paired-coding-omp.ts`: `tool_call`, `input`, `session_stop`, session lifecycle events |
| ask-graham | UserPromptSubmit, Stop | `omp/ask-graham-omp.ts`: `before_agent_start`, `session_stop` |
| pattern-check | PreToolUse, Stop, SessionEnd | `omp/pattern-check-omp.ts`: `tool_call`, `session_start`, `session_stop` |
| reminders-review | SessionStart, UserPromptSubmit | `omp/reminders-review-omp.ts`: `session_start`, `before_agent_start` |
| ledger | SessionStart, UserPromptSubmit, PreToolUse, Stop, SessionEnd | none; Claude Code only |
| ctx-watch | SessionStart, Stop | none; the skill, CLI and launchd timer work on both; the Stop check is Claude Code only |
| delegation | SessionStart, PreToolUse, PostToolUse, SubagentStop | `omp/delegation-omp.ts`: `before_agent_start`, `context`, `tool_call`, `tool_result`, `session_compact`; the three ported guards are Claude Code only |
| continuity | SessionStart, UserPromptSubmit, PreCompact, Stop | `omp/continuity-omp.ts`: `auto_compaction_start`, `auto_compaction_end`, `session_before_compact`, `session_compact`; the context-pressure check is Claude Code only |
| brb | SessionStart, UserPromptSubmit, Stop | `omp/brb-omp.ts`: `input`, `before_agent_start`, `session_stop` |
| as2-skills | none; skills only | `.omp-plugin/plugin.json`, skills only |
| plugin-kit | none; skill, scripts and agents | none; works from a checkout on both |

## The test bar

Every plugin in this repository passes `node --test` from inside its directory, plain and in an
empty home (`env -i HOME=$(mktemp -d) ... node --test`), and passes the six rows of
`ledger gate check` on every change since the branch's base:

- `survives` (can't break the session): every hook command in `hooks/hooks.json` exits 0 within
  5 s, denying and blocking nothing, on each of five fault inputs (empty stdin, malformed JSON,
  an unknown event, an unwritable state directory, no config and an empty `HOME`).
- `visible` (failures visible): the malformed-JSON and unwritable-state inputs each leave a line
  in the plugin's `errors.log` and a `systemMessage`, and every `test/fixtures/<x>.txt` has an
  `<x>.unavailable.txt` beside it.
- `says` (text says what to do when it can't): every skill and agent has a "When this can't run"
  section, and every deny or block reason names a command in backticks.
- `evals` (behaviour is proved): `evals/manifest.json` declares what each hook can return, one
  `evals/<x>.scenario.json` with a real stdin fixture proves each outcome, and the newest canary
  row for the committed tree passes.
- `retention` (state is declared and pruned): `.claude-plugin/plugin.json` declares every path
  the plugin writes outside the worktree, with a prune command for anything kept a number of days.
- `docs` (a release is written down): a version bump has a `CHANGELOG.md` entry and a README
  release heading in the plugin, and this README names the plugin (never its version).

The rows' exact rules are in [the ledger README](plugins/ledger/README.md), under *The plugin
gate*.

## Adding a plugin

1. From a checkout, run `/plugin-kit:new-plugin <name>` (or
   `node plugins/plugin-kit/scripts/new-plugin.mjs <name>`). It scaffolds the fail-open hook
   runner, one handler per event, the five-fault contract test, the scenario runner and the
   canary live run, a scenario stub per event, the prune verb and state declaration, a
   `CHANGELOG.md`, and a skill with its "When this can't run" section.
2. Add the plugin's row to the table at the top of this file: its name and one sentence saying
   what it does for the user. That is the only edit this file takes for a new plugin, and a
   later release takes none.
3. Add its entry to both `.claude-plugin/marketplace.json` and `.omp-plugin/marketplace.json`
   (name, source, the same sentence) when it is ready to publish. OMP reads the second file
   when it exists, so an entry missing there makes `omp plugin install <name>@jo-wolff-plugins`
   fail with "not found in marketplace". The `description` in `.claude-plugin/plugin.json`,
   `.omp-plugin/plugin.json`, `package.json` and the marketplace entries is one purpose
   statement, the same everywhere, and never a list of changes.
4. Run `node --test` in the plugin and `node plugins/ledger/scripts/ledger.mjs gate check
   --plugins <name>` from the repository root; both green before the first push.

Later releases bump the version in the plugin's `.claude-plugin/plugin.json`,
`.omp-plugin/plugin.json` and `package.json`, add the `CHANGELOG.md` entry and the README
release heading, and leave this file alone.

## License

MIT. See `LICENSE`.
