---
name: pattern-check
description: Before big work in a repository (a new feature, module, tool, or any change that will touch several files), find the existing pattern in the repo that already does the job of each new piece you plan to add, decide reuse, replace, or new-with-reason for each, and record the table with the pattern-check script. Use when starting a project or plan, when a pattern-check hook denies a write or refuses a reply, when ask-graham asks for it before a verdict, or on /pattern-check. The hooks hold Edit, Write, commits and PRs after the configured number of distinct files until the receipt exists.
argument-hint: "[what you are about to build] | record | status"
license: MIT
---

# Pattern check

Before an agent does big work in a repository, it looks for the repository's existing way of doing each thing it is about to add, and writes down what it found. Reviewers keep finding designs that introduced a second helper, store, loader, parser or hook where one already served; this check makes the agent earn the claim "nothing like it exists" piece by piece, before the writes start.

The check cannot be skipped: two hooks hold the work until a receipt exists for the session.

- **PreToolUse**: from the Nth distinct file an Edit, Write or MultiEdit call would touch (N is 3 by default), the call is denied, and so are `git commit`, `gh pr create` and the obvious shell writes (`>`, `>>`, `sed -i`, `tee`) into the repository. Under N files nothing fires.
- **Stop**: a reply that proposes a plan or design is refused once, with the command to run.

Both deny texts name the exact command. Both hooks fail open on the plugin's own faults (a corrupt state file, a bad config) with a one-line warning, never on the agent's omission.

## When to run it

Run it at the start of any work that will add pieces to a repository: a feature, a module, a tool, a plan, a design. Run it when a hook names it. Run it when ask-graham reaches its verdict on an ask bigger than two minutes. A two-file fix that adds nothing new does not need it; if the hooks hold you anyway, record `No new pieces: <reason>`.

## Steps

### 1. Open the receipt

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/pattern-check.mjs" open "<what you are about to build>"
```

One sentence: what gets built, where it lives. The script prints the session it opened and the exact `record` command to run at the end. Keep that line. If a hook already denied you, it printed the same command with `--session <key>`; use that one.

### 2. List the new pieces

Write down every piece the work adds, one per line: a helper, a store, a config loader, a parser, a hook, a CLI command, a test harness, a route, a table, a column, a job, a type, a script. Anything that will have a name in the repository when you are done. The design is the input here; if you have not designed yet, list what you expect to add and come back to the table when the design changes.

Done when: every noun in your plan that will become a file, a function, a table, or a command has a line.

### 3. For each piece, look for the existing pattern

Three searches per piece, in the repository you are about to change. Do all three; a name grep alone misses the sibling that shares no keyword.

1. **Grep the nouns and verbs.** The piece's name, its synonyms, what it does (`retry`, `backoff`, `attempt`; `parse`, `decode`, `read`). Search file names and contents. Read every hit you would cite.
2. **List what is registered beside it.** Name the parent the new piece attaches to (a router, a registry, a plugin list, a commands directory, a migrations folder, a hooks file, an exports index), then list its siblings and read the ones that do a similar job. A chart pick beside `featured_quote_id`; a new hook beside the three hooks already in `hooks.json`; a new command beside the directory of commands.
3. **Read the conventions files, if present.** `CONTEXT.md`, `ENGINEERING_STANDARDS.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, a `docs/` or `.ai/` directory: these say how the repository already does things. One search for the piece's noun in each that exists.

Delegate when it is big: more than three pieces, or more than one repository, is a subagent's job while you keep going.

Done when: each piece has either a `file:line` for the existing pattern that does its job, or a note of what was searched and found nothing.

### 4. Decide, per piece

- **reuse**: the existing pattern does the job; the design calls it instead of adding a piece.
- **replace**: the existing pattern does the job badly or partially; the new piece replaces it, and the old one goes (name the callers that move).
- **new**: nothing in the repository does this job. The reason says what was searched and why the nearest thing does not fit. "Nothing found" is not a reason; "grep for `webhook`, `inbound`, `signature` in `src/` found only the outbound client at `src/net/client.ts:40`, which signs requests and parses nothing" is.

A second way to do something the repository already does is the finding this check exists for. When the table has a `new` row whose nearest pattern is close, the design uses the pattern or the reason says in one line why it cannot.

### 5. Record the table

Write the table, four columns, one row per piece, then pipe it to `record`:

```sh
cat <<'EOF' | node "${CLAUDE_PLUGIN_ROOT}/scripts/pattern-check.mjs" record
| new piece | existing pattern (file:line) | reuse / replace / new | reason |
|---|---|---|---|
| retry helper | src/net/retry.ts:12 | reuse | same backoff, already exported |
| webhook parser | (none: grep webhook, inbound, signature in src/; read src/net/) | new | only an outbound client exists, it parses nothing |
EOF
```

Rows can also go on the command line, one `--row "piece | pattern | decision | reason"` each. When the work adds no new piece at all:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/pattern-check.mjs" record --no-new-pieces "<why: what the change is>"
```

`record` refuses an empty table, a decision that is not `reuse`, `replace` or `new`, a `new` row without a reason, and a `reuse` or `replace` row without a `file:line`. Nothing is written on refusal; fix the row and run it again.

The receipt lands at `<repo>/.pattern-check/<session>.md` with a copy in the plugin's state directory. The repository copy is untracked: the script suggests adding `.pattern-check/` to `.gitignore` or `.git/info/exclude` and never edits either itself. From then on, writes, commits and PRs in this session go through.

Done when: `record` printed `receipt recorded`.

### 6. Report it

In the reply that carries the plan or design, include the table (or the `No new pieces` line) under a `**Pattern check:**` heading, so the reader sees what was searched without opening the receipt. Each `reuse` and `replace` names its `file:line`; each `new` names what was searched.

## Status

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/pattern-check.mjs" status
```

Prints the session key, the files counted so far against the threshold, the receipt path if any, and which config files are in effect.

## How the script finds your session

Hooks receive the session id; the Bash tool that runs this script does not. The PreToolUse hook records the session it saw for the repository on every call, and it fires on the Bash call that runs this script, so `record` without `--session` finds the right session. When two sessions share one repository, or when a hook's deny text gave you `--session <key>`, pass that flag.

## Configuration

Zero configuration works: threshold 3, both hooks on, receipts in `.pattern-check/`. To change it, see the plugin README: `${XDG_CONFIG_HOME:-$HOME/.config}/pattern-check/config.json` for the user, `.pattern-check.json` at a repository root to override it there.

## What this check does not do

It does not judge "same job" for you; that is the reading in step 3. It does not catch every shell write: a `python -c` or `cp` that writes a file is neither counted nor denied, and the `git commit` and `gh pr create` denials are the backstop for those. It does not see a plan written without a plan-shaped heading, label, or opener; the PreToolUse counter catches that work when the writes start.
