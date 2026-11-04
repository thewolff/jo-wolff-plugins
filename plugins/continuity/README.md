# Continuity

Keep a long session's state across compaction. Four hooks and one skill:

- **`hooks/pre-compact.mjs`** (PreCompact) saves the session's deterministic state (branch,
  uncommitted paths, files touched, recent asks, the repository's open handoffs) to a snapshot
  under the plugin's state directory, and leaves a heartbeat record saying whether that worked.
- **`hooks/session-start.mjs`** (SessionStart) injects that snapshot back after a compaction and
  removes it, re-inlines the rules files (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`) on the walk
  from the cwd to the repository root that the host does not re-read on its own, lists the newest
  entries of the repository's durable-notes directory, and on every start says when the save last
  succeeded on this machine, or that it never has. A save that silently stopped working is the
  failure this line exists to end.
- **`hooks/user-prompt-submit.mjs`** (UserPromptSubmit) says the liveness line once when
  SessionStart did not, and asks once for a handoff when the session's context is near full. On
  Claude Code that is the token usage the last reply recorded in the transcript; see below.
- **`hooks/stop.mjs`** (Stop) blocks one stop per session at the same threshold, unless this
  session already wrote a handoff, so the model has a turn to write one while it still holds the
  context the handoff needs.
- **`skills/handoff/SKILL.md`** (`/continuity:handoff`) writes the judgment layer no hook can
  derive, what was in progress, the next move, what was ruled out, what is still uncertain, to
  `<repo>/.ai/handoffs/`, and says how to resume from one: restate its content before continuing.

Ported from the newdle plugin 0.2.175 (its `compact-continuity`, `compaction-liveness` and
`context-pressure` hooks and its `handoff` skill); the table of what was stripped is at the end.
Built on plugin-kit 0.3.1; Node 22.13 or later; Claude Code hooks.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install continuity@jo-wolff-plugins
```

Nothing to set up. The first session on a machine hears the liveness line say no save has ever
been recorded, which is true until the first compaction.

## What it does

### The pre-compaction save (`hooks/pre-compact.mjs`)

On PreCompact, `lib/snapshot.mjs` writes
`${XDG_STATE_HOME:-~/.local/state}/continuity/<session_id>.json` holding, each section naming
its source: the branch (`git branch --show-current`), the uncommitted paths (`git status
--short`, the first 40), the files written or edited this session (read from the transcript's
`Edit`/`Write`/`NotebookEdit`/`MultiEdit` tool calls, the first 40), the last 5 user asks (from
the transcript; a host with no transcript may send `intents`, `file_operations` and
`agent_judgment` on the payload instead, and the file says which it used), and the open handoffs
under the repository's `.ai/handoffs/` (`lib/handoffs.mjs`: `status: open`, modified within 7
days, the newest 3 in full and one line each for the rest). Every list is capped where it is
captured and every cut is written into the file; a shortened `git status` that read as a clean
tree was the bug the caps answer. A payload with no transcript and none of the host fields gets
a reconstruction section instead (recent commits, unpushed commits) that says it is one.

