# ledger

A durable, id'd record of the questions an agent asks you and the choices it makes without
asking, kept in one SQLite file on your machine. The agent asks you in plain words and you
answer in plain words; it records each question as a `q-` row and records your reply against
it, and the ids stay on its side. Every unasked decision gets an `nt-` note. A CLI the agent
runs, a batch mode that applies a pasted block line by line, and five hooks that make the record
hard to skip: open questions and recent notes are injected at session start, the
AskUserQuestion tool is denied until the question has a row, `git push` and `gh pr create` are
denied until the session has a note saying why, and a reply is sent back once when it ends
without recording an answer you already gave, asks you something with no row, or states a
decision without a note.

The hooks are on in every folder until you turn them off for one (`/ledger:disable`). Every hook fails open:
the ledger never blocks a session because the ledger itself is broken.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ledger@jo-wolff-plugins
```

Needs Node 22.13 or later (`node:sqlite`; see *Node and `node:sqlite`* below). Zero config: the
database is created on first use at `~/.local/share/ledger/ledger.db`. Claude Code only in this
version; there is no OMP adapter.

## Turning it off, per project

Installing the plugin turns the hooks on everywhere: every session records. To stop a folder
from being recorded, type in a session there:

```
/ledger:disable
```

or run `node <plugin dir>/scripts/ledger.mjs disable` in the folder. Either writes
`.ledger.json` with `{"enabled": false}` there and never deletes it; `/ledger:enable` (or
`… enable`) sets it back to `true`. Delete the file yourself to return to the default. The hooks
look for that file in the session's cwd and every parent above it, so disabling a repo root
covers its packages. `"enabled": false` in the user file turns the hooks off everywhere, and a
project file with `"enabled": true` turns them back on under it. `LEDGER_ENABLED=1` or `=0` in
the environment overrides both files (handy for one session or for CI).

A disabled project costs one directory walk per hook and nothing else: no database is opened or
created, nothing is printed. The CLI itself always works; `enabled` only gates the hooks.

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

- `ask "<body>" --name <short> --options a,b --default a` whenever it needs your decision, then
  ask you in plain words without showing the id. `--ceiling <usd>` and `--about "<text>"` attach
  a spend limit or the thing the question concerns;
- `answer <q-id> <option>` as soon as you reply, with the option your words mean (or
  `withdraw <q-id>` if you set the question aside);
- `note "<text>"` for a choice it made without asking, and before any `git push` or `gh pr create` (what is being pushed and why);
- read `pending` and `log` when it resumes.

You answer the way you would answer anyone. If the agent ends a turn after your reply without
recording the answer, the Stop hook sends it back once with the ids to record.

Advanced: typing `approve q-…` (or `deny`, `withdraw`, any option word, followed by the id) into
a prompt records the answer directly through the UserPromptSubmit hook; you never need to.

## CLI

```
node <plugin dir>/scripts/ledger.mjs <verb> [args]      # one command
node <plugin dir>/scripts/ledger.mjs < lines.txt         # batch: one command per line
node <plugin dir>/scripts/ledger.mjs help                # the verb table, id grammar, batch rule
```

| Verb | Who | Effect |
|---|---|---|
| `ask "<body>" --name <short> --options a,b[,c] [--default a] [--deadline 2h\|<ISO>] [--kind question\|approval\|plan] [--allows "a: …; b: …"] [--ceiling <usd>] [--about "<text>"]` | agent | opens a question bound to the process cwd; prints `q-…` and its `pending` line, for the agent (the human is asked in plain words). Default is the first option. `--kind plan` needs `--allows` for every option. Repeating an open question (same body and options in the same folder) returns its id and writes nothing. |
| `answer <q-id> <word>` or `<word> <q-id>` | agent, on the human's reply | records the answer. The word must be one of the question's options or `withdraw`; anything else is refused with the option list and nothing is written. Same word twice → `already answered`, exit 0; a different word → refused naming the existing answer. |
| `approve <q-id>` / `deny <q-id>` | human | the answers `approve` / `deny` when the question offers them. |
| `<n> <word>` | human | the n-th line of `pending`, answered with that word. |
| `withdraw <q-id>` | either | state `withdrawn`, with an `nt-` note saying so (when the question offers `withdraw` as an option, it is recorded as that answer instead). |
| `extend <q-id>` | human | the answer `extend` when offered, else the deadline moves by its original span. |
| `note "<text>"` | agent | a note row for the cwd; prints `nt-…`. |
| `pending` | either | the paste-ready block, one `<default> <q-id>  # <name> · <body> · default <d> · also: <others> / withdraw` line per open question in the cwd or a parent of it, then `about …`, `ceiling $…`, `allows:` and `due …` lines when set. |
| `log [N]` | either | the last N notes, questions and answers for the cwd (default 20), newest first, across sessions. |
| `enable` / `disable` | human | writes `"enabled": true` / `false` to `.ledger.json` in the cwd, keeping any other keys in it. An unparsable existing file is refused, not overwritten. `/ledger:enable` and `/ledger:disable` run these in the session's folder. |
| `config` | either | the effective settings, where each came from, both config file paths, and whether the database file is the plugin's own or shared. |
| `help` | either | the table above, the id grammar, the batch rule. |

