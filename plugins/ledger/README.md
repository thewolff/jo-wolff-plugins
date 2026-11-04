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
- `answer <q-id> <option>` as soon as you reply, with the option your words mean; when your reply
  is none of the options, `answer <q-id> "<your reply>"` records it as you gave it (or
  `withdraw <q-id>` if you set the question aside);
- `note "<text>"` for a choice it made without asking;
- before any `git push` or `gh pr create`, a `note` or an `outcome <ref> "<text>"` saying what is being pushed and why;
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
| `ask "<body>" --name <short> --options a,b[,c] [--default a] [--deadline 2h\|<ISO>] [--kind question\|approval\|plan] [--allows "a: …; b: …"] [--ceiling <usd>] [--about "<text>"]` | agent | opens a question bound to the process cwd; prints `q-…` and its `pending` line, for the agent (the human is asked in plain words). Default is the first option. `--kind plan` needs `--allows` for every option. Repeating an open question (same body in the same folder with the same set of options, in any order) returns its id and writes nothing, unless the open row belongs to another session or to an untagged CLI run: then the asking session adopts it (`session_id` and `asked_at` move to this session) and the Stop rules treat it as this session's question. The existing row's options, default and `--allows` stay as they are; the repeat's flags are not written over them. A different set of options is a different question. A held duplicate is never adopted; `reopen` it. |
| `answer <q-id> <reply>` or `<word> <q-id>` | agent, on the human's reply | records the answer. A reply that is one of the question's options is recorded as that option (`via` `cli`); `withdraw` withdraws. `answer <q-id> <reply>` with any other reply (several words allowed, trimmed, at most 200 characters) records it as given, a free-form answer: state `answered`, `via` `freeform`, shown in `log` as `answered (freeform): <reply>`. The short forms (`<word> <q-id>`, `<n> <word>`, a bare word) and lines typed into a prompt take options only: anything else is refused with the option list and nothing is written, so a typo never becomes an answer. Same reply twice → `already answered`, exit 0; a different one → refused naming the existing answer. |
| `approve <q-id>` / `deny <q-id>` | human | the answers `approve` / `deny` when the question offers them. |
| `<n> <word>` | human | the n-th line of `pending`, answered with that word. |
| `withdraw <q-id>` | either | state `withdrawn`, with an `nt-` note saying so (when the question offers `withdraw` as an option, it is recorded as that answer instead). |
| `extend <q-id>` | human | the answer `extend` when offered, else the deadline moves by its original span. |
| `hold <q-id>` | agent | an open question becomes `held`: formed and deliberately deferred for you, not put to you yet. Still unresolved (`resolved_at` stays empty); listed under *Waiting on you* at session start and as `held` in `pending`. Answering or withdrawing it still works. Asking the same question again returns its id and says to `reopen` it. |
| `reopen <q-id>` | agent | a held question becomes open again, with `asked_at` set to now, because the agent is putting it to you now. |
| `note "<text>"` | agent | a note row for the cwd; prints `nt-…`. |
| `outcome <ref> [q-id] "<text>"` | agent | what a decision or an answered question produced: `ref` (required, no spaces) is a PR URL, a commit or a path, and the optional `q-id` links the question. A note row of kind `outcome`; `log` shows `→ <ref>`. It lifts the push gate the same as a `note`; it does not count as the `note` a stated decision needs. |
| `pending` | either | the paste-ready block, one `<default> <q-id>  # <name> · <body> · default <d> · also: <others> / withdraw` line per open question in the cwd, a parent of it or a folder under it (a question from a folder under the cwd ends ` · in <folder>`), then `about …`, `ceiling $…`, `allows:` and `due …` lines when set, then one `held <q-id>  # <name> · <body>` line per held question in the same scope. |
| `pending --all` | either | every open and held question in the database, whatever its folder: one group per folder headed by the folder's path (groups in path order), each group's open questions as `pending` lines (not numbered: `<n> <word>` answers only the cwd's own list), oldest first, then its held ones marked `held`. For a database shared by several folders. |
| `log [N]` | either | the last N notes, questions and answers for the cwd (default 20), newest first, across sessions. |
| `enable` / `disable` | human | writes `"enabled": true` / `false` to `.ledger.json` in the cwd, keeping any other keys in it. An unparsable existing file is refused, not overwritten. `/ledger:enable` and `/ledger:disable` run these in the session's folder. |
| `config` | either | the effective settings, where each came from, both config file paths, and whether the database file is the plugin's own or shared. |
| `doctor` | either | is the ledger healthy: one `ok`, `warn` or `fail` line per check (see [Doctor and the bounce ledger](#doctor-and-the-bounce-ledger)). Exit 0 when nothing failed, 1 when anything did; warns do not change it. Never writes the database and never creates it. |
| `bounces [--since <N>d\|<N>h]` | either | the hooks' bounces since then (default `7d`): per rule, how many fired, were satisfied, were bypassed and are still open; then the last 20 rows (time, session short id, rule, tool, outcome). Covers every folder. |
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
| SessionStart | `hooks.sessionStart` | Injects, in order and only when non-empty: *Waiting on you* (held questions for the cwd, its parents and the folders under it, oldest first, name and one-line body, a subfolder's naming the folder; kept on `source: compact`), open questions for the same scope (the `pending` block), the last `inject.notes` entries of `log`, the exact invocation plus allow rule and a one-line verb summary, when `inject.elsewhere` is on a block for the open and held questions in other folders (a folder that is not the cwd, not a parent of it and not under it): one header line (`ledger: N question(s) waiting on you in M other folder(s) (asked elsewhere, not for this folder's work; for you, not the human: when the human's reply answers one, run \`… answer <q-id> <option>\` and tell them it is recorded; never show the id):`), then each folder's path followed by one `pending` line per question (default, id, name, body, the other options), a held one's line opening with `held` in place of the default word, at most 10 questions in full and a count of the rest with the `pending --all` command, the cross-lab review findings line (see [Cross-lab review](#cross-lab-review)), and, last, the doctor line (see [Doctor and the bounce ledger](#doctor-and-the-bounce-ledger)). Capped at 9,000 characters; the log entries are cut first, never the held or open questions or the other-folders block, review or doctor lines. On `source: compact` the log section is dropped and the verb summary is one line; the other-folders block, review and doctor lines stay. Records the session in `cc_sessions`. |
| PreToolUse | `hooks.preToolUse` | Runs on `AskUserQuestion` and `Bash` only. `AskUserQuestion` is denied while no question is open for the cwd (a question whose cwd equals the hook cwd or is an ancestor of it), with the reason `ledger: ask the question through the ledger first: \`… ask "<body>" --name <short> --options a,b --default a\`, then ask it; keep the q- id to yourself and record the reply with \`… answer <q-id> <option>\`.` A Bash command that runs `git push` or `gh pr create` (any simple command of a `&&`/`;`/`|`/newline chain, read with shell quoting; git's global options and a path on the binary are tolerated) is denied while the session has no `note` and no `outcome`, with the reason `ledger: record what this push is before pushing: \`… note "<what and why>"\` or \`… outcome <ref> "<what and why>"\` (one in this session lifts the gate).` The same command is checked by the review gate (below) at the same time: when both stop it, one deny lists both as numbered items, so the agent meets every missing step at once. Before denying it proves the store can take a write (the remedy writes); if it cannot, the tool passes with a `systemMessage`. Other tools and other commands are never seen. |
| Stop | `hooks.stop` | Checks the final message once per turn (keyed on `prompt_id`; a second Stop in the same turn passes). Answer rule (`forcing.stopAskRule`): the Stop's `prompt_id` differs from the one stamped by the session's previous Stop (so you wrote since), and the session has open questions asked at or before that previous Stop → `{"decision":"block","reason":…}` listing them newest first and telling the agent to take the answer from your latest message and run `answer <q-id> <option>` (or `withdraw`); it clears once every such question is answered or withdrawn. Ask rule (same switch): after removing code blocks, inline code and double-quoted spans, a sentence ends with `?` (a `?` at the end of a line or followed by a space, so "Should I …? I'd say yes." counts and a URL's `?query` does not) and that sentence asks for a decision: a permission or decision request on the agent (a modal on I/we: "should I", "shall we", "can I push?", "may I"; "want me to", "do you want", "would you like"), a confirmation ("is this right", "does that look right", "is it safe to", "ok to", "ready to"), an explicit choice ("would you prefer", "which option should we", an option list after a comma or colon, a sentence that is only options such as "Alpha or beta?", or a choice about the thing being configured: "Should the helper use local or remote storage?"), or a wh-question (what/where/when/who/which/how) carrying a modal on I/we, "whether", a preference or an option list ("How should we proceed?", "Which option should we use?"). A "why" question never counts, and neither do a bare "which", a loose "or", "do we know/have …", or "whether"/"proceed" inside a question about recorded facts: "Which file holds the config?", "Are the logs compressed or uncompressed?", "Does the log say whether the build failed?", "Did the deployment proceed without errors?" and "What are we working on?" are requests for information and need no row. It is a heuristic with a once-per-turn escape: an information request worded as a request ("Should the parser be deciding this?") bounces once and no question is open for the folder (this session's, or one open in the cwd or a parent of it, whoever asked it) → block telling the agent to `ask` first, then ask in plain words; messages under 40 substantive characters are not checked. Neither rule reads ids out of the reply. A session's questions are those tagged with its id, plus untagged ones asked in or around its folder after it started. Decision rule (`forcing.stopDecisionRule`): after also removing double-quoted spans, the message contains one of `forcing.decisionPhrases` as whole words, the session recorded no `note` during this turn, and it asked no question during this turn (the stated default of a question just asked is not a decision) → block telling the agent to `note`, then finish. Checked in the order answer, ask, decision. Every Stop stamps `cc_sessions.last_stop_at` and `last_stop_prompt`; "this turn" runs from the previous stamp (or the session start) to now. |
| SessionEnd | `hooks.sessionEnd` | In one transaction: stamps `ended_at` and the reason on the session row, and marks the session's open bounce rows `bypassed`. Waits at most 250 ms for a lock (SessionEnd hooks share a 1.5-second budget). Prints nothing; errors go to the log. |
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
| `forcing.decisionPhrases` | the eight phrases below | the phrases the decision rule looks for, whole words, any case |
| `inject.notes` | `5` | how many recent `log` entries SessionStart injects |
| `inject.elsewhere` | `true` | whether SessionStart adds the block listing open and held questions in other folders; `false` turns it off |
| `inject.answers` | `true` | whether each prompt tells the session about answers to its questions recorded in other sessions since its last prompt; `false` turns it off |
| `inject.doctor` | `true` | whether SessionStart adds, last, `ledger: doctor reports N issue(s); run … doctor` when the cheap doctor checks find something; `false` turns it off |
| `review.mode` | `"gate"` | the cross-lab review gate on `git push`, `gh pr create` and `gh pr merge`: `gate` denies a push whose HEAD has no review or has findings, `advise` allows it with a notice, `off` turns the review off. Read from the user file only; a project file's `review` is ignored with a notice |
| `review.labs` | `["codex"]` | the labs `ledger review` runs, in parallel: any of `codex`, `kimi`, `claude`, `glm`. User file only |
| `review.models` | `null` | a model per lab, e.g. `{"claude": "opus", "glm": "zai/glm-5.3-flash"}`; unset means the lab's CLI default (`glm`: `zai/glm-5.3`). User file only |
| `review.profiles` | `null` | an `omp` profile per omp-backed lab, e.g. `{"glm": "work"}`; unset means no `--profile` (omp's base profile). Each value is a non-empty string; an empty one makes the loader reject the whole `review.profiles` value and say so. User file only |
| `review.maxRounds` | `3` | how many review rounds (reviewed commits on the branch since the merge-base) `ledger review` runs before it stops and says to ask the human: waive, or continue with `--force-round`. User file only |
| `review.judgeCommand` | `null` | the judge that checks "this finding is resolved" claims: a shell command that gets the prompt on stdin (or in place of a literal `{prompt}`) and prints `yes` or `no`. Unset falls back to `enforcement.judgeCommand` in the i-have-audhd profile (`~/.claude/i-have-audhd.json`), so one judge is configured once. User file only |

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
| bounce row cannot be written | n/a | n/a | the deny or allow stands; one `errors.log` line | the block or pass stands; one `errors.log` line | the end stamp and the bypass update share one transaction, so neither lands; one `errors.log` line | n/a |
| review lab unavailable (no binary, non-zero exit, timeout, empty reply) | `ledger review` records the lab `unavailable` with the error, exit 0 | n/a | the lab is left out of the verdict and named in a `systemMessage`; every lab unavailable allows the push with a `systemMessage` | n/a | n/a | n/a |
| review gate cannot decide (git fails, a query throws) | n/a | the findings line is left out | allows the push with a `systemMessage`; one `errors.log` line | n/a | n/a | n/a |

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
| `review <lab>` | one per lab in `review.labs` (none when `review.mode` is `off`): the lab's binary is on `PATH` | the binary is missing | |

Doctor opens the database read-only and never creates or migrates it. The SessionStart doctor
line does not run all of this on every start: it runs only the cheap checks (the database
opened, which the hook needs anyway; the schema version; the `errors.log` count for the last 7
days) and adds one line, after everything else and never truncated, on `compact` too, when any
of them finds an issue. A database that does not exist yet is not an issue.

`errors.log` is one file per state folder, shared by every database a machine uses. Each line
ends with ` [db <path>]`, the database the writing process had configured, and `doctor` and the
SessionStart line count only the lines for the database they check. Lines for another database,
and untagged lines from ledger 0.2.x, are named in the `errors` check's ok text as "not counted".

The bounce ledger is `cc_bounces`: one row per Stop block and PreToolUse deny, with the rule,
session, `prompt_id`, tool and time. A row starts open and is closed once:

| Rule | Marked `satisfied` when |
| :- | :- |
| `stopAnswerRule` | a later Stop of the same session and `prompt_id` finds an answer or withdraw for one of the session's questions recorded after the bounce |
| `stopAskRule` | a later Stop of the same session and `prompt_id` finds a question the session asked after the bounce |
| `stopDecisionRule` | a later Stop of the same session and `prompt_id` finds a `note` the session recorded after the bounce |
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
backticks (unquoted, in double quotes, or in an unquoted heredoc) is. When the command does not
say which commit, the call is allowed with a notice saying so: `--all`, `--mirror`, `--tags`,
`--branches`, a `:` or pattern refspec, a configured `remote.<name>.push`, `push.default
matching`, a `-c` or `--config-env` that sets push, remote or branch config, a `GIT_CONFIG*`,
`GIT_DIR` or `GIT_WORK_TREE` assignment or export, `--git-dir`, a `cd` or `-C` whose folder is
computed (`$`, `~`, a glob, `cd -`), `--head <owner>:<branch>`, a remote that cannot be read in
time or has no such branch, gh failing.

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
are cached in `cc_meta` under `judge:<sha256>`, so asking the same thing again costs nothing. The
judge command is `review.judgeCommand`, else the i-have-audhd plugin's
`enforcement.judgeCommand`: one judge, configured once.

| Verb | Effect |
| :- | :- |
| `review status` | the gate's state for HEAD; the branch's rounds (round, sha, lab, counts by severity, verdict); then every row for HEAD |
| `review addressed "<why>"` | the manual override of a finding: records that HEAD resolves the outstanding findings of earlier commits, each checked by the judge. Refused without a reason, when HEAD has findings of its own (fix, commit and review again, or waive), when there are no outstanding findings, or when the judge says `no` (which records a `findings` row for HEAD naming them) |
| `review waive "<why>"` | lets HEAD through; the reason is required and recorded. This is the way out when the human is prototyping or needs the push anyway |

SessionStart adds `ledger: cross-lab review found N finding(s) on <sha>; run … review status`
when HEAD has open blocking or should findings (not when `review.mode` is `off`).

## Inspecting the database

```
sqlite3 ~/.local/share/ledger/ledger.db
.tables
SELECT id, name, state, cwd FROM cc_questions WHERE state = 'open';
SELECT q.id, q.name, q.state, a.word FROM cc_questions q LEFT JOIN cc_answers a ON a.question_id = q.id;
SELECT id, kind, body, made_by, made_at FROM cc_notes ORDER BY made_at DESC LIMIT 20;
```

Tables: `cc_meta`, `cc_questions`, `cc_answers`, `cc_notes`, `cc_sessions`, `cc_bounces`,
`cc_reviews`. Timestamps are ISO
8601 UTC. `cc_questions.state` is `open`, `held`, `answered` or `withdrawn`; `cc_answers.via` is
`cli`, `prompt-hook` or `freeform`; `cc_notes.kind` is `note`, `withdraw`, `extend` or `outcome`,
and `cc_notes.ref` carries an outcome's PR, commit or path. Schema version 3 rebuilt
`cc_questions` and `cc_notes`, and version 4 rebuilt `cc_answers`, in place to widen those CHECK
constraints (SQLite cannot alter one); no other table is touched. Version 5 adds two columns and
rebuilds nothing: `cc_answers.session_id` (the session that recorded the answer) and
`cc_sessions.last_prompt_seen_at` (the prompt hook's answers mark). Version 6 creates two tables
and touches no existing one: `cc_bounces` (the bounce ledger; `outcome` is `satisfied`,
`bypassed` or empty while open) and `cc_reviews` (one row per cross-lab review result).

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

- **Waiting in other folders**: every open and held question asked in a folder that is not this
  one, grouped by folder, with its body, its options (the default marked), its state and its age.
- **Answered since your last turn**: the answers and withdrawals recorded on this session's
  questions since its last prompt, the same lines the UserPromptSubmit hook will give Claude on
  your next prompt, so you see them before Claude does.

Answering costs no turn. A digit (1 to 9) selects a question; its option buttons record that
option, and the Reply field records an option word or free text (Enter records). From the prompt,
`/ledger answer <q-id> <reply>` does the same; the short form `/ledger <word> <q-id>` records
that one word. Either way the answer goes through the ledger CLI as this session
(`scripts/ledger.mjs --json answer <q-id> <reply>` with `LEDGER_SESSION_ID`), so the asking
window's next prompt gets its `answered since your last turn` line, and the Stop hook there
stops chasing the question. The pane redraws when the CLI returns. `/ledger` opens the pane,
`/ledger close` closes it, Esc returns the keyboard to the prompt, Ctrl+X X closes.

The data refreshes at session start, at the start and end of each of your turns, and once a
second while the pane is on screen; each refresh is one `node mods/pane/query.mjs` run, which
reads with the same `elsewhereQuestions` and `answersSince` the settings hooks use. When a
session starts with something waiting, the pane opens by itself; on a screen too narrow to
place it, a toast names `/ledger` instead.

Where nothing can draw (`claude -p`, a pane that is not placed), the end of each turn adds one
transcript block instead: one line per answer since your last turn, one line per question waiting
elsewhere with its options, and the `/ledger answer` command that records. The pane never
writes a row itself and never writes outside the ledger's own tables.

The fallback and the pane fail the same way as the hooks: a query that cannot open the database
shows `ledger: database …` in the pane and one dim transcript line, a CLI refusal comes back as
text (`ledger refused: …`), and no error ever reaches Claude Code.

### Two-window test

1. Open two Desktop windows on two different folders, both with the plugin enabled.
2. In window A ask something through the ledger (`… ask "Which colour?" --name colour --options green,red --default green`, or let the agent ask).
3. In window B type `/ledger`. The pane lists `colour` under window A's folder with both options.
4. Press `1`, then the `red` button, or type `/ledger answer <q-id> red`. The pane shows `recorded: … red → <q-id> (colour)` with no turn spent in either window.
5. In window A send any prompt. Claude's context carries `ledger: answered since your last turn: colour → red (via cli)` and window A's pane shows the same line under *Answered since your last turn* before the prompt is sent.

Tests: `node --test` covers the pane's data layer (`test/pane-data.test.mjs`, `test/pane-query.test.mjs`);
`claude plugin test` from `plugins/ledger` runs the mod through Claude Code's test kit
(`mods/pane/tests/pane.test.tsx`: the command, the drawing, the fallback, the poll, and the
fault inputs).

## Known gaps

- The Stop rules look only at the final message; a question asked and withdrawn mid-turn is not seen, and a decision stated in an earlier message of the same turn is not either.
- The decision rule is a phrase list. A decision worded outside the list passes; a phrase used in a different sense ("I chose not to look") blocks once. A reply that asks a question recorded this turn is not checked: its stated default ("if you don't answer, I'll go with alpha") is already the question's `--default`. `instead of` left the default list in 0.3.0, because it fired on descriptions of bugs ("`add` subtracts instead of adding"). Tune `forcing.decisionPhrases` per project.
- The push gate reads the Bash command text with shell quoting. A push run from a script file or an alias is not seen.
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