Each invocation also appends two heartbeat records (`started`, then `ok` or `failed:<code>`) to
`heartbeat.ndjson`. When the payload carries a real `token_count` (a host adapter that passes
one; Claude Code's PreCompact payload does not), it also appends one `{bytes, tokens}` line to
`calibration.ndjson`, which sharpens the pressure check's byte estimate below. Each write to
these files, and to `errors.log`, is a plain append; once a file passes 400 lines it is trimmed
to its newest 200 by a rename-swap (the kept lines go to a temp file that is renamed over the
old), so a reader never sees a half-written file. The limit: the swap does not serialise writers,
so a line another session appends between the trim's read and its rename is lost. That window
opens once in every 200 writes, and needs two sessions writing the same log in the same few
milliseconds.

Every git call the save makes (branch, status, the two handoff-root lookups, and the commit
lists of a reconstruction) runs at once inside one 2-second budget; the root lookups are also
capped at 500 ms each. A call still running when the budget ends is killed and its field is
saved as `(unknown: timed out)`, and the snapshot is written anyway. A `git status` that failed
or timed out renders as `(unknown: …)`, never as `(clean)`.

Auto-compaction with no handoff written and no host-supplied judgment puts one `systemMessage`
in front of the person: the judgment layer was not captured. PreCompact cannot inject context
and no hook gives the model a turn before auto-compaction, so the person is the only one who can
act on it. A manual `/compact` says nothing.

### The restore and the liveness line (`hooks/session-start.mjs`)

On SessionStart with `source: "compact"`, `lib/snapshot.mjs` reads this session's snapshot (by
`session_id`; another session's is never injected), renders it as markdown under
`## Restored session state (post-compaction)` with a line asking the model to restate what the
thread is and what is pending on it before continuing, and unlinks it. A snapshot over 20,000
characters is cut at that length, says so with the file's path, and is kept; one older than a
day is ignored and left for prune. A restore that refills the window the compaction just cleared
is worse than none.

After the same compaction, with or without a snapshot to restore, two more sections follow
(`lib/repo-rules.mjs`); neither appears on a fresh start, a resume or a clear:

**`## Repo rules re-inlined`.** The rules files that scope the payload's cwd, which the host
loaded into the conversation as the session read into their directories and the compaction took
with it. The walk collects, per directory from the cwd up to the walk root, `CLAUDE.md` (with
`CLAUDE.local.md` after it) else `AGENTS.md`, and inlines them root first, nearest last, so the
nearest file's rules are read last and win. The root is the git root (the nearest directory at or
above the cwd holding a `.git` entry; a worktree's `.git` file counts), or the nearest directory
above the git root holding a rules file (a workspace that keeps one rules file over several
checkouts; searched up to, not including, the home directory and `/`), or, with no git root, the
cwd alone. The cwd is resolved through its symlinks first; a rules file that is a symlink to a
path outside that root is skipped and named; a file reached twice is inlined once. A level that
is `CLAUDE_PROJECT_DIR` or above it (Claude Code sets it to the launch directory) is skipped and
named as the host's: the host loaded it at launch and keeps it. Caps, in bytes: 8,000 per file
and 9,000 for the whole rendered section, headings, paths, markers and skip lines included (the
source hook's per-file cap, and the budget its live rules-injection sibling used for one chain),
and never more than what the snapshot (or the not-restored notice) and the notes list leave of
the 20,000-character restore guard, so the rules are what gives way when a snapshot is large.
Within the cap the smallest files land whole and the largest are cut on a UTF-8 character
boundary to one shared allowance, each cut ending in `(truncated at N bytes; the file is M bytes,
read it for the rest)` with N the bytes shown; a file whose share would be under 200 bytes is
skipped instead, and every skipped file is one `- skipped <path>: <why>` line, as many as fit and
then one line counting the rest. A walk that found nothing says so. A section with no room for
even its heading is left out, and the systemMessage names it. `@path` imports are not expanded; the token stays as written.
`"rules": "off"` in the config file drops the section.

**`## Durable notes`.** The newest `notesCount` (default 5) regular files of `notesDir` (default
`.ai/decision-log`, relative to the git root of the cwd resolved through its symlinks, as the
rules walk resolves it, or that cwd when there is no git root; an absolute path is taken as is) by
modification time, one filename per line, dot-files and directories left out, with the line that
the notes directory and the rules files are the source of truth and the restored snapshot is only
the safety net. An absent directory is one line saying so; `"notesCount": 0` drops the section.
The whole section counts against the 20,000-character restore guard and is fitted before the
rules: short of room it lists fewer names, then none, then is left out and named in the
systemMessage.

On every SessionStart, `lib/liveness.mjs` reads the heartbeat and adds one of four texts. The
newest save's result decides which, not the newest success:

- `continuity, pre-compaction save liveness: last successful save N minutes ago (<ISO>); the
  snapshot path is alive.`: the newest save succeeded. One line.
- `**the last save failed** N minutes ago (<outcome>, <ISO>); the last success was M hours ago
  (<ISO>).`: the save worked once and has broken since.
- `**no pre-compaction save has ever been recorded on this machine.**` with the heartbeat path:
  the file is absent or empty, which is what a hook that never runs looks like from outside.
- `**no pre-compaction save has ever succeeded on this machine.**` with the number of times the
  hook was invoked (invocations, not heartbeat records) and the last outcome (`failed:EACCES`,
  say): the hook runs and cannot write.

After a compaction with no snapshot to restore, the start also says **this compaction's state
was not restored** and what the heartbeat recorded for this session's save (`failed:EACCES`, a
save that started and never finished, or none at all), so the model does not assume a restore it
never got.

The line is marked said in `sessions/<session_id>.json`, so the prompt hook does not repeat it.

### The context-pressure check (`hooks/user-prompt-submit.mjs`, `hooks/stop.mjs`)

**On Claude Code this is the token usage the last reply recorded.** Claude Code writes each
assistant reply into the transcript with a `message.usage` object; `lib/pressure.mjs` (through
`lib/calibration.mjs`) takes the newest main-thread reply after the last compaction marker (a line
with `"subtype":"compact_boundary"`) and sums `input_tokens + cache_read_input_tokens +
cache_creation_input_tokens`, which is what the model was sent on that turn. A reply without the
cache fields counts `input_tokens` alone; subagent (sidechain) replies and zero-usage replies are
passed over. The answer is compared against `contextTokens` (default 200,000).

When no reply since the marker recorded usage (a fresh window, or a host whose transcript has
none), the check falls back to the transcript's bytes since the marker, or the whole file when it
has none, divided by `BYTES_PER_TOKEN_ESTIMATE` (8), and the warning says `(estimate)`. On the
machine this was written on, Claude Code transcripts ran about 8 to 9.5 bytes per context token
with a wide spread, so treat that fallback as rough in either direction. No transcript there had
a compaction marker, so the fallback can also count bytes from before an earlier compaction.

An OMP or other host adapter that passes a real `token_count` at PreCompact, and whose
transcript records no usage, gets a calibrated byte estimate instead: each such compaction
records `{bytes, tokens}` in `calibration.ndjson`, and once any record exists the median
tokens-per-byte ratio replaces the constant. The warning says which basis it used.

At or past `threshold` × `contextTokens` (default 0.65 × 200,000), the prompt hook adds, once per
session:

> continuity: this session's context is N% full (from the token usage the last reply recorded).
> Before it ends, run `/continuity:handoff` to write the judgment layer to
> `.ai/handoffs/` in the repository … If there is genuinely nothing in flight worth passing on …
> say so in one line and stop.

and the Stop hook returns `{ decision: "block", reason: <the same text> }` once per session, so
the model gets one more turn to write the handoff. It does not block when an open handoff whose
`session_id` is this session's is already in `.ai/handoffs/`: the turn it would ask for has
happened. A stop with `stop_hook_active: true` is never blocked; the once-mark is written before
the block is given, and a mark that cannot be written means no block, so the person can always
end the session.

### The handoff skill (`skills/handoff/SKILL.md`)

`/continuity:handoff [lane]`. The skill resolves the handoff root (`$CLAUDE_PROJECT_DIR`, else
the main worktree root from `git rev-parse --path-format=absolute --git-common-dir`, else
`--show-toplevel`, else the cwd; `lib/handoffs.mjs` resolves it the same way, so every worktree
of a repository shares one pool), finds or creates
`<root>/.ai/handoffs/<YYYY-MM-DD>--<HHMM>--<author>--<lane>.md` with frontmatter (`session_id`,
`lane`, `author`, `branch`, `created`, `status: open`) and five sections (Where I left off, Next
move, Already ruled out, Live uncertainty, Working state), adds `handoffs/` to
`<root>/.ai/.gitignore`, and makes no git writes. It writes nothing when no trigger fired, and
says so in one line. On resuming, the skill's rule is to restate the handoff's content, not its
name, before continuing: resuming a session is structurally a standup.

## Config

`${XDG_CONFIG_HOME:-~/.config}/continuity/config.json`, read by every hook (`lib/config.mjs`):

```json
{ "threshold": 0.65, "contextTokens": 200000, "pressure": "on", "liveness": "on", "snapshot": "on",
  "rules": "on", "notesDir": ".ai/decision-log", "notesCount": 5 }
```

| Key | Default | Meaning |
|---|---|---|
| `threshold` | `0.65` (the newdle hook's) | the fraction of `contextTokens` at which the pressure check speaks; a JSON number strictly between 0 and 1 (a string or an array is a problem, not a number) |
| `contextTokens` | `200000` | the context size the estimate is compared against; a positive whole number |
| `pressure` | `"on"` | `"off"` silences the prompt warning and the Stop block |
| `liveness` | `"on"` | `"off"` silences the liveness line |
| `snapshot` | `"on"` | `"off"` skips the PreCompact save (the heartbeat records `skipped:off`) and the restore; the two sections below still follow a compaction |
| `rules` | `"on"` | `"off"` drops the post-compaction `## Repo rules re-inlined` section |
| `notesDir` | `".ai/decision-log"` | the durable-notes directory the post-compaction `## Durable notes` section lists; relative to the git root (the cwd when there is none) unless absolute; a non-empty string |
| `notesCount` | `5` | how many of its newest entries to list; a whole number from 0 (the section is dropped) to 100 |

A missing file is the defaults. A file that does not parse, or a value of the wrong shape, is
the defaults for that value, and the hooks name the file and the problem once per session (one
once-mark shared by every hook).

## State

Declared in `.claude-plugin/plugin.json`:

| Path | Kept | Pruned |
|---|---|---|
| `${XDG_STATE_HOME:-~/.local/state}/continuity/<session_id>.json` | the snapshot; consumed by the restore | `scripts/prune.mjs --days 30` |
| `…/continuity/sessions/<session_id>.json` | the once-marks (`livenessSaid`, `promptWarned`, `stopBlocked`, `configNoted`) | same |
| `…/continuity/heartbeat.ndjson`, `calibration.ndjson` | the save's liveness log; the tokens-per-byte observations (only from a host that passes `token_count`) | kept; trimmed to the newest 200 lines once past 400 |
| `…/continuity/errors.log` | the hook runner's fault log | kept; the hooks' own lines trim it to the newest 200 once past 400 |
| `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json` | yours | never |
| `<repo>/.ai/handoffs/*.md` | written by the skill, in the repository, gitignored | not by this plugin; the reader ignores files older than 7 days |

`node scripts/prune.mjs [--days N] [--dry-run]` removes snapshots and once-marks older than N
days and the directories left empty; its last line is `pruned: <n> file(s), <bytes> bytes freed`.

## How it fails

Every hook runs under `lib/hook-runner.mjs` (vendored from plugin-kit) and exits 0 whatever
happens; a fault is one line in `${XDG_STATE_HOME:-~/.local/state}/continuity/errors.log` and a
`systemMessage` reading `continuity <event> failed open: <why>`. The full table is
[HOW-IT-FAILS.md](HOW-IT-FAILS.md); the short form:

| Piece | Fails how | Then |
|---|---|---|
| any hook | stdin not JSON, a throw, no answer in 4 s | runner logs one line, allows; never a block |
| `hooks/pre-compact.mjs` | the snapshot cannot be written | heartbeat `failed:<code>`, a `systemMessage` naming the path; compaction proceeds |
| `hooks/pre-compact.mjs` | git slow or absent, transcript unreadable | every git call shares one 2 s budget; a field git did not answer is `(unknown: timed out)` or `(unknown: … failed)`, and the snapshot is still written |
| `hooks/session-start.mjs` | no snapshot, a stale one, one that does not parse | nothing restored; the liveness line alone, and after a compaction the rules and notes sections |
| `hooks/session-start.mjs` (the rules walk) | the cwd missing or not a directory; a rules file unreadable, empty, a symlink out of the tree, or reached twice; the rules larger than the cap or the snapshot leaving no room | the section still appears: one line saying nothing was walked, or one `- skipped <path>: <why>` line per file; a cut file ends `(truncated at N bytes …)`; never a silently shortened rule |
| `hooks/session-start.mjs` (the notes probe) | `notesDir` absent, not a directory, or unreadable | one line saying so under `## Durable notes` |
| `hooks/session-start.mjs` | heartbeat absent or never `ok` | the liveness line says so, in bold; never reads as healthy |
| `hooks/user-prompt-submit.mjs`, `hooks/stop.mjs` | no `transcript_path`, unmeasurable transcript, no recorded usage | silent when there is nothing to measure; with no recorded usage, the bytes / 8 fallback, and the warning says `(estimate)` |
| `hooks/stop.mjs` | the once-mark cannot be written | no block |
| `lib/config.mjs` | config missing, malformed, wrong-typed | defaults; the problem named once per session |
| `skills/handoff` | `.ai/handoffs/` unwritable, no git, no command | the five sections go in the reply; the skill's "When this can't run" section |

`test/hook-contract.test.mjs` proves the five fault inputs for every hook; `test/hooks.test.mjs`
runs each hook as a child process on its parse / allow / warn / unparseable inputs and walks one
session end to end; `test/lib.test.mjs` covers every lib module including its error paths;
`test/port.test.mjs` pins the stripped strings below. `evals/manifest.json` declares each event's
outcomes and the fourteen `evals/*.scenario.json` prove them: `evals/pre-compact-auto-no-handoff.scenario.json`
is the save with its `systemMessage`, `evals/session-start-restore.scenario.json` the restore,
`evals/session-start-restore-rules.scenario.json` the re-inlined rules,
`evals/session-start-restore-notes.scenario.json` the durable-notes list,
`evals/stop-blocks-near-full.scenario.json` the block and `evals/stop-once-per-session.scenario.json`
its once-rule (`bash e2e/live-run.sh --no-live` replays them offline). Run `node --test` from inside `plugins/continuity/`.

### When this can't run

- On a host other than Claude Code. Continuity is Claude Code only in 0.1.0: its hooks read
  Claude Code's payloads and transcript. OMP seats keep newdle's save until an OMP adapter ships.
- Without Node 22.13 or later on the hooks' PATH: no hook runs, and the liveness line never
  appears, which is itself the sign.

## Ported from newdle 0.2.175

Source paths are under the installed plugin `~/.claude/plugins/cache/contextpress/newdle/0.2.175/`.
"Stripped" lists what the source did that this plugin does not, with the source line where
the number is known.

| Source | Destination | Stripped |
|---|---|---|
| `hooks/compact-continuity.mjs`, PreCompact half (`snapshot()`) | `hooks/pre-compact.mjs`, `lib/snapshot.mjs` `buildSnapshot()`/`capture()` | the header's canonical-home line `shipyard/.claude/hooks/compact-continuity.mjs` (line 2); the repository-scope gate `hooksEnabled()` from `lib/hook-scope.mjs`, which ran the hook only where a `newdle-hooks.json` declared it on (lines 28 and 119); the snapshot's home `<repo>/.ai/session-state--<session>.md` (`STATE_DIR = ".ai"`, line 129), now `${XDG_STATE_HOME:-~/.local/state}/continuity/<session>.json`, so the plugin writes nothing into the repository; the `### Newest decision-log entries` block of the reconstruction section, `ls -1t .ai/decision-log` (line 531), until 0.2.0 brought it back as the `## Durable notes` section (`lib/repo-rules.mjs` `renderNotes()`: a configurable directory, no subprocess, listed after every compaction rather than only in a degraded capture); the `## Repo rules in play` section (`repoRulesSection`, lines 308 to 338), which re-inlined the rules chains of every repository touched this session through `lib/repo-rules-walk.mjs` and paired with newdle's separate `repo-rules-inject` hook, until 0.2.0 brought it back as `## Repo rules re-inlined` (`lib/repo-rules.mjs` `walkRules()`: one walk from the payload's cwd, not one per touched path; the same per-level rule and the same launch-directory skip; byte caps with the largest files cut first; no `@path` import expansion); the systemMessage's "or running /wrap-up at the end of one" (line 605), replaced by `/continuity:handoff`; the comment pointing at `newdle-hooks.judgment.ts:205` (line 443); the hand-rolled stdin/exit scaffolding, replaced by `lib/hook-runner.mjs` |
| `hooks/compact-continuity.mjs`, SessionStart half (`restore()`) | `hooks/session-start.mjs`, `lib/snapshot.mjs` `restore()` | the scope gate as above; the read from `<repo>/.ai/`; the restore text's "restate before continuing" rule is kept |
| `hooks/compaction-liveness.mjs`, `hooks/lib/compaction-liveness-report.mjs`, `hooks/lib/heartbeat.mjs` | `hooks/session-start.mjs`, `hooks/user-prompt-submit.mjs`, `lib/liveness.mjs`, `lib/heartbeat.mjs` | the scope gate (`compaction-liveness.mjs` lines 33 to 41, `ENG-1622`); the heartbeat home `~/.claude/newdle-compaction-heartbeat.ndjson` (`heartbeat.mjs` lines 45 to 46), now under the state directory; the "not declared" case of `renderLiveness()` (`compaction-liveness-report.mjs` lines 73 to 84), which said the repository had no `newdle-hooks.json`, a case this plugin has no equivalent of; the once-per-session flag file in `os.tmpdir()`, now `sessions/<session>.json` under the state directory; the sentence prefix "Newdle plugin," now "continuity," |
| `hooks/context-pressure.mjs`, `hooks/lib/calibration.mjs` | `hooks/user-prompt-submit.mjs`, `hooks/stop.mjs`, `lib/pressure.mjs`, `lib/calibration.mjs`, `lib/session-flags.mjs` | the scope gate and `withMuteHint()` (lines 27 to 37); the env kill switch `NEWDLE_CONTEXT_PRESSURE=off` (line 39) and threshold override `NEWDLE_CONTEXT_THRESHOLD` (lines 47 to 50, default 0.65), now `pressure` and `threshold` in `config.json`, same default; the nudge flag `join(tmpdir(), "newdle-context-pressure-<key>.json")` (line 62), now the once-marks under the state directory; the calibration home `~/.claude/newdle-context-calibration.ndjson` (`calibration.mjs` lines 27 to 28); "run the `handoff` skill" in the block text (line 150), now `/continuity:handoff` |
| `hooks/lib/handoffs.mjs` | `lib/handoffs.mjs` | nothing: the `.ai/handoffs/` layout, root resolution, the 7-day staleness, the show-3 cap and the 120-line entry cap are kept |
| `skills/handoff/SKILL.md` | `skills/handoff/SKILL.md` | `user-invocable: false` in the frontmatter, so `/continuity:handoff` exists; the `## When to use this instead of wrap-up` section with its `.ai/decision-log/` table and "feeds the promotion pipeline" (lines 34 to 52), replaced by one paragraph on what belongs in the repository's own record; the `wrap-up` drain contract ("wrap-up owns the drain, both passes", lines 153 to 161, and item 5 of Consuming, lines 196 to 198), replaced by the resuming session setting `consumed` and `superseded` itself; the pointer to `${CLAUDE_PLUGIN_ROOT}/references/output-types.md`, now "if the output-types plugin's contract is loaded"; the references to `.ai/session-state--<session-id>.md` as the hook's file (lines 118 and 166 to 168), now the plugin's state directory; "take a beat then hand off" and the em dashes |

The strings `shipyard`, `linear`, `.projects`, `newdle-hooks`, `/Users/<name>/` and `ENG-<n>`
appear in nothing the plugin runs or loads; `test/port.test.mjs` scans every file except this
one, `CHANGELOG.md` and itself.

## Changes in 0.2.0

The two pieces the 0.1.0 port left out of `hooks/compact-continuity.mjs` are back, generic
(`lib/repo-rules.mjs`), both only on the SessionStart that follows a compaction:

- `## Repo rules re-inlined`: the `CLAUDE.md` (with `CLAUDE.local.md`) else `AGENTS.md` of every
  directory from the payload's cwd to the walk root (the git root, the nearest rules-holding
  directory above it below the home directory, or the cwd alone), root first, nearest last. A
  level at or above `CLAUDE_PROJECT_DIR` is the host's and is named as skipped. 8,000 bytes per
  file, 9,000 for the section, and never more than the 20,000-character restore guard has left
  after the snapshot: the rules give way first. The largest files are cut to one shared allowance
  with a `(truncated at N bytes …)` marker; every skipped file is one line with its reason; a
  symlink out of the tree is never followed.
