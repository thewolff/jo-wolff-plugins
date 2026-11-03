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
  Each piece ends as `reuse`, `replace`, or `new` with a reason.
- **The script** (`scripts/pattern-check.mjs`) opens the receipt, records the table, and shows
  status. The receipt is Markdown at `<repo>/.pattern-check/<session>.md`, with a copy in the
  plugin's state directory.
- **PreToolUse hook**: counts the distinct files a session touches through Edit, Write and
  MultiEdit (and the obvious shell writes into the repository). From the Nth distinct file on
  (N is 3 by default), it denies those tools and the Bash commands `git commit`, `gh pr create`,
  `>`/`>>` redirects, `sed -i` and `tee` into the repository, until the receipt exists. The deny
  text names the exact command to run. Under N files it never fires.
- **Stop hook**: refuses, once, a reply that proposes a plan or design when the session has no
  receipt. The refusal names the command.

Both hooks fail open on the plugin's own faults. A state file that does not parse, a config that
does not, an unwritable state directory, a thrown error: the call goes through and a one-line
warning is shown. Only the agent's omission, no receipt, denies.

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
| new piece | existing pattern (file:line) | reuse / replace / new | reason |
|---|---|---|---|
| retry helper | src/net/retry.ts:12 | reuse | same backoff, already exported |
| webhook parser | (none: grep webhook, inbound, signature in src/; read src/net/) | new | only an outbound client exists, it parses nothing |
EOF
```

Rows can also be given as `--row "piece | pattern | decision | reason"`, one per row. When the
work adds no new piece at all, the receipt is one line:

```sh
node "<plugin root>/scripts/pattern-check.mjs" record --no-new-pieces "two copy edits in existing files"
```

`record` refuses an empty table, a decision other than `reuse`, `replace` or `new`, a `new` row
without a reason, and a `reuse` or `replace` row without a `file:line`; nothing is written on
refusal. `status` prints the session, the files counted so far, the receipt path, and the config
files in effect.

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
loop guard (`stop/<key>`), and per repository the session last seen there (`current/<hash>`).
Every file is written to a temporary name and renamed into place, so a hook killed mid-write
leaves the previous file. Delete the directory to reset everything.

## The honest gap

The Bash matchers catch the obvious write forms and nothing else. A `python -c`, `perl -pi`,
`cp`, `mv`, `install`, `dd`, a script that writes from inside, or a redirect the parser misreads
is neither counted nor denied. `git commit` and `gh pr create` are the backstop: once a session is
held (it reached the threshold through counted writes), committing or opening the PR is denied
however the files got written. A session that writes everything through uncaught forms and never
reaches the threshold is not held, and its commit goes through.

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

Covers: the threshold fires at N and not at N-1; the same file counts once however it is spelled;
the deny text names the command with `--session`; the receipt lifts the deny; commit and PR are
held once the threshold was reached; fail-open on a corrupt state file, a corrupt config, an
unwritable state directory and garbage stdin; the off switches; the missing-`session_id`
degradation; the Stop refusal with and without a receipt, its loop guard and `stop_hook_active`;
the CLI's session resolution, `record` from stdin and flags, and its refusals; the manifests; and
the OMP adapter (`omp/pattern-check-omp.test.mjs`, a fake `pi` and `ctx`): edit, write and bash
mapped onto the hooks, one counter shared with a Claude Code hook call for the same session id,
multi-file hashline edits, URL-scheme paths ignored, the refusal once per turn, the per-cwd
fallback warning, fail-open on a throw, and registering once. The adapter test imports the `.ts`
file through Node's built-in type stripping; CI runs the suite on Node 24.

## Changelog

### 0.2.0

OMP adapter (`omp/pattern-check-omp.ts`, declared in `package.json` under `omp.extensions`, with
`.omp-plugin/plugin.json`): the PreToolUse counter on OMP's `tool_call` and the Stop refusal on
`session_stop`, through the hooks' own `handle` functions and state. `omp/REGISTRATION.md` covers
loading and reversal.

### 0.1.0

First release: the skill, the script (`open`, `record`, `status`), the PreToolUse counter with
Edit/Write/MultiEdit and Bash denials, the Stop refusal, user and repository config, tests.
