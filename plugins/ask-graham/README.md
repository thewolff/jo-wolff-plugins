# Ask Graham

A skill that answers "should we build X?" with one engineer's stated judgment and a single
verdict, plus an optional one-line prompt nudge that runs it on every new idea.

The skill (`skills/ask-graham/SKILL.md`) restates the ask, searches for what already exists,
answers five gate questions, checks a few red flags for technical asks, and ends in exactly one
verdict:

- **do it now** (under two minutes),
- **start now** (bigger, and waiting has a named cost),
- **later** (bigger, and nothing gets worse while it waits),
- **don't build**.

The breakdown that follows is scaled to the size of the work: none, one task, or High Level
Design → Epics → Stories → Tasks with acceptance criteria.

Every check asks "Do you want me to research and see if something comparable exists?"
No keeps the search local; yes adds open-source and commercial options, screened by gates
then ranked with pros, cons, and dated, sourced stats; stars, age, forks, and followers stay context only.

## Who Graham is

Graham is a frontend engineer and a friend of Jo Wolff, who wrote the skill. Jo asked him seven
questions about how he decides whether to build something; his answers are in
`skills/ask-graham/references/graham-answers.md`, verbatim, typos included. He agreed to be
named and quoted: "100%. Nothing would make me happier."

Every rule in the skill is tagged with its source: **Graham #N** for his words, **Jo** for the
author's overrides, **Skill** for mechanics the skill adds. One override matters: Graham listed
type systems as something he would kill or defer, and the skill does not follow him. Using
types is never counted against an ask; building your own type system when an established one
exists is a red flag, and that flag is Jo's.

## Install

Claude Code:

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ask-graham@jo-wolff-plugins
```

From a shell, the same thing is `claude plugin marketplace add thewolff/jo-wolff-plugins` then
`claude plugin install ask-graham@jo-wolff-plugins`.

OMP, from a shell:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install ask-graham@jo-wolff-plugins
```

On Claude Code the nudge and the Stop check run from `hooks/hooks.json`. OMP does not run
`hooks.json`; the install registers `omp/ask-graham-omp.ts` (declared in `package.json` under
`omp.extensions`), which does the same jobs on OMP's `before_agent_start` and `session_stop`
events. A Claude Code install alone gives OMP neither.

## Using it

Ask "should we build X?" or "is it worth building?", or type `/ask-graham <the thing to build>`
on Claude Code or `/skill:ask-graham <the thing to build>` on OMP.

If the agent has to stop and wait for your answer to the comparables question, its reply still
carries the judgment so far: step 1's one-sentence ask and the five gate questions, answered from
what it found, with the question alone on the last line.

```
**Ask:** <what gets built, for whom, where it lives>

**Gate questions** (Graham #1)
- Why: <answer + evidence>
- How long lived: <answer>
- Already exists: <"local search pending", or what it found so far>
- In scope: <answer>
- Owner / maintenance: <answer>

Do you want me to research and see if something comparable exists?
```

The skill does not run on a ticket or issue, a bug fix, a task inside an already-decided
project, or a request to continue existing work. One exception: before a task inside a decided
project writes a new table, a new column on an existing table, a new top-level module, or a new
service, the skill runs a **structure check**: the local search for what already exists
(including what else hangs off the same parent table or module, and for a column every column
already on that table) and the red flags, with no comparables question and no verdict. It always
says what it found: the matches with receipts, or plainly that there are no similar tables,
columns, modules, or services. A task that creates none of the four gets no output.

## Intensity

Two levels:

| Level | What runs it |
|---|---|
| `ask` (default) | `/ask-graham` (`/skill:ask-graham` on OMP), or an explicit "should we build this?" |
| `every-idea` | the above, plus a one-line nudge added to every message you send |

The level comes from the first of these that exists:

1. the nearest `.ask-graham` in the working directory or any directory above it, so one file at
   a workspace root covers every repository and worktree under it;
2. `${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/config` (`XDG_CONFIG_HOME` counts only when it
   is an absolute path);
3. the default, `ask`.

