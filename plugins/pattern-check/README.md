# pattern-check

Before an agent does big work in a repository, it has to look for the repository's existing way of
doing each thing it is about to add, decide reuse, replace, or new-with-reason for each, and write
that down. Two hooks hold the work until it has, on Claude Code and on OMP.

The problem it answers: a design review that asks "where did this introduce a new pattern when an
existing one served?" keeps coming back with a long list. Agents start writing before they have
read what is already there. This plugin makes the reading mandatory and the result inspectable.

## What it does

- **The skill** (`skills/pattern-check/SKILL.md`) is the method: list every new piece, then for
  each one grep the repository for its nouns and verbs, list what is registered beside it in the
  same router, registry or directory, read the hits, and read the conventions files if present.
  Each piece ends as `reuse`, `replace`, or `new` with a reason, and with five columns saying how
  it fails, filled from its error paths.
- **The script** (`scripts/pattern-check.mjs`) opens the receipt, records the table, and shows
  status. The receipt is Markdown at `<repo>/.pattern-check/<session>.md`, with a copy in the
  plugin's state directory.
- **PreToolUse hook**: counts the distinct files a session touches through Edit, Write,
  MultiEdit and NotebookEdit (and the obvious shell writes into the repository). From the Nth
  distinct file on (N is 3 by default), it denies those tools and the Bash commands
  `git commit`, `gh pr create`, `>`/`>>` redirects, `sed -i` and `tee` into the repository,
  until the receipt exists. The deny text names the exact command to run. Under N files it
  never fires.
- **Stop hook**: refuses, once, a reply that proposes a plan or design when the session has no
  receipt. The refusal asks both questions, what exists already and how does it fail, and names
  the command.

Both hooks fail open on the plugin's own faults. Empty or malformed stdin, stdin not closed within
2 s, a state file that does not parse, a config that does not, an unwritable state directory, a
thrown error: the hook exits 0, the call goes through, a one-line warning is shown (Claude Code's
`systemMessage`), and one line naming the hook file and the reason is appended to
`<state dir>/errors.log`. When errors.log itself cannot be written the warning says so. Only the
agent's omission, no receipt, denies. Rerunning a hook on the same input is safe; hooks never
retry; each has a 5 s timeout in `hooks.json`.

## Install

Claude Code:

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install pattern-check@jo-wolff-plugins
```

From a shell: `claude plugin marketplace add thewolff/jo-wolff-plugins` then
`claude plugin install pattern-check@jo-wolff-plugins`.

Node 18 or later is needed on `PATH`; the hooks and the script are plain Node ESM with no
dependencies.

OMP, from a shell:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install pattern-check@jo-wolff-plugins
```

Inside a running OMP session use `/marketplace add` and `/marketplace install` with the same
arguments.

### On OMP

OMP does not run `hooks/hooks.json`. The install registers `omp/pattern-check-omp.ts` instead,
which feeds OMP's events to the same two hook functions:

- `tool_call` for `edit` (including a hashline patch naming several files), `write` and `bash`
  goes to the PreToolUse hook; a deny becomes a blocked tool call with the same text.
- `session_stop` goes to the Stop hook; a refusal continues the turn with the same text, once per
  turn.

The session key is OMP's session id, so the counter, the receipt and the refusal record are the
files a Claude Code hook would use for that id, and the config and off switches are the same
files. The adapter fails open: a throw inside it lets the call or the stop through and shows one
warning. Tools that write without naming the file in their input (`ast_edit`, `eval`) are not
counted; the commit and PR blocks remain the backstop. Loading routes, the event table and the
reversal are in [`omp/REGISTRATION.md`](omp/REGISTRATION.md).

## Using it

At the start of big work, the agent runs:

```sh
node "<plugin root>/scripts/pattern-check.mjs" open "<what you are about to build>"
```

does the search the skill describes, and records the table:

```sh
cat <<'EOF' | node "<plugin root>/scripts/pattern-check.mjs" record
| new piece | existing pattern (file:line) | reuse / replace / new | reason | fails how | next step | restart-safe | bounded | evidence kept |
|---|---|---|---|---|---|---|---|---|
| retry helper | src/net/retry.ts:12 | reuse | same backoff, already exported | gives up after the last attempt and throws RetryExhausted; the job runner logs it at src/jobs/run.ts:88 | the log line names the upstream to check | yes: each attempt is a GET | 5 attempts, 30 s total (src/net/retry.ts:14) | the job's error row in jobs.failures |
| webhook parser | (none: grep webhook, inbound, signature in src/; read src/net/) | new | only an outbound client exists, it parses nothing | throws WebhookError; the router answers 400 and logs the request id | the 400 body names the field to fix | yes: parsing is pure | n/a: no retries, one parse per request | the access log line with the request id |
EOF
```

Rows can also be given as `--row "piece | pattern | decision | reason | fails how | next step |
restart-safe | bounded | evidence kept"`, one per row. When the work adds no new piece at all,
the receipt is one line:

