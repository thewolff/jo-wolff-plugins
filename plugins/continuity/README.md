# Continuity

Keep a long session's state across compaction. Four hooks, one skill and an OMP extension:

- **`hooks/pre-compact.mjs`** (PreCompact) saves the session's deterministic state (branch,
  uncommitted paths, files touched, recent asks, the repository's open handoffs) to a snapshot
  under the plugin's state directory, leaves a heartbeat record saying whether that worked, and
  on Claude Code prints plain-text instructions asking the compaction summary to end with a
  `## Handoff` section.
- **`hooks/session-start.mjs`** (SessionStart) injects that snapshot back after a compaction and
  removes it, re-inlines the rules files (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`) on the walk
  from the cwd to the repository root that the host does not re-read on its own, lists the newest
  entries of the repository's durable-notes directory, and on every start says when the save last
  succeeded on this machine, or that it never has. A save that silently stopped working is the
  failure this line exists to end.
- **`hooks/user-prompt-submit.mjs`** (UserPromptSubmit) says the liveness line once when
  SessionStart did not, and asks for a handoff when the session's context has grown past the ask
  point (default 175,000 tokens, and at least 40,000 past where the session or compaction window
  started), again after each further 150,000, and afresh after every compaction. On Claude Code
  the size is the token usage the last reply recorded in the transcript; see below.
- **`hooks/stop.mjs`** (Stop) blocks one stop under the same rule, unless this session wrote a
  handoff since the last compaction and the last block, so the model has a turn to write one
  while it still holds the context the handoff needs.
- **`skills/handoff/SKILL.md`** (`/continuity:handoff`) writes the judgment layer no hook can
  derive, what was in progress, the next move, what was ruled out, what is still uncertain, to
  `<repo>/.ai/handoffs/`, and says how to resume from one: restate its content before continuing.
- **`omp/continuity-omp.ts`** runs the save and the restore under OMP, where plugin hooks do not
  run: the same two hook files, spawned on OMP's own compaction events; see "Under OMP".

Ported from the newdle plugin 0.2.175 (its `compact-continuity`, `compaction-liveness` and
`context-pressure` hooks and its `handoff` skill); the table of what was stripped is at the end.
Built on plugin-kit 0.3.1; Node 22.13 or later; Claude Code hooks plus an OMP extension.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install continuity@jo-wolff-plugins
```

On OMP:

```
omp marketplace add thewolff/jo-wolff-plugins
omp plugin install continuity@jo-wolff-plugins
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

**On Claude Code the hook also prints, on every compaction (auto, idle, manual), a fixed
plain-text instruction (`SUMMARY_INSTRUCTIONS` in `hooks/pre-compact.mjs`, about 1,000
characters) asking the compaction summary to end with a `## Handoff` section: In flight, Ruled
out, Still open, Next step.** Claude Code uses a PreCompact hook's plain stdout, under 10,000
characters, as instructions for the compaction summary, and discards its `systemMessage` and
`continue` fields ([hooks reference, PreCompact](https://code.claude.com/docs/en/hooks.md)), so
the judgment layer reaches the next window through the summary even when no handoff file was
written. Nothing from the transcript or the payload is put into that text. With `"snapshot":
"off"` the save is skipped and the instructions are still printed.

The notice that an auto or idle compaction found no handoff file, which 0.3 gave here as a
`systemMessage` Claude Code then discarded, now comes from `hooks/session-start.mjs` after the
compaction (below). Under OMP (the adapter sets `CONTINUITY_HOST=omp`) the hook answers JSON as
before: the no-handoff notice for an auto-compaction and any fault as a `systemMessage` the
adapter shows, and no summary instructions. A manual `/compact` says nothing to the person on
either host.

### The restore and the liveness line (`hooks/session-start.mjs`)

On SessionStart with `source: "compact"`, `lib/snapshot.mjs` reads this session's snapshot (by
`session_id`; another session's is never injected), renders it as markdown under
`## Restored session state (post-compaction)` with a line asking the model to restate what the
thread is and what is pending on it before continuing, and unlinks it. The whole context after a
compaction (the restore with its heading and notices, the two sections below, the liveness line
and the blank lines joining them) is at most 20,000 characters. A restore that does not fit whole
in its share of that guard is cut on a character boundary, says so with the number of characters
shown and the file's path, inside the same guard, and is kept; one older than a day is ignored
and left for prune. A restore that refills the window the compaction just cleared is worse than
none. With no handoff file in the snapshot, the restore says so and points the model at the
summary's `## Handoff` section instead (under OMP, whose summary got no such instruction, it says
only that no handoff was written). When the restored save came from an auto or idle compaction
with no handoff file and no host-supplied judgment, a `systemMessage` tells the person so.

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
passed over. The oldest such reply after the marker is the window's **baseline**: what the
session (or the window since the last compaction) started at.

When no reply since the marker recorded usage (a fresh window, or a host whose transcript has
none), the check falls back to the transcript's bytes since the marker, or the whole file when it
has none, divided by `BYTES_PER_TOKEN_ESTIMATE` (8), and the ask says `(estimate)`. On the
machine this was written on, Claude Code transcripts ran about 8 to 9.5 bytes per context token
with a wide spread, so treat that fallback as rough in either direction.

An OMP or other host adapter that passes a real `token_count` at PreCompact, and whose
transcript records no usage, gets a calibrated byte estimate instead: each such compaction
records `{bytes, tokens}` in `calibration.ndjson`, and once any record exists the median
tokens-per-byte ratio replaces the constant. The ask says which basis it used.

**When it asks.** Counted per compaction window, separately for the prompt hook and the Stop
hook (`dueAsk()` in `lib/pressure.mjs`):

1. **The first ask in a window** comes at the ask point, and never before the context is
   `askMarginTokens` (40,000) past the window's baseline. A Desktop session that opens at 130,000
   tokens is not asked on its first turn, and neither is the first turn after a compaction. The
   ask point, first match wins:
   - `askTokens` in the config file;
   - else, when the file sets `threshold` or `contextTokens` (the 0.3 keys), `threshold` ×
     `contextTokens`, each defaulting to its 0.3 value (0.65 and 200,000);
   - else, when `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` is set, that value (raised to 100,000 when
     lower, as Claude Code does) minus `askMarginTokens`;
   - else 175,000.
2. **After an ask** the next one in the same window comes once the context has grown a further
   `reaskStepTokens` (150,000) past the size it was asked at. An agent that answered "nothing in
   flight" at 180,000 is asked again at 330,000, not on every prompt in between.
3. **A compaction re-arms both.** The marks in `sessions/<session_id>.json` (`promptWarned`,
   `stopBlocked`) record the window they belong to: the `uuid` of the last `compact_boundary`
   line (its byte offset when it has none, `start` before the first). The transcript is
   append-only, so the same window is recognised when the session is resumed days later, and a
   new marker starts the count over. A 0.3 flags file, whose marks are bare timestamps with no
   window, counts as an earlier window and is re-armed.
4. **A handoff silences the ask that is due** when an open handoff in `.ai/handoffs/` carries
   this session's `session_id` and was written after the window's compaction marker and after
   the last ask. The next step is counted from the size it silenced.

Why 175,000: Opus 5.5 has a native 1M-token window and auto-compacts near 967K ([model
configuration](https://code.claude.com/docs/en/model-config.md)), so a fraction of 200,000 is no
longer "near full"; Desktop's Code tab instead compacts an idle session at 200,000 tokens or more
after about an hour (`idleCompaction`, on by default there, threshold
`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`; [settings
reference](https://code.claude.com/docs/en/settings-reference.md)). Asking 25,000 below that
leaves room to write the handoff before an idle compaction can take the context.

The prompt hook adds the ask as `additionalContext`:

> continuity: this session's context is 180,000 tokens (from the token usage the last reply
> recorded). Before it is compacted, run `/continuity:handoff` to write the judgment layer to
> `.ai/handoffs/` in the repository … If there is genuinely nothing in flight worth passing on …
> say so in one line and stop. This asks again only after the context grows by another 150,000
> tokens, or after the next compaction.

and the Stop hook returns `{ decision: "block", reason: <the same text> }` under the same rule, so
the model gets one more turn to write the handoff. A stop with `stop_hook_active: true` is never
blocked; the mark is written before the block is given, and a mark that cannot be written means
no block, so the person can always end the session.

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
{ "askTokens": 175000, "askMarginTokens": 40000, "reaskStepTokens": 150000, "pressure": "on",
  "liveness": "on", "snapshot": "on", "rules": "on", "notesDir": ".ai/decision-log", "notesCount": 5 }
```

| Key | Default | Meaning |
|---|---|---|
| `askTokens` | unset: `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` − `askMarginTokens` when that variable is set, else `175000` | the context size, in tokens, of the first handoff ask in a compaction window; a positive whole number. Wins over `threshold` and `contextTokens` |
| `askMarginTokens` | `40000` | how far past the window's first recorded usage the context must be before the first ask; a whole number, 0 or more |
| `reaskStepTokens` | `150000` | how much further the context must grow, in the same window, after an ask or a handoff before the next ask; a positive whole number |
| `threshold` | unset (0.3: `0.65`) | kept for 0.3 config files: with `askTokens` unset, setting this or `contextTokens` makes the ask point `threshold` × `contextTokens`, the unset one at its 0.3 default; a JSON number strictly between 0 and 1 (a string or an array is a problem, not a number) |
| `contextTokens` | unset (0.3: `200000`) | the other half of that product; a positive whole number |
| `pressure` | `"on"` | `"off"` silences the prompt ask and the Stop block |
| `liveness` | `"on"` | `"off"` silences the liveness line |
| `snapshot` | `"on"` | `"off"` skips the PreCompact save (the heartbeat records `skipped:off`) and the restore; the summary instructions and the two sections below still follow a compaction |
| `rules` | `"on"` | `"off"` drops the post-compaction `## Repo rules re-inlined` section |
| `notesDir` | `".ai/decision-log"` | the durable-notes directory the post-compaction `## Durable notes` section lists; relative to the git root (the cwd when there is none) unless absolute; a non-empty string |
| `notesCount` | `5` | how many of its newest entries to list; a whole number from 0 (the section is dropped) to 100 |

The margin and the re-ask step apply whichever way the ask point was set. A missing file is the
defaults. A file that does not parse, or a value of the wrong shape, is the defaults for that
value, and the hooks name the file and the problem once per session (one once-mark shared by
every hook; on Claude Code the PreCompact hook, whose messages are discarded, leaves it to the
next hook).

## State

Declared in `.claude-plugin/plugin.json`:

| Path | Kept | Pruned |
|---|---|---|
| `${XDG_STATE_HOME:-~/.local/state}/continuity/<session_id>.json` | the snapshot; consumed by the restore | `scripts/prune.mjs --days 30` |
| `…/continuity/sessions/<session_id>.json` | the once-marks (`livenessSaid`, `configNoted`) and the ask anchors (`promptWarned`, `stopBlocked`: `{ epoch, tokens, at, by }`) | same |
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
| `hooks/pre-compact.mjs` | the snapshot cannot be written | heartbeat `failed:<code>` and an errors.log line; the summary instructions still print, and the restore says the state was not restored; under OMP a `systemMessage` naming the path; compaction proceeds |
| `hooks/pre-compact.mjs` | git slow or absent, transcript unreadable | every git call shares one 2 s budget; a field git did not answer is `(unknown: timed out)` or `(unknown: … failed)`, and the snapshot is still written |
| `hooks/session-start.mjs` | no snapshot, a stale one, one that does not parse | nothing restored; the liveness line alone, and after a compaction the rules and notes sections |
| `hooks/session-start.mjs` (the rules walk) | the cwd missing or not a directory; a rules file unreadable, empty, a symlink out of the tree, or reached twice; the rules larger than the cap or the snapshot leaving no room | the section still appears: one line saying nothing was walked, or one `- skipped <path>: <why>` line per file; a cut file ends `(truncated at N bytes …)`; never a silently shortened rule |
| `hooks/session-start.mjs` (the notes probe) | `notesDir` absent, not a directory, or unreadable | one line saying so under `## Durable notes` |
| `hooks/session-start.mjs` | heartbeat absent or never `ok` | the liveness line says so, in bold; never reads as healthy |
| `hooks/user-prompt-submit.mjs`, `hooks/stop.mjs` | no `transcript_path`, unmeasurable transcript, no recorded usage | silent when there is nothing to measure; with no recorded usage, the bytes / 8 fallback, and the ask says `(estimate)` |
| `hooks/user-prompt-submit.mjs`, `hooks/stop.mjs` | a 0.3 flags file, a mark from an earlier compaction window | re-armed: the ask is due again at the ask point of the current window |
| `hooks/stop.mjs` | the mark cannot be written | no block |
| `lib/config.mjs` | config missing, malformed, wrong-typed | defaults; the problem named once per session |
| `skills/handoff` | `.ai/handoffs/` unwritable, no git, no command | the five sections go in the reply; the skill's "When this can't run" section |

`test/hook-contract.test.mjs` proves the five fault inputs for every hook; `test/hooks.test.mjs`
runs each hook as a child process on its parse / allow / warn / unparseable inputs and walks one
session end to end; `test/lib.test.mjs` covers every lib module including its error paths;
`test/port.test.mjs` pins the stripped strings below; `omp/continuity-omp.test.mjs` covers the
OMP adapter (its payload, its budgets, each fail-open path, and one save-then-restore round trip
through the real hooks). `evals/manifest.json` declares each event's
outcomes and the fifteen `evals/*.scenario.json` prove them: `evals/pre-compact-auto-no-handoff.scenario.json`
is the save with its plain-text summary instructions, `evals/pre-compact-omp-payload.scenario.json` the same save
on the payload the OMP adapter sends, with its `systemMessage`, `evals/session-start-restore.scenario.json` the restore,
`evals/session-start-restore-rules.scenario.json` the re-inlined rules,
`evals/session-start-restore-notes.scenario.json` the durable-notes list,
`evals/stop-blocks-near-full.scenario.json` the block and `evals/stop-once-per-session.scenario.json`
its once-per-step rule (`bash e2e/live-run.sh --no-live` replays them offline). Run `node --test` from inside `plugins/continuity/`.

### When this can't run

- On a host other than Claude Code or OMP: the hooks read Claude Code's payloads and the OMP
  extension builds that payload from OMP's events; no third host is adapted.
- On OMP, the context-pressure check (`hooks/user-prompt-submit.mjs`, `hooks/stop.mjs`) does not
  run: it measures a Claude Code transcript, and OMP compacts on its own threshold without one.
- Without Node 22.13 or later on the hooks' PATH: no hook runs, and the liveness line never
  appears, which is itself the sign. Under OMP the extension looks for `node` on PATH when the
  host is Bun; `CONTINUITY_NODE=/path/to/node` overrides.

## Under OMP

OMP does not run a plugin's `hooks/hooks.json`; it loads the extension modules a plugin's
`package.json` names under `omp.extensions`. `omp/continuity-omp.ts` is that module. It imports
nothing from the hooks: it spawns `hooks/pre-compact.mjs` and `hooks/session-start.mjs` as the
same stdin-JSON CLIs Claude Code runs, so one implementation and one test suite serve both hosts,
and the state they write (`${XDG_STATE_HOME:-~/.local/state}/continuity/`, the same snapshot file,
heartbeat, once-marks and caps) is the same on both.

The event mapping, from OMP's docs (`extensions.md`, "Session lifecycle"; `compaction.md`,
"Extension and hook touchpoints"):

| Claude Code | OMP | What the extension does |
|---|---|---|
| PreCompact | `session_before_compact` | spawns `hooks/pre-compact.mjs` with a PreCompact payload built from the event: `trigger` (`auto` while an `auto_compaction_start` is in flight, else `manual`, a `/compact`), `custom_instructions`, and the three host fields `lib/snapshot.mjs` takes from a transcript-less host: `intents` (the user texts of the messages the compaction is about to discard, the last five, 500 characters each), `file_operations` (the host's read / written / edited paths with counts, 6,000 characters), `token_count` (the host's token count before the compaction). No `transcript_path`: an OMP session file is not a Claude Code transcript. The hook's `systemMessage` (auto-compaction with no handoff written; a snapshot that could not be written) is shown with `ctx.ui.notify`. The handler never cancels a compaction and never replaces its summary. |
| SessionStart (`source: "compact"`) | `session_compact` | spawns `hooks/session-start.mjs` with `source: "compact"`; its `additionalContext` (the restored snapshot, the `## Repo rules re-inlined` section, the `## Durable notes` list, the liveness line, the same text as on Claude Code) goes to the agent through `pi.sendMessage` as a hidden custom message (`continuity-restored`): steered into the running turn when the agent is streaming, appended to the context when it is idle. OMP compacts in session, so the moment to read the snapshot back is right after the compaction that wrote it. |

The session id on both payloads is `ctx.sessionManager.getSessionId()`, stable across OMP's
provider-id rotations, so the save and the restore share one snapshot path and one once-mark.

OMP loads two rules filenames into the system prompt on the walk up from its cwd, `CLAUDE.md` and
`AGENTS.md` (its `claude-md` and `agents-md` context-file providers, each asking for one exact
name), and a compaction does not touch the system prompt (`context-files.md`). It does not load
`CLAUDE.local.md`. So the spawn sets `CLAUDE_PROJECT_DIR` to the session's cwd and
`CONTINUITY_HOST_RULES=CLAUDE.md,AGENTS.md`: at the launch directory and above, the rules
section says `skipped <path>: loaded by the host at launch` for a `CLAUDE.md` or `AGENTS.md`
instead of spending the restore budget on a second copy, and inlines a `CLAUDE.local.md` there
like any nested file. Without `CONTINUITY_HOST_RULES` (Claude Code, which loads the local file
too) every rules file at those levels is named as kept, as before.

The restore runs once per compaction entry: the extension remembers, per session, the
`compactionEntry.id` it last started a restore for, and a repeated `session_compact` for that
entry sends nothing, so a kept (truncated) snapshot is not sent twice and a delivered restore is
never followed by a "not restored" line. A new entry restores again. The memory is bounded: one
entry id per session, recorded only when a restore starts, dropped on `session_shutdown`, and at
most 64 sessions, the oldest dropped first.

Lifecycle exclusions. Two OMP paths commit a compaction without `session_before_compact`, so no
save runs for them: the manual handoff (`/handoff`, which writes the host's own handoff summary)
and the snapcompact frame rescue. The extension notes per session that a save ran (succeeded or
failed) and the branch leaf it ran on; a `session_compact` whose entry was committed on that leaf
is paired, and any other is unpaired. For an unpaired one the restore runs only when a snapshot
file for the session is already on disk (one a truncated restore kept, or one whose own restore
never ran). With no snapshot it sends nothing: no save was attempted for this compaction, so
there is no failed save to report, and the host's summary stands. A paired `session_compact`
behaves as on Claude Code, including the "this compaction's state was not restored" line when
the save failed. A save whose compaction another extension cancelled leaves no note: an aborted
`auto_compaction_end` or an aborted pre-event signal deletes it, and a cancelled `/compact`'s note
names a leaf the next compaction is not committed on once the session has moved on, so it is
discarded unpaired.

Budgets: OMP abandons an extension handler at 30 s. Each hook answers inside the runner's own 4 s
deadline whatever its handler does; the extension gives each spawn 8 s (node start-up and the
stdout drain on top), kills the child's process group when that passes, and the event proceeds.
`omp/continuity-omp.test.mjs` pins both budgets against the runner's constant. While an extension
registers `session_before_compact`, OMP runs every compaction blocking rather than speculatively in
the background; the save needs the pre-event, and there is no other hook that fires before every
compaction.

Fail open, the same way as the hooks: a spawn that fails, exits non-zero, prints something other
than JSON or outruns its budget is one `omp-adapter <hook>: …` line in the state directory's
`errors.log`, and the compaction (or the turn) proceeds without it.

### What newdle's save did on OMP that this now does, and what it does not

This replaces the pre-compaction save that newdle's OMP extension (`~/.omp/agent/extensions/newdle-hooks.ts`,
its `session_before_compact` and `session_compact` handlers) ran for OMP seats. Same:

- The save on `session_before_compact`, unconditional, with the host's discarded asks, file
  operations and token count on the payload (newdle's `intents`, `file_operations`, `token_count`,
  the same three names, read by the same `buildSnapshot()` this plugin ported).
- The restore on `session_compact`, handed to the agent through `pi.sendMessage` as a hidden
  message, in session, right after the compaction.
- Fail open: a throw in either handler never stops a compaction.

Not carried over:

- **The one-time cancel.** newdle cancelled the first threshold compaction of a seat with no fresh
  handoff and injected a "write the handoff now" instruction; the next crossing compacted
  unconditionally. This extension never returns `{ cancel: true }`: the person is told, through
  the hook's `systemMessage`, that auto-compaction fired with no handoff written, and the
  compaction runs.
- **The in-session compaction contribution.** newdle appended its snapshot to the compaction entry
  (`pi.appendEntry`, `preserveData`) as a second copy that survived inside the session file. The
  snapshot here lives in the state directory only, where the restore reads it back.
- **The archive copy.** newdle kept a per-seat copy under `~/.omp/agent/compaction-archive/`
  that the restore could not consume. Nothing here writes under `~/.omp`.
- **The "no continuity record was recovered" message.** newdle sent one when both its sources
  were empty. Here the restore is never silent after a compaction: with no snapshot it says so
  and gives the liveness line, the rules section and the notes list, the same as on Claude Code.
- **The project-directory and seat gates.** newdle ran only where its manifest declared the hooks
  on and read the seat name from the environment. This extension runs in every OMP session the
  plugin is installed in.

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

## Changes in 0.4.0

The handoff ask now fires when it is useful and again when it is due. It asks at an absolute
point (`askTokens`, default 175,000, under Desktop's 200,000-token idle compaction; or
`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` minus the margin when that is set) and never before the
context is `askMarginTokens` (40,000) past where the window started, so a session that opens at
130,000 tokens is not asked on its first turn. It asks again after each further
`reaskStepTokens` (150,000), and a compaction re-arms both the prompt ask and the Stop block; a
0.3 flags file is re-armed. A 0.3 config with `threshold` or `contextTokens` keeps its ask point.
On Claude Code the PreCompact hook prints plain-text summary instructions asking for a
`## Handoff` section, and the no-handoff notice Claude Code discarded from PreCompact is given
after the compaction by the SessionStart hook. Details in "The context-pressure check" and
[CHANGELOG.md](CHANGELOG.md).

## Changes in 0.3.1

`scripts/prune.mjs` is plugin-kit 0.4.1's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged.

## Changes in 0.3.0

- `omp/continuity-omp.ts`, an OMP extension (`package.json` `omp.extensions`, `.omp-plugin/plugin.json`)
  that spawns `hooks/pre-compact.mjs` on `session_before_compact` and `hooks/session-start.mjs` on
  `session_compact`; the "Under OMP" section above has the payload, the budgets and the table of
  what newdle's OMP save did that this does and does not.
- `omp/continuity-omp.test.mjs` (nineteen tests, one a save-then-restore round trip through the
  real hooks) and `evals/pre-compact-omp-payload.scenario.json` (fifteen scenarios in all).
- The restore runs once per compaction entry, and only after a save was attempted or when a
  snapshot is on disk (the lifecycle exclusions above).
- `lib/repo-rules.mjs` reads `CONTINUITY_HOST_RULES`: when set, the launch-directory skip covers
  only those file names. The OMP extension sets it to `CLAUDE.md,AGENTS.md`, so `CLAUDE.local.md`
  is inlined under OMP. Unset (Claude Code), nothing changes. No change to the hooks, the config
  keys or the state layout.

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
