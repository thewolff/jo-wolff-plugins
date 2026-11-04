# delegation

Teach an agent the brief a subagent is handed, then gate on it. A fresh session is told the
brief's shape before its first spawn (a SessionStart block under 25 lines, and the `delegation`
skill with a worked example). A spawn whose brief does not say how the work fails is refused
before it starts, and the refusal carries the missing section as a fill-in template, so the
brief can be repaired from the refusal alone. A builder-class spawn also has to say where it
stops (the spiral bound) and has to come after the session's pattern-check receipt. A message
the host could not deliver is marked as undelivered next to the tool result, so the parent does
not wait for a reply that is never coming. A builder report that does not end with `Stopped
because: …` draws a warning that says the exact line to add. Alongside: the eleven general
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
text; it finds the command in a sibling checkout or in the plugin cache beside this plugin. With
pattern-check not installed the deny still fires and says to install it; set
`requirePatternCheck: false` in the config to run without it.

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
carried, once per session, never to a subagent. The text is `sessionBlock()` in
`lib/brief.mjs`.

## The gates

| Gate | Fires on | Condition | Answer |
|---|---|---|---|
| 1 How it fails | PreToolUse `Agent`/`Task`; OMP `task` | `tool_input.prompt` (OMP: each `tasks[].task`) has no heading line `## How it fails` | deny; reason names the heading, what the section holds, and `templates/builder-brief.md` |
| 4 Spiral bound | same | `subagent_type` is builder-class and the prompt has no heading line `## Spiral bound` | deny; same shape |
| 2 Receipt | same | builder-class and no `<git root of cwd>/.pattern-check/<session_id>.md` (nor pattern-check's state copy) | deny; reason names the path and the exact `pattern-check.mjs open … then record --session <key>` command |
| 3 Not delivered | PostToolUse `SendMessage`; OMP `write agent://…` | `tool_response.success === false` (OMP: `isError`) | `decision: "block"`, reason = the tool's own `message` + `this message was NOT delivered; spawn a new agent or fix the name` |
| Stop line | SubagentStop; OMP `task` result | `agent_type` builder-class and `last_assistant_message` has no last line `Stopped because: acceptance met \| bound hit \| told to stop` | `systemMessage` only; never a block |

A heading matches literally: any level `#` to `######`, case-insensitive, an optional trailing
colon, up to three leading spaces. Nothing else in the prompt is read: not the section's
content, not prose that mentions the words, not fenced code. A builder-class name is compared
bare (`newdle:builder`, `agents/builder` and `Builder` all match `builder`); a missing
`subagent_type` is Claude Code's default, `general-purpose`, which is in the default class.

The deny texts, exactly (`<type>` is the subagent type as given; `<section>` is the section
from `templates/builder-brief.md`, verbatim, one per missing heading):

- gate 1: `Spawn refused: the prompt has no "## How it fails" heading. Re-issue the spawn with the same prompt plus the section below, filled in (keep the heading line as written; the gate reads it literally). Full template: templates/builder-brief.md in the delegation plugin.` then a blank line and the `## How it fails` section. For a builder-class type the sentence `The report ends with one line: \`Stopped because: acceptance met | bound hit | told to stop\`.` sits before `Full template`.
- gate 4: `Spawn refused: builder-class "<type>" needs a "## Spiral bound" heading too. Re-issue the spawn …` then the `## Spiral bound` section.
- both: `Spawn refused: the prompt has no "## How it fails" or "## Spiral bound" heading; builder-class "<type>" needs both. Re-issue the spawn with the same prompt plus the sections below …` then both sections.
- gate 2: `Spawn refused: builder-class "<type>" needs a pattern-check receipt for this session, and none exists at <root>/.pattern-check/<key>.md. Run: node "<pattern-check>/scripts/pattern-check.mjs" open "<what you are about to build>" then node "<pattern-check>/scripts/pattern-check.mjs" record --session <key> with --row "..." or --no-new-pieces "<reason>". Then re-issue this spawn.`
- gate 3: `<the tool's message> (to: <name>)` on one line, then `this message was NOT delivered; spawn a new agent or fix the name`.
- the stop warning: `delegation: builder-class agent "<type>" (<id>) ended without a "Stopped because:" line. Treat the report as unfinished until you know which applies. The report's last line is exactly one of: \`Stopped because: acceptance met\` (every acceptance check passed once), \`Stopped because: bound hit\` (a retry, commit, time or tool bound stopped it; name which), \`Stopped because: told to stop\` (you sent a stop). Put this in the brief of the next builder-class spawn: "End your report with one line: Stopped because: acceptance met | bound hit | told to stop." Full template: templates/builder-brief.md in the delegation plugin.` (or `ended with "Stopped because: <value>", which is not one of the three values`).

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
| `delegation-guard` | PreToolUse `Read`, `Grep`, `Bash`, `Agent`, `Task` | a `Read` over `readLineThreshold` lines (1000) with no bounding `limit`; the `streakThreshold`-th (6) distinct file touched directly since the last spawn (main session only; a spawn resets it); a whole-tree search (`find .`, recursive grep/rg with no path, a `Grep` with no `path`) | `warn`: additionalContext naming the subagent that fits (`reader`, `builder`, `scout`). `block`: deny with the same text and what to do instead. newdle answered `ask`; an `ask` reaches nobody in a subagent or under `-p`, so that tier is gone. |
| `worktree-spawn-guard` | PreToolUse `Agent`/`Task` with `isolation: "worktree"` | the cwd is a workspace root (its `repos/` holds independent git repositories: a worktree gets an empty `repos/`), or `git status --porcelain` is not empty (a worktree carries no uncommitted work) | `warn`: additionalContext naming the hazard and the first ten status lines. `block`: deny (newdle's behaviour). |
| `repo-rules-inject` | PreToolUse `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | the file's rules chain (`CLAUDE.md` + `CLAUDE.local.md`, else `AGENTS.md`, on the walk up) minus the levels the launch directory already loaded and minus files injected earlier this session; `@imports` resolved; oversized sections become a path plus heading outline inside `rulesBudget` (9000) | `on`: additionalContext. Never a decision. `off` turns it off. |

## The agents

Eleven agents from newdle 0.2.175, in `agents/`: `auditor`, `builder`, `changelog`,
`checker`, `debugger`, `planner`, `reader`, `research`, `scout`, `storyteller`, `summarizer`.
Each preloads the `output-types` skill (from the output-types plugin) and, where newdle did,
one `as2-skills` skill; both are sibling plugins in this marketplace and are installed
separately. `builder` and `beefy-builder` (newdle's larger-scope builder, not ported: its text
is shipyard-specific end to end) are the builder class by default. `builder` ends its report
with the `Stopped because:` line the stop warning looks for.

## Config

`${XDG_CONFIG_HOME:-~/.config}/delegation/config.json`; a missing file is the defaults. A
present file that is not JSON, or has a field of the wrong type, is ignored whole and said so
once per hook answer (`delegation <hook>: config ignored: <file>: <what>`), so a typo never
widens or narrows a gate.

```json
{
  "off": false,
  "builderClass": ["builder", "beefy-builder", "task", "sonic", "general-purpose"],
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
on OMP events: gates 1, 4 and 2 on the `task` tool call (every `tasks[]` entry; the first
failing one blocks the call, naming its index; the receipt is keyed on OMP's session id and
cwd the way pattern-check's own OMP adapter keys it); the stop warning on the `task` result
(`details.results[].output`, as additionalContext); and gate 3's twin on a `write` to an
`agent://` path. The ported hooks are Claude Code only.

The limit on OMP: OMP already errors a `write agent://<id>` to a peer that is not running, so
the twin only adds the instruction. A write to a parked peer is queued and the peer revived,
and whether it acts on the message is not knowable from the tool result, so a message to a
peer that has finished its work is not flagged.

## How it fails

| Piece | Fails how | Visible where | The person does |
|---|---|---|---|
| any hook | stdin not JSON; the handler throws; no answer in 4 s | one line in `${XDG_STATE_HOME:-~/.local/state}/delegation/errors.log`; a `systemMessage` `delegation <hook> failed open: …`; the call goes through unchecked | nothing for one line; a repeating line is a bug: open an issue with the line |
| session-start | the runner fault above | the session starts untaught; the gate still holds | nothing |
| spawn-gate | `tool_input.prompt` is not a string | the spawn is allowed; one line in `…/delegation/skipped.log` | nothing; the line is the trace that the gate was awake |
| spawn-gate gate 2 | the cwd is in no git repository, or the payload has no cwd | the spawn is allowed; one skipped.log line | run the spawn from inside the repository if the receipt is wanted |
| spawn-gate gate 2 | pattern-check is not installed | the deny names `<pattern-check plugin root>` and says to install it | install pattern-check, or set `requirePatternCheck: false` |
| send-message-check | the response has no `success` field (another host version) | nothing; the send's own result is the only signal | nothing |
| subagent-stop | `last_assistant_message` is absent (older host, or the agent ended on a tool call) | the warning says the report ended without the line | read the report; the warning is advisory |
| the OMP adapter | a handler throws | returns undefined (OMP would otherwise turn a throw into a block of every `task` call) | nothing |
| delegation-guard | the file is unreadable or binary; the state dir is unwritable | not counted, not flagged; the streak is lost, never the call | nothing |
| worktree-spawn-guard | git is missing, fails, or exceeds 3 s | nothing | nothing |
| repo-rules-inject | a rules file is unreadable | that file contributes nothing | nothing |
| config.json | not JSON, not an object, a wrong-typed field | defaults, plus one systemMessage naming the file and the field | fix the field the message names |

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
| `agents/debugger.md` | `agents/debugger.md` | `skills: debugging` (now `debugging-and-error-recovery`, the as2-skills name); the output-types reference path; "Honor shipyard and repo AGENTS.md" |
| `agents/planner.md` | `agents/planner.md` | `skills: planning` (now `spec-and-plan`, the as2-skills name); the output-types reference path; "Jo review gates" (now: engineering-user review gates) |
| `agents/reader.md` | `agents/reader.md` | the output-types reference path |
| `agents/research.md` | `agents/research.md` | "Newdle research specialist" and the beefy-research note in the description; "Newdle team"; "shipyard AGENTS.md verify-before-assuming rules" (now: the repository's); the output-types reference path |
| `agents/scout.md` | `agents/scout.md` | the output-types reference path |
| `agents/storyteller.md` | `agents/storyteller.md` | the `jo-deck` skill reference (now: a deck-building skill); `.ai/VOICE.md` (now: the repository's voice guide); "Newdle output" (now: customer-facing output); "Jo's decision" (now: the person's); the output-types reference path |
| `agents/summarizer.md` | `agents/summarizer.md` | nothing: the file had no repository-specific line |
| `hooks/delegation-guard.mjs` + `lib/git-cmd.mjs` (`segments`, `shellSurface`) | `hooks/delegation-guard.mjs`, `lib/shell.mjs` | the `ask` tier and `askOrDeny` (the ask-to-deny conversion for unsurfaceable contexts, with `lib/prompt-surface.mjs` and `lib/hook-scope.mjs`); the `tmpdir()/newdle-delegation-<key>.json` state file (now JSONL under the plugin's XDG state dir, swept after a day); the `newdle:` agent prefix (now any `plugin:` prefix); the decision-log citations. Fixed on the way: `grep -rn` was not seen as recursive (`-r` had to end the cluster); a quoted `\|` split the command before quotes were masked |
| `hooks/worktree-spawn-guard.mjs` | `hooks/worktree-spawn-guard.mjs` | the shipyard decision-log citations and the "shipyard root" naming (the check itself, a `repos/` holding independent git repositories, is unchanged); the deny-only answer (now `warn` default, `block` by config) |
| `hooks/repo-rules-inject.mjs` + `lib/repo-rules-walk.mjs` + `lib/budget-fit.mjs` | `hooks/repo-rules-inject.mjs`, `lib/repo-rules.mjs` | the `tmpdir()/newdle-repo-rules-<id>.json` state file (now under the plugin's XDG state dir); the shipyard-specific comments; `budget-fit-cli.mjs` (a CLI no hook called) was not ported |
| `agents/beefy-builder.md`, `agents/beefy-research.md` | not ported | both are shipyard-specific end to end (Newdle monorepo ownership, `.projects/` sync, Linear closing); `beefy-builder` stays in the default builder class so a repository that ships its own is gated |