```sh
node "<plugin root>/scripts/pattern-check.mjs" record --no-new-pieces "two copy edits in existing files"
```

`record` refuses an empty table, a decision other than `reuse`, `replace` or `new`, a `new` row
without a reason, a `reuse` or `replace` row without a `file:line`, and a row whose fail columns
are missing, empty, a placeholder (`-`, `?`, `TBD`, `todo`, `unknown`), or `n/a` without a reason;
the message names the row and the column. Nothing is written on refusal. `status` prints the
session, the files counted so far, the receipt path, and the config files in effect.

### The fail columns

The first four columns answer "what exists already". The last five answer "how does it fail",
before the piece is written, so a review can later check the code against them.

| column | what it holds |
|---|---|
| `fails how` | What breaks, and what the operator sees: where it is logged or surfaced (a log file, a status line, an HTTP status, a warning). |
| `next step` | What the failure message tells the reader to do. |
| `restart-safe` | `yes` or `no`, then why: is rerunning after a crash halfway through safe? |
| `bounded` | The retry or deadline bound (`3 attempts, 10 s`), or `n/a: <why>`. |
| `evidence kept` | What survives cleanup for the person debugging it: log lines, files, rows. |

Every cell must say something. `n/a` is accepted only with a reason after it (`n/a: pure
function, nothing to retry`). A literal pipe inside a cell is written `\|`.

Receipts written by 0.1 and 0.2 have four columns. They still count: the hooks only check that a
receipt exists for the session. A new receipt needs all nine.

In skill content `<plugin root>` is written `${CLAUDE_PLUGIN_ROOT}`, which Claude Code substitutes
when the skill loads; the hooks print the resolved path in their deny texts.

### How the script knows the session

Hooks receive `session_id`; the Bash tool that runs the script does not. The PreToolUse hook
records the session it saw for the repository on every call, and it fires on the Bash call that
runs the script, so a plain `record` finds the right session. The deny and refusal texts include
`--session <key>` anyway, so the command they name is exact even when two sessions share one
repository. `PATTERN_CHECK_SESSION` in the environment also works.

When a hook payload carries no usable `session_id`, the session is keyed by its working directory
and the hooks say so in a warning. Two sessions in that directory then share a counter and a
receipt.

### The receipt in the repository

`.pattern-check/` is created untracked. The script says so and suggests adding `.pattern-check/`
to `.gitignore` or `.git/info/exclude`; it never edits either. Committing receipts is a valid
choice too: they are a record of what was searched.

## Configuration

Zero configuration works: threshold 3, both hooks on, receipts in `.pattern-check/`, no extra
matchers.

Two files, both optional, both JSON:

- user: `${XDG_CONFIG_HOME:-$HOME/.config}/pattern-check/config.json`
- repository: the nearest `.pattern-check.json` in the working directory or any directory above it

The repository file wins for a key it sets; the user file for a key it leaves out; the default
otherwise. `denyCommands` is additive: the two lists are concatenated.

```json
{
  "threshold": 3,
  "denyCommands": ["^terraform apply", "^kubectl apply"],
  "receiptDir": ".pattern-check",
  "hooks": { "preToolUse": true, "stop": true }
}
```

| key | type | default | meaning |
|---|---|---|---|
| `threshold` | integer, at least 1 | `3` | The Nth distinct file is denied. Files 1 to N-1 are counted and allowed. |
| `denyCommands` | array of regular expression sources | `[]` | Extra Bash commands to deny once the session is held, tested against the whole command string with JavaScript `RegExp`. |
| `receiptDir` | relative path, no `..` | `".pattern-check"` | Where the receipt goes, under the repository root. |
| `hooks.preToolUse` | boolean | `true` | The counter and the denials. |
| `hooks.stop` | boolean | `true` | The plan-proposal refusal. |

A file that does not parse, or a key of the wrong shape, falls back to the default for that key
and the hooks print one warning line naming the file and the key. The call goes through.

### State

`${XDG_STATE_HOME:-$HOME/.local/state}/pattern-check/` holds, per session key: the distinct
files counted (`sessions/<key>.json`), a copy of the receipt (`receipts/<key>.md`), the refusal
loop guard (`stop/<key>`), per repository the session last seen there (`current/<hash>`), and
`errors.log`, one line per hook fault (timestamp, hook file, reason), rotated to `errors.log.1`
past 1 MB. Every state file is written to a temporary name and renamed into place, so a hook
killed mid-write leaves the previous file. Delete the directory to reset everything.

## The honest gap

