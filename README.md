# jo-wolff-plugins

Plugins about working with an agent: what its output is made of, what shape that output
arrives in, when it may write code at all, whether it has looked for what the repository already
has, whether the thing is worth building in the first place, going through your reminders with
it, keeping a record of what it did and asked, and a vendored set of engineering skills.

- **[output-types](#output-types)** — label receipted facts, and only those, with the receipt
  that earns the label; a Stop check warns when a label has no receipt.
- **[i-have-audhd](#i-have-audhd)** — how to write to someone who is ADHD and autistic, with the
  research behind each rule and a Stop hook that warns when a message buries what they need.
- **[paired-coding](#paired-coding)** — pair with the agent one change set at a time, behind a
  gate that refuses writes you have not agreed to.
- **[ask-graham](#ask-graham)** — answer "should we build X?" with one engineer's stated
  judgment and a single verdict, when you ask or on every new idea.
- **[pattern-check](#pattern-check)** — before big work, the agent finds the existing pattern for
  each new piece and records reuse, replace or new; hooks hold writes, commits and PRs until it has.
- **[reminders-review](#reminders-review)** — go through your open Apple Reminders one at a
  time: the agent answers, confirms before acting, and closes each one only when you say yes.
- **[ledger](#ledger)** — a durable, id'd record of the questions an agent asks you and the
  choices it makes without asking, in one SQLite file. It records every session everywhere until
  you switch a folder off with `/ledger:disable`; hooks keep every question and your plain-words
  answer on a row.
- **[plugin-kit](plugins/plugin-kit/README.md)** — start a new plugin here that meets the test
  bar on day one: the fail-open hook runner, one handler per event, the five-fault contract test,
  the scenario runner and the canary live run, a scenario stub per event, the prune verb and
  state declaration, and a skill with its "When this can't run" section, scaffolded by
  `/plugin-kit:new-plugin`; `ledger gate check` passes on it, the `evals` row excepted, before
  the first rule is written, and that row fails naming the stubs until they are filled.
  Changes in plugin-kit 0.3.2: the judge sameness test allowlists nothing: ledger 0.3.7 ships the kit's `lib/judge.mjs` byte for byte.
  Changes in plugin-kit 0.3.1: the hook runner waits for stdout to drain before it exits (bounded by its deadline), so an answer larger than one 64 KiB pipe buffer is no longer cut short.
  Changes in plugin-kit 0.3.0: `lib/judge.mjs`, the shared judge dispatch every judging plugin vendors byte for byte (a sameness test diffs the copies), configured once with `node lib/judge.mjs setup`; `--judge` on the scaffolder.
  Changes in plugin-kit 0.2.2: the scaffold writes a `CHANGELOG.md` (Keep a Changelog, with the
  0.1.0 entry) beside the README's `## Changes in 0.1.0`, and the `release-gate` checklist's
  version-match step wants the three things ledger 0.3.6's `docs` row wants: the CHANGELOG
  entry, the README release heading and this README's mention.
  Changes in plugin-kit 0.2.1: the `cross-lab-reviewer` agent has a review budget: verdicts `ship`, `ship-with-limits` and `fix-first` (only on a blocking finding), a required `Threat model:` line, a one-sentence worst case per finding, and blocking-only reviews from round 3.
  Changes in plugin-kit 0.2.0: the shared scenario runner `lib/live-run.mjs` and the evals, prune
  and state scaffold templates. Changes in plugin-kit 0.1.2: two agents, `cross-lab-reviewer` (a Codex review of the branch) and `release-gate` (the release checklist, report-only).
- **[as2-skills](plugins/as2-skills/README.md)** — the 22 engineering skills of agent-system 2.0,
  vendored from four upstream skill packs at pinned releases, with frontmatter claude.ai accepts.
  Install with `/plugin install as2-skills@jo-wolff-plugins`; skills only.
  Changes in as2-skills 0.1.2: every skill has a "How it fails" section, and the manifest
  declares the one path a skill writes outside the worktree (`$TMPDIR/seo-audit-*`), the bar
  ledger 0.3.5's `gate check` enforces; see the plugin's
  [release notes](plugins/as2-skills/README.md#changes-in-012). Changes in as2-skills 0.1.1:
  the triad and quorum fan-out scripts ship their `lib/leg-runner.sh`.
- **[delegation](#delegation)** — teach the agent the brief a subagent is handed (a SessionStart
  block and a skill with a worked example), then gate on it: a spawn without `## How it fails` is
  refused with the section to fill in, a builder-class spawn also needs `## Spiral bound` and a
  pattern-check receipt, an undeliverable message is marked NOT delivered, and a builder report
  without `Stopped because:` draws a warning. Plus the eleven general agents and three guards
  ported from newdle. Changes in delegation 0.1.1: `lib/hook-runner.mjs` re-vendored from
  plugin-kit 0.3.1 (the handler's env carries the runner's start and deadline; stdout drains before exit); hooks answer as
  before.
- **[ctx-watch](#ctx-watch)** — notice when the ctx daemon is dead, unsupervised,
  or stale, or its semantic index is not ready; repair what ctx documents a command for, and
  say so at SessionStart and in a macOS popup from a launchd timer; the SessionStart line also
  says when the timer itself has stopped. At Stop, the `consult-history` check says when a
  resumed session never asked ctx what the thread was. macOS; Claude Code hooks, plus a CLI
  that works anywhere.
  Changes in ctx-watch 0.2.1: `lib/hook-runner.mjs` re-vendored from plugin-kit 0.3.1 (the
  handler's env carries the runner's start and deadline; stdout drains before exit); hooks answer as before. In 0.2.0: the
  semantic index (`.daemon.jobs.semantic_index` not `ready`
  with semantic search enabled) is a failing probe naming `ctx semantic enable --wait`, in the
  SessionStart line and the popup; the `consult-history` Stop check (a resume, a compaction,
  or "as discussed" with no `ctx search` since; `~/.claude/ctx-watch.json`, default warn);
  `evals/` and the plugin-kit scenario runner; see the plugin's
  [release notes](plugins/ctx-watch/README.md#changes-in-021).
- **[continuity](#continuity)** — keep a long session's state across compaction: a PreCompact
  hook saves branch, diff, touched files, recent asks and the repository's open handoffs to a
  snapshot the post-compaction SessionStart injects back; every start says when that save last
  succeeded, so a dead save is never silent; a context-pressure check warns once and blocks one
  stop near the compaction target, naming `/continuity:handoff`; and the handoff skill writes
  the judgment layer no hook can derive. Claude Code hooks. Changes in continuity 0.2.0: after a
  compaction the restore block also re-inlines the rules files (`CLAUDE.md`, `CLAUDE.local.md`,
  `AGENTS.md`) on the walk from the cwd to the repository root, root first, inside what the
  restore guard has left (8,000 bytes per file, 9,000 for the section, every cut and skip
  named), and lists the newest entries of the repository's durable-notes directory
  (`notesDir`, default `.ai/decision-log`); config keys `rules`, `notesDir`, `notesCount`. See
  the plugin's [CHANGELOG](plugins/continuity/CHANGELOG.md).
- **[brb](#brb)** — type `brb` and walk away: the agent keeps working, every ask it would
  have stopped for waits in a digest, and only a broken main, data loss, a security finding,
  spend near a ceiling or a blocker on everything comes through at once; `back` prints the
  digest. Claude Code hooks plus an OMP extension. Changes in brb 0.1.1: `lib/hook-runner.mjs`
  re-vendored from plugin-kit 0.3.1 (the handler's env carries the runner's start and deadline; stdout drains before exit);
  hooks answer as before.

output-types delivers text and, since 0.3.0, checks every finished message for a label without
a receipt, warning only; see its *delivers, and warns* note. i-have-audhd delivers its rules and checks every finished message, warning by
default. paired-coding enforces at the tool boundary, within the limits in its *what this
enforces, and what it does not* note. ask-graham is a skill, a one-line prompt nudge you can
turn off, and a Stop check that blocks once per turn when an answer that read the skill has no
verdict line (or, for a structure check, no `**Found:**` or `**No similar:**` line), which
`/ask-graham stop-check off` turns off.
reminders-review and as2-skills are skills only. pattern-check enforces at the tool boundary: it
holds writes, commits and PRs past a file threshold until a receipt exists, and does not judge
the receipt.

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
omp plugin install as2-skills@jo-wolff-plugins
omp plugin install plugin-kit@jo-wolff-plugins
omp plugin install ctx-watch@jo-wolff-plugins
omp plugin install delegation@jo-wolff-plugins
omp plugin install continuity@jo-wolff-plugins
omp plugin install brb@jo-wolff-plugins
```

Inside a running OMP session the commands are `/marketplace add` and `/marketplace install`, with
the same arguments. `/plugin install` inside OMP installs nothing. On OMP output-types delivers its
skill only; its hooks do not run there. i-have-audhd and paired-coding install OMP extensions
that run their hooks, and ask-graham installs its prompt nudge (see each section). plugin-kit
is a skill and a script, so it works on both. ctx-watch's SessionStart line is Claude Code
only; its skill, CLI and launchd timer work on both. ledger is Claude Code only. delegation's
gates, teaching block and agents run on both; its three ported guards are Claude Code only.
continuity's hooks are Claude Code only; its handoff skill works on both.
brb installs an OMP extension that runs its hooks.

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

This section describes the repository after pull requests #73 to #81 merged onto `6c68968`, plus the plugin-kit 0.3.1 re-vendor.
The versions are in the table under *Who does what*; per-plugin detail is in each plugin's
section or README.

### One turn, start to end

**Session start.** output-types injects the CLAIM and CITE labels; i-have-audhd the message
skeleton and its rule headings; ledger the questions waiting on you and its last notes; ctx-watch
a line when the ctx daemon is dead, unsupervised or stale or its semantic index is not ready; reminders-review overdue and today's
reminders. delegation injects a block under 25 lines with the brief skeleton inline, so the
session knows the brief's shape before its first spawn. After a compaction, continuity restores
this session's snapshot and leads with a liveness line on its newest save. While you are away,
brb repeats the away instruction.

**A prompt.** ask-graham adds its one-line nudge at level `every-idea`; i-have-audhd hands back
the last message's warn findings once; ledger relays answers recorded in other sessions. Typed as
the whole prompt, `brb`, `back` and `pending` go to brb, and none of them starts a turn while
away. At 65% of the context window (the default), continuity warns once and names
`/continuity:handoff`.

**A tool call.** pattern-check holds writes, `git commit` and `gh pr create` from the third
distinct file until `.pattern-check/<session>.md` exists. ledger holds `AskUserQuestion` until
the question is on a ledger row, and `git push` / `gh pr create` until the session has a note or
outcome and, in a plugin repository, `ledger gate check` passes its six rows. paired-coding
refuses writes you have not agreed to; in learning mode a card also needs `why` and `sources`.
delegation warns on oversized reads, long direct streaks and worktree spawns from a dirty tree,
and injects the rules files of a directory the session did not load.

**A spawn.** delegation refuses an `Agent`/`Task` (OMP: `task`) brief with no `## How it fails`
heading; a builder-class brief also needs `## Spiral bound` and the session's pattern-check
receipt. Read-only agents (scout, reader, research and the rest of `readOnlyAgents`) skip the
last two. The refusal carries the missing section as a fill-in template.

**A subagent stops.** delegation warns, never blocks, when a builder-class report does not end
with `Stopped because: acceptance met | bound hit | told to stop`. A failed `SendMessage` becomes
a block saying the message was not delivered.

**Stop.** i-have-audhd runs thirteen checks on the finished message, five through the judge (six with links-judge on), and
warns by default. output-types warns on every CLAIM without a `file:line` or command and every
CITE without a URL; its judge stage is off by default. ask-graham blocks once on a missing
verdict or sources line; pattern-check once on a plan with no receipt; ledger on a decision
asked outside the ledger. paired-coding warns in learning mode when a closed change set has no
`Recall:` line. ctx-watch warns when a resumed or compacted session reaches its first stop
without a `ctx search`. Past the threshold, continuity blocks once so the agent writes the handoff.

**Compaction.** continuity saves a snapshot of the session, git state included, before it
(Claude Code only), and says so when auto-compaction fires with no handoff written.

**Away.** Between `brb` and `back`, brb's Stop hook files `## Needs you` lines in a digest,
surfaces `on fire:` lines at once, and sends the agent back to work until it writes `idle:`,
stops twice with no tool call, or runs three continuations in a row that raise nothing new.

**End.** ledger stamps the session and may write a decision-log entry; pattern-check keeps the
receipt and removes its working files.

### Who does what

| Plugin | Version | What it does | Reads from / gives to another plugin |
|---|---|---|---|
| output-types | 0.3.1 | the CLAIM/CITE contract at SessionStart; a Stop check that warns on a label without its receipt | vendors plugin-kit's `lib/judge.mjs` and `lib/hook-runner.mjs`; delegation's brief skeleton carries its CLAIM/CITE line |
| i-have-audhd | 1.7.0 | the message skeleton and thirteen Stop checks (links-resolve and the opt-in links-judge since 1.6.1), warning by default; its judge is the shared one since 1.7.0 | vendors plugin-kit's `lib/judge.mjs`; its `enforcement.judgeCommand` is an override of the shared judge file, and the last fallback of plugin-kit's judge resolution and of ledger's review judge |
| paired-coding | 1.6.0 | change sets behind a write gate; learning mode with `pair_learn`, `why` + `sources` on a card, `recall` on done; a pattern claim needs a pattern source, `alternatives` drawn from ask-graham's findings | reads pattern-check's receipt and ask-graham's findings when present; no dependency |
| ask-graham | 0.8.1 | "should we build X?" with a verdict; a prompt nudge and a Stop check; each verdict or structure check recorded per session in `ask-graham/findings/<session id>.json` | reads your `sources.md`; nothing from another plugin; its `**Alternative:**` line carries pattern-check's `better design` cell when that plugin is installed; its findings file is for other plugins to read |
| pattern-check | 0.4.0 | holds big work until a reuse/replace/new receipt exists, each row with its `better design` and how it fails | its receipt file is what delegation's spawn gate requires |
| reminders-review | 0.2.1 | Apple Reminders, one at a time | none |
| ledger | 0.3.7 | questions and choices on rows; the push gate with six rows; the review judge from plugin-kit's shared `lib/judge.mjs` | its `says` row checks the "When this can't" heading every skill and agent carries; its canary runs every plugin's `e2e/live-run.sh` |
| plugin-kit | 0.3.2 | the scaffold (with `CHANGELOG.md` since 0.2.2), the hook runner, the shared judge lib, the scenario runner, two agents | gives `lib/hook-runner.mjs` and `lib/judge.mjs` to the plugins that vendor them, and `lib/live-run.mjs` to every `e2e/live-run.sh` |
| as2-skills | 0.1.2 | 22 vendored engineering skills, each with "How it fails" | its sections meet ledger's `says` row |
| ctx-watch | 0.2.1 | ctx daemon and semantic-index health, repair, and the consult-history Stop check | vendors the hook runner and the scenario runner |
| delegation | 0.1.1 | brief teaching, spawn gate, `SendMessage` check, SubagentStop warning, 11 agents, three guards | needs pattern-check's receipt for builder-class spawns; vendors the hook runner |
| continuity | 0.2.0 | PreCompact snapshot, post-compaction restore with the rules files and durable notes re-inlined, liveness line, context-pressure warning, `/continuity:handoff` | vendors the hook runner |
| brb | 0.1.1 | `brb` / `back` / `pending`, the away digest, keep-working, on-fire surfacing | vendors the hook runner |

### What they share

- **The judge command.** plugin-kit's `lib/judge.mjs` resolves one command (the plugin's env
  var, its own setting, `~/.config/judge/config.json`, then i-have-audhd's
  `enforcement.judgeCommand`) and output-types and i-have-audhd vendor it (i-have-audhd's own
  setting is that same `enforcement.judgeCommand`, so for it the profile comes first), while
  ledger's `lib/judge.mjs` still reads the i-have-audhd profile itself.
- **The receipt.** output-types defines what earns a CLAIM or CITE and warns at Stop when a
  label lacks one; pattern-check's receipt is the `.pattern-check/<session>.md` file, which
  delegation's spawn gate requires before a builder-class spawn.
- **"How it fails" and "When this can't run".** as2-skills writes the section into every skill,
  ledger's `says` row fails a skill or agent without one, and delegation's spawn gate refuses a
  brief without `## How it fails`.
- **The hook runner.** plugin-kit's `lib/hook-runner.mjs` is copied into ctx-watch,
  reminders-review, output-types, delegation, continuity and brb, so their hooks fail open.

### What runs where

Claude Code runs each plugin's `hooks/hooks.json`. OMP reaches a plugin only through an extension
listed under `omp.extensions` in its `package.json`, installed through `.omp-plugin/plugin.json`.

| Plugin | Claude Code hooks (`hooks/hooks.json`) | OMP (`.omp-plugin` + extension) |
|---|---|---|
| output-types | SessionStart, Stop | none; the skill only (see *Install on OMP*) |
| i-have-audhd | SessionStart, UserPromptSubmit, Stop | `omp/i-have-audhd-omp.ts`: `session_start`, `before_agent_start`, `session_stop` |
| paired-coding | SessionStart, UserPromptSubmit, PreToolUse, Stop, SessionEnd | `omp/paired-coding-omp.ts`: `tool_call`, `input`, `session_stop`, session lifecycle events |
| ask-graham | UserPromptSubmit, Stop | `omp/ask-graham-omp.ts`: `before_agent_start`, `session_stop` |
| pattern-check | PreToolUse, Stop, SessionEnd | `omp/pattern-check-omp.ts`: `tool_call`, `session_start`, `session_stop` |
| reminders-review | SessionStart, UserPromptSubmit | `omp/reminders-review-omp.ts`: `session_start`, `before_agent_start` |
| ledger | SessionStart, UserPromptSubmit, PreToolUse, Stop, SessionEnd | none; Claude Code only |
| ctx-watch | SessionStart, Stop | none; the skill, CLI and launchd timer work on both; the Stop check is Claude Code only |
| delegation | SessionStart, PreToolUse, PostToolUse, SubagentStop | `omp/delegation-omp.ts`: `before_agent_start`, `context`, `tool_call`, `tool_result`, `session_compact` |
| continuity | SessionStart, UserPromptSubmit, PreCompact, Stop | none; Claude Code only |
| brb | SessionStart, UserPromptSubmit, Stop | `omp/brb-omp.ts`: `input`, `before_agent_start`, `session_stop` |
| as2-skills | none; skills only | `.omp-plugin/plugin.json`, skills only |
| plugin-kit | none; skill, scripts and agents | none; works from a checkout on both |

## output-types

A plugin that makes an agent label the receipted facts it returns — CLAIM for what it checked this
session, CITE for what an outside source says — and attach the receipt that earns the label.
Everything else stays plain prose, and unlabeled means not backed by a receipt, so a reader can
tell what was checked from what was assumed.

The problem it addresses: an agent's report is one stream of confident prose. A fact read out of a
file, a fact half-remembered from training, and a number nobody re-derived all read the same.
Labeling only the receipted ones separates them: the reader trusts a label and weighs the rest
themselves.

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install output-types@jo-wolff-plugins
```

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install output-types@jo-wolff-plugins
```

Inside a running OMP session, use `/marketplace add thewolff/jo-wolff-plugins` and then
`/marketplace install output-types@jo-wolff-plugins`. `/plugin install` inside OMP installs
nothing: it prints the installed-plugin list and returns.

**On OMP only the skill loads.** Tested on OMP 18.4.4: OMP does not run a plugin's
`hooks/hooks.json`, so the session-start hook never fires, the core is never injected, and the
Stop check never runs. The skill is listed and loads on demand, so the contract is in force only
once the model has read it. Name the skill in your instructions if you want it from the first
turn.

### What you get

- **Two labels**, each with the receipt that earns it, and the rule that a receipt rather than
  confidence sets the label.
- **Seven rules** that catch the most: third-party semantics are never vocabulary; a receipt
  licenses only what it literally shows; a figure reused in a new context is a new claim.
- **What unlabeled prose still owes**: actions state their command, result and undo; a decision
  for the reader goes last and restates its subject; a report that could not meet the contract
  says so at the top.
- The rules for **handing a command to a person to run**.
- A **session-start hook** that emits the operative core before the first tool call, reading it out
  of the contract file so there is only ever one copy of that text. Claude Code only; see *Install
  on OMP*.
- A **Stop check** that reads the finished message and warns, in one line to you, about every
  `**CLAIM**` or `**CITE**` that carries no receipt shape; optionally, a judge model asks whether
  each receipt licenses its sentence. Warns, never blocks; off switch and the judge's switch below.

Changes in 0.3.1: `lib/hook-runner.mjs` re-vendored from plugin-kit 0.3.1, so the Stop hook's
answer drains before the hook exits (bounded by the hook's deadline: 4 s, or 55 s with the judge
on) instead of being cut at one 64 KiB pipe buffer; the check itself is unchanged.

Changes in 0.3.0: the Stop check (next section). Mechanical, every turn: each `**CLAIM**` without
an absolute `file:line` or a command and its result, and each `**CITE**` without a URL or a test
run with its command, is named by line in one `systemMessage`, the first five, then `+N more`.
Never `decision: block`. A judge stage, off by default, runs when
`${XDG_CONFIG_HOME:-~/.config}/output-types/config.json` has `"judge": true` and a judge command
resolves. The judge dispatch is plugin-kit 0.3.0's `lib/judge.mjs`, vendored byte for byte, and
the command is configured once for every plugin with `node lib/judge.mjs setup`. New files:
`hooks/output-types-stop.mjs`, `lib/receipts.mjs`, `lib/judge.mjs`, `lib/hook-runner.mjs`.
`OUTPUT_TYPES_CHECK=off` turns the check off.

Changes in 0.2.2: the plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares
what the session-start hook can return (the core as a `systemMessage`, or silence under
`OUTPUT_TYPES_INJECT=off`), one `evals/<x>.scenario.json` proves each, and the core scenario
carries a `session` and a `judge` rubric the nightly canary runs under `claude -p` and grades
with `claude plugin eval`. `e2e/live-run.sh` hands off to plugin-kit's scenario runner.
`.claude-plugin/plugin.json` declares the one state path (`$XDG_STATE_HOME/output-types`, 30
days) and `scripts/prune.mjs` prunes it. The skill has a "When this can't run" section.

Changes in 0.2.1: a hook fault (contract file missing, unreadable or without its markers, or the
hook's own module failing to load or loading broken) now appends one line naming the hook file
and the reason to `${XDG_STATE_HOME:-~/.local/state}/output-types/errors.log`, and the one-line
warning reaches you as well as the model and says where the reason went. `OUTPUT_TYPES_INJECT=off`
is read first, so it silences the hook even when the install is broken. The hook no longer waits
on a stdin pipe its caller leaves open: it reads for at most one second, then injects.

Changes in 0.2.0: only receipted facts are labeled, as CLAIM or CITE. The GUESS, PMDW, ACTION and
QUESTION labels, the `<!-- output-types … -->` envelope and the numbered degradation tiers are
gone; unreceipted statements, actions, questions and degraded coverage are plain prose. The whole
contract now lives in `skills/output-types/reference.md`, which the skill points at and the hook
injects from.

### The Stop check

Every time the agent finishes a message, the hook reads it back (the payload's
`last_assistant_message`, else the last assistant text in the transcript Claude Code names in the
payload) and looks at each labelled statement. A label is `**CLAIM**` or `**CITE**` in markdown
bold that starts a line (after any list or `>` quote marker), or that is followed by a colon or
the end of its line; prose that mentions CLAIM casually is not a label, and nothing inside a
fenced code block is, at any indentation, so a quoted example never warns about itself. A bold
label inside a sentence ("The hook never blocks (**CLAIM**), …") is checked against that sentence
and the line after it, unless it is only mentioned: joined to another label by and, or, a comma
or a slash ("**CLAIM** and **CITE** are the two labels"), quoted or in code, or followed by a word
about it such as label, means, is or needs. For a label that starts a line or takes a colon, the
statement is the text after the label up to the next such label, a heading, a rule, a bold-only
line, or a blank line, except that a fence after a blank line (a command and its output, the
usual receipt) belongs to the statement, blank lines inside the fence included.

**The mechanical stage** is deterministic and runs every turn. A `**CLAIM**` needs an absolute
`/`-rooted `file:line` (or `file:line-line`; a relative or `~/` path is not one), or a command and
what it gave: a fence holding the command and what it printed (or a fenced command plus a result
phrase such as `exit 0`), or a command with `→ output` after it on the same line or opening the
next, where the command is a bare `$ cmd` at the line start or inline code that opens with `$ `
or has a space in it (`` `npm test` → exit 0, 12 passing ``). A symbol in code is not a command:
"`` `resolveJudgeCommand` returns null ``" and "`` `handle()` -> null ``" warn. A `**CITE**` needs
an `http(s)://` URL, or the words test/tested/ran/run with a command in code. A statement with
neither is named by line in one `systemMessage`, shown to you:

```
output-types: 2 labelled statements without a receipt that holds. Add the receipt or remove the label (unlabeled means unreceipted).
  line 3 **CLAIM** "the handler returns early.": needs an absolute file:line, or the command and its result
  line 5 **CITE** "the vendor caps it at 100.": needs the URL fetched, or the test run with its command
```

The first five are named, the rest counted (`+N more`). The shape is checked, not the content: a
path that does not exist still passes here. The check never blocks: a `decision: "block"` on Stop
re-prompts the model and contends with other Stop hooks, and the contract is yours to weigh.
Nothing labelled, no transcript, or `OUTPUT_TYPES_CHECK=off` → no output at all. The mechanical
path answers inside 4 s; past that the runner fails open with one line in `errors.log`.

**The judge stage** is off by default: a model call per statement adds seconds to every Stop.
Turn it on by writing `{ "judge": true }` to `${XDG_CONFIG_HOME:-~/.config}/output-types/config.json`,
and configure the judge command once, for this and every other plugin that judges, with
`node "<plugin dir>/lib/judge.mjs" setup` (it asks for the command, makes one test call, and
writes `~/.config/judge/config.json`). The command is resolved in this order, and a skipped.log
line names which source supplied it: `OUTPUT_TYPES_JUDGE_BIN` in the environment → `judgeCommand`
(and `judgeTimeoutMs`) in the output-types config file → the shared judge file → i-have-audhd's
`enforcement.judgeCommand` in `~/.claude/i-have-audhd.json`, read-only. A shared judge file that
is not valid JSON stops the search there (the i-have-audhd profile is not used in its place);
`node lib/judge.mjs which` names the file and the parse error. With the judge on, each
statement that passed the mechanical stage is put to it once: does the receipt license what the
sentence says. A `fail`, or an answer that is neither pass nor fail (marked unverified), joins
the same warning with the judge's reason when it gave one; a judge that times out, exits
non-zero, prints no JSON, or cannot start is one line in
`${XDG_STATE_HOME:-~/.local/state}/output-types/skipped.log` and the check goes on with the
mechanical result; so is a judge that is on with no command resolved, naming the malformed
shared file or the places it looked. Every call is clamped to what is left of the hook's 55 s budget (the Stop
entry in `hooks.json` has `timeout: 60`), counted from when the hook process started, before
it read its input, so a hanging judge is killed by its own timer, never by the host. Should the
hook's own deadline fire first anyway, the judge's process group is killed as the hook exits.

### What this does, and what it does not do: it delivers, and it warns

Three pieces, and it is worth knowing which does what before you install.

**The session-start hook puts the core in front of the model before the first tool call.** A
contract that governs every assertion cannot be delivered by a mechanism that fires in response to
an assertion, and the first assertion of a session is usually in the first turn. So the hook emits
the operative core at session start, and it is in force from turn one. It reads that text out of
`skills/output-types/reference.md`, between the markers, rather than carrying its own copy. There
is one copy of the core and it cannot drift from the contract.

**The skill points at the full contract and loads on demand**, matched against its description:
receipts, the seven rules, rendering, degraded reports, handed-over commands. Once read, the text
stays in context for the rest of the session.

**The Stop check reads what the agent sends back, and warns.** It catches one failure: a label
with no receipt shape, and with the judge on, a receipt that does not say what the sentence says.
It does not catch the other one: a fact left bare, with no label at all, is exactly what the
contract says an unreceipted statement should look like, and nothing here can tell a deliberate
omission from a forgotten receipt. So do not read an installed copy as a guarantee: a report that
comes back with every fact unlabeled comes back exactly that way. What you get is a contract the
model has read, held to the half of it that is checkable.

Two things help in practice. Name the skill in the delegation prompt for any agent you dispatch,
and say so in your own instructions if you want more than the core in force from the start.

If you want the injection off without uninstalling the plugin, set `OUTPUT_TYPES_INJECT=off` in the
environment; the hook then emits nothing and the skill still loads on demand.

If the core did not load, the session still starts and shows one line saying so. The reason is in
`${XDG_STATE_HOME:-~/.local/state}/output-types/errors.log`, one line per failure, or in the warning
itself when that log cannot be written. The Stop check's own faults go to the same file, as
`<iso> Stop <reason>`, with a `output-types Stop failed open: …` line to you; a judge it could not
use goes to `skipped.log` beside it.

### Developing output-types

The tests run with `node --test` from inside `plugins/output-types/`. `lib/judge.mjs` and
`lib/hook-runner.mjs` are plugin-kit's, copied byte for byte; change them there and copy again
(the kit's `test/judge.test.mjs` and this plugin's `test/manifest.test.mjs` both fail on drift).
A full changelog is in [`plugins/output-types/CHANGELOG.md`](plugins/output-types/CHANGELOG.md).

## i-have-audhd

How to write to someone who is ADHD and autistic. The two halves pull opposite ways — ADHD wants
short and new, autism wants complete and exact — and the rules resolve that by ordering, never by
cutting content: what the reader must know goes first, what they must choose goes last, and every
reference survives without scrolling.

Renamed from `communication-rules` in 1.0.0. Before uninstalling a configured old plugin,
follow the package README's [upgrade recipe](plugins/i-have-audhd/README.md#upgrading-from-communication-rules):
the opt-in tool preserves your private profile and disabled state without loader aliases.
Old logs stay archived; resume markers are not carried forward.

### Install

It needs `node`: Claude Code runs its hooks as `node <hook>.mjs` from your `PATH`, and the OMP
adapter runs them under node resolved to an absolute path (`I_HAVE_AUDHD_NODE` pins one).
Three steps:

1. **Add the marketplace and install.** Claude Code:

   ```
   /plugin marketplace add thewolff/jo-wolff-plugins
   /plugin install i-have-audhd@jo-wolff-plugins
   ```

   OMP, from a shell (inside a running OMP session the commands are `/marketplace add` and
   `/marketplace install` with the same arguments; `/plugin install` inside OMP installs
   nothing):

   ```
   omp plugin marketplace add thewolff/jo-wolff-plugins
   omp plugin install i-have-audhd@jo-wolff-plugins
   ```

2. **Choose a judge.** Five of the thirteen Stop-hook checks (`do-not-batch-by-label`,
   `conclusion-first`, `restate-resumed-thread`, `report-what-you-did-not-do`,
   `bad-news-first`) need a model to read the message, and they stay off until a judge command
   is configured. Since 1.7.0 that is the shared judge every judging plugin reads,
   `~/.config/judge/config.json`; write it once from the marketplace copy you just added:

   ```
   node ~/.claude/plugins/marketplaces/jo-wolff-plugins/plugins/i-have-audhd/lib/judge.mjs setup
   ```

   On OMP the same file is at
   `~/.omp/plugins/cache/marketplaces/jo-wolff-plugins/plugins/i-have-audhd/lib/judge.mjs`
   (any plugin's vendored copy writes the same file). It asks for the command, makes one test
   call, shows the JSON it will write, and writes after you type `yes`. To give i-have-audhd a
   judge of its own that wins over the shared file, or to choose none, run
   `node <same directory>/tools/setup.mjs` instead: it lists the judges (the Claude Code CLI,
   the Codex CLI, OMP, a command you type, or none of its own), tests the pick, and writes
   `enforcement.judgeCommand` in `~/.claude/i-have-audhd.json`, the one profile both hosts
   read, only after a `yes`. Run either again any time to change the choice.

3. **Start a new session.** If you skipped step 2, the first session shows a one-time notice
   naming the five checks that are off, both files, and both setup commands.

OMP does not run a plugin's `hooks/hooks.json`. The install registers the plugin's OMP extension,
`omp/i-have-audhd-omp.ts` (registered on omp 18.8.6), which runs the same two hooks, the
session-start injection and the Stop check, for the main session only, not for subagents; OMP has
no blocking equivalent of Claude Code's `SubagentStop`. `omp/REGISTRATION.md` carries the manual
fallback and an isolated live probe.

### What you get

- **The skill**: eleven rules, each with its reasons and sources in `references/`.
- **A session-start injection** of the skill's first-turn core — the message skeleton, the
  options rule, reference survival, commands, and three machinery anchors — plus every rule
  heading, read out of `skills/i-have-audhd/SKILL.md` between its markers so there is one copy.
- **A Stop hook** that checks every finished message with eleven checks (six deterministic, five
  judge-gated) and names the skill rule behind each finding.
- **A prompt hook** that delivers the last checked message's warn findings to the agent with
  your next prompt, once, as a short notice carrying the fix.
- **An optional operator profile** you write on your own machine, so the rules can name a real
  addressee and adapt to how that person reads. The repository ships only a generic example
  (`example.i-have-audhd.json`). **Keep your profile out of version control if it describes a
  real person.**

### What this does, and what it does not do: it warns, it does not block

Every check warns by default: findings land in `~/.claude/.i-have-audhd-state/warnings.log`, the
turn ends normally, and the agent gets the findings with your next prompt so the fix applies from
its next message on. A 2026-09-21 corpus adjudication found no check whose false-positive rate
supports blocking by default, so block is a deliberate profile setting, per check or global; on
OMP it also needs `enforcement.armOmp: true`. The five judge-gated checks stay inactive until you
choose a judge (install step 2), and each fired trigger is logged to `skipped.log`.

`touch ~/.claude/.i-have-audhd-off` disables the Stop hook within one turn.
`I_HAVE_AUDHD_INJECT=off` turns the injection off; the skill still loads on demand. The package
README and `skills/i-have-audhd/reference.md` carry the schema, every check's contract, and the
measured rates.

Changes in 1.7.0: the judge command is plugin-kit's shared judge. `lib/judge.mjs` is vendored
byte for byte and resolves the command in the kit's order, the profile's
`enforcement.judgeCommand` first, else `~/.config/judge/config.json`, so one
`node lib/judge.mjs setup` configures this plugin with every other that judges; an existing
profile with `judgeCommand` keeps working unchanged, and `null` there means no override.
`judge/ask.mjs` keeps the prompt, the verdict shape, the cache, the harness budget and the
`cause=` failure line; that line now carries the kit's error kinds, a `detail=` and the
`source=` the command came from. `tools/setup.mjs` writes the override only, and the
session-start notice names both files. Eval `stop-judge-shared-config` replays the real-judge
capture with the command in the shared file.

Changes in 1.6.1: `links-resolve` warns when a link in the message does not open: a local path
in backticks that does not exist, a GitHub URL with no such page shape, a sentence that calls an
issue a PR, or (from a local cache a detached helper fills, never a live call) a target GitHub
says is missing or is the other kind. A sentence that says the file is still to come is not
checked. `links-judge`, off by default, asks the judge whether the linked thing is what the
sentence says it is. Every judge failure line now names its cause (revoked credential, no
credential, rate limit, judge self-abort, hook deadline, bad JSON, other), with session,
harness, model, timing, section and a replayable prompt file; the notice states the cause and
its fix.

Changes in 1.6.0: two new checks. `handed-command` warns when a message hands you a shell command
that is not one `zsh /absolute/path/script.sh` line with its script in a scratch directory
(`~/agent-scratch` by default) outside every git checkout (rule 10); commands quoted as evidence do not
count. `link-the-reference` warns when a line names a PR, an issue or a file with no link to it on
the same line (rule 11); receipts, fenced code and `→` evidence lines never count. A new profile
field, `inject`, switches the session-start rules and the Stop checks independently (`full`,
`rules` or `none`) and, in its object form, switches each of the eleven rules on or off: a rule
switched off leaves the injection, and the checks bound to it go quiet. The package README's
*What you can turn on and off* lists every switch with its default. The kill-switch file still
wins over every value.

Changes in 1.5.2: the plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares
what each of the three hooks can return and seven `evals/<x>.scenario.json` prove them
(injection on and off, the pending-warning relay and the quiet prompt, the Stop hook's default
warn, its plural block, and the judge-gated warning replayed from the captured real-judge
output); `e2e/live-run.sh` hands off to plugin-kit's scenario runner. The three state paths are
declared (`~/.claude/.i-have-audhd-state`, 30 days, pruned by `scripts/prune.mjs`; the profile
and the off file kept by design) and the skill has a "When this can't run" section. Fix: the
Stop hook and the four check scripts compared `import.meta.url` with `file://${process.argv[1]}`
as strings, and node resolves the main module through symlinks, so reached through one (macOS's
`/var/folders` tmpdir, where `ledger gate check` snapshots the plugin) the Stop hook never ran
and exited 0 with nothing printed and nothing logged; the guards now compare real paths.

Changes in 1.5.1: a hook's own fault is no longer silent. Empty or malformed stdin, a throw, an
unparseable profile, or a state file that cannot be written leaves one line in `errors.log` and
one warning line; the hook still exits 0 and blocks nothing. Every block reason now ends with the
way out: `touch ~/.claude/.i-have-audhd-off`, or the check's `enforcement.rules` key set to
`"warn"`.

## paired-coding

A plugin for pairing with an agent on code, one change set at a time. The agent drives and you
navigate. Before each change set it shows you a **card** naming the decision inside the change,
the code it touches, the code it plans to write, the effect it will have and the exact files it
will write. It writes only after the two of you agree on that card, then shows you the real diff.

The problem it addresses: agent code arrives faster than a person can recognise the decisions
inside it, so a wrong direction is found after a whole feature exists. Pairing moves the
decision point to before each change set is written, while it is still cheap to steer.

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install paired-coding@jo-wolff-plugins
```

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install paired-coding@jo-wolff-plugins
```

Inside a running OMP session, use `/marketplace add thewolff/jo-wolff-plugins` and then
`/marketplace install paired-coding@jo-wolff-plugins`. `/plugin install` inside OMP installs
nothing: it prints the installed-plugin list and returns.

Tested on OMP 18.4.4, the install registers the gate as an OMP extension: the eight `pair_*`
tools appear natively in every omp process you run, in any repository, with no `-e`. It stays
inert until `pair_start`, so a session that never pairs is untouched. The bundled MCP server is
built for Claude Code and is hidden on OMP. `omp plugin upgrade` keeps the gate registered, and
`omp --no-extensions` starts a process without it. To remove it, run
`omp plugin uninstall paired-coding@jo-wolff-plugins`.
`plugins/paired-coding/omp/REGISTRATION.md` also has the routes that load the gate without
installing the plugin.

### What you get

- **A skill** that runs the session: define the work, recon into a roadmap of cards, then a
  loop of card, discussion, agreement, the change set, and a read-back with the diff.
- **A roadmap you can leave and come back to.** Cards can be marked not ready, and a later
  session in the same worktree offers to pick up the unfinished ones; you can decline.
- **A gate at the tool boundary** on Claude Code (hooks plus a bundled MCP server) and on OMP
  (an extension). While pairing, the host's own write, edit, shell, eval and sub-agent tools are
  refused; the agent writes and runs commands only through the plugin's `pair_*` tools, and
  its own writes land only in the agreed change set's files, temp directories and the state of
  the ledger and pattern-check plugins (see **Changes in 1.4.3**). Every run sits under a
  sandbox (Seatbelt on macOS, Landlock or bubblewrap on Linux) that fences the files the run
  writes itself and its local Unix-socket connections, not the network, so a run can still
  ask a process outside the sandbox to write for it.
- **A journal** of every card, quote, verdict, refusal and diff, kept outside the worktree.
- **A stop only you can give:** pairing ends when you type `pair stop` as a message of its own.

Changes in 1.6.0: the card's `why` and `sources` draw on what the session already found. A
`why` that claims a codebase pattern (`pattern used in`, `the rest of the codebase`,
`convention here`, `how the codebase does`, `existing pattern`, `follows the pattern`, `the
pattern in`) needs a pattern source, in any mode: one absolute `file:line` inside
`<git root>/.pattern-check/` (pattern-check's receipt) or two inside the repository, else
`pair_propose` refuses naming the receipt path it looked for and both counts. A new optional
card field `alternatives` (`[{ design, chosen }]`, exactly one chosen) is required when
ask-graham's findings file for the session is on disk, and then has to carry the findings'
chosen design and, when they weighed another, a non-chosen entry; the card lists them with the
chosen one marked. Both checks read sibling plugins' files only, neither plugin has to be
installed, and a missing file never refuses. See the plugin README, *A pattern claim needs a
pattern source*.

Changes in 1.5.0: learning mode, off by default. Type `learning mode on` or `teach me as we go`
while pairing and each card's decision line adds **Why this approach** with **Sources** (a URL
fetched this session with its passage, an absolute `file:line`, or a `from memory` mark); "teach
me more" keeps the card closed and is answered one sourced layer at a time with a recall
question, and each read-back asks one recall question. `learning mode off` turns it off. The
gate enforces it: a new `pair_learn` tool switches it, and refuses to switch it off unless your
latest typed turn says `learning mode off`; while it is on, `pair_propose` refuses a card without
`why` and `sources`, `pair_done` refuses without `recall`, and the Stop hook (Claude Code) and
`session_stop` handler (OMP) warn, never block, when a turn closed a change set without a
`Recall:` line. With it off, the 1.4.4 flow is unchanged. See the plugin README, *Learning mode*.

Changes in 1.4.4: the plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares
what each of the five hooks can return and nine `evals/<x>.scenario.json` prove them (the
write denied and the inert hook at PreToolUse, the pairing-on and stop-queued prompts, the
fresh and carried-over session start, the session end leaving its carry, the Stop hook judging
a queued turn; scenarios that need pairing on run `evals/pair-start.mjs`, the same `pair_start`
verb the MCP server exposes), with the typed-agreement path and `pair stop` listed under
`manual`; `e2e/live-run.sh` hands off to plugin-kit's scenario runner. Every refusal now ends
with the standing way out: pairing ends when your partner types `pair stop` as a whole message.
The journal directory (`~/.local/state/paired-coding`, 30 days, pruned by `scripts/prune.mjs`)
and the per-run temp directories are declared as state, and the skill has a "When this can't
run" section.

### What this enforces, and what it does not

**It enforces the write boundary, not your agreement.** The agent judges when you have agreed
and quotes your words to open a change set. The gate checks that the quote is whole words from
a turn you typed after the card, that the card has no open points and that its files have not
changed since you saw it. It cannot check that those words meant yes. A misread go-ahead can
open a change set, but only for that card's files, and the quote sits in the journal for you to
audit.

**It runs on macOS and Linux, on two hosts.** The gate is built for Claude Code and OMP and was
tested live on both, on macOS. On Linux it uses Landlock, through a small helper the plugin
ships, when the kernel has Landlock ABI 3 or later, and bubblewrap otherwise. Landlock fences
writes per file, except that new files under a glob entry are fenced per directory; bubblewrap
fences some writes per directory and needs unprivileged user namespaces. The Linux sandboxes
were tested in an Ubuntu container, and neither host has been run live on Linux. Codex is
unverified. Elsewhere the skill runs as conversation and nothing at the tool boundary stops a
write.

**Some of it rests on undocumented host fields, and fails closed.** On Claude Code, "you typed
it" is read from transcript fields Claude Code does not document. If they change, every turn
reads as untrusted and pairing can never open a change set; it does not open one by mistake.

**The sandbox fences a run's own writes, not the network.** Local services over TCP stay
reachable from a run, `sshd` on `127.0.0.1` included, and `open`, `osascript` and Apple Events
are not blocked, so a run can ask a process outside the sandbox to write for it.

**A process that escapes the sandbox is caught late.** It is caught at the next read-back, and
only if it writes inside the worktree.

The plugin's own README carries the full list, with the evidence behind each line.

Changes in 1.4.3: the ledger and pattern-check plugins keep working while pairing is on. Each
ends a reply with a Stop hook that demands its CLI run (`ledger.mjs ask`, `pattern-check.mjs
record`); with the host shell refused and `pair_run` fencing every write outside the agreement,
those runs failed (`EPERM` on `<worktree>/.pattern-check/`, "database read-only" on the
ledger's SQLite file) and the reply could neither finish nor be let go. Now `pair_run` may
write that state in both phases, boundary or no boundary, under every sandbox: the ledger's
database with its `-wal` and `-shm` sidecars at `~/.agent-system-2/ledger.db`, at the ledger's
default `~/.local/share/ledger/ledger.db`, and wherever `LEDGER_DB`, the ledger's config file
or the nearest `.ledger.json` points it; `<worktree>/.pattern-check/`; and
`~/.local/state/ledger/` and `~/.local/state/pattern-check/`. One list (`lib/sibling-state.mjs`)
feeds the Seatbelt profile, the bubblewrap binds and the Landlock rules, so the three grant the
same paths. A carve-out never reaches the worktree root, `.git`, the state directory or a
protected path, is dropped when it sits above one of them, and before every run the tree
under a carve-out directory is looked at on every backend, every entry of it, within a budget
(a hard-linked file, an entry that cannot be read, a `.git` entry, a mount point there, or a
tree too large to finish looking at refuses the run by name); snapshots leave
`.pattern-check/` out, so a receipt written there is not drift at `pair_done`. While pairing,
ledger and pattern-check calls go through `pair_run`: the host shell stays refused for every
command (the host runs it outside the fence, with its own environment), and the refusal for
a sibling call says to run the same command with `pair_run`, where the kernel decides where
its writes land. Before launching one, `pair_run` refuses by name a call whose shape no hook
demands (anything but `node <script> <subcommand> …` with the script `ledger.mjs` or
`pattern-check.mjs`, spelled plainly, existing and resolving inside
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
`NODE_COMPILE_CACHE`, on every host, through one function. The plugin README's gate section
has the full table and the Linux limits (a grant there needs an existing inode). Also in
1.4.3: on Claude Code, `SessionEnd` removes the state directory of a session that never
called `pair_start` (it held only queued typed input and stashed notices), under the session
lock and after a second look for the activation marker, so a `pair_start` landing as the
session ends is kept, and the lock is released only by its holder (a token file named by
the holder's pid inside the lock, removed before the lock directory, which the kernel keeps
while anything else is inside; a release that cannot remove its token fails instead of
reporting success), so no release lets go of another holder's lock. A lock is taken over
only when the pid its token names is not running and the lock is stale, by removing that
one token by name; a lock whose holder is still running is never evicted on its age, and
the wait fails naming the pid and the recovery command, `node <plugin>/bin/pair.mjs unlock
--stale <lock directory>`, which makes the same check. That command acts only on
paired-coding's own lock directories inside the state base (any other path, or a symlink
out of it, exits 2 untouched); its refusal of a running pid explains pid reuse and never
advises ending a process, and `--force` clears a reused pid's lock only when that pid's
command line names neither `paired-coding` nor `pair-server`. A token naming the waiting
process itself is reported as a non-reentrant lock attempt. A release failure the locked
work's error cannot carry (a frozen error) goes to `errors.log`, and the work's error is
thrown unchanged. A session that paired keeps its
directory, journal and receipt included, and a directory that will not go is one warning
and one `errors.log` line, never a failed end.

Changes in 1.4.2: a fault in any hook appends one line to `errors.log` in the plugin's state
directory and shows one warning, and never blocks a session that is not pairing. While pairing,
for `pair_*` tools, or when the gate cannot tell whether pairing is on, the tool is still refused,
and the refusal names the tool and the way out (`pair stop`, or disabling the plugin). The OMP
adapter's `tool_call` handles these faults the same way.

Changes in 1.4.1: a prompt typed in the Claude Desktop app counts as typed. Any other
programmatic prompt is still refused as untrusted.

Changes in 1.4.0: every card shows the planned code before you agree, unprompted, and
`pair_propose` takes it as a `proposedCode` field on both hosts.

## ask-graham

A skill that answers "should we build X?" the way Graham, a frontend engineer, says he decides:
five gate questions, a short list of red flags, the 2-minute rule from GTD, and fewer lines wins.
It ends in exactly one verdict: **do it now**, **start now**, **later**, or **don't build**,
with a breakdown scaled to the size of the work.

Every check asks "Do you want me to research and see if something comparable exists?"
No keeps the search local; yes adds open-source and commercial options, screened by gates
then ranked with pros, cons, and dated, sourced stats; stars, age, forks, and followers stay context only.

The problem it addresses: an agent asked "can we build X?" hears "build X". It does not stop to
ask why, whether something already does it, or who will maintain it, so the backlog fills with
things that were cheap to start and expensive to keep.

Graham agreed to be named and quoted: "100%. Nothing would make me happier." His answers are in
the plugin, verbatim, typos included.

The package README is [`plugins/ask-graham/README.md`](plugins/ask-graham/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ask-graham@jo-wolff-plugins
```

Then ask "should we build X?", or type `/ask-graham <the thing to build>` on Claude Code or
`/skill:ask-graham <the thing to build>` on OMP. To have it run on every new idea as well, see
*When it runs* below.

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install ask-graham@jo-wolff-plugins
```

Inside a running OMP session, use `/marketplace add thewolff/jo-wolff-plugins` and then
`/marketplace install ask-graham@jo-wolff-plugins`. `/plugin install` inside OMP installs
nothing: it prints the installed-plugin list and returns.

Tested on OMP 18.8.6, the install lists the skill and registers the prompt nudge as an OMP
extension (`omp/ask-graham-omp.ts`, declared in the plugin's `package.json`): with the level at
`every-idea`, the nudge reached the model request ahead of the message, and with a repo file at
`ask` it did not. A Claude Code install alone does not give OMP the nudge; install on OMP too.

### What you get

- **Graham's five gate questions**, answered from evidence (the repo, its issue tracker, its
  backlog files) rather than put back to you. Apart from the comparables question, you are asked only what
  no tool can settle: who will own it, or which reason matters to you.
- **A search for what already exists** before anything else, delegated to a subagent when it
  spans repos.
- **Graham's red flags** for technical asks: an enum invented for a platform you do not control,
  a JSON round-trip, JSON built by hand, and a homegrown type system where an established one
  exists.
- **One verdict**, then a breakdown only as deep as the work needs: High Level Design, epics,
  stories, tasks of hours to a few days, each with acceptance criteria and no prescribed code.
- **Every rule tagged with its source**: *Graham #N* for his words, *Jo* for the author's
  overrides, *Skill* for mechanics the skill adds. The skill never presents its own mechanics as
  Graham's view.
- **A structure check** for tasks inside a decided project: before one writes a new table, a new
  column on an existing table, a new top-level module or a new service, the skill searches what
  else hangs off the same parent and reports what it found, or plainly that it found nothing
  similar. It gives no verdict and does not ask the comparables question.
- **A level you set**, `ask` or `every-idea`, for how eagerly it runs (next section).

Changes in 0.8.1: the Claude Code Stop hook records each reply that carries a `**Verdict:**` or
`**Structure check:**` line in `${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/findings/<session id>.json`
(the ask, the verdict, the verdict line's one-line why as the chosen design and the
`**Alternative:**` design, the `**Found:**` items), one file per session, overwritten at each such
stop and pruned after 30 days, so other plugins can read what the check decided; consumers apply a
file to the first decision after its `writtenAt`. A write that fails is one `errors.log` line,
never a blocked turn.

Changes in 0.8.0: the reply shows the better design beside the pattern-fit one. Step 4's
second-pattern flag still makes the design use the repo's pattern or say why it cannot; when a
design beats the pattern-fit one on a stated axis (fewer moving parts, removes a known failure
mode, closes a gap the pattern leaves, or is what the repo would adopt if starting today) the
reply shows it too, with what it costs over the pattern. The completed-check template gains an
`**Alternative:**` line after `**Red flags:**` (the better design, its axis and its cost, or
`none: <what was weighed>`); fewer lines still picks the default and never drops the
alternative. Two live scenarios prove the two shapes; the Stop check is unchanged. (Jo, 2026-11-04)

Changes in 0.7.3: a reply that waits on the comparables question must also carry step 1's
`**Ask:**` line and step 3's five `**Gate questions**` bullets; the Stop check blocks it once
otherwise, naming what is missing, so the question can no longer stand in for the judgment.

Changes in 0.7.2: the plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares
what the two hooks can return and four `evals/<x>.scenario.json` prove them (the every-idea
nudge and the quiet prompt at `ask`; the Stop check blocking a reply with no verdict, with a
`session` and a `judge` rubric the nightly canary runs under `claude -p` and grades with
`claude plugin eval`, and letting one with a verdict through); `e2e/live-run.sh` hands off to
plugin-kit's scenario runner. The state directory (`$XDG_STATE_HOME/ask-graham`, 30 days) is
declared and `scripts/prune.mjs` prunes it; the skill has a "When this can't run" section.
Fix: `scripts/upkeep.mjs` compared `import.meta.url` with `file://${process.argv[1]}` as
strings, and node resolves the main module through symlinks, so reached through one it did
nothing and exited 0; the guard now compares real paths.

Changes in 0.7.1: the Stop check reads the reply from the Stop payload's
`last_assistant_message`, and no longer takes Claude Code's telemetry entries as the newest entry
of the conversation, which had let a reply with no verdict through and blocked one that had a
verdict. An unreadable block record now lets the stop through. The Claude Code hooks no longer
fail silently: a fault still lets the prompt or stop through, and now lands in `errors.log` with
the hook file and reason and shows one warning line.

Changes in 0.7.0: adds the structure check. Its reply opens with `**Structure check:**` and then a
`**Found:**` or `**No similar:**` line, which the Stop check requires in place of a verdict line.
The every-idea nudge names the structure check.

### When it runs

Two levels:

- **`ask`**, the default. The skill runs on `/ask-graham` or an explicit "should we build
  this?" / "is it worth building?". Its description is written so nothing else matches.
- **`every-idea`**. It also runs whenever you propose a new project, product, feature or tool
  that does not exist yet. A hook adds one short line to each of your messages telling the agent
  to run the check if the message is a new idea, to run the structure check if it is a task that
  creates a new table, column, top-level module or service, and to ignore the line otherwise. On
  Claude Code that is a `UserPromptSubmit` hook; on OMP an extension on the `before_agent_start`
  event. At `ask` neither adds anything.

At both levels it does not run on a ticket or issue, a bug fix, a task inside an
already-decided project (apart from the structure check above), or a request to continue
existing work. Deciding which messages are new ideas is left to the agent: the hook does not
classify anything, so a ticket can still draw a check if the agent misreads it.

The level comes from the first of these that exists:

1. the nearest `.ask-graham` in the working directory or any directory above it, so one file
   at a workspace root covers every repository and worktree under it;
2. `${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/config`;
3. the default, `ask`.

Each file holds `intensity=ask` or `intensity=every-idea`. A file that names neither counts as
`ask`, so a typo in a file meant to turn the level down cannot turn it up. The same files take a
second line, `stop-check=off`, to turn off the Stop check that blocks once when an answer that
read the skill has no `**Verdict:**` line (default `on`). A reply ending with the exact
comparables question alone on its final line may wait for an answer without a verdict, when a
`**Ask:**` line and the five `**Gate questions**` bullets come before it. To change either from a session (on
OMP, write `/skill:ask-graham` in place of `/ask-graham`):

```
/ask-graham intensity                    # show both settings and which file set each
/ask-graham intensity every-idea         # set your level
/ask-graham intensity ask --here         # override it for this repository
/ask-graham stop-check off               # turn the Stop check off for you
/ask-graham stop-check off --here        # turn it off for this repository only
```

Without a session, run the script directly with the same arguments:
`node <plugin dir>/skills/ask-graham/scripts/intensity.mjs [every-idea|ask | stop-check on|off] [--here]`.

A `.ask-graham` written with `--here` sits untracked in the repository's root. Add it to
`.git/info/exclude` if you do not want to commit it.

### Where Jo overrides Graham

Graham listed type systems as something he would kill or defer. The skill does not follow him
there: using types is never counted against an ask. Building your own type system when an
established one exists is a red flag, and that flag is Jo's, not Graham's.

### Your own open-work sources

Open work does not all live in the repo. List the other places on your machine in
`${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/sources.md`, one bullet per source with the
read-only command or path to check:

```markdown
- **Prior sessions:** `my-history-tool search --limit 5 -- "<the ask>"`
- **Open work items:** `sqlite3 -readonly ~/work/tracker.db "SELECT id, title FROM items WHERE status='open';"`
- **Decisions waiting on me:** `~/notes/HELD.md`
```

The file is optional; without it the skill checks the repo, its issue tracker, and any backlog
file the project's `AGENTS.md` or `CLAUDE.md` names. Keep it out of version control: it
describes your machine. Every source in it is read-only to the skill.

### Developing ask-graham

The tests run with `node --test` from inside `plugins/ask-graham/`. Uninstall, update, and the
rest of the details are in the package README.

## pattern-check

Before an agent does big work in a repository, it has to look for the repository's existing way
of doing each thing it is about to add, decide reuse, replace, or new-with-reason for each, and
write that down. A PreToolUse hook holds the work until it has: from the Nth distinct file a
session writes (3 by default), it denies further writes, `git commit` and `gh pr create` until
the session has a receipt.

The receipt is a table with one row per new piece and ten columns. The first four answer "what
exists already": `new piece`, `existing pattern (file:line)`, `reuse / replace / new`, `reason`.
The fifth, `better design`, answers "what would beat the pattern": `none: <what was weighed>`, or the design that
beats the pattern-fit one on a stated axis with what it costs over the pattern. The last five
answer "how does it fail", before the piece is written: `fails how`, `next step`,
`restart-safe`, `bounded`, `evidence kept`. The script refuses a row whose `better design` cell
is missing, empty, a bare `none` or a placeholder, and a row whose fail cells are empty, a placeholder (`-`,
`?`, `TBD`, `todo`, `unknown`), or `n/a` without a reason, and names the row and column it
refused.

The problem it addresses: a design review that asks "where did this introduce a new pattern when
an existing one served?" keeps coming back with a long list. Agents start writing before they
have read what is already there. This plugin makes the reading mandatory and the result
inspectable. The package README is
[`plugins/pattern-check/README.md`](plugins/pattern-check/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install pattern-check@jo-wolff-plugins
```

Node 18 or later is needed on `PATH`.

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install pattern-check@jo-wolff-plugins
```

Inside a running OMP session, use `/marketplace add thewolff/jo-wolff-plugins` and then
`/marketplace install pattern-check@jo-wolff-plugins`.

### What you get

- **The skill**: the method. List every new piece, grep the repository for its nouns and verbs,
  read what sits beside it in the same router, registry or directory, and end each piece as
  `reuse`, `replace` or `new` with a reason, a `better design` cell, plus the five fail columns.
- **The script** (`scripts/pattern-check.mjs`): `open`, `record` and `status`. The receipt is
  Markdown at `<repo>/.pattern-check/<session>.md`. When the work adds no new piece,
  `record --no-new-pieces "<why>"` writes a one-line receipt.
- **A PreToolUse hook** that counts the distinct files a session touches through Edit, Write,
  MultiEdit, NotebookEdit and the obvious shell writes, and from the Nth file on denies those
  tools, `git commit`, `gh pr create`, redirects, `sed -i` and `tee` into the repository until
  the receipt exists. The deny text names the exact command to run.
- **A Stop hook** that refuses, once, a reply proposing a plan or design when the session has no
  receipt.
- **Configuration** in an optional user or repository JSON file: the threshold, extra commands
  to deny, the receipt directory, and each hook on or off.

### What this enforces, and what it does not

**It gates writes in the session, not the truth of the receipt.** The hooks check only that a
receipt exists for the session. They do not check that the pattern it names is the right one,
and they do not check that a `--no-new-pieces` receipt is true: an agent that records "no new
pieces" and then adds several is let through.

**The shell matchers catch the obvious write forms only.** `cp`, `mv`, `python -c`, a script
that writes from inside, and a write inside `eval` or `sh -c` are neither counted nor denied.
`git commit` and `gh pr create` are the backstop once a session is held, but a session that
writes everything through uncaught forms never reaches the threshold.

**The Stop hook's plan test is a fixed list of signals** (plan or design headings, openers such
as "Here's the plan"). A plan written without those shapes is not refused.

Both hooks fail open on the plugin's own faults: the call goes through, one warning is shown,
and the reason is appended to `errors.log` in the plugin's state directory.

Changes in 0.3.0: the receipt gains the five fail columns, and `record` refuses a row whose fail
cells are empty, placeholders, or `n/a` without a reason; four-column receipts already written
still count. The deny and Stop refusal texts ask both questions: what exists already, and how
does it fail. Bash write forms are read through a shell lexer, fixing two real commands the
redirect matcher miscounted. Hook faults are appended to `errors.log` as well as shown,
`hooks.json` sets a 5 s timeout, and NotebookEdit is counted.

Changes in 0.4.0: the receipt gains a `better design` column after `reason`: `none: <what was
weighed>` (a bare `none` is refused), or the design that beats the pattern-fit one on a stated axis with what it costs
over the pattern; pattern fit stays the default and the better design is shown beside it.
`record` refuses a row whose cell is missing (a nine-column 0.3 row), empty or a placeholder,
naming the row and column; receipts already on disk still lift the hold. ask-graham 0.8.0's
`**Alternative:**` line carries the cell. Two scenarios prove the accept and the refusal.
(Jo, 2026-11-04)

Changes in 0.3.2: the plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares
what the three hooks can return and eight `evals/<x>.scenario.json` prove them (under the
threshold, the third file held, with a `session` and a `judge` rubric the nightly canary runs
under `claude -p` and grades with `claude plugin eval`, the receipt lifting the hold, a corrupt
config warning and letting the call through; a plan refused without a receipt, passed with one,
a report passing; SessionEnd cleaning its files); `e2e/live-run.sh` hands off to plugin-kit's
scenario runner. `pattern-check prune [--days 30]` removes receipt copies, stop guards and
session files older than that (errors.log and `current/` stay) and prints the bytes freed; the
state directory, the config file and the repository's `.pattern-check/` are declared as state.
The skill's "When this can't run" section names the scenarios.

Changes in 0.2.0: an OMP adapter (`omp/pattern-check-omp.ts`) runs the PreToolUse counter on
OMP's `tool_call` and the Stop refusal on `session_stop`, through the hooks' own functions and
state.

### Developing pattern-check

The tests run with `node --test` from inside `plugins/pattern-check/`.

## reminders-review

Go through the open reminders on your chosen Apple Reminders lists with the agent, one at a time.
A question gets a ready answer. An instruction gets the agent's reading of it and its plan, and
nothing happens until you say yes to both. A note gets a suggested next step. Anything unclear
gets a question. Before moving on, the agent asks "Can I close this one?" and marks the reminder
complete only on a yes. It never deletes reminders.

Needs macOS and [remindctl](https://github.com/openclaw/remindctl)
(`brew install steipete/tap/remindctl`). [rem](https://github.com/BRO3886/rem) is optional: with
it installed the agent also reads the link field you see in Reminders.app, which remindctl cannot
see. Run `/reminders-review` with list names, or save defaults with
`/reminders-review lists <name> ...`. Details are in `plugins/reminders-review/README.md`.

Changes in 0.2.1: `lib/hook-runner.mjs` re-vendored from plugin-kit 0.3.1, the kit's runner with
this plugin's stdout drain; the due-reminders block is unchanged.

Changes in 0.2.0: due and overdue reminders from the lists you watch (`watch` in the config file,
or `REMINDERS_REVIEW_WATCH`) come up at session start and at most hourly after, on Claude Code and
OMP. The skill has a "When this can't run" section (`remindctl` missing or not authorized, `rem`
missing, a list name matching nothing, one `complete` failing, not macOS), and
`.claude-plugin/plugin.json` declares the state directory and its prune command. ledger 0.3.5's
five-row gate passes on it.

Changes in 0.1.2: reads the Reminders.app link field with `rem show` when rem is installed, and
gives its install line once when it is missing. remindctl stays the source for everything else,
and `remindctl complete` is still the only write.

Changes in 0.1.1: shows each reminder's notes and URL. When a reminder has neither, the agent
says in one line that a Reminders.app link may not have reached it and asks you to paste it,
instead of working from the title alone.

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install reminders-review@jo-wolff-plugins
```

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install reminders-review@jo-wolff-plugins
```

## ledger

A durable, id'd record of the questions an agent asks you (one-word answers, an optional spend
ceiling) and the notes it records when it decides without asking, in one SQLite file on your
machine. The agent asks in plain words and records your plain-words reply against the
question's row itself; ids stay on the agent's side. Hooks inject the open questions and recent
notes at session start, deny the AskUserQuestion tool until the question has a row, deny
`git push` and `gh pr create` until the session has a note or an outcome saying why, and send
back once a reply that ends without recording an answer you gave, asks with no row, or states a
decision without a note. Every hook fails open.

The hooks record every session until you switch a folder off with `/ledger:disable`
(`/ledger:enable` turns it back on). The plugin's tables are all prefixed `cc_`, so the database
can be a SQLite file another tool already uses.

Changes in 0.3.7 (with plugin-kit 0.3.2): `lib/judge.mjs` is plugin-kit's shared judge dispatch,
copied byte for byte, and ledger's cache and verdicts live in `lib/ledger-judge.mjs`. The review
judge is `LEDGER_JUDGE_BIN`, else `review.judgeCommand`, else the shared judge file
`${XDG_CONFIG_HOME:-~/.config}/judge/config.json` (new), else the i-have-audhd profile; verdicts
and the cache are unchanged, and `judge could not start:` is now followed by the error code.
Ledger's diff judge never runs shorter than 60 s; a longer shared `timeoutMs` is honoured. A
judge printing a `claude -p --output-format json` envelope is read through it. Desktop fixes: the
skill is renamed `record` (`/ledger:record`), so `/ledger` opens the pane instead of running the
skill; the pane's end-of-turn line no longer repeats Claude's reply; the pane logs one
`ledger pane: surface=… placed=…` line per session; `doctor` drops `config …: … ignoring it`
errors.log lines whose notice no longer reproduces (`n stale config notice(s) ignored`).

Changes in 0.3.6 (with plugin-kit 0.2.2): the gate grows from five rows to six. `docs` (a
release is written down): when a plugin's `.claude-plugin/plugin.json` version differs from the
base commit's, its `CHANGELOG.md` has an entry for the new version, its README has a release
heading for it (`## Changes in <ver>`, `### <ver>` or `### <date> — <ver>`), and this README
names the version for the plugin (in its bullet, on a `Changes in <plugin> <ver>` line, or on a
`Changes in <ver>` line under the plugin's section). The row is skipped while the version is
unchanged, each failure names the file and the heading it wanted, and the base manifest and
this README are read out of the commits like every other input. `plugins/ledger/CHANGELOG.md`
exists from this version on.

Changes in 0.3.5 (with plugin-kit 0.2.0): the gate grows from three rows to five. `evals`
(behaviour is proved): `evals/manifest.json` declares, for every event `hooks.json` registers,
the outcomes the handler can return; one `evals/<x>.scenario.json` per event × outcome, with a
real stdin fixture, not a stub, proves it; and the newest canary row for the committed plugin
tree is a pass (or `unavailable` with its reason), at most 7 days old where a scenario is
judge-backed. `retention` (state is declared and pruned): `.claude-plugin/plugin.json` declares
every path the plugin writes outside the worktree, with a prune command for anything kept a
number of days, and every write the canary observed sits under a declared path. The canary row
keeps the committed tree it certifies (`tree_sha`) and the files the live run left outside its
work directory (`writes`), runs every declared prune after the live runs and records each as a
`cc_canary_prunes` row (`--no-prune` skips that), and `canary status` prints the last run, the
last pass and the last prune per plugin; schema 8. Every plugin in this repository has an
`e2e/live-run.sh` handing off to plugin-kit's scenario runner, and the ledger's own scenarios
cover its five events. The hooks' direct-invocation guards compare real paths, the fix the
i-have-audhd and ask-graham scripts needed: a hook reached through a symlink (macOS's
`/var/folders` tmpdir, where `gate check` snapshots the plugin) otherwise never ran.

Changes in 0.3.4 (with plugin-kit 0.1.1): two fixes to what 0.3.3 shipped. The canary no longer
hands its `e2e/live-run.sh` the caller's `LEDGER_*` environment; a `LEDGER_DB` in the shell
that ran `ledger canary run` outranked the script's throwaway config and pointed the seeded
question and the headless session at the real store (the scripts, ledger's and the kit's
template, also `unset` those keys for a run by hand). plugin-kit's `new-plugin` scaffolds into
the `plugins/` of the git repository the cwd is in, found with `git rev-parse --show-toplevel`,
instead of the directory above the kit (which, installed from the marketplace, was the plugin
cache); a cwd in no repository is refused naming `--dest`.

Changes in 0.3.3: the fault-tolerance gate and the feedback loop. `ledger gate check` runs the
repository test bar's checks (three then; five since 0.3.5; six since 0.3.6) on every plugin changed since the base of a repository of
plugins (can't break the session: each hook on five fault inputs; failures visible: an
`errors.log` line and a `systemMessage`, and an `<x>.unavailable.txt` fixture beside every
`<x>.txt`; text says what to do: a "When this can't run" section in every skill and agent, a
backtick command in every deny text), records the rows for the committed tree it checked, and
the push gate denies a push or PR without rows or with a failed check, naming `gate check` and
`review waive` as the ways out. The labs read the author's pattern-check receipt before the
diff and tag a stated failure path the code lacks, or a silent one the receipt lacks,
`[blocking] fault-tolerance:`. Three verbs tell whether the hooks are doing anything: `canary
run` runs every plugin's `e2e/live-run.sh` under `claude -p` nightly (`canary install` writes
the launchd plist and prints the bootstrap line); `report` grades a week of bounces per rule,
with a cached judge overlay; `digest` posts the week's report as a comment on the configured
`owner/repo#number` issue (`digest install` likewise), and session start says when it is
overdue. Session end writes a decision-log entry in the `/wrap-up` shape under the
repository's `.ai/decision-log/` when the session answered or noted anything, and session
start injects the newest and the open or durable entries where the newdle plugin's hook will
not. Session start withdraws questions asked more than `sweep.autoWithdrawDays` ago (7) whose
session has ended, and `doctor` counts stale ones. Bounces keep the text that fired the rule
and the transcript path; `bounces` shows them; `review judge <key>` shows a cached answer. A
session-start question from another window is relayed to the human in one plain line (never
its id), an `ask` with no `--default` invents none, and every hook's store failure now leaves
an `errors.log` line beside its message. Schema 7 adds `cc_judge_cache`, `cc_canary_runs`,
`cc_gate_checks` and two `cc_bounces` columns; the plugin README's "Inspecting the database"
section says what an older ledger does with a schema-7 file. The new `plugin-kit` plugin
scaffolds a plugin that passes the gate on day one.

Changes in 0.3.2: a side pane for Claude Code Desktop. The ledger mod opens a pane listing the questions still open in other folders and the answers recorded since your last turn, and `/ledger answer <id> <reply>` (or the pane's own buttons and reply field) records through the ledger CLI without spending a model turn. Where no pane can draw (`claude -p`, narrow terminals, OMP) the same information lands as one block in the transcript. See the plugin README, "Ledger pane (Desktop)", for the two-window test.

Changes in 0.3.1: three fixes from the first live sessions on 0.3.0, each from a bounce that had
no way out. An `ask` that repeats a question still open from an earlier session or an untagged
CLI run in the same folder (same text, same set of options in any order) now adopts that row
(its session id and asked-at move to the asking session; its options and default stay) instead
of writing nothing; before, the session had no row of its own and the Stop ask rule sent every
reply back with "this session has no open question row". The ask rule itself now stands down on
any question open for the folder (this session's, or one in the cwd or a parent of it), and it
fires only on a question that asks for a decision: a request ("should I", "do you want", "ready
to"), an explicit choice ("whether", "do you prefer", an option list after a comma or colon), or
a wh-question carrying one ("How should we proceed?"). A greeting or a request for information
("What are we working on?", "Which file holds the config?", "Are the logs compressed or
uncompressed?") needs no row; a "why" question never does. Session start now lists the
questions waiting in other folders in full, folder by folder with each question's `pending` line
(default, id, name, body, the other options; a held one marked `held`), so a session can record
the human's answer to one of them without a lookup;
before, it only counted them. And a prompt that is just an option word of an open question
("local", "Remote.") gives Claude one line naming that question and the `answer` command, as a
hint only: nothing is recorded until Claude runs it. One more, in the review gate: the `glm`
lab no longer has a built-in `omp` profile. It runs with no `--profile` (omp's base profile)
unless `review.profiles.glm` names one; before, the default was `agent-system-2`, and a user
file with `"profiles": {"glm": ""}` (rejected by the loader, which wants a non-empty string)
silently ran every GLM review under that profile.

Changes in 0.3.0: the ledger checks itself and records its own bounces. `ledger doctor`
prints one `ok`, `warn` or `fail` line per check (the database opens read-write, the schema
version is current, which config layer set `db` and `enabled`, `hooks.json` lists every
event, `errors.log` lines in the last 7 days per hook, bounces left open for more than a day)
and exits 1 only when a check fails; it never writes the database. Session start adds one last
line, `ledger: doctor reports N issue(s)`, when the cheap subset of those checks (schema
version, recent `errors.log` lines) finds something; `inject.doctor: false` turns it off.
Every Stop block and PreToolUse deny now writes a row to a new `cc_bounces` table, marked
`satisfied` when the remedy happens later in the session and `bypassed` at session end
otherwise, and `ledger bounces [--since 7d]` counts them per rule, so the rules that only get
walked past can be found and retired. A cross-lab review gate now stands in front of `git push`,
`gh pr create` and `gh pr merge`: `ledger review` sends the branch's diff to the labs in
`review.labs` (`codex`, `kimi`, `claude`, and `glm` through `omp`) in parallel and records each
verdict for the HEAD commit in a new `cc_reviews` table; the push is denied while HEAD has no
review or has findings, a lab that cannot run is named and left out, and `ledger review waive
"<reason>"` lets a commit through with the human's reason on record. `review.mode` (`gate` by
default, or `advise`, or `off`) is read from the user config file only. Findings carry a
severity (`blocking`, `should`, `nit`); nits alone let the push through with a notice. Each
reviewed commit is a numbered round, and past `review.maxRounds` (default 3) the review stops
and says to ask the human. A judge model checks every claim that a finding is resolved, whether
a later review dropped it, listed it again only as a nit, or the agent ran `review addressed
"<why>"`; a `no` keeps the gate closed, and a judge that cannot answer counts the finding
resolved and says so. A lab that is skipped or unavailable keeps its findings open on the new
commit, and `review addressed` is refused while HEAD has findings of its own. The judge is
`review.judgeCommand`, or the i-have-audhd plugin's `enforcement.judgeCommand`; its passage is
capped at 8 kB and says when it was cut. Session start now also
shows the open and held questions asked in folders under the session's folder, each naming its
folder, and `pending` lists them the same way. Reviewers run without tools, from an empty
scratch folder, with an allowlisted environment. The gate checks the commit a command actually
publishes (`cd` and `git -C` folders, each in its own shell scope, refspecs, git's own choice
when no refspec is given, the branch `gh pr create --head` names as the remote has it now, read
with a `git ls-remote` that cannot prompt and is killed with its helpers after 5 seconds, the
pull request `gh pr merge` names, pushes inside `$(…)`), and
allows with a notice when it cannot tell, including a `-c` or `GIT_CONFIG*` setting that steers
the push and a remote that does not answer in 5 seconds; a merge not bound with
`--match-head-commit` gets a notice naming the commit checked. `review --base` narrows only the
diff the labs read, and a later review of an older commit clears nothing found on a newer one.
Opening a 0.2.3 database migrates it to schema
version 6 by creating new tables; no existing table is touched. A push missing both a note and a
review is denied once, naming both. The Stop ask rule now catches a question mid-line ("Should
I …? I'd say yes."); the decision rule stands down when the reply asks a question recorded that
turn, and `instead of` left the default phrase list. A bounce marked `bypassed` at SessionEnd
turns `satisfied` when the same session resumes and does the remedy. `errors.log` lines carry
the database they were written against, and `doctor` counts only its own.

Changes in 0.2.3: one database shared by every folder is now readable across folders.
`ledger pending --all` lists every open and held question in the database, grouped under the
path of the folder it was asked in, oldest first within a folder. Session start adds one line
when questions are waiting on you outside the session's folder (not the folder, a parent or a
subfolder of it): how many, in how many other folders, and the `pending --all` command to see
them. The line is kept after a compaction; set `inject.elsewhere` to `false` to turn it off.
`ledger pending` without `--all` is unchanged. An answer now reaches the session that asked
while it is still open: when a question is answered or withdrawn from another session or folder,
the asking session's next prompt carries one line saying so (`answered since your last turn:
<name> → <word>`), once. Set `inject.answers` to `false` to turn it off. Opening a 0.2.2 database
migrates it to schema version 5 in place by adding two columns; no table is rebuilt.

Changes in 0.2.2: an `outcome` lifts the push gate the same as a `note`, so one
`ledger outcome <ref> "<what and why>"` per push is enough. The Stop hook's decision rule still
wants a `note` in the turn that states the decision. A reply that is none of a question's options
is recorded as given: `ledger answer <q-id> "<reply>"` stores it as a free-form answer (up to 200
characters), and `log` shows it as `answered (freeform)`, so a question is no longer withdrawn
because your reply was off the list. A prompt line such as `approve q-…` still applies exact
options only, so a typo never becomes an answer. Opening a 0.2.1 database migrates it to schema
version 4 in place, rebuilding `cc_answers` and keeping every row.

Changes in 0.2.1: you never type a question id. The agent asks in plain words and records your
reply with `ledger answer`; the Stop hook sends a turn back once when you replied and the answer
is not recorded, and no longer requires a reply to name its row (`approve q-…` typed into a
prompt still works as a shortcut). The hooks are on by default, with `/ledger:enable` and
`/ledger:disable` to set a folder's switch. A question the agent forms but defers is `held`
(`ledger hold`, `ledger reopen`), never dropped, and is listed as *Waiting on you* at session
start; `ledger outcome <ref> [q-id] "<text>"` records what a decision produced (a PR, a commit, a
path). Opening a 0.2.0 database migrates it to schema version 3 in place, keeping every row. A
database at a configured `db` path that fails to open as SQLite (corrupt, or not a database) is
reported and left exactly as it is; only the plugin's own default file is moved aside to
`<path>.corrupt-<stamp>` and recreated.

Needs Node 22.13 or later (`node:sqlite`). Claude Code only; no OMP adapter. One allow rule
keeps the agent's ledger commands from prompting for permission; the plugin prints it at
session start. Verbs, config keys, the fail-open table and the known gaps are in
[`plugins/ledger/README.md`](plugins/ledger/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ledger@jo-wolff-plugins
```

### Developing ledger

The tests run with `node --test` from inside `plugins/ledger/`.

## ctx-watch

Notice when the [ctx](https://github.com/ctxrs/ctx) daemon is dead, not supervised, or stale,
or its semantic index is not ready, and say so where you will see it. The probe is `ctx daemon
status --format json` with `CI` removed from the environment, judged on `.daemon.running`,
`.daemon.supervisor.status`, `.daemon.jobs.core_refresh.last_run_at_ms` (over 2 h is stale)
and `.daemon.jobs.semantic_index.status` (not `ready` while semantic search is enabled; the
fix line is `ctx semantic enable --wait`, since ctx 2.3.0 has no rebuild verb) and never on
the exit code, which is 0 either way. A failing probe is repaired with `ctx index mode auto`, the command
ctx's own docs give for "installs or repairs supervision and starts the persistent background
daemon" (verified on a throwaway data root; a non-CI `ctx daemon status` does not restart
anything), guarded so it never sets ctx up or flips a deliberate `manual` mode. Two surfaces:
a SessionStart line, `ctx-watch: <reason>; fix: \`<command>\``, plus a dead-man's line when the
timer itself has not run; and a launchd timer (`install` writes the plist and prints the one
`launchctl bootstrap` line, never running it) whose `tick` strikes once, goes down on the
second failing probe in a row, and shows one `osascript` dialog per episode, with one latch
per failure kind (daemon, semantic index) so a semantic popup cannot hold off a daemon
outage's. A third, at Stop: the `consult-history` check warns (or blocks, by
`~/.claude/ctx-watch.json`) when a session resumed, compacted or forked, or a reply says "we
spoke previously", "earlier you said" or "as discussed", and no `ctx search`, `show session`
or `show event` was called since; the line names `ctx search '<the prompt's first six words>'`. Claude Code only (no OMP
adapter). Built on plugin-kit; macOS; Node 22.13 or later. The reasons, the repair's guard,
the episode rules, the check and the failure table are in
[`plugins/ctx-watch/README.md`](plugins/ctx-watch/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ctx-watch@jo-wolff-plugins
```

Then, once, from your own Terminal: `node <plugin dir>/scripts/ctx-watch.mjs install` and the
`launchctl bootstrap gui/<uid> <plist>` line it prints.

### Developing ctx-watch

The tests run with `node --test` from inside `plugins/ctx-watch/`; the hook scenarios with
`bash e2e/live-run.sh --no-live`. The ctx captures in `test/fixtures/` are re-made by
`test/fixtures/capture.sh`, by hand.

## delegation

Teach an agent the brief a subagent is handed, then gate on it. Every session gets a block
under 25 lines at SessionStart with the brief's skeleton inline (`# Target` with non-goals,
`# Change`, `# Acceptance`, `## How it fails`, `## Spiral bound`, the closing `Stopped
because:` line), and the `delegation` skill carries the lesson with a worked example. A
PreToolUse gate on `Agent`/`Task` refuses a spawn whose prompt has no `## How it fails`
heading, and a builder-class spawn (`builder`, `beefy-builder`, `task`, `sonic`,
`general-purpose`, or your `builderClass` list) without `## Spiral bound` or without this
session's pattern-check receipt; the refusal carries the missing section verbatim, so the brief
is repaired from the refusal alone. A PostToolUse check marks a `SendMessage` the host could not
deliver as NOT delivered next to its result. A SubagentStop warning names the exact `Stopped
because:` line a builder report ended without. On OMP the same gates run on the `task` tool and
its results. Alongside: eleven agents (`auditor`, `builder`, `changelog`, `checker`, `debugger`,
`planner`, `reader`, `research`, `scout`, `storyteller`, `summarizer`) and three guards
(`delegation-guard`, `worktree-spawn-guard`, `repo-rules-inject`) ported from newdle 0.2.175 with
their repository-specific lines removed; the per-file list is in the plugin README. Built on
plugin-kit; Node 22.13 or later. The gate texts, the config and the failure table are in
[`plugins/delegation/README.md`](plugins/delegation/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install delegation@jo-wolff-plugins
```

On OMP: `omp plugin marketplace add thewolff/jo-wolff-plugins` then
`omp plugin install delegation@jo-wolff-plugins`. The agents preload the `output-types` skill
and some `as2-skills` skills, both sibling plugins installed separately. Gate 2 names the
`pattern-check` plugin's command; without it installed the refusal says to install it, or set
`requirePatternCheck: false` in `${XDG_CONFIG_HOME:-~/.config}/delegation/config.json`.

### Developing delegation

The tests run with `node --test` from inside `plugins/delegation/`; every hook is spawned
through the fail-open runner with its 4 s deadline in an empty HOME and XDG sandbox.

## continuity

Keep a long session's state across compaction. On PreCompact, `hooks/pre-compact.mjs` saves the
session's deterministic state (branch, uncommitted paths, files touched, the last five asks, and
the open handoffs under the repository's `.ai/handoffs/`) to
`${XDG_STATE_HOME:-~/.local/state}/continuity/<session_id>.json`, every list capped and every
cut announced in the file, and leaves a heartbeat record saying whether it worked. On the
SessionStart that follows a compaction, `hooks/session-start.mjs` injects that snapshot back
(this session's only, at most 20,000 characters) and removes it, then re-inlines the rules files
(`CLAUDE.md` with `CLAUDE.local.md`, else `AGENTS.md`) of every directory from the cwd to the
repository root that the host does not re-read on its own, root first, inside what the restore
guard has left (8,000 bytes per file, 9,000 for the section, the largest files cut first with a
marker, every skipped file named; a level the host loaded at launch is skipped), and lists the
newest five entries of the repository's durable-notes directory (`notesDir`, default
`.ai/decision-log`) as the source of truth the snapshot is only the safety net for; on every
start it adds one line, `continuity, pre-compaction save liveness: last successful save N minutes
ago; the snapshot path is alive`, or a bold line saying the save has never been recorded or never
succeeded on this machine, so a save that silently died is seen the next morning. The
context-pressure check (`hooks/user-prompt-submit.mjs`, `hooks/stop.mjs`) estimates the
session's size from the transcript and the ratio observed at earlier compactions, and at 0.65
of the compaction target (configurable in `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json`)
warns once with the prompt and blocks one stop, both naming `/continuity:handoff`; a machine
that has never compacted hears nothing. The handoff skill writes
`<root>/.ai/handoffs/<date>--<time>--<author>--<lane>.md` with five sections (where I left off,
next move, already ruled out, live uncertainty, working state) and the rule that a resuming
session restates the content before continuing. Every hook fails open. Built on plugin-kit
0.3.1; Node 22.13 or later. The config keys, the state table, the failure table and the
"Ported from newdle 0.2.175" table are in
[`plugins/continuity/README.md`](plugins/continuity/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install continuity@jo-wolff-plugins
```

### Developing continuity

The tests run with `node --test` from inside `plugins/continuity/`;
`bash e2e/live-run.sh --no-live` replays the fourteen scenarios offline.

## brb

Type `brb` (a note may follow) as the whole prompt and walk away. The prompt is blocked before
it reaches the model, a hold is written for the session, and from then on every prompt carries
an away instruction: keep working, put every ask under `## Needs you`, start a line with
`on fire:` only for a broken main branch, data loss, a security finding, spend near a ceiling
or a blocker on everything, and end with an `idle: <why>` line when nothing is runnable.
The Stop hook copies each new Needs-you line into a digest, surfaces each on-fire line at once
(a `systemMessage`, an OSC 9 terminal notification, a best-effort macOS notification) without
holding it, and sends the agent back to work (Stop hook feedback on Claude Code, a block on
OMP) until an `idle:` line, a tool-less continuation that brings nothing new, or two stops with
no tool call between them. `pending` prints the digest; `back` prints it, archives it and ends
the hold. The on-fire kinds mirror
agent-system 2.0's surface. Built on plugin-kit 0.3.1; Node 22.13 or later; Claude Code hooks
plus an OMP extension that runs the same hooks. The exact instruction text, the three release
rules, the config (`onFireCap`, `idleStops`) and the failure table are in
[`plugins/brb/README.md`](plugins/brb/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install brb@jo-wolff-plugins
```

On OMP: `omp plugin install brb@jo-wolff-plugins`;
[`plugins/brb/omp/REGISTRATION.md`](plugins/brb/omp/REGISTRATION.md) has the fallbacks.

### Developing brb

The tests run with `node --test` from inside `plugins/brb/`; `bash e2e/live-run.sh --no-live`
replays the scenarios offline.

## License

MIT. See `LICENSE`.
