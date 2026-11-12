# ledger

A durable, id'd record of the questions an agent asks you and the choices it makes without
asking, kept in one SQLite file on your machine. The agent asks you in plain words and you
answer in plain words; it records each question as a `q-` row and records your reply against
it, and the ids stay on its side. Every unasked decision gets an `nt-` note. A CLI the agent
runs, a batch mode that applies a pasted block line by line, and five hooks that make the record
hard to skip: open questions and recent notes are injected at session start, the
AskUserQuestion tool is denied until the question has a row, `git push` and `gh pr create` are
denied until the session has a note or an outcome saying why, and a reply is sent back once when
it ends without recording an answer you already gave, asks you something with no row, or states
a decision without a note.

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

## Turning a folder off

Every session records once the plugin is installed. To stop one folder (and everything under it),
type in a session there:

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

The skill `record` (`skills/record/SKILL.md`, typed as `/ledger:record`) tells the agent to:

- `ask "<body>" --name <short> --options a,b --default a` whenever it needs your decision, then
  ask you in plain words without showing the id. `--ceiling <usd>` and `--about "<text>"` attach
  a spend limit or the thing the question concerns;
- `answer <q-id> <option>` as soon as you reply, with the option your words mean; when your reply
  is none of the options, `answer <q-id> "<your reply>"` records it as you gave it (or
  `withdraw <q-id>` if you set the question aside);
- `note "<text>"` for a choice it made without asking;
- before any `git push` or `gh pr create`, a `note` or an `outcome <ref> "<text>"` saying what is being pushed and why;
- read `pending` and `log` when it resumes.
- treat questions listed from other folders as information about another window, never as its
  own *Needs you*.

