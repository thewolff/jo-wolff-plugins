# delegation

Teach an agent the brief a subagent is handed, then gate on it. A fresh session is told the
brief's shape before its first spawn (a SessionStart block under 25 lines, and the `delegation`
skill with a worked example). A spawn whose brief does not say how the work fails is refused
before it starts, and the refusal carries the missing section as a fill-in template, so the
brief can be repaired from the refusal alone. A builder-class spawn also has to say where it
stops (the spiral bound) and has to come after the session's pattern-check receipt. A message
the host could not deliver is marked as undelivered next to the tool result, so the parent does
not wait for a reply that is never coming. A builder report that does not end with `Stopped
because: …` draws a warning, shown to the user, that says the exact line to add. Alongside: the eleven general
agents and the three direct-work guards ported from the newdle plugin, with the
repository-specific lines removed.

The problem: a parent that spawns a builder with "fix the tests" gets a builder that retries
until the context runs out, and a parent that sends a message to a finished agent reads the
failed send as a sent message. Both are the host behaving as documented. Teaching puts the
missing information in the one place it has to be, the brief; the gate is the backstop for the
spawn that skipped the lesson; the undelivered mark puts the missing signal in the one place it
is read, the tool result.

Everything is on by default with no config file; the config can loosen a gate, never is it
needed to tighten one. Node 22.13 or later. Claude Code hooks and an OMP extension; the OMP
half is in *On OMP* below.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install delegation@jo-wolff-plugins
```

On OMP:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install delegation@jo-wolff-plugins
```

Gate 2 (the pattern-check receipt) names the `pattern-check` plugin's own command in its deny
text; it finds the command in a sibling checkout or in the plugin cache beside this plugin (the
newest version, compared numerically). With pattern-check not installed the gate is skipped and
one skipped.log line says so. With it installed and no receipt, the deny names the command and
the way out: `requirePatternCheck: false` in the config.

## Teaching: the skill and the SessionStart block

The `delegation` skill (`skills/delegation/SKILL.md`) is the lesson: when to delegate and to
which agent class, the sections in order (`# Target` with non-goals, `# Change`,
`# Acceptance`, `## How it fails`, `## Spiral bound` with the exact retry, commit-budget and
acceptance rules), the `Stopped because:` line, the CLAIM/CITE line, and one worked example (the
template filled in for a real task). The agent reads it when it is about to spawn or when a
spawn was refused.

`hooks/session-start.mjs` gives every session (startup, resume, clear, compact) one
`additionalContext` block, under 25 lines: "Before any Agent/Task call, the prompt you hand the
subagent carries these sections", the skeleton inline, the configured builder-class names, the
closing line, the labeling rule, and which agent fits which job. On OMP the same block is a
hidden custom message offered on `before_agent_start` until a `context` event shows it was
carried, and offered again after a `session_compact` of the main session; never to a subagent.
The text is `sessionBlock()` in `lib/brief.mjs`.

## The gates