- `## Durable notes`: the newest `notesCount` (default 5) files of `notesDir` (default
  `.ai/decision-log` at the git root) by mtime, with the line that the notes and the rules files
  are the source of truth and the snapshot is the safety net.
- Config: `rules` (`"on"`/`"off"`), `notesDir` (a non-empty string), `notesCount` (0 to 100).
- Tests for the walk, the caps and the probe in `test/lib.test.mjs`, the post-compaction block in
  `test/hooks.test.mjs`, and two scenarios, `evals/session-start-restore-rules.scenario.json` and
  `evals/session-start-restore-notes.scenario.json` (fourteen in all).

## Changes in 0.1.1

`lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.2.1's). The handler thread's
env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, a process group
the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits, and the runner
waits for stdout to drain before it exits (bounded by the same deadline), so an answer larger
than one 64 KiB pipe buffer is no longer cut short. continuity's
hooks register none, so every hook answers as before, under the same 4 s deadline.

## Changes in 0.1.0

First release, ported from newdle 0.2.175. What changed after the first review, before release:

- The pressure warning and the Stop block work on Claude Code, which never sends a token count
  to a hook: the context size is the token usage the last reply recorded in the transcript,
  against `contextTokens` (new, default 200,000). With no recorded usage it falls back to the
  transcript's size / 8 and says `(estimate)`; calibration is used only when a host has sent a
  real `token_count`.
- The Stop block does not fire when this session already wrote a handoff.
- PreCompact's git calls share one 2 s budget; a field git did not answer is saved as unknown,
  and an unanswered `git status` is never shown as a clean tree.
- The liveness line reports the newest save's result, so a save that broke after one success
  says so; a restore that found nothing says why.
- `threshold` must be a JSON number; a config problem is named once per session.
- `errors.log`, `heartbeat.ndjson` and `calibration.ndjson` are appended to, and trimmed by a
  rename-swap only once past twice their cap.
- `scripts/prune.mjs` runs from a path with a space or through a symlink.

The full record is [CHANGELOG.md](CHANGELOG.md).