Each file holds `intensity=ask` or `intensity=every-idea`, and may also hold
`stop-check=on` or `stop-check=off` (see [The Stop check](#the-stop-check)), one setting per
line. Blank lines, lines starting with `#`, and other lines are ignored. Each setting is
resolved on its own: a file with a line for only one of them falls through to the next file for
the other. A file with a line for a setting but an unknown value counts as that setting's
default (`ask`, `on`) and stops the search there, so a typo in a file meant to turn the level
down cannot turn it up. A file with a line for neither counts as `ask` and `on`.

To show or change it from a session (on OMP, write `/skill:ask-graham` in place of
`/ask-graham`):

```
/ask-graham intensity                    # show both settings and which file set each
/ask-graham intensity every-idea         # write the user file
/ask-graham intensity ask --here         # write .ask-graham at this git repository's root
/ask-graham stop-check off               # turn the Stop check off in the user file
/ask-graham stop-check off --here        # turn it off for this git repository only
```

That runs the script beside the skill, which you can also call directly with the same
arguments, plus `--cwd <dir>` to resolve from another directory:

```
node <plugin dir>/skills/ask-graham/scripts/intensity.mjs [every-idea|ask] [--here] [--cwd <dir>]
node <plugin dir>/skills/ask-graham/scripts/intensity.mjs stop-check [on|off] [--here] [--cwd <dir>]
```

Writing one setting keeps the file's line for the other.

`--here` fails outside a git repository. The `.ask-graham` it writes is untracked; add it to
`.git/info/exclude` if you do not want to commit it.

## The nudge

At `every-idea`, each message you send gets this line attached as hidden context:

> ask-graham (intensity every-idea): If this message proposes a new idea that doesn't exist yet
> (not a ticket, bug, or task in an existing project), run the ask-graham check before planning
> or building. If it is a task in an existing project that creates a new table, a new column on an
> existing table, a new top-level module, or a new service, run the ask-graham structure check
> (findings only, no verdict) before writing it.
> Otherwise ignore this.

At `ask` nothing is added. The hook does not classify messages; the agent decides whether a
message is a new idea, so a ticket can still draw a check if the agent misreads it.

- **Claude Code**: a `UserPromptSubmit` hook (`hooks/ask-graham-hook.mjs`) reads the level from
  the prompt's working directory and returns the line as `additionalContext`. It always exits 0.
  If stdin is empty or not JSON, a config file names no valid level, or the hook throws, it
  treats the level as `ask` (or reads it from its own working directory, for bad stdin), appends
  one line to `errors.log` (see [Faults](#faults)), and shows you one `systemMessage` line saying so.
- **OMP**: the extension reads the level from the session's working directory each time a turn
  starts (OMP's `before_agent_start` event: once per message you send while the agent is idle,
  and once per batch of messages you typed while it was working) and adds the line to that
  turn's request as a hidden message. It never changes your message. If the setting cannot be
  read, it falls back to `ask` silently: unlike Claude Code, nothing tells you.

**To turn the nudge off**, set the level back to `ask`: `/ask-graham intensity ask` (or
`/skill:ask-graham intensity ask` on OMP) for your user level, or add `--here` for one
repository. Check which file wins with `/ask-graham intensity`, since a `.ask-graham` above you
overrides the user file.

## The Stop check

When the agent finishes a turn in which it read the ask-graham skill, the check looks at its
final message for a verdict line:

```
**Verdict:** <do it now | start now | later | don't build>
```

The label is `Verdict` with or without bold, the colon inside or outside it, followed by exactly
one of the four verdicts, in any case, with a straight or curly apostrophe in "don't". The
words alone in a sentence do not count, and neither does any other word after the label, the
verdicts this skill used before 0.3.0 included. If the line is missing, the stop is blocked once,
with a reason that names the four verdicts and asks the agent for the line, so the answer gets
its verdict in the same turn.

A waiting reply may instead end with the exact comparables question alone on its final line,
without quotes, but only with step 1 and step 3 above it: a line starting `**Ask:**` with text
after it, and a line starting `**Gate questions**` followed by the five bullets `- Why:`,
`- How long lived:`, `- Already exists:`, `- In scope:` and `- Owner` (any suffix before the
colon, such as `- Owner / maintenance:`), each with an answer. Labels match in any case, with
or without bold, after any list marker; inside a code fence or a quote they do not count. A
waiting reply with all of it passes on both hosts without recording a block. One missing any of
it is blocked once, with a reason that names exactly what is missing (`**Ask:**`, the
`**Gate questions**` line, or the bullet), so the agent can add it in one turn. Mentioning or
quoting the question in a completed report does not exempt that report from its verdict.

A structure check gives no verdict, and the turn's first use of the skill has to declare it: the
skill loaded with the args `structure-check <the new structure>` (`/ask-graham structure-check …`,
a Claude Code `Skill` call, or `/skill:ask-graham structure-check …` on OMP), or a read of
`skills/ask-graham/structure-check.md` (`skill://ask-graham/structure-check.md` on OMP) before
SKILL.md. If the turn's first use was anything else (a read of SKILL.md, or an invocation with
other args or none), it is a full check: a later marker read does not change it. In a structure
check with no invocation that had other args, a reply passes on both hosts without recording a
block when it opens with these two lines:

```
**Structure check:** <the new structure>
**Found:** <each match, with a file:line receipt and how it overlaps>
```

or, when the search matched nothing, `**No similar:** <the parent, and what was searched>` as the
second line. Without one of the two outcome lines the stop is blocked once, with a reason that
names both; in a structure check a verdict line or the comparables question does not stand in
for them. A full check still needs its verdict (or the waiting comparables question) even if it
prints these lines, and the label anywhere but the reply's first line, quoted, fenced, unbolded,
or with nothing after it, does not count. The check reads the shape, not the content: any text
after `**Found:**` or `**No similar:**`, even a single period, satisfies it.

**To turn the Stop check off**, without uninstalling: `/ask-graham stop-check off` (or
`/skill:ask-graham stop-check off` on OMP) writes `stop-check=off` to your user file; add
`--here` for one repository, or put the line in a `.ask-graham` yourself. Both hosts read it at
every stop, so it applies from the next stop without a restart. `/ask-graham stop-check on` turns
it back on. Check which file wins with `/ask-graham intensity`.

What counts as reading the skill:

- on Claude Code, the agent calling the `Skill` tool for `ask-graham` (or `<plugin>:ask-graham`),
  you typing `/ask-graham` (or `/ask-graham:ask-graham`), or a `Read` of a file ending
  `/ask-graham/SKILL.md`;
- on OMP, you typing `/skill:ask-graham` at the start of a message or anywhere in it, or the
  agent's `read` of `skill://ask-graham`, `skill://<namespace>/ask-graham`, or a file ending
  `/ask-graham/SKILL.md`.

On either host a read of the structure-check marker (a path ending
`/ask-graham/structure-check.md`, or `skill://[<namespace>/]ask-graham/structure-check.md`) also
counts, and declares a structure check.

A skill body pasted into an ordinary message does not count. `/ask-graham intensity` and
`/ask-graham stop-check` (or their `/skill:ask-graham` forms) give no verdict, so a settings-only
turn, one whose every use of the skill is a settings invocation, is not checked. A turn that
also invokes the skill with other args (or none) or reads the skill file is checked, and so is
an ordinary check that runs the settings script along the way.

Only the current turn is read: the conversation chain from the newest entry back to the last
message you sent, so a skill read in an earlier turn does not count, and neither does one on a
branch you rewound away from, whether or not you sent a new message after rewinding.

- **Once per turn.** After one block the next stop in the same turn passes, verdict or not, so a
  reply that still lacks the line cannot loop. A stop that follows another hook's or extension's
  continuation is still checked.
- **Main session only.** Claude Code subagents end on `SubagentStop`, which the check is not
  registered for, and OMP does not fire `session_stop` for subagents. A subagent's ask-graham
  answer is checked only if the main agent reads the skill itself.
- **Fails open.** A missing or unreadable transcript, a record that cannot be written, or any
  error lets the stop through. On Claude Code the hook always exits 0, never blocks because of
  its own fault, and prints nothing unless it blocks or hits a fault (see [Faults](#faults)).
- **Claude Code** (`hooks/ask-graham-stop.mjs`, a `Stop` hook) checks the reply in the Stop
  payload's `last_assistant_message` (falling back to the transcript's last reply when the payload
  has none), reads the turn's skill use from the transcript at `transcript_path`, and remembers
  the turn it last blocked in
  `${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/blocked/<session id>` (`XDG_STATE_HOME`
  counts only when it is an absolute path), one small file per session. If that file cannot be
  written, the stop passes rather than block with no record. Delete the directory whenever you
  like: `rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/blocked"`. The worst a deleted
  record does is allow one more block in a turn already blocked.
- **OMP** (the `session_stop` handler in `omp/ask-graham-omp.ts`) reads the session file and
  takes the final text from the stop event. It remembers the blocked turn in memory, so
  nothing is written to disk and a restart forgets it.

## Your own open-work sources

Optional. List extra places to check in `${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/sources.md`,
one bullet per source with the read-only command or path:

```markdown
- **Prior sessions:** `my-history-tool search --limit 5 -- "<the ask>"`
- **Decisions waiting on me:** `~/notes/HELD.md`
```

Without it the skill checks the repo, its issue tracker, and any to-do, roadmap or task file the
project's `AGENTS.md` or `CLAUDE.md` names. Keep it out of version control: it describes your
machine. The plugin ships no source of its own; it reads whatever this file says on the machine
it runs on.

**What is enforced.** With the file present, the every-idea nudge lists each source (its label and
its command or path, as written), and the Stop check requires, in a full check's turn after the
skill loads, verdict reply or waiting reply alike:

- a Read of the sources file;
- for a bullet with a backticked command, a Bash or eval tool call (OMP `bash`, `pair_run` or
  `eval`) containing the command's first two words, three when the second is `node`, `bun`,
  `python3`, `sh`, `zsh` or `npx`; words from a placeholder such as `<the ask>` on are not needed.
  A command that fails still counts as run. A bullet with a command and a path counts as a command;
- for a bullet with only a path (backticked or bare, `~` and `$HOME` expanded, `*` matching any
  part), any tool call naming that path;
- a `**Local search:**` block in the reply with one line per bullet, written `<label>: <result>`.
  The label before the colon must equal the bullet's whole label (any case, bold and a trailing
  colon ignored), so `Held decisions` never proves `Decisions`; the result after it carries *found*,
  *nothing found* or *unreachable*, and a status word inside the label does not count. A bullet
  with neither command nor path is proved by this line alone. Inside a code fence or a quote it
  does not count.

One line proves a command or path bullet without a run: *unreachable* with a stated policy reason,
not a keyword. The reason says the listed command writes, deletes or is destructive
(`unreachable: the command writes to the ledger`, `unreachable (would delete rows)`), or that
research was declined (for a remote-only source after the user said no: `research declined`,
`said no to research`). Not running it is the skill's rule there. Any other *unreachable*, bare or
with an error, still needs the attempted call, even when the error contains such a word:
`unreachable (error writing lockfile)` and `unreachable (request declined: HTTP 403)` are errors.

Anything missing blocks the stop once, with a reason under 300 characters naming the first missing
source, what was expected, and how many more are missing. The Local search block is enforced only
when a sources file exists: without one, nothing here is required and the Stop check behaves as
before. A structure check needs none of it. Claude Code reads the tool calls from the transcript
the Stop hook already parses; OMP reads them from the session file, which records every tool call
with its arguments, so the check runs on both hosts.

How it fails:

| Situation | What happens |
|---|---|
| A bullet has no bold label, or the file has no labelled bullet | That bullet is ignored; a file with none counts as no file. No fault line. |
| A command's prefix was never run in the turn | Blocked once, naming the source and the prefix expected. |
| A path was never read or named by a tool call | Blocked once, naming the source and the path. |
| The transcript is torn (a line half-written) | The torn line is skipped. If it held the proof, the stop is blocked once; the next stop in the turn passes. |
| OMP cannot see tool calls | Not the case today: OMP writes each tool call to the session file, which the check reads. If a future OMP stopped writing them, every check with a sources file would block once per turn, then pass. |
| A subagent ran the search | Blocked once, and the block is correct: the check sees only the main session's tool calls, so the parent runs each configured source itself (a background call the parent starts counts). Everything beyond the configured sources, such as repo greps and comparables, may still be delegated. |

## Update and uninstall

Claude Code:

```
claude plugin update ask-graham@jo-wolff-plugins
claude plugin uninstall ask-graham@jo-wolff-plugins
```

Claude Code needs a restart to apply an update.

OMP:

```
omp plugin marketplace update jo-wolff-plugins
omp plugin upgrade ask-graham@jo-wolff-plugins
omp plugin uninstall ask-graham@jo-wolff-plugins
```

Refresh the marketplace before upgrading: `omp plugin upgrade` installs the version in OMP's
cached copy of the marketplace, so without the refresh it reinstalls the version you already
have. Then relaunch your OMP sessions; a running session keeps the extension it loaded at start.

Updating one harness does not update the other. OMP reads Claude Code's plugin list, but its own
install wins for the same plugin, so after `claude plugin update` alone OMP keeps running its
older copy. `node scripts/check-omp-install.mjs` from a checkout of this repository compares the
two and prints the commands for any plugin that differs.

Uninstalling removes the plugin, not your settings. `~/.config/ask-graham/config` (or its
`XDG_CONFIG_HOME` equivalent), `sources.md` beside it, and every `.ask-graham` file stay where
they are and apply again if you reinstall. The Stop check's records in
`~/.local/state/ask-graham/blocked/` (or under `XDG_STATE_HOME`) stay too. Delete them by hand if
you want them gone.

## Upkeep evidence

For every recommended package or tool, include an upkeep line with five fields: last commit,
last release, issue activity and human response, active human maintainers, and runtime
compatibility. Each field needs a receipt (the fetched source and observed result, or the exact
command and its output) or an explicit unknown. The line records the collection date and activity
window. If the evidence is missing or incomplete, say so rather than treating it as healthy.

The helper is a report formatter, not a collector: it does not fetch evidence, execute runtimes
or candidates, install software, decide eligibility, or calculate a recommendation. With a
complete evidence JSON file, run it offline as:

```
node <skill dir>/scripts/upkeep.mjs <evidence.json>
```

The evidence format and output contract are in
`skills/ask-graham/scripts/upkeep.mjs` and
`skills/ask-graham/scripts/upkeep.test.mjs`. Warnings name the risk and an exit path; they affect
ranking and caution only, never eligibility. Stars and repository age are context, not evidence
of fit or upkeep. For compatibility, discover the relevant runtimes actually installed on the
machine, record the detection command and output, and compare the selected installed version
with support evidence. If a runtime cannot be detected or its version's support is unverified,
report it as unknown rather than guessing.

## Faults

A Claude Code hook's own fault never blocks a prompt or a stop. Each fault, from either hook,
appends one line `<ISO time> <hook file> <reason>` to
`${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/errors.log` (`XDG_STATE_HOME` counts only when
it is an absolute path) and puts one line in the hook's `systemMessage`:
`ask-graham <hook file> failed open (<what happened>): <reasons> (logged to <path>)`. The faults
are: stdin empty or not a JSON object; a config file (`.ask-graham` or the user file) that names
no valid value for the setting the hook reads, which then counts as its default; for the Stop
hook, a payload without a usable `session_id` or `transcript_path`, a transcript or block record
that cannot be read, and a block record that cannot be written (the stop then passes); and any
throw. If `errors.log` itself cannot be written, the warning says so. A missing config file is not
a fault. Delete the log whenever you like.

## Tests

Run `node --test` from this directory. Tests exercise the consumer-visible upkeep report and
warnings, verdict behavior on hand-built transcripts in both Claude Code and OMP shapes
(`verdict.test.mjs`, fixtures in `fixtures/transcripts.mjs`), intensity resolution and CLI, both
hosts' hooks/extensions, and manifest version parity. Both Claude Code hooks also run as spawned
processes under every fault above with a 5 s budget per process (`hooks/failopen.test.mjs`), one
end-to-end run goes through the settings CLI and both hooks over a temp repo and state dir
(`e2e.test.mjs`), and the Stop hook reads real Claude Code transcripts captured with
`zsh fixtures/capture-claude-code.sh` (`fixtures/claude-code/`, `hooks/real-transcripts.test.mjs`).
CI runs the same command on Ubuntu and macOS with Node 24 (`.github/workflows/ask-graham.yml`).
`sources.test.mjs` covers the sources file: the parser, the nudge lines, and the Stop check's
sources proof on both transcript shapes, with a fixture file of invented sources.

## Release notes

### 2026-11-04 — 0.7.3

Closes the loophole where a turn could end on the comparables question and skip the judgment:
three runs in a row asked only that question, never naming the ask (step 1) or answering the gate
questions (step 3). A waiting reply now needs a `**Ask:**` line and a `**Gate questions**` block
with all five bullets above the question; the Stop check blocks it once otherwise, naming what is
missing. Jo's rule (2026-11-04: "you can't skip step 1"). Verdict replies and the structure check
are unchanged. The check is shared, so OMP's `session_stop` applies it too.

The sources file is now enforced, not remembered. Asked "how are you going to enforce not ignoring
the sources file" (Jo, 2026-11-04), the plugin now parses your
`${XDG_CONFIG_HOME:-~/.config}/ask-graham/sources.md`: the every-idea nudge lists each source, and
a full check with that file present must read it, run or read each source in the same turn, and
report each one under `**Local search:**`, or the stop is blocked once naming the first one missed
(see [Your own open-work sources](#your-own-open-work-sources)). Nothing about any particular
machine ships: the plugin names no command or path of its own. Without a sources file nothing
changes.

Fixes from review of the sources check. A source skipped because its listed command writes, or
because research was declined for a remote-only source, is proved by its `**Local search:**` line
marking it *unreachable* with that reason; before, the check demanded the very run the skill
forbids. A result line now proves only the source whose whole label it carries:
`Held decisions: nothing found` no longer satisfies a `Decisions` source, and a status word inside
a label (`Found items`) is not read as the status. The standing "Delegate the search" rule now says
the configured sources stay in the parent session while everything else may be delegated.

### 2026-11-04 — 0.7.2

The plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares what the two hooks
can return and four `evals/<x>.scenario.json` prove them: the every-idea nudge
(`prompt-nudge-every-idea`) and the quiet prompt at `ask` (`prompt-quiet-at-ask`); the Stop check
blocking a reply with no verdict (`stop-no-verdict`, which also carries a `session` and a `judge`
rubric the nightly canary runs under `claude -p` and grades with `claude plugin eval`) and letting
one with a verdict through (`stop-with-verdict`). `e2e/live-run.sh` hands off to plugin-kit's
`lib/live-run.mjs`. The state directory (`$XDG_STATE_HOME/ask-graham`, 30 days) is declared in
`.claude-plugin/plugin.json` and `node scripts/prune.mjs --days 30` prunes it, keeping
`errors.log`. The skill has a "When this can't run" section.

Fix: `skills/ask-graham/scripts/upkeep.mjs` compared `import.meta.url` with
`file://${process.argv[1]}` as strings. Node resolves the main module through symlinks, so run
through one it did nothing and exited 0. The guard now compares real paths.

### 2026-11-03 — 0.7.1

The Stop check now reads the reply from the Stop payload's `last_assistant_message`, and no longer
takes Claude Code's telemetry entries (an `id` and no parent field, such as `api-request`) as the
newest entry of the conversation. Captured runs of Claude Code 2.1.317 showed the Stop hooks
running before the final reply was in the transcript, with an `api-request` entry as the last
entry, so 0.7.0 let a reply with no verdict through, and in another run blocked a reply that ended
in a verdict, which made the agent send its answer twice. An unreadable block record now lets the
stop through (logged and warned) instead of blocking every stop of the turn.

The Claude Code hooks no longer fail silently. Bad stdin, an invalid config value, an unreadable
transcript, an unwritable block record, or a throw still lets the prompt or stop through, and now
also lands in `errors.log` with the hook file and reason and shows one warning line (see
[Faults](#faults)). Adds process-level fault tests, an end-to-end test, and Stop-hook tests on
captured real Claude Code payloads and transcripts (`fixtures/claude-code/`, with the account,
email, home and temp paths redacted).

### 2026-10-28 — 0.7.0

Adds the structure check: before a task inside a decided project writes a new table, a new column
on an existing table, a new top-level module, or a new service, the skill searches what else hangs
off the same parent and flags a second
pattern where the repo already has one, with no verdict. A structure check does not ask the
comparables question; Jo's call, in Jo's words: "skip the question, but give feedback? like if it
finds something it should obviously present that it found something. but if it doesnt it should
let the user know that there were no similar tables, modules, or services". So its reply always
opens with `**Structure check:**` and then a `**Found:**` or `**No similar:**` line, which the
Stop check requires in place of a verdict line. Only a turn whose first use of the skill declares
it (args `structure-check`, or a read of `structure-check.md` before SKILL.md) is a structure
check. The every-idea nudge names the structure check.
Columns are in the trigger by Jo's call, in Jo's words: "i agree about the column", answering
whether the structure check should also fire when a task adds a new column to an existing table.

### 2026-10-20 — 0.6.0

Adds receipted upkeep evidence and risk/exit-path warnings for evaluating recommendations.
Warnings inform ranking without becoming gates; missing evidence and runtime compatibility stay
explicitly unknown.

## License

MIT. See the repository root `LICENSE`.