| Gate | Fires on | Condition | Answer |
|---|---|---|---|
| 1 How it fails | PreToolUse `Agent`/`Task`; OMP `task` | `tool_input.prompt` (OMP: the shared `context` plus each `tasks[].task`, or the single `task`) has no heading line `## How it fails`. On OMP a `readOnlyAgents` entry is exempt | deny; reason names the heading, what the section holds, and `templates/builder-brief.md` |
| 4 Spiral bound | same | `subagent_type` is builder-class and the prompt has no heading line `## Spiral bound` | deny; same shape |
| 2 Receipt | same | builder-class, pattern-check installed, and no `<git root of cwd>/.pattern-check/<session_id>.md` (nor pattern-check's state copy) | deny; reason names the path, the exact `pattern-check.mjs open … then record --session <key>` command, and `requirePatternCheck: false` |
| 3 Not delivered | PostToolUse `SendMessage`; OMP `write agent://…` | `tool_response.success === false` (OMP: `isError`) | `decision: "block"`, reason = the tool's own `message` + `this message was NOT delivered; spawn a new agent or fix the name` + the two tool calls that do it |
| Stop line | SubagentStop; OMP `task` result | `agent_type` builder-class (an empty `agent_type` is not) and the last non-empty line of `last_assistant_message` is not `Stopped because: acceptance met \| bound hit \| told to stop` (a detail may follow the value, as in `bound hit (commit budget)`) | `systemMessage`, shown to the user; never a block. On OMP, additionalContext for the parent |

A heading matches literally: any level `#` to `######`, case-insensitive, an optional trailing
parenthetical (`## Spiral bound (builder)`), an optional trailing colon, up to three leading
spaces. Nothing else in the prompt is read: not the section's content, not prose that mentions
the words, and not a heading inside a fenced code block (``` or ~~~). A builder-class name is
compared bare (`newdle:builder`, `agents/builder` and `Builder` all match `builder`); a missing
`subagent_type` is Claude Code's default, `general-purpose`, which is in the default class. A
name in `readOnlyAgents` (`reviewer-codex`, `reviewer`, `auditor`, `scout`, `reader`,
`research`, `beefy-research`, `security-reviewer`, `summarizer`, `changelog`, `checker` by
default) is never builder-class: it needs no Spiral bound and no receipt, and its report draws
no stop warning. On Claude Code it still needs `## How it fails`; on OMP it is exempt from
that too (see *On OMP*).

The deny texts, exactly (`<type>` is the subagent type as given; `<section>` is the section
from `templates/builder-brief.md`, verbatim, one per missing heading):

- gate 1: `Spawn refused: the prompt has no "## How it fails" heading. Re-issue the spawn with the same prompt plus the section below, filled in (keep the heading line as written; the gate reads it literally). Full template: templates/builder-brief.md in the delegation plugin.` then a blank line and the `## How it fails` section. For a builder-class type the sentence `The report ends with one line: \`Stopped because: acceptance met | bound hit | told to stop\`.` sits before `Full template`.
- gate 4: `Spawn refused: builder-class "<type>" needs a "## Spiral bound" heading too. Re-issue the spawn …` then the `## Spiral bound` section.
- both: `Spawn refused: the prompt has no "## How it fails" or "## Spiral bound" heading; builder-class "<type>" needs both. Re-issue the spawn with the same prompt plus the sections below …` then both sections.
- gate 2: `Spawn refused: builder-class "<type>" needs a pattern-check receipt for this session, and none exists at <root>/.pattern-check/<key>.md. Run: node "<pattern-check>/scripts/pattern-check.mjs" open "<what you are about to build>" then node "<pattern-check>/scripts/pattern-check.mjs" record --session <key> with --row "..." or --no-new-pieces "<reason>". Then re-issue this spawn. To turn this gate off instead, set \`"requirePatternCheck": false\` in <config file>.`
- gate 3: `<the tool's message> (to: <name>)` on one line, then ``this message was NOT delivered; spawn a new agent or fix the name (a new `Agent` call, or `SendMessage` to a name that is running)``.
- the stop warning, worded for the person reading the session because that is who a SubagentStop `systemMessage` reaches: `delegation: builder-class agent "<type>" (<id>) ended without a "Stopped because:" line. Its report is unfinished until it says which applies. The report's last line is exactly one of: \`Stopped because: acceptance met\` (every acceptance check passed once), \`Stopped because: bound hit\` (a retry, commit, time or tool bound stopped it; name which after it), \`Stopped because: told to stop\` (the parent sent a stop). The next builder-class brief needs: "End your report with one line: Stopped because: acceptance met | bound hit | told to stop." Full template: templates/builder-brief.md in the delegation plugin.` (or `ended with "Stopped because: <value>", which is not one of the three values`, or `has "Stopped because: <value>" but not as its last line`).

A brief rebuilt from a refusal alone passes the gate; `test/gates.test.mjs` does exactly that.
The brief this plugin was built from asked for a reason under 300 characters; Jo's steering on
2026-11-04 (the full section in the refusal, since nobody writes these from memory) replaced
that bound, and the reasons are now a few hundred characters per missing section.

On Claude Code 2.1.318 a PreToolUse deny reaches the model as an `is_error` tool result
prefixed `PreToolUse:Agent hook error:`, and holds under `--dangerously-skip-permissions`; a
`SendMessage` to an unreachable name returns `{"success":false,"message":"No agent named …"}`
with `is_error` unset, which is why gate 3 exists. Both measured in the research report this
plugin was built from (`agent-scratch/jo-wolff-plugins/CLAUDE-CODE-DELEGATION-HOOKS-2026-11-04.md`).

## The brief template

`templates/builder-brief.md`: Target, Change, Acceptance, `## How it fails` (what breaks, where
it shows, recovery, retry bound), `## Spiral bound` (one retry per failing step, a commit
budget, report instead of chasing when acceptance cannot be met), and the closing `Stopped
because:` line. The section texts live in `lib/brief.mjs` and the template is held equal to them
by the tests, so the refusal and the file never drift apart.

## The ported hooks

Three guards from newdle 0.2.175, general-purpose behaviour kept, repository-specific lines
removed (the list is in *Ported from newdle*). Each is set by `checks.<name>` in the config.

| Hook | Fires on | What it watches | Default |
|---|---|---|---|
| `delegation-guard` | PreToolUse `Read`, `Grep`, `Bash`; PostToolUse `Agent`, `Task` | a `Read` over `readLineThreshold` lines (1000) with no bounding `limit` (counting stops at the threshold); the `streakThreshold`-th (6) distinct file touched directly since the last spawn (main session only; a spawn that ran resets it, a denied one does not); a whole-tree search (`find .`, recursive grep/rg with no path, a `Grep` with no `path`) | `warn`: additionalContext naming the subagent that fits (`reader`, `builder`, `scout`). `block`: deny with the same text and what to do instead. newdle answered `ask`; an `ask` reaches nobody in a subagent or under `-p`, so that tier is gone. |
| `worktree-spawn-guard` | PreToolUse `Agent`/`Task` with `isolation: "worktree"` | the cwd is a workspace root (its `repos/` holds independent git repositories: a worktree gets an empty `repos/`), or `git status --porcelain` is not empty (a worktree carries no uncommitted work) | `warn`: additionalContext naming the hazard and the first ten status lines. `block`: deny (newdle's behaviour). |
| `repo-rules-inject` | PreToolUse `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | the file's rules chain (`CLAUDE.md` + `CLAUDE.local.md`, else `AGENTS.md`, on the walk up) minus the levels the launch directory already loaded and minus files injected earlier this session; `@imports` resolved; oversized sections become a path plus heading outline inside `rulesBudget` (9000) | `on`: additionalContext. Never a decision. `off` turns it off. |

## The agents

Eleven agents from newdle 0.2.175, in `agents/`: `auditor`, `builder`, `changelog`,
`checker`, `debugger`, `planner`, `reader`, `research`, `scout`, `storyteller`, `summarizer`.
Each preloads the `output-types` skill (from the output-types plugin) and, where newdle did,
one `as2-skills` skill; both are sibling plugins in this marketplace and are installed
separately. The default builder class is `builder`, `beefy-builder` (newdle's larger-scope
builder, not ported: its text is shipyard-specific end to end), `task` (OMP's default agent),
`sonic` and `general-purpose` (Claude Code's default agent). `builder` ends its report with the
`Stopped because:` line the stop warning looks for. Every agent here has a `## When this can't
run` section: what the gate refuses before it starts, and what it reports when its inputs or
tools are out of reach.

## Config

`${XDG_CONFIG_HOME:-~/.config}/delegation/config.json`; a missing file is the defaults. A
present file that is not JSON, or has a field of the wrong type, is ignored whole and said so
once per hook answer (`delegation <hook>: config ignored: <file>: <what>`), so a typo never
widens or narrows a gate.

```json
{
  "off": false,
  "builderClass": ["builder", "beefy-builder", "task", "sonic", "general-purpose"],
  "readOnlyAgents": ["reviewer-codex", "reviewer", "auditor", "scout", "reader", "research", "beefy-research", "security-reviewer", "summarizer", "changelog", "checker"],
  "requireHowItFails": true,
  "requireSpiralBound": true,
  "requirePatternCheck": true,
  "checks": { "delegation-guard": "warn", "worktree-spawn-guard": "warn", "repo-rules-inject": "on" },
  "readLineThreshold": 1000,
  "streakThreshold": 6,
  "rulesBudget": 9000
}
```

## On OMP

OMP does not run `hooks/hooks.json`. The extension `omp/delegation-omp.ts` does the same jobs
on OMP events: gates 1, 4 and 2 on the `task` tool call (each `tasks[]` entry judged on the
shared `context` plus its own `task`, or the single-task form as one entry; the first failing
one blocks the call, naming its index; the receipt is keyed on OMP's session id and cwd the way
pattern-check's own OMP adapter keys it); the stop warning on the `task` result
(`details.results[].output`, as additionalContext, so on OMP the parent model does see it); and
gate 3's twin on a `write` to an `agent://` path. The ported hooks are Claude Code only.

A `readOnlyAgents` entry (`reviewer-codex`, `scout`, `reader`, …) is exempt from every OMP gate,
`## How it fails` included. Plumb's own How-it-fails gate on OMP exempts read-only agents
outright, and two gates that disagree on one dispatch would refuse Plumb's read-only spawns.
The other entries of the same `task` call are still judged. On Claude Code the spawn gate
still asks a read-only agent for `## How it fails`.

The limit on OMP: OMP already errors a `write agent://<id>` to a peer that is not running, so
the twin only adds the instruction. A write to a parked peer is queued and the peer revived,
and whether it acts on the message is not knowable from the tool result, so a message to a
peer that has finished its work is not flagged.

## How it fails

Every row's hook × outcome has a scenario under `evals/`, run offline by `e2e/live-run.sh`
before its live phase: the denies (`evals/spawn-gate-deny-no-how-it-fails.scenario.json`,
`evals/spawn-gate-deny-builder-no-spiral-bound.scenario.json`,
`evals/send-message-check-deny-undelivered.scenario.json`), the warnings
(`evals/subagent-stop-warn-no-stopped-line.scenario.json`,
`evals/delegation-guard-warn-large-read.scenario.json`) and the silent siblings.

| Piece | Fails how | Visible where | The person does |
|---|---|---|---|
| any hook | stdin not JSON; the handler throws; no answer in 4 s (the hooks.json timeout is 5 s, so the runner answers first) | one line in `${XDG_STATE_HOME:-~/.local/state}/delegation/errors.log`; a `systemMessage` `delegation <hook> failed open: …`; the call goes through unchecked | nothing for one line; a repeating line is a bug: open an issue with the line |
| session-start | the runner fault above | the session starts untaught; the gate still holds | nothing |
| spawn-gate | `tool_input.prompt` is not a string | the spawn is allowed; one line in `…/delegation/skipped.log` | nothing; the line is the trace that the gate was awake |
| spawn-gate gate 2 | the cwd is in no git repository, or the payload has no cwd | the spawn is allowed; one skipped.log line | run the spawn from inside the repository if the receipt is wanted |
| spawn-gate gate 2 | pattern-check is not installed | the spawn is allowed; one skipped.log line naming the reason | install pattern-check if the receipt is wanted |
| send-message-check | the response has no `success` field (another host version) | nothing; the send's own result is the only signal | nothing |
| subagent-stop | `last_assistant_message` is absent (older host, or the agent ended on a tool call) | the warning says the report ended without the line | read the report; the warning is advisory |
| subagent-stop | auto mode: the subagent hands its report back through the `SubagentHandback` tool (Claude Code 2.1.271+), so `last_assistant_message` holds only its closing text; the SubagentStop input carries no field with the handed-back report | the warning can fire on a report that did end with the line | read the delivered report; the warning is advisory and nothing is blocked |
| subagent-stop | the session itself runs as a builder-class agent (`--agent builder`, or the `agent` setting): Claude Code's internal agents (prompt suggestions, `/btw`) then report that name as `agent_type` | the warning fires when such an internal agent finishes | nothing; the warning is advisory |
| the OMP adapter | a handler throws | returns undefined (OMP would otherwise turn a throw into a block of every `task` call) | nothing |
| delegation-guard | the file is unreadable or binary; the state dir is unwritable | not counted, not flagged; the streak is lost, never the call | nothing |
| worktree-spawn-guard | git is missing, fails, or exceeds 3 s | nothing | nothing |
| repo-rules-inject | a rules file is unreadable | that file contributes nothing | nothing |
| config.json | not JSON, not an object, a wrong-typed field | defaults, plus one systemMessage naming the file and the field | fix the field the message names |

State lives under `${XDG_STATE_HOME:-~/.local/state}/delegation/` (declared in `plugin.json`
`state`); `scripts/prune.mjs --days 30` removes files older than 30 days, keeping `errors.log`.

## Developing delegation

`node --test` from inside `plugins/delegation/`. Every hook test spawns the hook through
`lib/hook-runner.mjs` with the 4 s deadline, in an empty HOME and XDG sandbox; the OMP adapter
is imported into node directly (erasable types only, no Bun).

## Ported from newdle 0.2.175

Source: `~/.claude/plugins/cache/contextpress/newdle/0.2.175/`, read-only. Lines removed name
shipyard, Linear, `.projects/`, `TASKS.md`, newdle's own repositories or people; everything
general was kept.

| Source | Destination | Stripped |
|---|---|---|
| `agents/auditor.md` | `agents/auditor.md` | "for the Newdle monorepo"; "PLAN.md/TASKS.md, decision-log entry" in the non-code list; `code-simplify` and `responsive-audit` audit types and the `find … newdle-<type>/SKILL.md` lookup with its newdle-* skill map (now the as2-skills names); the `gaslight` skill paragraph (now: the `cross-model-review` skill); "Honor shipyard AGENTS.md"; the output-types reference path (now the preloaded skill); "plans under `.projects/<name>/` at the shipyard root" |
| `agents/builder.md` | `agents/builder.md` | `skills: frontend-ui-engineering, incremental-implementation` (neither is in as2-skills; `impeccable` covers UI there and is not preloaded); "Newdle monorepo" and the `beefy-builder` hand-off in the description and body; "Read shipyard and repo AGENTS.md… mobile API compatibility windows"; the `.ai/VOICE.md` copy rule (now: the repository's voice guide); the whole *Task tracking* section (TASKS.md, Linear `save_issue`, Boot context); the output-types reference path; "Jo's rule: `builder` ships, `builder-reviewer` reads" |
| `agents/changelog.md` | `agents/changelog.md` | nothing: the file had no repository-specific line |
| `agents/checker.md` | `agents/checker.md` | nothing: the file had no repository-specific line |
| `agents/debugger.md` | `agents/debugger.md` | "for the Newdle monorepo"; `skills: debugging` (now `debugging-and-error-recovery`, the as2-skills name); the output-types reference path; "Honor shipyard and repo AGENTS.md" |
| `agents/planner.md` | `agents/planner.md` | "for the Newdle team"; `skills: planning` (now `spec-and-plan`, the as2-skills name); the output-types reference path; "Jo review gates" (now: engineering-user review gates) |
| `agents/reader.md` | `agents/reader.md` | "for the Newdle monorepo"; the output-types reference path |
| `agents/research.md` | `agents/research.md` | "Newdle research specialist" and the beefy-research note in the description; "Newdle team"; "shipyard AGENTS.md verify-before-assuming rules" (now: the repository's); the output-types reference path; `web_search` from `tools:` (not a Claude Code tool; `WebSearch` is) |
| `agents/scout.md` | `agents/scout.md` | "for the Newdle monorepo"; the output-types reference path |
| `agents/storyteller.md` | `agents/storyteller.md` | the `jo-deck` skill reference (now: a deck-building skill); `.ai/VOICE.md` (now: the repository's voice guide); "Newdle output" (now: customer-facing output); "Jo's decision" (now: the person's); the output-types reference path |
| `agents/summarizer.md` | `agents/summarizer.md` | nothing: the file had no repository-specific line |
| `hooks/delegation-guard.mjs` + `lib/git-cmd.mjs` (`segments`, `shellSurface`) | `hooks/delegation-guard.mjs`, `lib/shell.mjs` | the `ask` tier and `askOrDeny` (the ask-to-deny conversion for unsurfaceable contexts, with `lib/prompt-surface.mjs` and `lib/hook-scope.mjs`); the `tmpdir()/newdle-delegation-<key>.json` state file (now JSONL under the plugin's XDG state dir, swept after a day); the `newdle:` agent prefix (now any `plugin:` prefix); the decision-log citations. Fixed on the way: `grep -rn` was not seen as recursive (`-r` had to end the cluster); a quoted `\|` split the command before quotes were masked |
| `hooks/worktree-spawn-guard.mjs` | `hooks/worktree-spawn-guard.mjs` | the shipyard decision-log citations and the "shipyard root" naming (the check itself, a `repos/` holding independent git repositories, is unchanged); the deny-only answer (now `warn` default, `block` by config) |
| `hooks/repo-rules-inject.mjs` + `lib/repo-rules-walk.mjs` + `lib/budget-fit.mjs` | `hooks/repo-rules-inject.mjs`, `lib/repo-rules.mjs` | the `tmpdir()/newdle-repo-rules-<id>.json` state file (now under the plugin's XDG state dir); the shipyard-specific comments; `budget-fit-cli.mjs` (a CLI no hook called) was not ported |
| `agents/beefy-builder.md`, `agents/beefy-research.md` | not ported | both are shipyard-specific end to end (Newdle monorepo ownership, `.projects/` sync, Linear closing); `beefy-builder` stays in the default builder class so a repository that ships its own is gated |

## Changes in 0.1.1

`lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.2.1's). The handler thread's
env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, a process group
the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits, and the runner
waits for stdout to drain before it exits (bounded by the same deadline), so an answer larger
than one 64 KiB pipe buffer is no longer cut short. delegation's
hooks register none, so every hook answers as before, under the same 4 s deadline (the
hooks.json timeout stays 5 s).

## Changes in 0.1.0

First release: the delegation skill and SessionStart block, spawn gates 1, 4 and 2, the
undelivered-message mark, the stop warning, eleven agents and three guards ported from newdle
0.2.175, on Claude Code and OMP.

Changes before release, from the first review: on OMP a task is judged on the shared `context`
plus its own text, and the single-task form is judged too; a heading may carry a parenthetical
(`## Spiral bound (builder)`) and one inside a fenced code block no longer counts; a new
`readOnlyAgents` list (reviewers, auditors, scouts, readers, researchers) needs `## How it fails`
only; gate 2 is skipped with a skipped.log line when pattern-check is not installed, and its
deny names `requirePatternCheck: false` as the way out; the stop warning is worded for the user,
who is who a SubagentStop `systemMessage` reaches, and no longer fires for an empty
`agent_type`; the `Stopped because:` line may carry a detail and backticks, and has to be the
last non-empty line; pattern-check versions sort numerically; a denied spawn no longer resets
delegation-guard's streak, and its line count stops at the threshold; the hooks.json timeout is
5 s against the runner's 4 s; OMP re-teaches after a compaction; every agent has a `## When this
can't run` section; `evals/` scenarios cover every hook and outcome; `plugin.json` declares the
state directory, pruned by `scripts/prune.mjs`.

From the second review: on OMP a `readOnlyAgents` entry is exempt from every gate, `## How it
fails` included, matching Plumb's gate; the canary's step 1 checks for a SessionStart
`hook_response` (Claude Code 2.1.318 hook events carry no script path), so the canary can pass;
the stop warning's auto-mode limit (`SubagentHandback`) and the `--agent` session limit are
documented under *How it fails*.