"Who" is advisory; the CLI does not refuse by caller. `--by <name>` overrides the recorded
actor (default `agent` for agent verbs, the configured `user` or your OS username for answers).
`--cwd <dir>` binds the command to another folder. `--json` prints the results as an array of
`{line, text, status, id, message}`.

Questions are scoped by folder: a question asked in `/repo` is open for `/repo/packages/api`
too, and the hooks and `pending` for `/repo/other` do not see it. There is no "workload" row:
the folder is the unit of work, and what is in flight there is the project's own business.

### Ids

`q-` question, `an-` answer, `nt-` note. An id is `<prefix>-<base36 timestamp><4 random
chars>`, e.g. `q-mvr3k2p9a1xq`. A prefix cut short (`approve q-`) is a refused line, not prose.

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
any was refused or prose, 2 when the database could not be opened, is read-only, or a write lock
outlasted the busy timeout (the lines not applied are named).

## Hooks

Every hook reads config once and exits 0 without opening the database when the project is not
enabled or its own switch is off. Every refusal names the exact command that lifts it.

### What is forced

Exactly four things, each with its off switch:

1. **Session rows.** Every session the hooks run in has a `cc_sessions` row with its start, end and reason (`hooks.sessionStart`, `hooks.sessionEnd`).
2. **Questions and answers.** The agent cannot use `AskUserQuestion` without an open `q-` row, cannot end a turn on a question while the session has no open row, and cannot end the turn after your reply while a question asked before it has no answer recorded (`forcing.denyAskWithoutRow`, `forcing.stopAskRule`).
3. **Push needs a note.** `git push` and `gh pr create` are denied until the session holds one `note` saying what is being pushed and why (`forcing.pushNeedsNote`).
4. **Decision needs a note.** A reply that states a decision (`forcing.decisionPhrases`) is sent back once unless a `note` was recorded in that turn (`forcing.stopDecisionRule`).

Nothing else is forced. The CLI tags its rows with the session through `LEDGER_SESSION_ID`,
which the SessionStart hook exports into the session's shell environment (`CLAUDE_ENV_FILE`);
a note made without it still counts for the session it was made in when it is in or around the
session's folder and dated after the session started.

