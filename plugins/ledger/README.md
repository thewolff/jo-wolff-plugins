# ledger

A durable, id'd record of a thread's work, kept in one SQLite file on your machine: workloads the
agent opens and closes with a reason, questions it asks you with one-word answers, decisions it
made without asking, and cost ceilings you set. A CLI the agent runs, a batch mode that applies
a pasted block line by line, and five hooks that make the record hard to skip: open items are
injected at session start, pushes and PR creation and writes outside the folder are denied while
no workload is open, a reply that asks you something without a question row or calls open work
done is sent back once, open work is parked when the session ends, and `approve q-…` lines you
type into a prompt are applied before Claude reads them.

Every hook fails open. The ledger never blocks a session because the ledger itself is broken.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ledger@jo-wolff-plugins
```

Needs Node 22.13 or later (`node:sqlite`; see *Node and `node:sqlite`* below). Zero config: the
database is created on first use at `~/.local/share/ledger/ledger.db`. Claude Code only in this
version; there is no OMP adapter.

## Will it ask me about permissions every five seconds?

No, provided one allow rule is in place. The agent reaches the ledger through one command,
`node <plugin dir>/scripts/ledger.mjs <verb> …`. The SessionStart hook tells the agent to run
exactly that command, with the literal path, and prints the matching allow rule, which is one
line of the shape:

```
Bash(node /path/to/ledger/scripts/ledger.mjs *)
```

Put it in `permissions.allow` of `~/.claude/settings.json` (every project) or
`.claude/settings.json` (one project). Installed from the marketplace, the path contains a
version segment that changes on update, so the rule the hook prints wildcards it:
`Bash(node /…/plugins/cache/jo-wolff-plugins/ledger/*/scripts/ledger.mjs *)`. Copy the rule
from the first SessionStart injection rather than typing it.

Nothing else in the plugin asks. The hooks never return `permissionDecision: "ask"`, never exit
with code 2, and never insert a question of their own; `test/no-prompts.test.mjs` holds that.

## What the agent does with it

The skill (`skills/ledger/SKILL.md`) tells the agent to:

- `open "<title>"` before the first write in a folder;
- `ask "<body>" --name <short> --options a,b --default a` whenever it needs your decision, and
  end its message with the `pending` line for that question (the q-id, the default, what each
  option allows);
- `decide "<text>"` for a choice it made without asking;
- `close <wl-id> <reason>` or `park <wl-id> <reason>` before it says the work is done.

You answer by typing the line back: `approve q-…`, `deny q-…`, `withdraw q-…`, or any option
word the question offered. The UserPromptSubmit hook applies the line and shows the agent the
result; you can also paste the whole `pending` block with your answers.

## CLI

```
node <plugin dir>/scripts/ledger.mjs <verb> [args]      # one command
node <plugin dir>/scripts/ledger.mjs < lines.txt         # batch: one command per line
node <plugin dir>/scripts/ledger.mjs help                # the verb table, id grammar, batch rule
```

| Verb | Who | Effect |
|---|---|---|
| `open "<title>" [--stakes throwaway\|normal\|production]` | agent | opens a workload bound to the process cwd; prints `wl-…`. Same title already open in this cwd → returns that id, writes nothing. |
| `open <wl-id>` | either | resumes a parked or halted workload (`reopen` decision row). |
| `close <wl-id> <reason>` | either | closes; only a reason is required. Open questions on it are withdrawn in the same transaction and listed. Already closed → `already closed`, exit 0. |
| `park <wl-id> <reason>` | either | sets it aside; the gate treats it as closed until `open wl-…`. |
| `ask "<body>" --name <short> --options a,b[,c] [--default a] [--deadline 2h\|<ISO>] [--kind question\|approval\|plan] [--allows "a: …; b: …"] [--wl <id>]` | agent | opens a question on the cwd's open workload; prints `q-…`. Default is the first option. `--kind plan` needs `--allows` for every option. Repeating an open question returns its id. |
| `<word> <q-id>` or `answer <q-id> <word>` | human | records the answer. The word must be one of the question's options or `withdraw`; anything else is refused with the option list and nothing is written. Same word twice → `already answered`, exit 0; a different word → refused naming the existing answer. Question on a closed workload → `closed, nothing to decide`, exit 0. |
| `approve <q-id>` / `deny <q-id>` | human | the answers `approve` / `deny` when the question offers them. |
| `withdraw <q-id>` / `withdraw <wl-id>` | either | question: state `withdrawn`. Workload: closed with reason `withdrawn`; refused while it has open questions. |
| `halt <wl-id>` | human | status `halted`; the gate denies until `open wl-…`. |
| `ceiling <usd> [<hours>] <wl-id>` | human | records a ceiling; the first one on a workload sets the `extend` block size. Recorded and shown, not metered. |
| `extend <wl-id>` / `extend <q-id>` | human | workload: ceiling plus one block (refused with no ceiling). Question: the answer `extend` when offered, else the deadline moves by its original span. |
| `decide "<text>" [--wl <id>]` | agent | a decision row; prints `de-…`. |
| `pending` | either | the paste-ready block, one `<default> <q-id>  # <name> · <body> · default <d> · also: <others> / withdraw` line per open question, `allows:` lines for plan questions, `due …` when there is a deadline. |
| `stale [N]` | either | open or parked workloads untouched for N days (config `stale.days`), oldest first, with the line that clears each. |
| `config` | either | the effective settings and where each came from. |
| `help` | either | the table above, the id grammar, the batch rule. |

"Who" is advisory; the CLI does not refuse by caller. `--by <name>` overrides the recorded
actor (default `agent` for agent verbs, the configured `user` or your OS username for answers).
`--json` prints the results as an array of `{line, text, status, id, message}`.

### Ids

`wl-` workload, `q-` question, `an-` answer, `de-` decision, `ce-` ceiling. An id is
`<prefix>-<base36 timestamp><4 random chars>`, e.g. `q-mvr3k2p9a1xq`. A prefix cut short
(`approve q-`) is a refused line, not prose.

### Lines, batches and prose

A line is a command only when the whole line matches a verb shape (trailing ` # comment`
dropped). Anything else is prose: `not a command`, plus `closest: <word>` when the first token is
within edit distance 2 of a verb or an open question's option word. Prose is never written
anywhere. A bare option word with no id applies when exactly one open question in the cwd offers
it; several → `which one?` with their `pending` lines.

Batch mode (no verb, stdin piped) applies lines one at a time, in order, each in its own
transaction. A refused line is reported and the next line still runs, so a pasted block with
one bad line applies the other lines. Output is one line per input line, numbered against the
paste (`<n>: ok …`, `<n>: refused …`, `<n>: not a command…`, `<n>: skipped (blank)`), then
`applied <a>, refused <r>, not commands <p>`. Exit 0 when every non-blank line applied, 1 when
any was refused or prose, 2 when the database could not be opened or a write lock outlasted the
busy timeout (the lines not applied are named).

## Hooks

Every hook reads config once and exits 0 without opening the database when its switch is off.
Every refusal names the exact command that lifts it.

| Event | Config key | What it does |
|---|---|---|
| SessionStart | `hooks.sessionStart` | Injects, in order and only when non-empty: open questions for the cwd (the `pending` block), open workloads (parked and halted ones with their resume line), the last `inject.decisions` decisions, a one-line warning when no workload is open, and the exact invocation plus allow rule and a one-line verb summary. Capped at 9,000 characters; decisions are cut first, then workloads, never the questions. On `source: compact` the decisions section is dropped and the verb summary is one line. |
| PreToolUse | `hooks.preToolUse` | Runs on `Bash` (only when the command starts with `git` or `gh`), on `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and on `AskUserQuestion`. Denies per the table below while no workload is open for the cwd (an open workload whose cwd equals the hook cwd or is an ancestor of it). When one is open, everything passes with no output. |
| Stop | `hooks.stop` | Stamps the open workload's `last_seen_at`, then checks the final message once per turn (keyed on `prompt_id`; a second Stop in the same turn passes): the two rules below. Blocks with `{"decision":"block","reason":…}`. Messages under 40 substantive characters are never checked. |
| SessionEnd | `hooks.sessionEnd` | Parks every open workload this session opened (or, when no session opened it, any open one for the cwd) with `status_reason = "session ended (<reason>)"`, `status_by = "hook:SessionEnd"`, one `park` decision each. Never closes. Prints nothing; errors go to the log. |
| UserPromptSubmit | `hooks.userPromptCommands` | When every non-blank line of the prompt is an id-bearing ledger line (`approve q-…`, `close wl-… <reason>`, `ceiling 50 wl-…`, an ordinal like `1 approve`) or `pending` / `stale` / `help`, applies them as a batch with `via = prompt-hook` and gives Claude the numbered results as `additionalContext` (you see the same block as a `systemMessage`). One prose line anywhere → nothing happens. Free-text verbs (`open`, `ask`, `decide`) are the agent's and are never applied from a prompt. Never blocks the prompt. |

### PreToolUse rules

| Config key | Trigger | Deny reason |
|---|---|---|
| `forcing.denyPush` | a `git push` subcommand (the command is split on `&&`, `\|\|`, `;`, `\|`, newlines and `$( … )`; leading `VAR=value` and `git -C <dir>` are skipped) | `ledger: git push denied — no open workload for <cwd>. Run \`node …/ledger.mjs open "<what you are doing>"\` (or \`… open wl-…\` to resume), then retry.` |
| `forcing.denyPrCreate` | a `gh pr create` subcommand | the same text for `gh pr create` |
| `forcing.denyWritesOutsideCwd` | `file_path` (or `notebook_path`) resolves outside the hook cwd, symlinks resolved on both sides, a not-yet-existing path resolved through its nearest existing ancestor. Paths under the OS temp dir, `/tmp`, and the session's `scratchpad_dir` are exempt. | `ledger: write to <path> is outside <cwd> and no workload is open here. \`… open "<what you are doing>"\` lifts this.` |
| `forcing.denyAskWithoutRow` | `AskUserQuestion` with no open `q-` row on the gate workload | `ledger: ask the question through the ledger first: \`… ask "<body>" --name <short> --options a,b --default a\`, then put the q-id in the question text.` |

A halted workload is named in the reason: `halted by <de-…> (<reason>); \`… open wl-…\` lifts
it`. Only `gh pr create` is matched; a PR created through `gh api` is a known gap.

### Stop rules

| Config key | Trigger on the final message | Reason |
|---|---|---|
| `forcing.stopAskRule` | after removing code blocks and inline code, a line ends with `?` and the message names no `q-` id that is an open question on the gate workload | `ledger: this turn asks the human a question but names no open question row. Run \`… ask "<the question>" --name <short> --options <a,b> --default <a>\` and end the message with the \`pending\` line for it …` |
| `forcing.stopDoneRule` | a line names a `wl-` id that is open and contains `done`, `complete`, `completed`, `finished`, `shipped`, `landed`, `merged` or `closed` | `ledger: wl-… reads as finished but is still open. \`… close wl-… <reason>\` or \`… park wl-… <reason>\`, or keep working and say so.` |

## Config

`${XDG_CONFIG_HOME:-~/.config}/ledger/config.json`, optional. Each key is resolved on its own:
`LEDGER_DB` (database path) and `LEDGER_CONFIG` (config file path) environment variables first,
then the file, then the defaults below. A key of the wrong type falls back to its default with
one notice; unknown keys are ignored. `example.config.json` is the defaults verbatim.

| Key | Default | Effect |
|---|---|---|
| `db` | `~/.local/share/ledger/ledger.db` | database path; `~` is your home, `XDG_DATA_HOME` is honoured when absolute |
| `user` | `null` | name recorded on answers; `null` means your OS username |
| `timezone` | `null` | zone for displayed times; `null` means the process's local zone (storage is UTC) |
| `hooks.sessionStart` | `true` | the SessionStart injection |
| `hooks.preToolUse` | `true` | the whole PreToolUse gate |
| `hooks.stop` | `true` | the Stop check (and the `last_seen_at` stamp) |
| `hooks.sessionEnd` | `true` | parking open workloads at session end |
| `hooks.userPromptCommands` | `true` | applying ledger lines typed into a prompt |
| `forcing.denyPush` | `true` | deny `git push` with no open workload |
| `forcing.denyPrCreate` | `true` | deny `gh pr create` with no open workload |
| `forcing.denyWritesOutsideCwd` | `true` | deny writes outside the folder with no open workload |
| `forcing.denyAskWithoutRow` | `true` | deny `AskUserQuestion` with no open question row |
| `forcing.stopAskRule` | `true` | send back a reply that asks a question without a row |
| `forcing.stopDoneRule` | `true` | send back a reply that calls an open workload done |
| `inject.decisions` | `5` | how many recent decisions SessionStart injects |
| `stale.days` | `7` | the `stale` threshold |

`node <plugin dir>/scripts/ledger.mjs config` prints the effective values and the source of each.

## Fail-open table

Every hook ends in exit 0. Exit code 2 is never used by a hook. On an unexpected error a hook
appends one line to `${XDG_STATE_HOME:-~/.local/state}/ledger/errors.log` and tells you in a
`systemMessage` where the event honours one. Each row below has a test in `test/`.

| Condition | CLI | SessionStart | PreToolUse | Stop | SessionEnd | UserPromptSubmit |
|---|---|---|---|---|---|---|
| database file missing | creates the directory and the schema, proceeds | same | same | same | same | same |
| database locked (busy timeout, one retry) | exit 2, `ledger: database busy at <path>; nothing applied` (lines already applied are named) | injects what it can read; session not recorded, one `systemMessage` | the gate still evaluates (it only reads) | passes without checking, `systemMessage` | log only | lines report `not applied (database busy)`, one `systemMessage`, prompt proceeds |
| database corrupt | moves it to `<path>.corrupt-<stamp>`, creates a fresh one, says so, proceeds | same, in `systemMessage` | same | same | rename and log only | same |
| config file unparsable or a key of the wrong type | defaults, one stderr line | defaults, `systemMessage` | defaults, `systemMessage` | defaults, `systemMessage` | defaults, log | defaults, `systemMessage` |
| unknown config key | ignored | | | | | |
| hook throws or stdin is not JSON | n/a | allow, nothing injected, `ledger SessionStart failed open: <msg>` | allow with `systemMessage` | pass with `systemMessage` | exit 0, log | pass with `systemMessage` |
| hook times out | n/a | Claude Code cancels it; no injection | the tool proceeds | the stop proceeds | cut off | the prompt proceeds |
| switch off in config | n/a | exit 0 before opening the database | same | same | same | same |

## Inspecting the database

```
sqlite3 ~/.local/share/ledger/ledger.db
.tables
SELECT id, title, status, cwd FROM workloads WHERE status = 'open';
SELECT q.id, q.name, q.state, a.word FROM questions q LEFT JOIN answers a ON a.question_id = q.id;
```

Tables: `workloads`, `questions`, `answers`, `decisions`, `ceilings`, `sessions`. Timestamps are
ISO 8601 UTC. The schema is versioned (`PRAGMA user_version`) and migrated forward on open.

## Node and `node:sqlite`

The store is Node's built-in `node:sqlite`, so the plugin has no dependencies to install. It
needs Node 22.13 or later, where the module no longer needs a flag. The module is still marked
experimental on Node 22 and 24; its warning is silenced around the plugin's own import of it and
nowhere else. API drift across Node majors is the plugin's main maintenance risk; CI runs on
Node 24.

## Known gaps

- Only `gh pr create` is matched; a PR created through `gh api` or a web UI is not seen.
- Ceilings are recorded and shown, never metered: nothing stops at the ceiling.
- The Stop rules look only at the final message; a question asked and withdrawn mid-turn is not seen.
- Claude Code only. On OMP the skill installs but no hook runs.

## Developing

```
cd plugins/ledger
node --test
```

Tests use a sandboxed `HOME`, `XDG_*` and `LEDGER_*` so they never touch your ledger. The
`LEDGER_CWD` and `LEDGER_BUSY_TIMEOUT_MS` environment variables exist for the tests.

## License

MIT.
