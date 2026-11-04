# output-types

A plugin that makes an agent label the receipted facts it returns — CLAIM for what it checked this
session, CITE for what an outside source says — and attach the receipt that earns the label.
Everything else stays plain prose, and unlabeled means not backed by a receipt, so a reader can
tell what was checked from what was assumed.

The problem it addresses: an agent's report is one stream of confident prose. A fact read out of a
file, a fact half-remembered from training, and a number nobody re-derived all read the same.
Labeling only the receipted ones separates them: the reader trusts a label and weighs the rest
themselves.

Every release is in [CHANGELOG.md](CHANGELOG.md).

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install output-types@jo-wolff-plugins
```

### Install on OMP

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

## What you get

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

## The Stop check

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

## What this does, and what it does not do: it delivers, and it warns

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

## Developing output-types

The tests run with `node --test` from inside `plugins/output-types/`. `lib/judge.mjs` and
`lib/hook-runner.mjs` are plugin-kit's, copied byte for byte; change them there and copy again
(the kit's `test/judge.test.mjs` and this plugin's `test/manifest.test.mjs` both fail on drift).

## Changes in 0.3.2

`scripts/prune.mjs` is plugin-kit 0.3.3's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged.

## Changes in 0.3.1

`lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.3.0's): the runner waits for
stdout to drain before it exits, bounded by the hook's deadline (4 s, or 55 s with the judge on),
so a Stop warning larger than one 64 KiB pipe buffer is no longer cut short; a host that never
reads gets exit 0 at the deadline and one `stdout not drained` line in errors.log. What the Stop
check says is unchanged.

## Changes in 0.3.0

The Stop check. Mechanical, every turn: each `**CLAIM**` without an absolute `file:line` or a
command and its result, and each `**CITE**` without a URL or a test run with its command, is named
by line in one `systemMessage`, the first five, then `+N more`. Never `decision: block`. A judge
stage, off by default, runs when `${XDG_CONFIG_HOME:-~/.config}/output-types/config.json` has
`"judge": true` and a judge command resolves. The judge dispatch is plugin-kit 0.3.0's
`lib/judge.mjs`, vendored byte for byte, and the command is configured once for every plugin with
`node lib/judge.mjs setup`. New files: `hooks/output-types-stop.mjs`, `lib/receipts.mjs`,
`lib/judge.mjs`, `lib/hook-runner.mjs`, and this README. `OUTPUT_TYPES_CHECK=off` turns the check
off.