| Event | Config key | What it does |
|---|---|---|
| SessionStart | `hooks.sessionStart` | Injects, in order and only when non-empty: open questions for the cwd (the `pending` block), the last `inject.notes` entries of `log`, and the exact invocation plus allow rule and a one-line verb summary. Capped at 9,000 characters; the log entries are cut first, never the questions. On `source: compact` the log section is dropped and the verb summary is one line. Records the session in `cc_sessions`. |
| PreToolUse | `hooks.preToolUse` | Runs on `AskUserQuestion` and `Bash` only. `AskUserQuestion` is denied while no question is open for the cwd (a question whose cwd equals the hook cwd or is an ancestor of it), with the reason `ledger: ask the question through the ledger first: \`… ask "<body>" --name <short> --options a,b --default a\`, then ask it; keep the q- id to yourself and record the reply with \`… answer <q-id> <option>\`.` A Bash command that runs `git push` or `gh pr create` (any simple command of a `&&`/`;`/`|`/newline chain; git's global options and a path on the binary are tolerated) is denied while the session has no `note`, with the reason `ledger: record what this push is before pushing: \`… note "<what this push is and why>"\` (one note in this session lifts the gate).` Before denying it proves the store can take a write (the remedy writes); if it cannot, the tool passes with a `systemMessage`. Other tools and other commands are never seen. |
| Stop | `hooks.stop` | Checks the final message once per turn (keyed on `prompt_id`; a second Stop in the same turn passes). Answer rule (`forcing.stopAskRule`): the Stop's `prompt_id` differs from the one stamped by the session's previous Stop (so you wrote since), and the session has open questions asked at or before that previous Stop → `{"decision":"block","reason":…}` listing them newest first and telling the agent to take the answer from your latest message and run `answer <q-id> <option>` (or `withdraw`); it clears once every such question is answered or withdrawn. Ask rule (same switch): after removing code blocks and inline code, a line ends with `?` and the session has no open question row → block telling the agent to `ask` first, then ask in plain words; messages under 40 substantive characters are not checked. Neither rule reads ids out of the reply. A session's questions are those tagged with its id, plus untagged ones asked in or around its folder after it started. Decision rule (`forcing.stopDecisionRule`): after also removing double-quoted spans, the message contains one of `forcing.decisionPhrases` as whole words and the session recorded no `note` during this turn → block telling the agent to `note`, then finish. Checked in the order answer, ask, decision. Every Stop stamps `cc_sessions.last_stop_at` and `last_stop_prompt`; "this turn" runs from the previous stamp (or the session start) to now. |
| SessionEnd | `hooks.sessionEnd` | Stamps `ended_at` and the reason on the session row. Touches nothing else. Prints nothing; errors go to the log. |
| UserPromptSubmit | `hooks.userPromptCommands` | When every non-blank line of the prompt is an id-bearing ledger line (`approve q-…`, `extend q-…`, an ordinal like `1 approve`) or `pending` / `log [N]` / `help`, applies them as a batch with `via = prompt-hook` and gives Claude the numbered results as `additionalContext` (you see the same block as a `systemMessage`). One prose line anywhere → nothing happens. Free-text verbs (`ask`, `note`) and `config` / `enable` / `disable` are never applied from a prompt. Never blocks the prompt. |

## Config

Three layers, each key resolved on its own: environment (`LEDGER_DB`, `LEDGER_ENABLED`,
`LEDGER_CONFIG` for the user file's path) over the project file (`.ledger.json`, found by walking
up from the cwd) over the user file (`${XDG_CONFIG_HOME:-~/.config}/ledger/config.json`) over the
defaults below. Both files are optional and take the same keys. A key of the wrong type falls
back to the next layer with one notice; unknown keys are ignored. `example.config.json` is the
defaults verbatim.

| Key | Default | Effect |
|---|---|---|
| `enabled` | `true` | whether the hooks run for this folder; `/ledger:disable` sets it to `false` in `.ledger.json` |
| `db` | `~/.local/share/ledger/ledger.db` | database path; `~` is your home, `XDG_DATA_HOME` is honoured when absolute. A configured `db` is never renamed or recreated: if it is corrupt the ledger reports it and fails open (see the fail-open table) |
| `user` | `null` | name recorded on answers; `null` means your OS username |
| `timezone` | `null` | zone for displayed times; `null` means the process's local zone (storage is UTC) |
| `hooks.sessionStart` | `true` | the SessionStart injection and session row |
| `hooks.preToolUse` | `true` | the AskUserQuestion gate |
| `hooks.stop` | `true` | the Stop check |
| `hooks.sessionEnd` | `true` | stamping the session row at session end |
| `hooks.userPromptCommands` | `true` | applying ledger lines typed into a prompt |
| `forcing.denyAskWithoutRow` | `true` | deny `AskUserQuestion` with no open question row |
| `forcing.stopAskRule` | `true` | send back a reply that ends without recording an answer the human already gave, or that asks a question while the session has no open row |
| `forcing.pushNeedsNote` | `true` | deny `git push` / `gh pr create` while the session has no note |
| `forcing.stopDecisionRule` | `true` | send back a reply that states a decision with no note recorded this turn |
| `forcing.decisionPhrases` | the nine phrases below | the phrases the decision rule looks for, whole words, any case |
| `inject.notes` | `5` | how many recent `log` entries SessionStart injects |

The default `forcing.decisionPhrases`: `I decided`, `decided to`, `assumption:`, `assuming`,
`going with`, `instead of`, `chose`, `I'll go with`, `trade-off`. A project file can replace the
list (`{"forcing": {"decisionPhrases": ["went with", "settled on"]}}`).

`node <plugin dir>/scripts/ledger.mjs config` prints the effective values and the source of each.

## Fail-open table

Every hook ends in exit 0. Exit code 2 is never used by a hook. On an unexpected error a hook
appends one line to `${XDG_STATE_HOME:-~/.local/state}/ledger/errors.log` and tells you in a
`systemMessage` where the event honours one. Each row below has a test in `test/`.

| Condition | CLI | SessionStart | PreToolUse | Stop | SessionEnd | UserPromptSubmit |
|---|---|---|---|---|---|---|
| database file missing | creates the directory and the schema, proceeds | same | same | same | same | same |
| database locked (busy timeout, one retry) | exit 2, `ledger: database busy at <path>; nothing applied` (lines already applied are named) | injects what it can read; session not recorded, one `systemMessage` | passes with `systemMessage` where it would deny (the `ask` or `note` it would demand cannot write); a tool it would pass anyway passes silently | passes without checking, `systemMessage` (the turn stamp is a write) | log only | lines report `not applied (database busy)`, one `systemMessage`, prompt proceeds |
| database read-only (file mode, mounted read-only) | reads work; a write is exit 2, `ledger: database read-only at <path>; nothing applied`; `enable`, `disable` and `help` never touch the database | injects what it can read; session not recorded, one `systemMessage` | same as locked | same as locked | log only | lines report `not applied (database read-only)`, one `systemMessage`, prompt proceeds |
| database corrupt, default path (no `db` configured) | moves it to `<path>.corrupt-<stamp>`, creates a fresh one, says so, proceeds | same, in `systemMessage` | same | same | rename and log only | same |
| database corrupt, configured path (`db` from env, project or user file) | exit 2, `ledger: database corrupt at <path>: <error>; nothing applied`; the file is not renamed, recreated or written | no injection, one `systemMessage` naming the path and the error | passes, `systemMessage` | passes without checking, `systemMessage` | log only | nothing applied, one `systemMessage`, prompt proceeds |
| config file unparsable or a key of the wrong type | next layer, one stderr line | next layer, `systemMessage` | next layer, `systemMessage` | next layer, `systemMessage` | next layer, log | next layer, `systemMessage` |
| unknown config key | ignored | | | | | |
| hook throws or stdin is not JSON | n/a | allow, nothing injected, `ledger SessionStart failed open: <msg>` | allow with `systemMessage` | pass with `systemMessage` | exit 0, log | pass with `systemMessage` |
| hook times out | n/a | Claude Code cancels it; no injection | the tool proceeds | the stop proceeds | cut off | the prompt proceeds |
| switch off in config | n/a | exit 0 before opening the database | same | same | same | same |
| project disabled (`"enabled": false`) | the CLI works regardless | exit 0 before opening the database, nothing printed | same | same | same | same |

## Inspecting the database

```
sqlite3 ~/.local/share/ledger/ledger.db
.tables
SELECT id, name, state, cwd FROM cc_questions WHERE state = 'open';
SELECT q.id, q.name, q.state, a.word FROM cc_questions q LEFT JOIN cc_answers a ON a.question_id = q.id;
SELECT id, kind, body, made_by, made_at FROM cc_notes ORDER BY made_at DESC LIMIT 20;
```

Tables: `cc_meta`, `cc_questions`, `cc_answers`, `cc_notes`, `cc_sessions`. Timestamps are ISO
8601 UTC.

### Sharing the file with another tool

Every table the plugin owns is prefixed `cc_`, and its schema version is a row in `cc_meta`
(`key = 'schema_version'`), not `PRAGMA user_version`. So `db` can point at a SQLite file another
tool already uses: the plugin adds its `cc_` tables beside the others, migrates only those,
never reads or writes a table it does not own, and leaves `user_version` to the other tool.
`config` reports `shared file` when it sees foreign tables and `own file` otherwise. The file
must be a real SQLite database the plugin can write (WAL journal mode is set on open); a file
it cannot write is the read-only row above, and a file that does not open as a database is the
configured-path corrupt row: reported, never moved.

## Node and `node:sqlite`

The store is Node's built-in `node:sqlite`, so the plugin has no dependencies to install. It
needs Node 22.13 or later, where the module no longer needs a flag. The module is still marked
experimental on Node 22 and 24; its warning is silenced around the plugin's own import of it and
nowhere else. API drift across Node majors is the plugin's main maintenance risk; CI runs on
Node 24.

## Known gaps

- The Stop rules look only at the final message; a question asked and withdrawn mid-turn is not seen, and a decision stated in an earlier message of the same turn is not either.
- The decision rule is a phrase list. A decision worded outside the list passes; a phrase used in a different sense ("instead of X, the test does Y") blocks once. Tune `forcing.decisionPhrases` per project.
- The push gate reads the Bash command text. A push run from a script file or an alias is not seen; a `git push` inside a quoted string that never runs is.
- A ceiling on a question is recorded and shown, never metered: nothing stops at the ceiling.
- Disabling is per folder tree, not per repository: a `.ledger.json` with `"enabled": false` in your home directory would disable every project under it.
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