Slash commands: `/ledger:record` loads that skill, `/ledger:enable` and `/ledger:disable` set
the folder's switch, `/ledger:review` runs a review, and `/ledger` (no suffix) opens the
[ledger pane](#ledger-pane-desktop). Before 0.3.7 the skill shared the plugin's name, so a bare
`/ledger` resolved to that skill and ran it instead of opening the pane.

You answer the way you would answer anyone. If the agent ends a turn after your reply without
recording the answer, the Stop hook sends it back once with the ids to record.

Only a prompt you typed counts as your reply. Claude Code also writes lines into the
conversation that you did not: a subagent's `<task-notification>`, a `<system-reminder>`,
another session's message, local command output, tool results, the Stop hook's own feedback.
The Stop hook reads the session transcript and sends the agent back for an answer only when a
line written since the question is one you typed (`lib/transcript.mjs`, `isHumanPrompt`); a
transcript it cannot read, or one with no timestamped prompt, is no evidence and sends no
answer nag. While [brb](../brb/README.md) holds the session (its `away.json` for the session
is a valid brb record), you are away
by your own word: the hook does not ask for an answer at all, and a question the agent ends on
with no row is sent back with "record it with `ask`, then `hold`", never "ask the human".
`hold <q-id>` always holds, even when the question lists `hold` as an option;
`answer <q-id> hold` answers with that option.

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
| `ask "<body>" --name <short> --options a,b[,c] [--default a] [--deadline 2h\|<ISO>] [--kind question\|approval\|plan] [--allows "a: …; b: …"] [--ceiling <usd>] [--about "<text>"]` | agent | opens a question bound to the process cwd; prints `q-…` and its `pending` line, for the agent (the human is asked in plain words). Without `--default` the question has no default (nothing is invented, the line names none, and the human's bare first-option reply is their choice); an approval question defaults to `deny`. `--kind plan` needs `--allows` for every option. Repeating an open question (same body in the same folder with the same set of options, in any order) returns its id and writes nothing, unless the open row belongs to another session or to an untagged CLI run: then the asking session adopts it (`session_id` and `asked_at` move to this session) and the Stop rules treat it as this session's question. The existing row's options, default and `--allows` stay as they are; the repeat's flags are not written over them. A different set of options is a different question. A held duplicate is never adopted; `reopen` it. |
| `answer <q-id> <reply>` or `<word> <q-id>` | agent, on the human's reply | records the answer. A reply that is one of the question's options is recorded as that option (`via` `cli`); `withdraw` withdraws. `answer <q-id> <reply>` with any other reply (several words allowed, trimmed, at most 200 characters) records it as given, a free-form answer: state `answered`, `via` `freeform`, shown in `log` as `answered (freeform): <reply>`. The short forms (`<word> <q-id>`, `<n> <word>`, a bare word) and lines typed into a prompt take options only: anything else is refused with the option list and nothing is written, so a typo never becomes an answer. Same reply twice → `already answered`, exit 0; a different one → refused naming the existing answer. |
| `approve <q-id>` / `deny <q-id>` | human | the answers `approve` / `deny` when the question offers them. |
| `<n> <word>` | human | the n-th line of `pending`, answered with that word. |
| `withdraw <q-id>` | either | state `withdrawn`, with an `nt-` note saying so (when the question offers `withdraw` as an option, it is recorded as that answer instead). |
| `extend <q-id>` | human | the answer `extend` when offered, else the deadline moves by its original span. |
| `hold <q-id>` | agent | an open question becomes `held`: formed and deliberately deferred for you, not put to you yet. Still unresolved (`resolved_at` stays empty); listed under *Waiting on you* at session start and as `held` in `pending`. Answering or withdrawing it still works. Asking the same question again returns its id and says to `reopen` it. |
| `reopen <q-id>` | agent | a held question becomes open again, with `asked_at` set to now, because the agent is putting it to you now. |
| `note "<text>"` | agent | a note row for the cwd; prints `nt-…`. |
| `outcome <ref> [q-id] "<text>"` | agent | what a decision or an answered question produced: `ref` (required, no spaces) is a PR URL, a commit or a path, and the optional `q-id` links the question. A note row of kind `outcome`; `log` shows `→ <ref>`. It lifts the push gate the same as a `note`; it does not count as the `note` a stated decision needs. |
| `pending` | either | the paste-ready block, one `<default> <q-id>  # <name> · <body> · default <d> · also: <others> / withdraw` line per open question with a default and one `<q-id>  # <name> · <body> · options: <a>, <b> / withdraw` line per open question without one, in the cwd, a parent of it or a folder under it (a question from a folder under the cwd ends ` · in <folder>`), then `about …`, `ceiling $…`, `allows:` and `due …` lines when set, then one `held <q-id>  # <name> · <body>` line per held question in the same scope, then one `owed|started|deferred <ow-id>  # <body>` line per open, started or deferred owed item in the same scope, plus this session's own items from other folders when `LEDGER_SESSION_ID` is set (each ending ` · in <folder>`). |
| `pending --all` | either | every open and held question in the database, whatever its folder: one group per folder headed by the folder's path (groups in path order), each group's open questions as `pending` lines (not numbered: `<n> <word>` answers only the cwd's own list), oldest first, then its held ones marked `held`, then its open, started and deferred owed work. Needs no session id. For a database shared by several folders, and the command every capped owed list (SessionStart, UserPromptSubmit, and the Stop list's still-owed lines) points at with `… and N more; run \`… pending --all\``, so the items a list leaves out are always reachable. Events the Stop list cuts (owed, started, done and the rest) are not in `pending --all`; that line says they show at a later Stop, and they do. |
| `log [N]` | either | the last N notes, questions and answers for the cwd (default 20), newest first, across sessions. |
| `enable` / `disable` | human | writes `"enabled": true` / `false` to `.ledger.json` in the cwd, keeping any other keys in it. An unparsable existing file is refused, not overwritten. `/ledger:enable` and `/ledger:disable` run these in the session's folder. |
| `config` | either | the effective settings, where each came from, both config file paths, and whether the database file is the plugin's own or shared. |
| `doctor` | either | is the ledger healthy: one `ok`, `warn` or `fail` line per check (see [Doctor and the bounce ledger](#doctor-and-the-bounce-ledger)). Exit 0 when nothing failed, 1 when anything did; warns do not change it. Never writes the database and never creates it. |
| `bounces [--since <N>d\|<N>h]` | either | the hooks' bounces since then (default `7d`): per rule, how many fired, were satisfied, were bypassed and are still open; then the last 20 rows (`#id`, time, session short id, rule, tool, outcome), each followed by `text:` (what fired it, one line, cut to 160 characters) and `transcript:` (the session transcript's path) when the row has them. Covers every folder. |
| `canary run` / `runs` / `status` / `grade` / `prune` / `install` | human | the nightly canary (see [The feedback loop](#the-feedback-loop-canary-report-digest)). Runs on its own line. |
| `report [--since 7d] [--no-judge]` | either | the graded report of what the hooks did in the window. Runs on its own line. |
| `digest [--dry-run] [--force]` / `digest install` | human | the weekly report posted as a comment on the digest issue, and its launchd job. Runs on its own line. |
| `gate check [--plugins a,b] [--base <ref>]` | either | the plugin push gate's six checks on every plugin of this repository with a change since the base, recorded for HEAD (see [The plugin gate](#the-plugin-gate)). Runs on its own line. |
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
2. **Questions and answers.** A question is `open` (put to you), `held` (formed and deferred for you, listed under *Waiting on you*, never chased by the Stop hook), `answered` or `withdrawn`. An answer is one of the options or, when your reply was none of them, your reply as given (`via = 'freeform'`); a question is not withdrawn because the reply was off the list. The agent cannot use `AskUserQuestion` without an open `q-` row, cannot end a turn on a question while the session has no open row, and cannot end the turn after your reply while a question asked before it has no answer recorded (`forcing.denyAskWithoutRow`, `forcing.stopAskRule`).
3. **Push needs a note or an outcome.** `git push` and `gh pr create` are denied until the session holds one `note` or one `outcome` saying what is being pushed and why (`forcing.pushNeedsNote`).
4. **Decision needs a note.** A reply that states a decision (`forcing.decisionPhrases`) is sent back once unless a `note` was recorded in that turn (`forcing.stopDecisionRule`); an `outcome` does not count. What the decision produced can follow as an `outcome` note with a `ref` (PR, commit, path); outcomes are never required.

Nothing else is forced. The CLI tags its rows with the session through `LEDGER_SESSION_ID`,
which the SessionStart hook exports into the session's shell environment (`CLAUDE_ENV_FILE`);
a note made without it still counts for the session it was made in when it is in or around the
session's folder and dated after the session started.

| Event | Config key | What it does |
|---|---|---|
| SessionStart | `hooks.sessionStart` | Injects, in order and only when non-empty: *Waiting on you* (held questions for the cwd, its parents and the folders under it, oldest first, name and one-line body, a subfolder's naming the folder; kept on `source: compact`), open questions for the same scope (the `pending` block), the last `inject.notes` entries of `log`, the exact invocation plus allow rule and a one-line verb summary, when `inject.elsewhere` is on a block for the open and held questions in other folders (a folder that is not the cwd, not a parent of it and not under it): one header line (`ledger: N question(s) waiting on the human in M other folder(s) (asked by another window, not this folder's work). If the human's prompt answers one, run \`… answer <q-id> <option>\` and say it is recorded. Otherwise, in your first reply, tell the human in one plain line per question that another window is waiting on them: the question's body, its options and its default when it has one. Never show the q- id:`), then each folder's path followed by one `pending` line per question (default, id, name, body, the other options), a held one's line opening with `held` in place of the default word, at most 10 questions in full and a count of the rest with the `pending --all` command, the cross-lab review findings line (see [Cross-lab review](#cross-lab-review)), and, last, the doctor line (see [Doctor and the bounce ledger](#doctor-and-the-bounce-ledger)). Capped at 9,000 characters; the log entries are cut first, never the held or open questions or the other-folders block, review or doctor lines. On `source: compact` the log section is dropped and the verb summary is one line; the other-folders block, review and doctor lines stay. Records the session in `cc_sessions`. Before injecting, the sweep: open and held questions asked more than `sweep.autoWithdrawDays` days ago whose session has ended are withdrawn with a note (at most 20 per start, listed in one `systemMessage` line). Adds the weekly digest's exception lines (overdue, or attempted and failed) when they apply. |
| PreToolUse | `hooks.preToolUse` | Runs on `AskUserQuestion` and `Bash` only. `AskUserQuestion` is denied while no question is open for the cwd (a question whose cwd equals the hook cwd or is an ancestor of it), with the reason `ledger: ask the question through the ledger first: \`… ask "<body>" --name <short> --options a,b --default a\`, then ask it; keep the q- id to yourself and record the reply with \`… answer <q-id> <option>\`.` A Bash command that runs `git push` or `gh pr create` (any simple command of a `&&`/`;`/`|`/newline chain, read with shell quoting; git's global options and a path on the binary are tolerated) is denied while the session has no `note` and no `outcome`, with the reason `ledger: record what this push is before pushing: \`… note "<what and why>"\` or \`… outcome <ref> "<what and why>"\` (one in this session lifts the gate).` The same command is checked by the review gate (below) at the same time: when both stop it, one deny lists both as numbered items, so the agent meets every missing step at once. Before denying it proves the store can take a write (the remedy writes); if it cannot, the tool passes with a `systemMessage`. Other tools and other commands are never seen. |
| Stop | `hooks.stop` | Checks the final message once per turn (keyed on `prompt_id`; a second Stop in the same turn passes). Answer rule (`forcing.stopAskRule`): the Stop's `prompt_id` differs from the one stamped by the session's previous Stop, the transcript shows a prompt you typed since that Stop (a task-notification, system-reminder or other injected line does not count; a missing or unreadable transcript, or one with no timestamped prompt, is no evidence and never nags), brb does not hold the session, and the session has open questions asked at or before that previous Stop → `{"decision":"block","reason":…}` listing them newest first and telling the agent to take the answer from your latest message and run `answer <q-id> <option>` (or `withdraw`); it clears once every such question is answered or withdrawn. Ask rule (same switch): after removing code blocks, inline code and double-quoted spans, a sentence ends with `?` (a `?` at the end of a line or followed by a space, so "Should I …? I'd say yes." counts and a URL's `?query` does not) and that sentence asks for a decision: a permission or decision request on the agent (a modal on I/we: "should I", "shall we", "can I push?", "may I"; "want me to", "do you want", "would you like"), a confirmation ("is this right", "does that look right", "is it safe to", "ok to", "ready to"), an explicit choice ("would you prefer", "which option should we", an option list after a comma or colon, a sentence that is only options such as "Alpha or beta?", or a choice about the thing being configured: "Should the helper use local or remote storage?"), or a wh-question (what/where/when/who/which/how) carrying a modal on I/we, "whether", a preference or an option list ("How should we proceed?", "Which option should we use?"). A "why" question never counts, and neither do a bare "which", a loose "or", "do we know/have …", or "whether"/"proceed" inside a question about recorded facts: "Which file holds the config?", "Are the logs compressed or uncompressed?", "Does the log say whether the build failed?", "Did the deployment proceed without errors?" and "What are we working on?" are requests for information and need no row. It is a heuristic with a once-per-turn escape: an information request worded as a request ("Should the parser be deciding this?") bounces once and no question is open for the folder (this session's, or one open in the cwd or a parent of it, whoever asked it) and the reply does not repeat the body of a question open in another folder (relaying one of those to the human, as SessionStart asks, is not asking a new question) → block telling the agent to `ask` first, then ask in plain words; messages under 40 substantive characters are not checked. Neither rule reads ids out of the reply. A session's questions are those tagged with its id, plus untagged ones asked in or around its folder after it started. Decision rule (`forcing.stopDecisionRule`): after also removing double-quoted spans, the message contains one of `forcing.decisionPhrases` as whole words, the session recorded no `note` during this turn, and it asked no question during this turn (the stated default of a question just asked is not a decision) → block telling the agent to `note`, then finish. Checked in the order answer, ask, decision. Every Stop stamps `cc_sessions.last_stop_at` and `last_stop_prompt`; "this turn" runs from the previous stamp (or the session start) to now. |
| SessionEnd | `hooks.sessionEnd` | In one transaction: stamps `ended_at` and the reason on the session row, and marks the session's open bounce rows `bypassed`. Waits at most 250 ms for a lock (SessionEnd hooks share a 1.5-second budget). Then, since 0.3.3, the decision-log entry (see [The decision-log entry](#the-decision-log-entry)). Prints nothing; errors go to the log. |
| UserPromptSubmit | `hooks.userPromptCommands` | Answers from elsewhere (`inject.answers`): when the session has an id and the database already exists, every prompt reads the questions this session asked that another session or an untagged CLI run answered or withdrew since the session's last prompt (`cc_sessions.last_prompt_seen_at`, else its start), gives Claude one line each as `additionalContext` (`ledger: answered since your last turn: <name> → <word> (via <via>)`, or `… <name> withdrawn (via <via>)`), and moves the mark to now. Answers the session recorded itself are not repeated. Nothing found → nothing injected. Bare options: when the whole prompt is one option word of an open or held question, in any folder, alone or with trailing punctuation (`local`, `Local.`), Claude gets one line per such question as `additionalContext` (this session's questions first, then this folder's, then the rest): the question's `pending` line, its folder when it is not the cwd, and the `answer <q-id> <word>` command to run if the human meant it as their reply. Nothing is recorded by the hook and you are shown nothing; Claude decides and runs `answer`. A prompt never creates the database; a store that cannot be opened or a mark that cannot be written is logged to `errors.log` only. Ledger lines: when every non-blank line of the prompt is an id-bearing ledger line (`approve q-…`, `extend q-…`, an ordinal like `1 approve`) or `pending` / `log [N]` / `help`, applies them as a batch with `via = prompt-hook` and gives Claude the numbered results as `additionalContext`, after any answers-from-elsewhere lines (you see the same block as a `systemMessage`). One prose line anywhere → no line is applied. Free-text verbs (`ask`, `note`) and `config` / `enable` / `disable` are never applied from a prompt. Never blocks the prompt. |

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
| `forcing.pushNeedsNote` | `true` | deny `git push` / `gh pr create` while the session has no note or outcome |
| `forcing.stopDecisionRule` | `true` | send back a reply that states a decision with no note recorded this turn |
| `forcing.stopOwedRule` | `true` | send back, once per prompt, a reply that ends while work the human approved is still owed (not started, held or dropped) |
| `forcing.stopOfferRule` | `true` | send back, once per prompt, a reply that offers to do work with no ledger question recording the offer, even while another question is open |
| `forcing.decisionPhrases` | the eight phrases below | the phrases the decision rule looks for, whole words, any case |
| `inject.notes` | `5` | how many recent `log` entries SessionStart injects |
| `inject.elsewhere` | `true` | whether SessionStart adds the block listing open and held questions in other folders; `false` turns it off |
| `inject.answers` | `true` | whether each prompt tells the session about answers to its questions recorded in other sessions since its last prompt; `false` turns it off |
| `inject.doctor` | `true` | whether SessionStart adds, last, `ledger: doctor reports N issue(s); run … doctor` when the cheap doctor checks find something; `false` turns it off |
| `sweep.autoWithdrawDays` | `7` | SessionStart withdraws open and held questions asked more than this many days ago whose session has ended (or that had no session) and whose deadline is not still ahead, at most 20 per start, each with a `withdraw` note naming the sweep and one `systemMessage` line listing the ids; `0` turns it off |
| `digest.enabled` | `true` | the weekly digest and its SessionStart lines; `false` turns both off and `doctor` warns. User config only |
| `digest.issue` | `thewolff/jo-issues#325` | the GitHub issue the digest is posted to as a comment: `owner/repo#number` or a `https://github.com/owner/repo/issues/number` URL. A value naming no repository (a bare `325`) is refused at load with a notice and the default stands: the repository is always passed to `gh` as `--repo`, so neither gh's cwd nor `GH_REPO` ever picks the destination. User config only |
| `decisionLog.enabled` | `true` | whether SessionEnd writes a decision-log entry under the repository's `.ai/decision-log/` when the session recorded an answer or a note. `false` is the opt-out for people who keep no decision log; `doctor` then says `decision log: off` |
| `review.mode` | `"gate"` | the cross-lab review gate on `git push`, `gh pr create` and `gh pr merge`: `gate` denies a push whose HEAD has no review or has findings, `advise` allows it with a notice, `off` turns the review off. Read from the user file only; a project file's `review` is ignored with a notice |
| `review.labs` | `["codex"]` | the labs `ledger review` runs, in parallel: any of `codex`, `kimi`, `claude`, `glm`. User file only |
| `review.models` | `null` | a model per lab, e.g. `{"claude": "opus", "glm": "zai/glm-5.3-flash"}`; unset means the lab's CLI default (`glm`: `zai/glm-5.3`). User file only |
| `review.profiles` | `null` | an `omp` profile per omp-backed lab, e.g. `{"glm": "work"}`; unset means no `--profile` (omp's base profile). Each value is a non-empty string; an empty one makes the loader reject the whole `review.profiles` value and say so. User file only |
| `review.maxRounds` | `3` | how many review rounds (reviewed commits on the branch since the merge-base) `ledger review` runs before it stops and says to ask the human: waive, or continue with `--force-round`. User file only |
| `review.judgeCommand` | `null` | the judge that checks "this finding is resolved" claims: a shell command that gets the prompt on stdin (or in place of a literal `{prompt}`) and prints `yes` or `no`. Unset falls back to `command` in the shared judge file (`${XDG_CONFIG_HOME:-~/.config}/judge/config.json`), then to `enforcement.judgeCommand` in the i-have-audhd profile (`~/.claude/i-have-audhd.json`), so one judge is configured once. User file only |

The default `forcing.decisionPhrases`: `I decided`, `decided to`, `assumption:`, `assuming`,
`going with`, `chose`, `I'll go with`, `trade-off`. A project file can replace the
list (`{"forcing": {"decisionPhrases": ["went with", "settled on"]}}`).

`node <plugin dir>/scripts/ledger.mjs config` prints the effective values and the source of each.

## Fail-open table

Every hook ends in exit 0. Exit code 2 is never used by a hook. On an unexpected error a hook
appends one line to `${XDG_STATE_HOME:-~/.local/state}/ledger/errors.log` and tells you in a
`systemMessage` where the event honours one. Each row below has a test in `test/`.

| Condition | CLI | SessionStart | PreToolUse | Stop | SessionEnd | UserPromptSubmit |
|---|---|---|---|---|---|---|
| database file missing | creates the directory and the schema, proceeds | same | same | same | same | same |
| database locked (busy timeout; opening retries up to 4 times with a short pause, at least once) | exit 2, `ledger: database busy at <path>; nothing applied` (lines already applied are named) | injects what it can read; session not recorded, one `systemMessage` and one `errors.log` line (every hook's store failure logs since 0.3.3) | passes with `systemMessage` where it would deny (the `ask` or `note` it would demand cannot write); a tool it would pass anyway passes silently | passes without checking, `systemMessage` (the turn stamp is a write) | log only | lines report `not applied (database busy)`, one `systemMessage`, prompt proceeds |
| database read-only (file mode, mounted read-only) | reads work; a write is exit 2, `ledger: database read-only at <path>; nothing applied`; `enable`, `disable` and `help` never touch the database | injects what it can read; session not recorded, one `systemMessage` | same as locked | same as locked | log only | lines report `not applied (database read-only)`, one `systemMessage`, prompt proceeds |
| database corrupt, default path (no `db` configured) | moves it to `<path>.corrupt-<stamp>`, creates a fresh one, says so, proceeds | same, in `systemMessage` | same | same | rename and log only | same |
| database corrupt, configured path (`db` from env, project or user file) | exit 2, `ledger: database corrupt at <path>: <error>; nothing applied`; the file is not renamed, recreated or written | no injection, one `systemMessage` naming the path and the error | passes, `systemMessage` | passes without checking, `systemMessage` | log only | nothing applied, one `systemMessage`, prompt proceeds |
| config file unparsable or a key of the wrong type | next layer, one stderr line | next layer, `systemMessage` | next layer, `systemMessage` | next layer, `systemMessage` | next layer, log | next layer, `systemMessage` |
| unknown config key | ignored | | | | | |
| hook throws or stdin is not JSON | n/a | allow, nothing injected, `ledger SessionStart failed open: <msg>` | allow with `systemMessage` | pass with `systemMessage` | exit 0, log | pass with `systemMessage` |
| hook times out | n/a | Claude Code cancels it; no injection | the tool proceeds | the stop proceeds | cut off | the prompt proceeds |
| switch off in config | n/a | exit 0 before opening the database | same | same | same | same |
| project disabled (`"enabled": false`) | the CLI works regardless | exit 0 before opening the database, nothing printed | same | same | same | same |
| decision-log entry cannot be written (directory unwritable, a query throws) | n/a | n/a | n/a | n/a | the stamp stands; one `errors.log` line, no file | n/a |
| decision-log entry has nowhere to go (cwd in no git repository, git missing or slow) | n/a | n/a | n/a | n/a | the stamp stands; nothing written, nothing logged (not a fault) | n/a |
| bounce row cannot be written | n/a | n/a | the deny or allow stands; one `errors.log` line | the block or pass stands; one `errors.log` line | the end stamp and the bypass update share one transaction, so neither lands; one `errors.log` line | n/a |
| review lab unavailable (no binary, non-zero exit, timeout, empty reply) | `ledger review` records the lab `unavailable` with the error, exit 0 | n/a | the lab is left out of the verdict and named in a `systemMessage`; every lab unavailable allows the push with a `systemMessage` | n/a | n/a | n/a |
| review gate cannot decide (git fails, a query throws) | n/a | the findings line is left out | allows the push with a `systemMessage`; one `errors.log` line | n/a | n/a | n/a |
| plugin gate cannot decide (git fails, a query throws) | n/a | n/a | allows the push with a `systemMessage`; one `errors.log` line | n/a | n/a | n/a |
| pattern-check receipt or its directory unreadable | `ledger review` runs on the diff alone; one `errors.log` line | n/a | n/a | n/a | n/a | n/a |

## Doctor and the bounce ledger

`ledger doctor` runs these checks, in this order, and prints one line each:

| Check | ok | warn | fail |
| :- | :- | :- | :- |
| `db` | the configured path opens, and the file and its folder are writable | the file does not exist yet (it is created on first use) | it does not open, or it or its folder is read-only |
| `schema` | `cc_meta` schema version equals this plugin's | | any other version |
| `config` | names the layer that set `db` and the one that set `enabled` | `enabled` resolves `false`, or a config file did not parse | |
| `hooks` | `hooks/hooks.json` lists SessionStart, UserPromptSubmit, PreToolUse, Stop and SessionEnd, and each script exists | | an event or a script is missing |
| `errors` | no `errors.log` lines for this database in the last 7 days | lines for this database in the last 7 days: counted per hook, the last 5 printed | |
| `bounces` | no open bounce rows older than 24 hours | open rows older than 24 hours, counted per rule | |
| `stale` | no open or held question whose session ended more than 24 hours ago | such questions, listed with their id, state, name, when asked, when the session ended and the folder; the way out is `answer`, `withdraw`, or asking it again from a live session, which adopts it. A question with no session is never stale; a session that never ended (a crash) is reached by the 7-day sweep only | |
| `digest` | last posted within 8 days (or first seen within 8 days when never posted) and no failed attempt since | overdue, or the last attempt failed (the SessionStart lines, same words), or `digest.enabled` is false | |
| `review <lab>` | one per lab in `review.labs` (none when `review.mode` is `off`): the lab's binary is on `PATH` | the binary is missing | |

Doctor opens the database read-only and never creates or migrates it. The SessionStart doctor
line does not run all of this on every start: it runs only the cheap checks (the database
opened, which the hook needs anyway; the schema version; the `errors.log` count for the last 7
days) and adds one line, after everything else and never truncated, on `compact` too, when any
of them finds an issue. A database that does not exist yet is not an issue.

`errors.log` is one file per state folder, shared by every database a machine uses. Since
0.4.1 each line carries `ctx={"session","cwd","ppid","parent"}` (the session id, the folder,
and the parent process's command, `? (ps <why>)` when ps cannot run) and a store failure's line
names its SQLite codes. Each line
ends with ` [db <path>]`, the database the writing process had configured, and `doctor` and the
SessionStart line count only the lines for the database they check. Lines for another database,
and untagged lines from ledger 0.2.x, are named in the `errors` check's ok text as "not counted".
A `config <file>: … ignoring it` line is counted only while that notice still reproduces: doctor
re-reads the named file (from its folder, so a project file is found too) and, when the file no
longer produces the notice, drops the line and names it as `n stale config notice(s) ignored`.
Such a line ages out of the 7-day window on its own; the file is never edited.

The bounce ledger is `cc_bounces`: one row per Stop block and PreToolUse deny, with the rule,
session, `prompt_id`, tool and time. A row starts open and is closed once:

| Rule | Marked `satisfied` when |
| :- | :- |
| `stopAnswerRule` | a later Stop of the same session and `prompt_id` finds an answer or withdraw for one of the session's questions recorded after the bounce |
| `stopAskRule` | a later Stop of the same session and `prompt_id` finds a question the session asked after the bounce |
| `stopDecisionRule` | a later Stop of the same session and `prompt_id` finds a `note` the session recorded after the bounce |
| `stopOwedRule` | a later Stop of the same session and `prompt_id` finds none of the session's owed items made at or before the bounce still blocking |
| `stopOfferRule` | a later Stop of the same session and `prompt_id` finds a question the session asked after the bounce |
| `denyAskWithoutRow` | a later `AskUserQuestion` in the same session is allowed |
| `pushNeedsNote` | a later `git push` / `gh pr create` in the same session is allowed |
| `reviewGate` | a later `git push` / `gh pr create` / `gh pr merge` in the same session that the review gate allows (with or without a notice). Only a deny writes a row |

The Stop rules are matched on the remedy, not by re-reading the reply, so a reply that only drops
the question mark or the decision phrase leaves its row open. An answer counts for
`stopAnswerRule` when this session recorded it, or when the question belongs to the session the
way the Stop rule decides it (tagged with the session, or untagged and asked in or around its
folder since it started). At SessionEnd every row still open for the session becomes `bypassed`,
in the same transaction as the end stamp. `bypassed` is not final: `claude -p` and every resumed
session fire SessionEnd at the end of each process under the same session id, so a remedy after a
resume turns a `bypassed` row `satisfied`. A row stays `bypassed` only when its session id never
comes back with the remedy. `cc_sessions.last_block_*` is unchanged.

## Cross-lab review

`ledger review` sends the branch's diff (`git diff <base>..HEAD`; the default base is the
merge-base with `origin/main`, else with a local `main` or `master` HEAD has moved past, else
`HEAD~1`; `--base <ref>` overrides it for the diff only) to every lab in `review.labs` at once
and records one `cc_reviews` row per lab for the HEAD commit. Each lab is asked to start every
finding with `[blocking]`, `[should]` or `[nit]` (untagged counts as `should`); the parsed list is
kept in `findings_json`. A row's verdict is `pass` (no findings), `pass-with-nits` (nits only),
`findings` (any blocking or should) or `unavailable` (the error). `--labs a,b` runs only those
labs this once. Each lab has 240 seconds; a timeout kills the CLI's whole process group. HEAD and
the base are resolved to commits once, before the labs start, and the diff is taken between those
two commits, so the rows name exactly the commit the labs read. Every row records the branch's
base (the default one, whatever `--base` said) and the branch name. `--base` never changes the
round count or which earlier findings are reconciled, so a narrower diff cannot drop a finding
without the judge.

A reviewer reads the diff it is handed and nothing else. Each CLI runs with its lab's own
tool-free switch (below), from a fresh empty scratch folder (so no agent file, settings, hooks or
instructions from the repository under review are found), with an environment built from an
allowlist (process basics, locale, proxies, CA bundles, and the lab's own `*_API_KEY`-style
variables) instead of the caller's, and `LEDGER_ENABLED=0` so the ledger's hooks stay out.

| Lab | How it is run |
| :- | :- |
| `codex` | `codex exec --skip-git-repo-check --ephemeral -s read-only --color never -` with the prompt and diff on stdin; `-m` from `review.models.codex` |
| `kimi` | `kimi -p "<prompt and diff>" --output-format stream-json --agent-file <scratch>/ledger-reviewer.md --skills-dir <empty>` (its CLI takes no stdin prompt, so a diff over 200 kB is recorded `unavailable`). The agent file sets `tools: []` and `subagents: []`; the reply is the last assistant message, and an assistant tool call makes the review `unavailable`. `-m` from `review.models.kimi` |
| `claude` | `claude -p "<prompt>" --no-session-persistence --tools "" --strict-mcp-config --disable-slash-commands` with the diff on stdin; `--model` from `review.models.claude` |
| `glm` | Z.ai GLM through `omp -p --no-session --no-tools [--profile <review.profiles.glm>] --model zai/glm-5.3 @<diff file> "<prompt>"`; no `--profile` unless `review.profiles.glm` names one; model from `review.models.glm` |

`LEDGER_REVIEW_BIN_<LAB>` (e.g. `LEDGER_REVIEW_BIN_CODEX`) points a lab at another binary.

The gate checks the commits the command publishes, not the hook's folder. Each command runs in
the folder its preceding `cd`/`pushd` select, in its own shell scope: a `cd` inside `( … )` or a
command substitution does not move a command after it. `git push` checks the repository its
`-C` options select, then each refspec's source; a deletion publishes nothing. With no refspec,
git's own choice is followed: HEAD under `push.default` `simple`, `current` or `upstream`,
nothing under `nothing`. `gh pr create` without `--head` checks HEAD (gh pushes the current
branch). With `--head <branch>` gh does not push, so the gate asks the remote for that branch as
it is now (`git ls-remote` of the branch's upstream, else `origin`'s `refs/heads/<branch>`) and
checks that commit; a local remote-tracking ref is never used, because it may be stale. The
lookup cannot prompt: an empty `GIT_ASKPASS` with `GIT_TERMINAL_PROMPT=0`, `-c core.askPass=`
and `-c credential.helper=` (no askpass program, keychain or other credential helper runs),
`SSH_ASKPASS` dropped with `SSH_ASKPASS_REQUIRE=never`, and `-o BatchMode=yes` put right after
the executable of the ssh command the repository already uses (`GIT_SSH_COMMAND`, else
`core.sshCommand`, else `GIT_SSH`, else `ssh`). ssh keeps the first value it gets for an option,
so a `-o BatchMode=no` in that command loses. A wrapper script in place of ssh gets the `-o`
first too; one that rejects it fails, and the call is allowed with a notice. The lookup runs in a process group of its own, and after
5 seconds the whole group is killed, transport helpers included; where process groups do not
exist only git is killed, and the notice says its helpers may still be running. `gh pr merge` checks the full sha given to `--match-head-commit`, else the head
commit `gh pr view` reports for that pull request (5 seconds); in that case an allowed merge
carries a notice naming the commit checked and the `--match-head-commit <sha>` that binds the
merge to it, because the head can move before the merge runs. The command is read with shell
quoting, so a quoted `git push` inside an argument is not a push, while one inside `$(…)` or
backticks (unquoted, in double quotes, or in an unquoted heredoc) is.

Two shapes are denied under `gate` from the command text alone, whatever HEAD's review says
(since 0.3.11; under `advise` each is a notice):

- **A push from a folder the gate cannot follow.** A `cd`, `pushd` or `-C` whose folder is
  computed (`$VAR`, `$(…)`, a backtick, `~`, a glob with `*`, `?` or `[…]`, a `{a,b}` brace
  expansion, `cd -`, a bare `cd`), a literal `cd` from inside a repository to a folder that does not exist, `--git-dir`,
  `--work-tree`, a `GIT_CONFIG*`, `GIT_DIR`, `GIT_WORK_TREE` or `GIT_NAMESPACE` assignment or
  export, a `-c` or `--config-env` that sets push, remote or branch config. The way out, named
  in the reason: re-issue the push as its own command with a literal folder,
  `cd /absolute/path && git push <remote> <branch>`. A hyphen in a literal folder name is fine;
  a folder whose own name has `[`, `]`, `{` or `}` is refused even when quoted, so push from a
  folder above it.
- **A push chained after a command that may change the commit it publishes.** A `git push` or
  `gh pr create` on the same command line as an earlier `git commit`, `rebase`, `merge`,
  `cherry-pick`, `revert`, `reset`, `pull`, `checkout`, `switch`, `am`, `fetch`,
  a `stash` other than `list` or `show`, a `branch` or `tag` that creates, moves or deletes, a `config` that writes,
  a `submodule update`, a `worktree add`, a `remote update` or `set-url`, a `notes` write,
  `gh pr checkout`, or any other git subcommand the gate does not know
  to leave HEAD and every other ref alone, a git alias included (`add`, `status`, `log`,
  `diff`, `stash list`, a listing `branch` or `tag`, a reading `config` and the like are
  known). A `gh pr merge` that names no pull request is refused the same way: the hook runs before any of the line does, so the commit that would be
  published does not exist yet. The way out: run that command first, review the commit, then
  run the push as its own command.

When the command does not say which commit for another reason, the call is allowed with a notice
saying so: `--all`, `--mirror`, `--tags`, `--branches`, a `:` or pattern refspec, a configured
`remote.<name>.push`, `push.default matching`, `--head <owner>:<branch>`, a remote that cannot
be read in time or has no such branch, gh failing.

For each commit the gate reads its rows, strictest first: a `waived` row lets it through; any lab
whose latest row is `findings` (and not followed by `addressed`) denies, with the findings
grouped by lab; no row at all denies; `pass-with-nits` allows with a notice listing the nits;
labs that were `unavailable` are left out and named in a notice, and when every lab was
unavailable the push is allowed with a notice. A new commit is a new HEAD, so a pass does not
carry over. A deny is only given while the database can take the write that lifts it (`review`,
`waive`); when it is locked, the push is allowed with a notice.

The round count needs a stable base. It is the merge-base with `origin/main` (else a local
`main` or `master`); on a branch with neither, the base the branch's first review recorded, while
it is still an ancestor of HEAD (a review from the root records the empty tree, so the root
commit's review stays round 1); else HEAD's parent.

**The loop.** After `findings`, the agent fixes the blocking and should findings, commits, and
runs `ledger review` again on the new commit. Each reviewed commit on the branch (since the
base) is one round; the output names the round and `review.maxRounds` (default 3). A review that
would go past the cap stops without running and says to ask the human: waive with their reason,
or continue with `--force-round`.

**The judge.** A blocking or should finding counts as resolved only when a judge model agrees.
Each lab's outstanding findings are its latest row that is not `unavailable`, on any reviewed
commit of the branch, this one included; a later row replaces an earlier one only when it is on
the same commit or a descendant, so a review of an older commit clears nothing found on a newer
one. Three things go to the judge: an outstanding finding the
lab's new reply no longer lists, one it lists again only as a nit, and every outstanding finding
on an earlier commit when the agent runs `review addressed "<why>"`. A lab that is `unavailable`
this time, or not in this run's labs, gets a `findings` row on the new commit carrying its
outstanding findings, so skipping a lab does not clear them. For each finding the judge gets the
finding and the diff between the two commits for the files it names, capped at 8 kB together;
a longer passage is cut and ends with a line saying so and giving the sha256 of the whole, so the
cache tells two long inputs apart. The question is "Does this change resolve the finding? Answer
yes or no." `no` keeps the finding open (`judge: "no"` in `findings_json`, the row stays
`findings`, the gate stays closed, and the output names it); `yes` resolves it. A judge that is
not configured, cannot start, times out (60 seconds) or answers anything else gives
`unverified`: the finding counts as resolved, fail open, and the gate's notice names it. Answers
are cached in `cc_judge_cache` under `judge:<sha256>` with the passage they were given, so asking the same thing again costs nothing and a cached answer can be read back with `review judge <key>`. The
judge command is `LEDGER_JUDGE_BIN`, else `review.judgeCommand`, else `command` in the shared
judge file `${XDG_CONFIG_HOME:-~/.config}/judge/config.json` (written by `node lib/judge.mjs
setup`), else the i-have-audhd plugin's `enforcement.judgeCommand`: one judge, configured once.
Ledger's diff judge never runs shorter than 60 s; a longer shared `timeoutMs` is honoured (`setup`
writes 30000 unless given `--timeout-ms`, and ledger keeps its 60 seconds over that). A command
that prints a `claude -p --output-format json` envelope is read through it: the answer is its
`result`. `lib/judge.mjs` is plugin-kit's shared dispatch, copied byte for byte; ledger's cache
and verdicts live in `lib/ledger-judge.mjs`.

| Verb | Effect |
| :- | :- |
| `review status` | the gate's state for HEAD; the branch's rounds (round, sha, lab, counts by severity, verdict); then every row for HEAD |
| `review addressed "<why>"` | the manual override of a finding: records that HEAD resolves the outstanding findings of earlier commits, each checked by the judge. Refused without a reason, when HEAD has findings of its own (fix, commit and review again, or waive), when there are no outstanding findings, or when the judge says `no` (which records a `findings` row for HEAD naming them) |
| `review waive "<why>"` | lets HEAD through; the reason is required and recorded. This is the way out when the human is prototyping or needs the push anyway |
| `review judge <key>` | prints one cached judge answer with the question and passage it was given (`judge:` prefix optional). Answers cached before 0.3.3 say `(not kept: cached before 0.3.3)` for both. Exit 1 for an unknown key |

SessionStart adds `ledger: cross-lab review found N finding(s) on <sha>; run … review status`
when HEAD has open blocking or should findings (not when `review.mode` is `off`).

### The pattern-check receipt in the prompt

Since 0.3.3 the labs read the author's [pattern-check](../pattern-check/README.md) receipt
before the diff, when there is one: the newest `.md` by mtime in `<repo>/.pattern-check/`
(`receiptDir` in `.pattern-check.json` overrides the directory) goes in under the heading
`Pattern-check receipt (what exists, how it fails)`, then `## Diff`, then the diff. The
prompt asks each lab to check every "how it fails" row against the diff and to tag a failure
path the receipt states and the code lacks, or a silent failure path in the code the receipt
does not name, `[blocking] fault-tolerance:`; the parsed item keeps `kind: "fault-tolerance"`.
A receipt over 32 KiB is cut there with a marker. No directory, no `.md` in it: the prompt is
the diff alone, as before. A receipt or directory that cannot be read: one `errors.log` line,
the prompt as before, the review runs.

## The plugin gate

A second gate on `git push` and `gh pr create`/`merge`, since 0.3.3, for a repository of
Claude Code plugins: one holding `plugins/*/hooks/hooks.json` or a root
`.claude-plugin/plugin.json`. It enforces the repository `AGENTS.md` test bar as six checks
(three since 0.3.3, `evals` and `retention` since 0.3.5, `docs` since 0.3.6), the same six for
every kind of agent-facing artifact, run by `ledger gate check` and recorded
as one `cc_gate_checks` row per (HEAD, plugin, check); a rerun replaces the rows. Only plugins
with a file changed in base..HEAD are checked (base: the review's default base, or `--base`;
`--plugins a,b` names them instead). The checks read the commit, never the checkout: each
plugin is checked out of HEAD's tree into a temporary directory (`git read-tree` and
`checkout-index` against a scratch index, so the repository's index stays as it was), and each
row keeps the hash of that plugin tree (`tree_sha`). An uncommitted repair counts for nothing
until it is committed, and the run says so (`(uncommitted changes under plugins/x/ were not
checked; commit them and rerun)`); a committed file deleted from the checkout is still checked,
since it is still pushed.

| Check | Passes when | Fails naming |
|---|---|---|
| `survives` (can't break the session) | every hook command in `hooks/hooks.json` exits 0 within 5 s, with stdout that is empty or JSON and no `permissionDecision: deny`, `decision: block` or `continue: false`, on each of five fault inputs: empty stdin, malformed JSON, an unknown event, an unwritable state (the plugin's `XDG_STATE_HOME` and `XDG_DATA_HOME` directories read-only, with a writable `errors.log` in the first), and no config (an empty `HOME`, `XDG_CONFIG_HOME`). A PreCompact hook may instead print plain text under 10,000 characters (since 0.3.10): Claude Code uses that stdout as instructions for the compaction summary | the hook and the input (`PreToolUse hook on empty stdin: exit 1`, `Stop hook on healthy: stdout is not JSON (…)`, `PreCompact hook on …: plain-text stdout is <n> characters; …`). A plugin with no `hooks/hooks.json` is `skipped` |
| `visible` (failures visible) | the malformed-JSON and unwritable-state inputs each left a line in `<XDG_STATE_HOME>/<plugin>/errors.log` and a `systemMessage` on stdout (SessionEnd has no reader, and Claude Code discards a PreCompact hook's `systemMessage`, so neither one's message is required, since 0.3.10 for PreCompact; a hook that printed nothing and logged nothing on the unwritable state never reached it and is not failed, the malformed-JSON input being the one every hook must answer; since 0.3.13, neither is a hook that logged nothing on the unwritable state after its healthy run wrote nothing in the directories that input makes read-only, whatever it printed, so a stateless hook whose output changes from run to run, such as a clock line, passes every time; "wrote nothing" is what a write tracker preloaded into a node hook recorded, and a hook it cannot follow gets no such pass); every `test/fixtures/<x>.txt` has an `<x>.unavailable.txt` sibling | the hook and input, or the fixture without its sibling |
| `says` (text says what to do when it can't) | every `skills/*/SKILL.md` and `agents/*.md` has a heading matching `when this can't` (`it cannot`, a curly apostrophe count too); every deny or block reason literal in `hooks/*.mjs` and `lib/*.mjs` (a string or template right after `permissionDecisionReason:`, or after `reason:` with `deny`, `block` or `rule:` within the five lines up to it; comments are skipped) names a command in backticks | the file, or the file, line and literal |
| `evals` (behaviour is proved) | `evals/manifest.json` declares, for every event `hooks.json` registers, the outcomes its handler can return (`deny`, `allow`, `ask`, `systemMessage`, `silent`); every declared event × outcome has one `evals/<x>.scenario.json` naming `event`, `expect` and a stdin fixture (`stdin` or `stdinFile`) and not marked `"stub": true`; a silent scenario of an event that can also fire names a `sibling` that does; a `judge` rubric has a `session` to grade. Then freshness: the newest `cc_canary_runs` row for the committed plugin tree (`tree_sha`) is a `pass`, or `unavailable` with its reason (no `claude` on the canary's PATH is the canary's finding, not the plugin's), and when any scenario is judge-backed that row is a `pass` at most 7 days old | the gap (`no scenario for Stop × deny`), the stub or malformed scenario file, or the canary: `no canary row for tree <sha>: run \`ledger canary run --plugins <p>\` on this commit`, a failed run with its note, or a judge-backed plugin whose newest row is not a pass. A plugin with no `hooks.json` and no `evals/` is `skipped` |
| `retention` (state is declared and pruned) | `.claude-plugin/plugin.json` `state` is an array of `{ path, retentionDays, prune }` (`~`, `$HOME`, `$XDG_*`, `$TMPDIR`, `<worktree>` placeholders, `*` for one segment; `kind: "file"` for a single file; `retentionDays: null` is kept by design; a positive `retentionDays` needs a `prune` command); a plugin whose source (`hooks/`, `lib/`, `scripts/` and the rest; tests, fixtures, evals, e2e, templates and the kit's two copied runners excluded) writes or resolves paths outside the worktree declares `state`; every write the canary observed (`cc_canary_runs.writes`) sits under a declared path | the malformed entry, the write sites with no `state` (`hooks/stop.mjs:41, …`), or `the canary saw a write at $XDG_STATE_HOME/<p>/x under no declared state path` |
| `docs` (a release is written down) | the plugin's `.claude-plugin/plugin.json` `version` is the base commit's (`skipped`: `version 0.3.5 unchanged since the base`; also skipped when neither the base nor the head manifest has a `version`; a `version` the base had and the head dropped fails with `manifest version missing at head`), or, when it differs (or the base has no manifest: a new plugin), all three hold: `CHANGELOG.md` and `README.md` in the plugin each have a release heading for the new version with at least one non-blank line under it, before the next heading of the same or a higher level; and the repository root `README.md` names the plugin. One rule reads both plugin files: a release heading is a heading at any level (`#` to `######`, under any parent heading or none) whose text starts with `<ver>`, `[<ver>]`, `Changes in <ver>` (any case), or `<YYYY-MM-DD> — <ver>` (em dash, en dash or hyphen), so `## [<ver>] - <date>` (Keep a Changelog), `## <ver>`, `## Changes in <ver>`, `### <ver>` and `### <date> — <ver>` all count in either file; the first such heading is the one read, a heading for a newer version is not looked at, and a heading inside a fenced code block does not count. The root README is an index and is never asked for a version: it names the plugin in a table row whose first cell is the plugin's name (`\| <plugin> \| …`, in a code span or not), in a `-` or `*` bullet that starts with the name, bold and linked or not (`- **[<plugin>](…)** …`, `* <plugin> …`), or in a heading whose whole text is the name (`## <plugin>`); another plugin's row, bullet or section does not count, nor does any of the three inside a fenced code block. The version is matched as a whole token in the plugin files: `0.3.6` is not found in `10.3.6`, `0.3.60`, `0.3.6.1`, `0.3.6-rc.1` or `v0.3.6`, and a heading's brackets must balance (`## [0.3.6` and `## 0.3.6]` are not release headings). The base manifest and the root README are read out of the commits, like the plugin's own files. A root plugin's README is the repository's, so the third part is not asked of it | the file and the heading it wanted (`CHANGELOG.md has no "## [0.3.6]" (or "## 0.3.6") heading`, `README.md has nothing under its 0.3.6 heading`, `the repository README.md does not name ledger: add its row to the plugin table ("\| ledger \| …"), or a bullet starting with "ledger", or a "## ledger" heading (the root README never names a version)`), or `CHANGELOG.md is missing: add it with a "## [0.3.6]" (or "## 0.3.6") entry` |

The whole run is capped at 60 s; a check that does not start before the cap records `fail`
with `timeout`. Exit 0 when every row passes or is skipped, 1 when one fails (or when `--base`
names no commit: `gate check: --base <ref> is not a commit`, before any row runs), 2 when the
repository holds no plugin.

At push time the plugins are the pushed commit's (`git ls-tree`), not the checkout's, so
removing a plugin's `hooks.json` from the checkout does not take it out of the gate, and a
push of a commit other than HEAD needs rows for that commit. The PreToolUse deny, given with
the note and review gates' as one numbered list when more than one applies, is `ledger: plugin
gate: <plugin> has no check rows for <sha>; run \`… gate check\`, fix, or \`… review waive
"<why>"\``, `… failed <check>: <detail>; run …`, or, for rows whose `tree_sha` is not that
commit's plugin tree, `… <plugin>'s rows for <sha> certify tree <t1>, not its tree <t2>; run
…`, or, for rows that lack one of the six checks (recorded by a ledger older than the
check, such as 0.3.5 before `docs`), `… <plugin>'s rows for <sha> have no docs row (recorded by
an older ledger); run \`… gate check\` again, …`. A
`review waive` row for HEAD lifts this gate as it lifts the review gate; `review.mode`
`advise` turns the deny into a notice and `off` turns the gate off. A repository that holds no
plugin never sees it. The push's commits are resolved once for both gates, so a remote that hangs
is waited on once. Any fault (git fails, a query throws) allows the push with a `systemMessage`
and one `errors.log` line. Each deny writes a `pluginGate` bounce row; a later push the gate
allows marks the session's open ones satisfied.

## The decision-log entry

Since 0.3.3, SessionEnd leaves the record a manual `/wrap-up` (the newdle plugin's) would, in
the same place and shape, when the session decided something through the ledger. It writes when
all of these hold: the session's cwd is in a git repository git could name (one `git rev-parse`,
one second; no repository, or git missing or slow, means no toplevel and nothing written, even
with a `.ai/decision-log` beside the cwd) and its toplevel has `.ai/decision-log/` (never
created); the session recorded at least one answer (its own, or one
to a question it asked) or one note; `decisionLog.enabled` is not `false`; and no entry in the
directory carries a time inside the session's start..end (its filename's `YYYY-MM-DD--HHMM`, else
its mtime), which means a wrap-up already ran. Otherwise nothing is written.

The file is `<repo>/.ai/decision-log/<YYYY-MM-DD>--<HHMM>--claude-desktop--<slug>.md` on the
local clock (`-2`, `-3` when the path exists); the slug is the branch, else the first answered
question's name, else the first note. The frontmatter is the wrap-up's: `date` (ISO 8601 with the
offset), `engineer: claude-desktop`, `session` (one line of counts), `status` (`resolved` when
none of the session's questions is still open or held, `open` when one is), `durable: false`.
The four sections: *What changed* lists the session's notes and outcomes; *Decisions made (and
why)* lists each answered question's body and the chosen option (never the id alone), with the
options offered and who answered; *Dead ends* lists the session's withdrawn questions with the
withdrawal's reason; *Heads-up* lists its questions still open or held. Any fault (git missing,
a query that throws, the directory unwritable) is one `errors.log` line and no file; the session
stamp is unaffected.

The reader is the other half, for Claude Desktop, which runs with the newdle plugin off and so
never gets that plugin's SessionStart injection of the log. When `decisionLog.enabled` is not
`false` and the repository's toplevel has `.ai/decision-log/`, SessionStart appends one block
after the ledger's own: the 5 newest entries (date, engineer, the title from the H1 or the
filename, the first two body lines each), then every older entry whose frontmatter says
`status: open` or `durable: true` (newest first, as many as fit; there is no count cap below the
budget), the whole at most 3000 characters including its `N more not shown` line, which counts
every entry not shown. It stands down where the newdle hook will inject: the nearest
`newdle-hooks.json` walking up from the toplevel (and from a linked worktree's main checkout)
says `"hooks": "on"`, the plugin's own scope rule, copied, not called; an absent, malformed or
`"off"` file is walked past or honoured as the plugin would. A newdle mute file is not read: a
muted recent-activity hook leaves both silent, the mute being the person's to lift. An entry that
cannot be read is left out; a fault in the reader is one `errors.log` line and no block.

## The feedback loop: canary, report, digest

Three verbs, added in 0.3.3, that tell whether the hooks are doing anything useful. Each runs
on its own line (never inside a batch) because each spawns processes.

### `canary`

`canary run [--repo <path>] [--plugins a,b] [--timeout <s>] [--no-prune | --prunes-only]` runs every plugin's
`e2e/live-run.sh` from its plugin directory (every directory under `<repo>/plugins/` that has
`hooks/hooks.json` or `.claude-plugin/plugin.json`; `--repo` defaults to the checkout this
plugin is loaded from) and inserts one `cc_canary_runs` row per plugin: `pass` (exit 0), `fail`
(any other exit, or the deadline, default 600 s, the process group killed), `unavailable` (no
script, exit 75, or no `claude` on PATH). The script writes its own stream-json transcript to
`CANARY_TRANSCRIPT` (`<state>/canary/<plugin>/<time>.jsonl`), and the canary keeps that file as
written (`transcript_path`; NULL with `no transcript from the script` in the note when the
script wrote none); the script's stdout and stderr go to `<time>.out.txt` beside it
(`output_path`), and the row keeps their last 16 KiB as `summary` and a line diff against the
plugin's last pass as `diff`. Since 0.3.5 the row also keeps `tree_sha`, the committed plugin
tree the run certifies (`git rev-parse HEAD:plugins/<p>`; NULL, printed `uncommitted tree`,
when the plugin has uncommitted changes or the repository is none: the gate's `evals` row
trusts only a row for the committed tree, so run the canary on the commit you push), and
`writes`, the script's `wrote: <path>` lines (files the live run left outside its work
directory, in placeholder form such as `$XDG_STATE_HOME/<p>/x`; the gate's `retention` row
checks each against the plugin's declared `state`). After the live runs, every `prune` command
the plugins declare in `.claude-plugin/plugin.json` `state[]` is run once, in the canary's own
environment (the real state is what is pruned), and recorded as a `cc_canary_prunes` row with
the bytes it reported freed (`… <n> bytes freed` on its last stdout line; NULL when it
reported none); `--no-prune` skips that pass. A prune that fails is its own row and never fails
the run. Exit 0 when nothing failed, 1 when something did, 2 when the store
could not be written (the canary has no session to fail open into; both paths are named so
nothing is lost; since 0.3.9 the prunes still run before that exit, so a store that cannot be
written never leaves state growing).

`canary run --prunes-only [--repo <path>] [--plugins a,b]` (0.3.9) is the daily job: no live
run, no `cc_canary_runs` row, every declared prune run before and independently of any database
write (a `cc_canary_prunes` row per prune is still attempted; one that cannot be written is
`not recorded: <reason>` on the line and changes nothing else; a store that cannot be opened at
all records no row, the prunes still run, and stderr ends `ledger: database <state> at <path>…;
the prunes ran, their rows were not recorded`). One line per prune,
`prune <plugin>: <its last stdout line>` (`unavailable, …` or `fail, exit <n>: …` ahead of it
when it was not a pass). Exit 0 when every prune ran (pass, or unavailable by its own exit 75),
1 when any failed or could not be started, naming each on the last line. The launchd line for
it is `canary install --prunes-only` below. Each `canary` action takes only its own switches:
`canary run --dry-run` (or `canary install --dry-run`) is the usage line on stdout, exit 2,
before the store is opened or anything runs; every `canary` usage error is exit 2.

The canary contract a plugin's `e2e/live-run.sh` follows (plugin-kit's `new-plugin` skill
ships a template): run from the plugin directory with `CANARY_PLUGIN`, `CANARY_TRANSCRIPT` (the
path the script copies its transcript to; the canary never writes there) and `CANARY_TIMEOUT_S`,
and with every `LEDGER_*` key of the caller's environment removed, so a `LEDGER_DB` in the shell
that runs the canary cannot outrank the script's throwaway config and point its seeded question
and headless session at the real store (the scripts `unset` the same keys themselves, for a run
by hand); exit 0 pass, 75 unavailable
with the reason on the last stdout line, anything else fail. Since 0.3.5 every plugin in this
repository has the script, and each one hands off to plugin-kit's `lib/live-run.mjs` (the
scenario runner): the hook phase replays every `evals/*.scenario.json` against the checkout's
hooks in a sandbox and needs no model; the live phase, when `claude` is on PATH, runs the
pinned CLI-contract session and every scenario with a `session`, and a `judge` rubric is graded
by `claude plugin eval`. The ledger's own scenarios cover its five events (the relayed
question at SessionStart, the `ledger` line at UserPromptSubmit, the push and ask gates at
PreToolUse, the Stop ask rule); the ledger pane has no live scenario and is listed under
`manual` in `evals/manifest.json`.

`canary runs [N] [--plugin <name>]` lists the last N rows. `canary status` prints, per plugin,
the last run (its status, id, time, tree and note) and the last pass, then the last prune per
declared path. `canary grade <id> biting|silent|fine
["<note>"]` records who read a run and what they made of it (`--by`, default `human`).
`canary prune [--days 30] [--dry-run]` removes transcript and output files older than that; rows
stay for ever. It is the prune command the ledger's own `state` declaration names for
`$XDG_STATE_HOME/ledger/canary`, so the nightly run prunes the ledger too, and since 0.3.9 it
follows the plugin-kit prune contract: the last line is
`pruned: <n> file(s), <bytes> bytes freed[ (dry run)]; kept <k>`, `--dry-run` counts and removes
nothing, a file that cannot be removed is named on stderr and counted as kept, exit 0.
`canary install [--repo <path>] [--hour 3] [--minute 30] [--prunes-only]` (a relative `--repo` is resolved against the cwd first: launchd runs the job from `/`; a path with no `plugins/` directory is refused) writes
`<state>/launchd/com.jo-wolff-plugins.ledger-canary.plist` (nightly, `canary run --repo …`,
logs beside it), checks it with `plutil -lint`, asks `launchctl print` whether the job is
loaded, and prints the `launchctl bootstrap gui/<uid> <plist>` line for you to run. It never
runs bootstrap itself. With `--prunes-only` (0.3.9) it writes
`<state>/launchd/com.jo-wolff-plugins.ledger-prunes.plist` instead (daily at 10:00 by default,
`canary run --prunes-only --repo …`) and leaves the nightly plist alone; the two jobs are
independent, so the bootstrap for the daily prunes is:

```
node "$CLAUDE_PLUGIN_ROOT/scripts/ledger.mjs" canary install --prunes-only --repo <checkout>
launchctl bootstrap gui/$(id -u) "${XDG_STATE_HOME:-$HOME/.local/state}/ledger/launchd/com.jo-wolff-plugins.ledger-prunes.plist"
```

The full nightly canary (`canary install`, 03:30) stays as it is; it prunes too, after the live
runs.

### `report`

`report [--since 7d] [--no-judge]` prints, per rule (the three Stop rules, the two PreToolUse
rules, the review gate, and any other rule name found in `cc_bounces`): fired, satisfied,
bypassed, open, and a grade. The mechanical grade is always computed: `biting` when bypassed ≥ 3
or more than half of what fired was bypassed (the rule sent back work that was then forced
through); `silent` when sessions ran in the window and the rule never fired; `fine` otherwise.
When a judge is configured (`LEDGER_JUDGE_BIN`, `review.judgeCommand`, the shared judge file,
or the i-have-audhd profile) it reads up to 20 bounce texts per rule that fired and answers `biting`, `silent` or
`fine`; that answer is printed beside the mechanical one as `(judge: …)` and never stored. A
judge that is missing, fails, answers none of the three words, or has no texts to read (rows
from before 0.3.3) prints `(judge unavailable: <reason>)`; the mechanical grade stands. Then:
canary runs in the window per plugin (last status, counts, grades), reviews waived with their
reasons, and the judge's cached yes/no answers. Read-only.

### `digest`

`digest [--dry-run] [--force]` builds the 7-day report, writes `cc_meta.digest_last_attempt`
first, then posts it with `gh issue comment <number> --repo <owner/repo> --body-file -` (30 s
deadline) to `digest.issue` (default `thewolff/jo-issues#325`). Success writes
`digest_last_posted` and clears `digest_last_error`; failure writes `digest_last_error` with the
reason (`gh not found on PATH`, `gh exited 1: …`, `gh timed out after 30s`), exits 1 and
prints the body so nothing is lost. An empty week still posts (`0 bounces, 0 canary runs,
nothing graded`): no comment means the job did not run. A second post within 24 h is refused
unless `--force`. `--dry-run` prints the body and writes no key. The body is at most 60 KiB,
cut with a marker. `digest install` writes
`<state>/launchd/com.jo-wolff-plugins.ledger-digest.plist` (Monday 09:00 local) the same way
`canary install` does.

The dead-man's switch: SessionStart stamps `digest_first_seen` once, then adds
`ledger: weekly digest overdue (last: <date>); run \`… digest\` or check launchd` when the
last post (or, never posted, that first stamp) is more than 8 days old, and
`ledger: weekly digest attempted <date>, post failed: <reason>` when the last attempt is newer
than the last post and left an error. Both read the local database only, so they work offline.
`doctor`'s `digest` check says the same, or `last posted <date>`. `digest.enabled: false`
turns the post and both lines off, and `doctor` warns that it is off.

## Inspecting the database

```
sqlite3 ~/.local/share/ledger/ledger.db
.tables
SELECT id, name, state, cwd FROM cc_questions WHERE state = 'open';
SELECT q.id, q.name, q.state, a.word FROM cc_questions q LEFT JOIN cc_answers a ON a.question_id = q.id;
SELECT id, kind, body, made_by, made_at FROM cc_notes ORDER BY made_at DESC LIMIT 20;
```

Tables: `cc_meta`, `cc_questions`, `cc_answers`, `cc_notes`, `cc_sessions`, `cc_bounces`,
`cc_reviews`, `cc_judge_cache`, `cc_canary_runs`, `cc_gate_checks`, `cc_canary_prunes`. Timestamps are ISO
8601 UTC. `cc_questions.state` is `open`, `held`, `answered` or `withdrawn`; `cc_answers.via` is
`cli`, `prompt-hook` or `freeform`; `cc_notes.kind` is `note`, `withdraw`, `extend` or `outcome`,
and `cc_notes.ref` carries an outcome's PR, commit or path. Schema version 3 rebuilt
`cc_questions` and `cc_notes`, and version 4 rebuilt `cc_answers`, in place to widen those CHECK
constraints (SQLite cannot alter one); no other table is touched. Version 5 adds two columns and
rebuilds nothing: `cc_answers.session_id` (the session that recorded the answer) and
`cc_sessions.last_prompt_seen_at` (the prompt hook's answers mark). Version 6 creates two tables
and touches no existing one: `cc_bounces` (the bounce ledger; `outcome` is `satisfied`,
`bypassed` or empty while open) and `cc_reviews` (one row per cross-lab review result). Version 7
(0.3.3) adds two columns to `cc_bounces` (`text`, what fired the rule: the reply excerpt or the
shell command, at most 500 characters; `transcript_path`, the session transcript the hook event
named, so the row can be reproduced) and creates three tables: `cc_judge_cache` (the judge's
`yes`/`no` per `judge:<sha256(passage + question)>` key, with the passage and question it was
given; the `judge:` rows that lived in `cc_meta` move here with `passage` NULL and leave
`cc_meta`), `cc_canary_runs` (one row per nightly canary run of one plugin: status
`pass`/`fail`/`unavailable`, exit code, duration, transcript and output paths, summary, diff against the last
green run, grade `biting`/`silent`/`fine` and who graded it) and `cc_gate_checks` (one row per
commit, plugin and check of the plugin push gate, `pass`/`fail`/`skipped` with a detail and
the hash of the plugin tree it certifies). Version 8 (0.3.5) adds two columns to
`cc_canary_runs` (`tree_sha`, the committed plugin tree the run certifies, NULL for an
uncommitted one; `writes`, a JSON array of the files the live run left outside its work
directory, in placeholder form) and creates `cc_canary_prunes` (one row per declared
`state[].prune` command the canary ran after the live runs: the path, the command, its status
and exit code, and the bytes it reported freed). A 0.3.3 or 0.3.4 ledger on a schema-8 file
runs on the tables both know, as described below for 0.3.1 on 7.

### An older ledger on a newer file

The schema only goes up: nothing in the plugin lowers `schema_version` or drops a table, and
there is no downgrade command. A 0.3.1 ledger (schema 6) opened against a schema-7 file does
not migrate (`migrate` returns when the file's version is at or past its own) and runs on the
tables both know: notes, questions, answers, sessions, bounces and reviews written by either
version are read by both. Measured with the 0.3.1 checkout against a file 0.3.3 had created:
`note`, `pending` and the SessionStart hook ran and showed both versions' notes; its `doctor`
reports `fail schema: version 7, this plugin expects 6` and nothing else, which is the only
sign. What 0.3.1 loses: the judge answers, which migration 7 moves out of `cc_meta` into
`cc_judge_cache`, so 0.3.1 asks the judge again and writes its answers back into `cc_meta`,
where 0.3.3 does not look (they are not lost, only unused). What 0.3.1 does not see: the
schema-7 tables and columns (`cc_judge_cache`, `cc_canary_runs`, `cc_gate_checks`, the bounce
text and transcript path), which keep their rows untouched for the next 0.3.3 run.

To go back to a pre-7 file, restore a backup taken before the upgrade (the file is one SQLite
database; copy it with its WAL checkpointed, `sqlite3 <db> "PRAGMA wal_checkpoint(TRUNCATE)"`,
or together with its `-wal` sibling; the plugin takes no backup itself) and accept the loss of
every row written since: that is the whole rollback story, and it is the one for any single-file store.
Do not edit `schema_version` by hand and do not delete a shared file (another tool's tables live
in it).

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

## Ledger pane (Desktop)

A side pane for Claude Code Desktop and the terminal (Claude Code 2.1.286 or later, where
plugins can ship mods; `hooks/hooks.json` names the module, `mods/pane/register.mjs`). It shows,
without a model turn:

- **Answered since your last turn**: the answers and withdrawals recorded on this session's
  questions since its last prompt, the same answers the UserPromptSubmit hook will give Claude
  on your next prompt, so you see them before Claude does. Each shows the question's text and
  `→ <answer>` (or `withdrawn`).
- **Waiting in other folders**: every open and held question asked in a folder that is not this
  one, under the folder's name (its last path segment; two folders with the same name show one
  more segment each, `a/web` and `b/web`). Each question shows its text, then its age (`on
  hold · 2h ago` for a held one), then its actions.

The pane is one column at every width: each heading leads with its count, nothing sits in a
side column a narrow pane would clip, and indentation is layout, never spaces in the text. A
person reads question text there, never a row id or a question's `--name`.

Answering costs no turn. The selected question (the first open one, until you pick another)
shows its option buttons, the default one labelled `<option> · default` and drawn as the primary
button, and a Reply field for free text (Enter records). Every other question shows one
`answer` button whose digit (1 to 9) selects it. From the prompt,
`/ledger answer <q-id> <reply>` does the same; the short form `/ledger <word> <q-id>` records
that one word. Either way the answer goes through the ledger CLI as this session
(`scripts/ledger.mjs --json answer <q-id> <reply>` with `LEDGER_SESSION_ID`), so the asking
window's next prompt gets its `answered since your last turn` line, and the Stop hook there
stops chasing the question. The pane redraws when the CLI returns and says `Recorded: <reply>`
over the question's text, or `Not recorded` with the CLI's reason said as a sentence with no row
id in it. A question with no text shows `(question text missing)`, never its name or id.
`/ledger` opens the pane, `/ledger close` closes it, Esc returns the keyboard to the prompt,
Ctrl+X X closes.

The data refreshes at session start, at the start and end of each of your turns, and once a
second while the pane is on screen; each refresh is one `node mods/pane/query.mjs` run, which
reads with the same `elsewhereQuestions` and `answersSince` the settings hooks use. When a
session starts with something waiting, the pane opens by itself; on a screen too narrow to
place it, a toast names `/ledger` instead.

Where the pane is not placed (`claude -p`, a screen too narrow), the end of each turn adds one
transcript block instead: one line per answer since your last turn, one line per question waiting
elsewhere with its options, and the `/ledger answer` command that records. The block is that line
alone; Claude's reply is not repeated in it. The pane never writes a row itself and never writes
outside the ledger's own tables.

Once per session the mod logs one dim transcript line, `ledger pane: surface=<app|none>
placed=<true|false|null>`: the surface the app handed the mod at session start (`none` means it
handed none; Claude Desktop runs Code headless, so a Desktop session says `none` and still draws)
and whether the pane is placed (`null`: the app cannot say). It is written at session start, or
at the first fallback turn when session start faulted first. A session where the fallback block
appears every turn and this line says `placed=false` is one where the pane is not on screen.

The fallback and the pane fail the same way as the hooks: a query that cannot open the database
shows `Can't read the ledger` and the reason in the pane and one dim transcript line, a CLI
refusal comes back as text (`ledger refused: …` from the prompt, `Not recorded` in the pane),
and no error ever reaches Claude Code.

### Two-window test

1. Open two Desktop windows on two different folders, both with the plugin enabled.
2. In window A ask something through the ledger (`… ask "Which colour?" --name colour --options green,red --default green`, or let the agent ask).
3. In window B type `/ledger`. The pane lists `Which colour?` under window A's folder name, with a `green · default` and a `red` button.
4. Press `red`, or type `/ledger answer <q-id> red`. The pane shows `Recorded: red` over `Which colour?` with no turn spent in either window.
5. In window A send any prompt. Claude's context carries `ledger: answered since your last turn: colour → red (via cli)`, and before the prompt is sent window A's pane shows `Which colour?` and `→ red` under *1 answer since your last turn*.

Tests: `node --test` covers the pane's data layer (`test/pane-data.test.mjs`, `test/pane-query.test.mjs`);
`claude plugin test` from `plugins/ledger` runs the mod through Claude Code's test kit
(`mods/pane/tests/pane.test.tsx`: the command, the drawing, the fallback, the poll, and the
fault inputs).

## Known gaps

- The Stop rules look only at the final message; a question asked and withdrawn mid-turn is not seen, and a decision stated in an earlier message of the same turn is not either.
- The decision rule is a phrase list. A decision worded outside the list passes; a phrase used in a different sense ("I chose not to look") blocks once. A reply that asks a question recorded this turn is not checked: its stated default ("if you don't answer, I'll go with alpha") is already the question's `--default`. `instead of` left the default list in 0.3.0, because it fired on descriptions of bugs ("`add` subtracts instead of adding"). Tune `forcing.decisionPhrases` per project.
- The push gate reads the Bash command text with shell quoting. A push run from a script file, a shell or git alias, a shell function, `sh -c "…"`, `eval` or `xargs` is not seen.
- The review gate's chained-push rule reads git subcommands and `gh pr checkout`. A command that moves HEAD some other way before a push on the same line (a script, `npm version`, a shell alias or function) is not seen, and the push is checked against HEAD as it was.
- Under `gate`, a push whose refs cannot be named is still allowed with a notice: `--all`, `--mirror`, `--tags`, `--branches`, a `:` or pattern refspec, a configured `remote.<name>.push`, `push.default matching`, a remote or `gh` that does not answer.
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

## Changes

### 0.4.2

- The PR-creation review check gates on the commit the PR actually opens: `--head` is
  resolved at `refs/heads/<branch>` on its remote, other options' values are skipped, attached
  `-Hx` / `-H=x` forms are read, and a repeated `--head` checks every branch named.

### 0.4.1

- Store failures name the SQLite primary and extended error codes, in the CLI's error line
  and in `errors.log`, so a read-only database says which SQLITE_READONLY variant fired.
  Every `errors.log` line also carries the session id, cwd and the parent process's command
  (`ctx={…}`), looked up only when a line is written, bounded, and fail-open.

### 0.4.0

- Owed work: `answer` records approved work as owed, and new verbs `owe`, `start`, `drop`,
  `done`, `wait` and `hold <ow-id>` move it. Two Stop rules, `stopOwedRule` and
  `stopOfferRule`, block the end of a turn once per prompt when approved work is not started
  or a reply offers work no question records. Owed work is listed at session start and on
  typed prompts; `ledger report` counts it and names work deferred more than 7 days.

### 0.3.13

- The gate's `visible` check no longer fails a stateless hook at random. A hook that wrote
  nothing in its state or data directory on the healthy input, and logged nothing on the
  unwritable-state input, passes that input whatever it printed. Before, it passed only when
  its output matched the healthy run's byte for byte, so a hook that prints the time failed
  whenever the two runs fell in different seconds. A hook that writes state on the healthy
  input and swallows the unwritable fault still fails. The gate records what the healthy run
  tried to write with a tracker it preloads into node hooks, so a lock file made and removed
  counts as a write; a hook it cannot follow (not a node process, or one that starts a process
  it cannot see or loads a native addon) gets the old byte-for-byte rule.

### 0.3.12

- Ledger pane: redrawn as one column that reads at a narrow dock width. Folders go by name
  (`newdle-mobile`, not the full path); each question leads with its text, then its age on its
  own line, then its actions; the default option is marked on its button (`approve · default`,
  the primary button) and the `options:` line is gone; headings lead with their count; the
  footer is `Esc back to prompt · Ctrl+X X close`; the Reply field's placeholder is
  `type your own`. No row id or question name is drawn: a question that is not selected shows an
  `answer` button with its digit, an answer since your last turn shows its question's text, and
  `Recorded: <reply>` replaces the CLI's `an-… → q-…` line. The query adds each answer's
  question body for that. Indentation is padding, not spaces; every line wraps, none is cut
  short. A question with no text shows `(question text missing)`; CLI refusals and errors are
  said without ids. Error and empty states match.

### 0.3.11

- Review gate, `gate` mode: a push from a folder the gate cannot follow (`cd $W`, `cd $(…)`,
  `~`, a glob, `cd -`, `--git-dir`, a `GIT_*` setting, a `-c` that steers the push) is denied
  instead of allowed with a notice; the reason names the literal form,
  `cd /absolute/path && git push <remote> <branch>`. Hyphens in a literal folder name resolve.
- Review gate, `gate` mode: a `git push` or `gh pr create` chained after a HEAD-moving command
  on the same command line (`git commit`, `rebase`, `merge`, `pull`, `checkout`, …) is denied;
  the reason says to run the push as its own command after a review of the new HEAD.
- `advise` still never denies; both shapes are a notice there.

### 0.3.10

- The gate's `survives` check accepts plain-text stdout from a PreCompact hook that exits 0 and
  prints under 10,000 characters: Claude Code uses that stdout as instructions for the
  compaction summary. JSON stays valid there; every other event still fails on stdout that is
  not JSON, and a PreCompact text of 10,000 characters or more fails naming its length.
- The `visible` check no longer asks a PreCompact hook for a `systemMessage` on a fault, as it
  never asked SessionEnd: Claude Code discards a PreCompact hook's `systemMessage`. The
  `errors.log` line is still required.

### 0.3.9

- `canary run --prunes-only`: the daily job. No live run, no `cc_canary_runs` row; every
  declared prune runs before and independently of any database write, one line per prune
  (`prune <plugin>: <its last stdout line>`), exit 0 when every prune ran, 1 naming a prune that
  failed or could not start. A full `canary run` against a store that cannot be written now
  runs the prunes before it exits 2. `canary install --prunes-only` writes the daily plist.
- `canary run --prunes-only` is dispatched before the store is opened: a store that cannot be
  opened records no prune row and the prunes run all the same (exit theirs, stderr names the
  rows not recorded). Each `canary` action takes only its own switches; `canary run --dry-run`
  is usage, exit 2, and runs nothing (every `canary` usage error is exit 2).
- `canary prune` follows the plugin-kit prune contract: `--dry-run`, the last line
  `pruned: <n> file(s), <bytes> bytes freed[ (dry run)]; kept <k>`, a file that cannot be
  removed named on stderr and counted as kept.
- The gate's `retention` row runs every declared prune command once with `--dry-run` (from the
  plugin directory, `CLAUDE_PLUGIN_ROOT` set, 60 s) and fails naming one that exits non-zero,
  cannot start, or ends with any line but the contract's. Each prune runs in a throwaway HOME,
  XDG config/state/data/cache roots and TMPDIR of its own, with only PATH kept from the gate's
  environment (no `LEDGER_DB`, no `*_STATE_DIR` or `*_DB` override), so a prune that ignores
  `--dry-run` removes nothing real.
- The pane draws in Claude Desktop. Desktop runs Code headless, so `session.start` arrives with
  `surface: null`; the mod gated its poll, its refresh and the pane on a non-null surface, so
  nothing ever drew there. The gate is gone: the poll and the refresh always start and the pane
  opens from the snapshot on every surface; where nothing is placed the end-of-turn fallback
  block covers it as before. The placement line still says `surface=none` on Desktop.
- The gate's `docs` row checks only that the root README names the plugin (`rootReadmeNames`),
  never its version; the root README changes only when a plugin is added, removed or changes
  purpose. Landed in #94 without a bump.

### 0.3.8

- The Stop hook's "the human has written since you asked" check counts only a prompt the person
  typed (`lib/transcript.mjs` `isHumanPrompt`); a task-notification, system-reminder or other
  injected `user` line that starts a new turn no longer triggers it.
- While brb holds the session, the Stop hook asks for no answer, and a question with no row is
  sent back with `ask` then `hold` instead of "ask in plain words".
- `hold <q-id>` never records an answer, even when `hold` is one of the question's options.

### 0.3.7

- The skill is renamed from `ledger` to `record` (`skills/record/`, `/ledger:record`), so
  `/ledger` reaches the pane mod's command instead of the skill. Its text adds that questions
  from other folders never go under the agent's own *Needs you*.
- The pane's end-of-turn fallback block no longer repeats Claude's whole reply above it (it was
  joined onto the engine's `{ text: <answer> }`); it is the ledger line alone.
- The pane logs one `ledger pane: surface=… placed=…` line per session (see
  [Ledger pane](#ledger-pane-desktop)).
- `doctor` re-reads the config file a `config …: … ignoring it` errors.log line names and drops the
  line when the notice no longer reproduces, reporting `n stale config notice(s) ignored`;
  SessionStart's doctor count drops it too.
- `lib/judge.mjs` is plugin-kit's shared judge dispatch, byte for byte; ledger's cache, passage
  and verdict logic lives in `lib/ledger-judge.mjs`. The judge command is `LEDGER_JUDGE_BIN`,
  else `review.judgeCommand`, else the shared judge file
  `${XDG_CONFIG_HOME:-~/.config}/judge/config.json` (new), else the i-have-audhd profile's
  `enforcement.judgeCommand`. Verdicts and the cache are unchanged; `judge could not start:`
  is now followed by the error code. Ledger's diff judge never runs shorter than 60 s; a longer
  shared `timeoutMs` is honoured. A `claude -p --output-format json` envelope is read through.

### 0.3.6

- The plugin gate runs six checks, not five: `docs` (a release is written down). When a
  plugin's `.claude-plugin/plugin.json` version differs from the base commit's, its
  `CHANGELOG.md` and `README.md` each have a release heading for the new version (any heading
  level; `## [<ver>]`, `## <ver>`, `## Changes in <ver>`, `### <date> — <ver>` and the like, in
  either file), and the repository root README names the version for the plugin (in a bullet
  starting with its name, on a `Changes in <plugin> <ver>` line, or on a `Changes in <ver>` line
  under `## <plugin>`). The row is `skipped` while the version is unchanged, fails when the
  head drops a version the base had, and each failure names the file and the heading it
  wanted. The base manifest and the root README are read out of the commits, like every other
  row's input, so a `--plugins` run now resolves the base too; a `--base` that names no commit
  exits 1 saying so. The push gate denies rows that lack a check (an older ledger's rows have
  no `docs`), naming the missing one. See [The plugin gate](#the-plugin-gate).
- `plugins/ledger/CHANGELOG.md` exists from this version on, in the Keep a Changelog shape the
  row accepts; the "Changes" section here keeps one entry per version as before.

### 0.3.5

- The plugin gate runs five checks, not three: `evals` (an `evals/manifest.json` declaring each
  hook's outcomes, one scenario per event × outcome, and a recent canary pass for the committed
  plugin tree) and `retention` (every path written outside the worktree declared in
  `.claude-plugin/plugin.json` `state`, with a prune command for anything kept a number of days)
  join the three from 0.3.3. See [The plugin gate](#the-plugin-gate).
- A canary row keeps `tree_sha`, the committed plugin tree it certifies, and `writes`, the files
  the live run left outside its work directory. After the live runs the canary runs every
  declared `prune` once and records it as a `cc_canary_prunes` row; `--no-prune` skips that pass.
  `canary status` prints the last run, the last pass and the last prune per plugin.
- Every plugin in this repository has an `e2e/live-run.sh` that hands off to plugin-kit's
  scenario runner `lib/live-run.mjs`; the ledger's own scenarios cover its five events.
- Schema 8: two columns on `cc_canary_runs` (`tree_sha`, `writes`) and the `cc_canary_prunes`
  table. A 0.3.3 or 0.3.4 ledger on a schema-8 file runs on the tables both know.

### Earlier versions

One line each, from the release commits; the full notes for 0.2.1 through 0.3.4 are in
[CHANGELOG.md](CHANGELOG.md).

- 0.3.4: patch release for the canary environment: the canary no longer hands `e2e/live-run.sh`
  the caller's `LEDGER_*` keys.
- 0.3.3: the plugin gate (three checks) and the feedback loop: `canary`, `report`, `digest`.
- 0.3.2: the side pane for Claude Code Desktop.
- 0.3.1: three fixes from the first live sessions on 0.3.0.
- 0.3.0: `doctor`, and a bounce ledger for every Stop block and PreToolUse deny.
- 0.2.3: `pending --all` and a SessionStart line for questions waiting in other folders.
- 0.2.2: an outcome lifts the push gate the same as a note.
- 0.2.1: hooks on by default with `/ledger:enable` and `/ledger:disable`; you never type a
  question id; a corrupt database at a configured path is reported, never moved aside.
- 0.2.0: opt-in per project, `cc_`-prefixed tables for a shared SQLite file.
- 0.1.0: first release.

## License

MIT.
