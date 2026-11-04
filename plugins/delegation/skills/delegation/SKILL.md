---
name: delegation
description: Use before any Agent/Task spawn or when a spawn was refused for a missing "How it fails" or "Spiral bound" section. Teaches the brief a subagent is handed, which agent class to pick, and the Stopped-because line a builder report ends with.
---

# Delegation: the brief

A subagent does exactly what its brief says and nothing the brief left out. The two things a
brief most often leaves out are how the work fails and where it stops, and a builder with neither
retries until its context runs out. This skill is the brief, section by section. The plugin's
spawn gate refuses a spawn without `## How it fails` (any spawn) or `## Spiral bound` (a
builder-class spawn: `builder`, `beefy-builder`, `task`, `sonic`, `general-purpose`, or the
`builderClass` list in the config) and carries the missing section in its refusal, so a refused
spawn is re-issued with the section filled in, never argued with. A builder-class spawn also
needs this session's pattern-check receipt; the refusal names the exact command.

## When to delegate, and to whom

Delegate when the work would otherwise keep the parent from taking the next instruction: a
search across more than one directory, a file over a thousand lines, a change across several
files, a question that needs fetched sources. Keep in the parent what is quick: one file read,
one command, one scoped grep.

| Job | Agent | What comes back |
|---|---|---|
| find paths, symbols, usages | `scout` | `path:line` receipts, nothing else |
| understand code you will not read yourself | `reader` | a structured map, read-only |
| a fact from vendor docs or library behaviour | `research` | cited findings, unverified items marked |
| ordered steps before any code | `planner` | a plan, no source edits |
| change code: a handful of files, one repository | `builder` | the diff, verification run, `Stopped because:` |
| review, verify, root-cause | `auditor`, `checker`, `debugger` | a report, severity-graded |
| narrative, decks, taglines | `storyteller` | content, never a build |

The builder class is the one that edits and runs things, so it is the one that spirals; the
Spiral bound section exists for it.

## The sections, in order

Headings are literal. The gate reads `## How it fails` and `## Spiral bound` as heading lines
(any level, case does not matter, a trailing colon or a parenthetical such as
`## Spiral bound (builder)` is fine) and nothing else, so prose that mentions the words does not
count and a heading inside a fenced code block does not count. On OMP the shared `context` and
each task are read together, so a section in `context` covers every task. A read-only agent
(`reviewer-codex`, `scout`, `reader`, `research`, `auditor` and the rest of `readOnlyAgents`)
needs `## How it fails` only on Claude Code, and nothing on OMP.

1. `# Target`: the repository, the branch or worktree, the files in play, and the non-goals
   (what the agent is not to touch, so "while I'm here" has an answer).
2. `# Change`: the steps in order, with the interface each step has to keep.
3. `# Acceptance`: the exact command, what green looks like, and what is reported back. One
   run, not "until it passes".
4. `## How it fails`: what breaks if this is wrong and where it shows first; what recovery is
   (the undo command, the file to restore, the migration to roll back); and the retry bound per
   failing step: one retry, then the failure is reported as a named item rather than chased.
5. `## Spiral bound`: one retry per failing step (the second failure of the same step stops the
   work on that step); a commit budget (name N; past it, stop and report what remains); when
   acceptance cannot be met, report what was tried, the exact failure and the last green state,
   and do not loosen the check, skip the step, or substitute an easier problem; a time or tool
   budget when there is one.
6. The report's last line: exactly one of `Stopped because: acceptance met` (every acceptance
   check passed once), `Stopped because: bound hit` (a retry, commit, time or tool bound stopped
   it; the report names which after it, as in `Stopped because: bound hit (commit budget)`),
   `Stopped because: told to stop` (the parent sent a stop). A builder-class report without it
   as the last non-empty line draws a warning: on Claude Code it is shown to the user, not to
   you; on OMP it is added to your context.