The Bash matchers catch the obvious write forms and nothing else. They read the command through a
small shell lexer: a `>` counts only as a shell operator, never inside quotes, `${…}`, `$(…)`,
backticks, a heredoc body, `[[ … ]]` or `(( … ))`, and never as part of `>=`, `=>`, `->` or
`<>`. A redirect, `tee` or `sed -i` whose target holds an expansion (`> "$OUT"`) is not counted,
because its path is not known before the shell runs; once the session is held it is denied, and
the deny says the target could not be read statically. A write whose every target is known and
outside the repository is never denied. Wrappers (`sudo -u root`, `env -i`, `nice -n 5`) and
control words (`then`, `do`, `!`) in front of `tee` or `sed` are skipped. A `python -c`,
`perl -pi`, `cp`, `mv`, `install`, `dd`, a script that writes from inside, a write inside a
process substitution (`>(tee x)`), a redirect inside `$(…)`, `eval` or `sh -c '…'` is neither
counted nor denied. `git commit` and `gh pr create` are the backstop:
once a session is held (it reached the threshold through counted writes), committing or opening
the PR is denied however the files got written; they are matched as text, so a quoted mention
(`echo 'git commit'`) is denied too. A session that writes everything through uncaught forms and
never reaches the threshold is not held, and its commit goes through.

The Stop hook's "proposes a plan" test is a fixed list of signals (an ask-graham `start now` or
`later` verdict; a heading or bold label such as plan, design, proposal, approach, architecture,
implementation plan, next steps; openers such as "I propose", "Here's the plan", "The plan is").
A plan written without any of those shapes is not refused; the PreToolUse counter catches that
work when the writes start. A reply that quotes someone else's plan is refused once.

The judgement of "same job" is the agent's. The skill mandates the reading and the table; it does
not find the match for you.

## With ask-graham

ask-graham's verdict step runs this check before `start now` or `later` on any ask bigger than two
minutes, so a build decision carries the table of what already exists. The two plugins are
independent: either installs without the other.

## Tests

```sh
cd plugins/pattern-check && node --test
```

Four layers, all in that one command; every spawned process has a 5 s timeout, so a hang fails.

- **Units** (`scripts/lib/*.test.mjs`): the shell lexer and matchers, including the two real
  commands 0.2.0 miscounted (`test-fixtures/real-commands.mjs`); the receipt parser and its fail
  columns, `n/a` rules and four-column back-compat; the hook runner's stdin, deadline and
  errors.log handling; config, state, context and the plan detector.
- **Hooks as processes** (`hooks/*.test.mjs`): each hook spawned with the JSON Claude Code sends
  (`session_id`, `cwd`, `tool_name`, `tool_input`; Stop's `stop_hook_active` and
  `last_assistant_message`). Exit 0 and allow on empty stdin, malformed JSON, a non-object
  payload, stdin held open past the deadline, an unwritable state directory, a corrupt state
  file, a missing or corrupt config, each with its errors.log line. Edit, Write, MultiEdit and
  NotebookEdit counted from their real field names.
- **End to end** (`e2e.test.mjs`): a `git init` repository and private state; files 1 and 2
  allowed, the 3rd denied with the exact command; the Stop hook refuses a design reply once and
  never twice; the command run through `/bin/sh` refuses a table without fail columns and records
  a full one; the 3rd and 4th files, a commit and a new design reply then go through.
- **Script** (`scripts/pattern-check.test.mjs`), **manifests** (`manifest.test.mjs`) and the
  **OMP adapter** (`omp/pattern-check-omp.test.mjs`, a fake `pi` and `ctx`). The adapter test
  imports the `.ts` file through Node's built-in type stripping; CI runs the suite on Node 24.

A live headless run (`claude -p --plugin-dir`) is not part of the suite; it costs a model call.

## Changelog

### 0.3.0

- Fix: the redirect matcher counted `>=2.2.3,` in a heredoc body and `${n:-ABSENT}"` in a quoted
  `->` as files in the repository. Bash write forms are now read through a shell lexer
  (`scripts/lib/matchers.mjs`); the two real commands are regression tests.
- The receipt gains five fail columns per piece: `fails how`, `next step`, `restart-safe`,
  `bounded`, `evidence kept`. `record` refuses a row whose fail cells are empty, placeholders, or
  `n/a` without a reason. Four-column receipts already written still count.
- The deny and Stop refusal texts ask both questions: what exists already, and how does it fail.
- Hook faults (empty or malformed stdin, stdin not closed within 2 s, unwritable state, bad
  config, a throw) are appended to `<state dir>/errors.log` as well as shown; `hooks.json` sets a
  5 s timeout; NotebookEdit (`notebook_path`) is counted.
- Tests: hooks as spawned processes with fault inputs, an end-to-end test over a real git
  repository.

### 0.2.0

OMP adapter (`omp/pattern-check-omp.ts`, declared in `package.json` under `omp.extensions`, with
`.omp-plugin/plugin.json`): the PreToolUse counter on OMP's `tool_call` and the Stop refusal on
`session_stop`, through the hooks' own `handle` functions and state. `omp/REGISTRATION.md` covers
loading and reversal.

### 0.1.0

First release: the skill, the script (`open`, `record`, `status`), the PreToolUse counter with
Edit/Write/MultiEdit and Bash denials, the Stop refusal, user and repository config, tests.