Every assertion of fact in the report is labeled only when it has a receipt: **CLAIM** with an
absolute `file:line` or the exact command and its output, **CITE** with a URL fetched this
session or a live probe. Everything else is unlabeled prose, and unlabeled means unreceipted.
Put that sentence in the brief; a subagent that was not told does not label.

The whole template, with these sections and nothing else, is `templates/builder-brief.md` in
this plugin.

## When this can't run

- The spawn was refused and the reason starts `Spawn refused:`: the plugin is working. The
  reason carries the missing section in full; add it to the prompt and re-issue the same spawn.
- The reason names a pattern-check receipt and a `node "<pattern-check>/scripts/pattern-check.mjs" open …` command: run that
  command (it is pattern-check's own CLI), then re-issue. To run without the receipt instead,
  set `requirePatternCheck: false` in `${XDG_CONFIG_HOME:-~/.config}/delegation/config.json`;
  with pattern-check not installed the gate is skipped on its own.
- A `delegation <hook> failed open: <why>` line appeared: the hook let a call through without
  its check and wrote the line to `${XDG_STATE_HOME:-~/.local/state}/delegation/errors.log`.
  Tell the person once; do not treat the allowed call as checked.
- The template is missing (`templates/builder-brief.md` does not exist where
  `CLAUDE_PLUGIN_ROOT` points): the sections above are the template; write them by hand.
- The gates each have an offline scenario: `evals/spawn-gate-deny-no-how-it-fails.scenario.json`
  is the refusal this section describes first.

## A worked example

The template filled in for a real task: a builder adding one config field to a CLI.

```
# Target
Repository /Users/me/code/ledger, branch `config-timeout`, worktree at `.tmp/config-timeout-wt`.
Files: `src/config.mjs`, `src/cli.mjs`, `test/config.test.mjs`, `README.md`.
Non-goals: no change to the SQLite schema; no new dependency; the other CLI flags stay as they are.

# Change
1. `src/config.mjs`: add `timeoutMs` (positive integer, default 5000) to the parsed config; a
   wrong type is a config fault that falls back to the default, same as the existing fields.
2. `src/cli.mjs`: pass `config.timeoutMs` to the one `spawnSync` call that currently hard-codes 5000.
3. `test/config.test.mjs`: a default case, an override case, a wrong-type case.
4. `README.md`: one row in the config table.

# Acceptance
`node --test` from the repository root, green once. The report lists the four files and the
exact test command with its summary line.

## How it fails
- A wrong default or type check makes every `spawnSync` wait forever or fail at once; it shows
  first in `test/config.test.mjs` (the override case) and then in any CLI run.
- Recovery: `git checkout -- src/config.mjs src/cli.mjs` restores the hard-coded value; the test
  file is new and is deleted.
- One retry per failing step; a second failure of the same step is reported as a named item.

## Spiral bound
- Retry bound: one retry per failing step. The second failure of the same step stops the work on that step.
- Commit budget: at most 2 commits (the change, the docs). Past it, stop and report what remains.
- When acceptance cannot be met: report what was tried, the exact failure, and the last green
  state. Do not loosen the check, skip the step, or substitute an easier problem.
- Tool budget: no live network; no installs.

Label only receipted facts: CLAIM with an absolute file:line or the exact command plus its
output; CITE with a URL fetched this session. Everything else is unlabeled prose.
End the report with one line: Stopped because: acceptance met | bound hit | told to stop.
```

## Reading the report

A builder report that ends `Stopped because: bound hit` is not a failure of the brief; it is
the brief working. Read which bound, decide whether to widen it, and re-issue with the new
bound named. A report with no `Stopped because:` line is unfinished until you know which of
the three applies; read its last lines and ask the agent if they do not say. On Claude Code the
warning about a missing line goes to the user, so you will not see it yourself.

A message sent to a subagent that came back marked `this message was NOT delivered` was not
read by anyone: spawn a new agent or fix the name; do not wait for a reply.
