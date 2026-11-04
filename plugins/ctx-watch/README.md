# ctx-watch

Notice when the [ctx](https://github.com/ctxrs/ctx) daemon is dead, not supervised, or stale,
or its semantic index is not ready; repair what ctx documents a command for; and say so in two
places: a line at Claude Code's SessionStart and a macOS popup from a launchd timer that runs
whether or not a session is open. And, at Stop, notice a session that picked a thread back up
(a resume or a compaction, or a reply that says "as discussed") without asking ctx what the
thread was: the `consult-history` check.

Why: from 2026-10-28 to 10-31 the ctx daemon was down and nothing said so. Its launchd job had
never loaded (ctx's own `launchctl bootstrap` had failed with "Bootstrap failed: 5: Input/output
error"), so `KeepAlive` never applied; agent shells carry `CI=true`, under which ctx refuses to
start a daemon, so no agent's ctx call brought it back; and `ctx daemon status` exits 0 either
way, so a script that read the exit code saw nothing wrong.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ctx-watch@jo-wolff-plugins
```

Then the timer, once, from your own Terminal (a GUI login session, which is where launchd's
`gui/<uid>` domain lives; ctx's own bootstrap failed from somewhere else):

```
node <plugin dir>/scripts/ctx-watch.mjs install
```

It writes the plist, lints it, and prints the one `launchctl bootstrap gui/<uid> <plist>` line
to run. It never runs bootstrap itself. The plist names this script by its absolute path, and
Claude Code installs plugins under a directory with a version segment
(`~/.claude/plugins/cache/jo-wolff-plugins/ctx-watch/<version>/`), so after a plugin update
the timer points at a path that may be gone: run `install` again and the printed bootout-and-
bootstrap line. Until you do, the SessionStart dead-man's line says the timer has stopped.

`install` refuses to write a plist when no `ctx` is on this shell's PATH (a timer that can
never find ctx would only ever pop up); `--ctx <path>` names one by hand.

## What it does

**The probe.** `ctx daemon status --format json`, spawned with `CI` removed from the environment
and a 10 s bound, judged on the JSON and never the exit code. Failing, each with its own reason
naming the field:

| Condition | Reason |
|---|---|
| ctx not on PATH (or the pinned path gone), timed out, no output | `ctx could not run: …` |
| output is not JSON | `` `ctx daemon status --format json` printed no JSON (exit N): … `` |
| `.daemon.running !== true` or `.daemon.status !== "running"` | `the ctx daemon is not running (.daemon.running = …, .daemon.status = …)` |
| `.daemon.supervisor.status !== "installed"` | `the ctx supervisor is not installed (…): launchd will not restart the daemon` |
| `.daemon.jobs.core_refresh.last_run_at_ms` missing | `` `ctx daemon status --format json` has no .daemon.jobs.core_refresh.last_run_at_ms `` |
| … not whole epoch milliseconds a Date can hold | `` `…` has an invalid .daemon.jobs.core_refresh.last_run_at_ms (…: not whole epoch milliseconds) `` |
| … more than 5 min ahead of this clock | `core_refresh in the future (…, 6m ahead of this clock; over 5m of skew)` |
| … over 2 h old | `the ctx daemon runs but core_refresh last ran 3h ago (…)` |
| `.daemon.jobs.semantic_index` missing | `` `ctx daemon status --format json` has no .daemon.jobs.semantic_index ``; fix `ctx semantic status` |
| … `.semantic_enabled === true` and `.status !== "ready"` | `the ctx semantic index is not ready (.daemon.jobs.semantic_index.status = "budget_exhausted")`; fix `ctx semantic enable --wait` |

**The semantic rows** (0.2.0) read the same `ctx daemon status` output: no second spawn. On
2026-11-04 at 03:00 `ctx search --format json` reported `semantic_status: unavailable` and
`semantic_fallback: flat-F32 projection is missing, stale, partial, or not pinned to Core
generation …` while the daemon was healthy, and `ctx daemon status` read
`.daemon.jobs.semantic_index.status = "budget_exhausted"` at the same time
(`test/fixtures/ctx-daemon-status-semantic-not-ready.txt`); at 13:00 search reported `ready`
and so did the field. The cheapest call that exposes semantic status is the one already made:
`ctx semantic status --format json` took 2.8 to 9 s and `ctx search --format json` 2.9 s,
against 0.15 s for `daemon status`. ctx 2.3.0 has no rebuild verb (`ctx semantic --help`:
`enable`, `status`, `disable`), so a not-ready index is not repaired: the line names
`ctx semantic enable --wait` ("Enable semantic search and start model indexing"; `--wait`:
"Wait until semantic search is ready for the current index"), which on an index that is
already enabled re-pins the projection rather than erroring (tried on a throwaway data root:
a second `enable` answered `status: "ready"`). `ctx index mode auto` is not tried for these
rows: the daemon is up and the mode command would change nothing. Semantic search not enabled
(`semantic_enabled: false`) is a pass with "semantic search not enabled" in the summary:
nothing to watch. The daemon rows come first; a daemon that is down is one line, the daemon's.

The supervisor check is the 10-28 failure (`install_failed`); the staleness check is a hung
daemon, which launchd's `KeepAlive` cannot see. A status that contradicts `running` (missing,
`stopped`, `stale_lock` with `running: true`) is a failing probe, not a pass by default; a stamp
from the future is a broken clock or a broken ctx, and is said rather than read as fresh.

The spawn's bound is hard: a ctx that ignores the polite kill signal is killed with SIGKILL at
the bound, together with everything in its process group, so neither the hook nor the timer can
be held by a stuck child.

**The repair.** On a failing probe, `ctx index mode auto` (with `CI` removed), then one more
probe. ctx's storage doc says of that command: "when auto is not overridden, ctx installs or
repairs supervision and starts the persistent background daemon". Tried on a throwaway data
root on 2026-11-04 with ctx 2.3.0: after `kill <daemon pid>`, three non-CI `ctx daemon status`
calls left it at `running: false, status: "stale_lock"` (so `daemon status` is read-only, as
ctx's CLI reference says: "without starting, stopping, repairing, or removing anything"); one
`ctx index mode auto` brought it back (`running: true`, new pid) in 0.4 s; the same command under
`CI=true` printed `Error: ctx daemon start was suppressed (ci)` and started nothing. Not tried
against a real managed install's launchd supervision, because that would mean killing the
daemon that was running; the storage doc's sentence is the claim for that half.

The repair runs only when ctx already reports `indexing.mode: "auto"` and the config file it
names exists. ctx-watch never sets ctx up and never flips a deliberate `manual` to `auto`; on
those it says `not attempted: …` and leaves the fix to you.

**The SessionStart line.** Healthy and on time: nothing. Otherwise one or two lines in a
`systemMessage`:

```
ctx-watch: the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock"); fix: `ctx index mode auto`
ctx-watch: timer has not run since 2026-11-04T09:25:11.882Z; run `node '/Users/…/scripts/ctx-watch.mjs' install` and the printed launchctl line
```

The probe line is at most 160 characters (a long reason is cut with `…`; the fix command never
is). The timer line is as long as the plugin's installed path makes it, quoted for the shell:
a path cut to fit would not be a command. The whole check inside the hook (probe, repair,
re-probe) runs on one 3 s clock: each ctx spawn's budget, the smaller of 1.2 s and what is
left, is worked out once; a step whose budget is not positive is skipped rather than run with
timeout 0 (which `spawnSync` reads as no limit), and the line then reads `ctx-watch: check
timed out after 3000 ms (<what the last step said>); fix: …`, inside the runner's 4 s.

The second line is the dead-man's switch: the launchd `tick` stamps the state file every run,
and the hook speaks when the stamp is older than twice the interval (or, if the timer never
ran, twice the interval after the hook's own first run). A watcher that is itself not running
is the failure this plugin exists for, so it is the one thing the hook checks about itself.

**The timer and the popup.** `install` writes
`${XDG_STATE_HOME:-~/.local/state}/ctx-watch/launchd/com.jo-wolff-plugins.ctx-watch.plist`:
`StartInterval` 300 s (`--interval` to change), `RunAtLoad`, `node <this script> tick
--state-dir <state> --ctx <ctx>`, logs beside it, this shell's `PATH` (repeated, empty and
relative entries dropped) so launchd finds `node`, and no `CI`. Every path in it is absolute.
The two arguments are what launchd's own environment would otherwise lose: `--state-dir` is
the directory this shell resolved (so a timer installed with `XDG_STATE_HOME` set reads and
writes the same `state.json` the SessionStart hook does), and `--ctx` is the executable found
on this shell's PATH at install (so a PATH edited later, or a `ctx` dropped into a directory
launchd searches first, cannot change which program the timer runs).

Each `tick` rotates any log over 256 KB (see Retention), probes (and repairs) as above, then
advances an episode in `<state>/state.json`: one failing tick is a strike, the second in a row
is down and shows the popup, later failing ticks stay silent, and a passing tick closes the
episode and re-arms it. So a blip between two ticks shows nothing, a real outage shows one
dialog within ten minutes, and a second outage shows a second one. Each failure kind has its
own popup latch: *daemon* (every row the repair is tried for: ctx missing or not answering, the
daemon down, the supervisor missing, `core_refresh` stale) and *semantic* (the semantic-index
rows, `healable: false`). A kind's popup comes after two failing ticks of
that kind in a row, so a daemon death after a semantic popup still shows its own dialog. The
daemon latch re-arms on any tick where the daemon is up (a pass, or a semantic failure). The
semantic latch re-arms only after two passing ticks in a row, the same count as the strikes
that open a down (`STRIKES_TO_DOWN`), so a semantic status that is `ready` for one tick between
not-ready runs shows one dialog, not one per return. While any popup is pending, no second
dialog of either kind starts; the other kind's comes on the first failing tick after it
settles. The popup is one
`/usr/bin/osascript -e 'display dialog …'`, giving up after an hour, run under a small detached
supervisor (`lib/popup-supervisor.mjs`) so the ticks keep running while it is up. The
supervisor is osascript's parent until it ends and then writes how it ended to that popup's own
file, `<state>/popups/<token>.json`. Before the dialog starts, the tick records its claim in
`state.json` (pending, under that token) while holding `<state>/state.lock`, so a second tick
running at the same moment sees the claim and asks for nothing; a claim that cannot be recorded
(the directory is not writable, the write fails, another tick holds the lock for more than 2 s)
starts no dialog and says so with the path. The episode's popup counts as delivered only on a
confirmed exit 0 (OK clicked, or the give-up) or a person dismissing it; a popup still running a
second after the tick started it is pending (no second dialog meanwhile, `status` says `not
confirmed yet`), and the next tick settles it from its token's file, which no other popup's
supervisor writes. One that could not start, died at once, or failed later (no osascript, no
GUI session) is `popup not shown: …` or `popup not delivered: …` in a tick's line, recorded in
the state (`popupFailedAt`, the reason), and tried again on the next failing tick, so an outage
that began while nobody was logged in still gets its dialog. A pending popup with no outcome
after its give-up plus ten minutes (a supervisor killed with the login session, or a tick that
died between its claim and the dialog) is treated as not delivered.

**The CLI** (`scripts/ctx-watch.mjs`):

| Verb | What |
|---|---|
| `check [--json]` | one probe (repair and re-probe on failure); the needs-you line or nothing; `--json` the whole result. Exit 0 always. |
| `tick` | the timer's run: rotate, settle a pending popup, probe, advance the episode, popup on the second failing tick. One summary line to the launchd log. |
| `install [--interval 300]` | write the plist (state directory and ctx pinned; interval 30 s to 7 days), `plutil -lint` it, ask `launchctl print` whether the job is loaded, print the bootstrap line. |
| `uninstall` | print the `launchctl bootout` line. Removes nothing. |
| `status` | the last probe, the episode (with the last popup: shown, pending, or not shown), the plist path, whether launchd has the job. |
| `prune [--days 30] [--dry-run]` | rotate the logs; remove rotated logs older than `--days` and stray temp files; `pruned: N file(s), B bytes freed` last. A dry run reports the plan the real run carries out. |

Every verb takes `--state-dir <dir>` and `--ctx <executable>`; the plist passes both. The
SessionStart hook spawns `ctx` from PATH, or the absolute path in `CTX_WATCH_CTX` when that is
set: the evals sandbox points it at `evals/fixtures/fake-ctx.sh` so no scenario probes or
heals a real daemon.

**The `consult-history` Stop check** (0.2.0, `hooks/stop.mjs`, `lib/consult-history.mjs`). A
deterministic scan of the Claude Code transcript; no judge. Two triggers:

- *resume*: the first Stop after a SessionStart whose `source` was `resume`, `compact` or
  `fork` (a resumed thread under a new session id: `--fork-session`, `/fork`, `/branch`), when
  no entry since that SessionStart is a ctx history call. The SessionStart hook leaves
  `<state>/resume/<session_id>` holding the time the hook started, written before its ctx probe
  (up to 3 s) so a prompt typed meanwhile is inside the window; the Stop hook reads and removes
  it whether or not the check fires, so one resume is checked once.
- *phrase*: the final assistant message says "we spoke previously", "earlier you said" or
  "as discussed" (whole words, any case) and this turn (since the last user prompt) made no ctx
  history call.

A ctx history call is a `tool_use` named `mcp__ctx__search`, `mcp__ctx__show_session` or
`mcp__ctx__show_event` (the shape Claude Code 2.1.300 and 2.1.317 write under
`~/.claude/projects/*/*.jsonl`: `mcp__<server>__<tool>`, two underscores each; the
single-underscore `mcp__ctx_search` is matched too), or a `Bash` tool_use whose command runs
`ctx search`, `ctx show session` or `ctx show event`. Entries with `isSidechain: true` (a
subagent's) or `isMeta: true` (the host's injected prompts) are skipped; a torn line in a live
transcript is skipped, not a fault. A prompt is a user entry the person typed: an entry with an
`origin.kind` other than `human` (Claude Code stamps `task-notification`, `peer` and
`coordinator` on what it injects) is not one, and nor, on an entry with no `origin`, is text led
by a tag (`<task-notification>`, `<local-command-stdout>`) other than a slash command's
`<command-…>`. So a subagent finishing mid-turn neither starts a new turn nor becomes the topic.

The message, one line: `` ctx-watch: resumed without consulting history — `ctx search '<topic>'` ``
(or `` said "as discussed" without consulting history — … ``), where `<topic>` is the first six
words of the prompt that resumed the thread (the phrase trigger: this turn's prompt), quoted for
the shell. When the window holds no prompt (a compaction mid-turn, or a prompt stamped before
the marker), the topic is the last prompt before it. A transcript with no prompt at all gets a
bare `` `ctx search` `` and the line says the transcript has no prompt to take a topic from;
`block`'s reason asks for the thread's subject to be added. The switch is `~/.claude/ctx-watch.json`:

```json
{ "checks": { "consult-history": "off" | "warn" | "block" } }
```

Default `warn`: the line is a `systemMessage` (you see it; the turn is over) and one line in
`<state>/checks.log`. `block`: `{ "decision": "block", "reason": … }` naming the `ctx search`
command and the way out, except on a Stop with `stop_hook_active: true` (the one after a block),
which warns: never twice. `off`: nothing, and the resume marker is still consumed. The flag file
`~/.claude/.ctx-watch-off` (existence) is `off` whatever the JSON says. It turns off this Stop
check only: the SessionStart line and the launchd timer do not read it, and the SessionStart hook
still leaves the resume marker (the Stop hook consumes it silently). A config file that is
not JSON, not an object, or names a mode that is not one of the three is one `errors.log` line
and the default.

Under OMP this check does not run in 0.2.0: this plugin ships no OMP adapter and OMP does not
read `hooks/hooks.json` (see `plugins/i-have-audhd/omp/`, which exists for that reason). What
an adapter would need, documented rather than built: OMP's resume signal is its continuity
block in the first prompt, not a SessionStart `source`; whether the adapter can see the
session's tool calls decides whether the resume trigger can exist there at all. The phrase
trigger needs only the final message and this turn's tool calls.

## Retention

Everything the plugin writes is under `${XDG_STATE_HOME:-~/.local/state}/ctx-watch`, declared
in `.claude-plugin/plugin.json` `state` with `prune` as its command (the nightly canary runs
it): `state.json` (one small file, rewritten each tick; its temp file is removed if a write
fails), `state.lock` (present only while a writer holds it), `popups/<token>.json` (one small
outcome file per popup shown), `errors.log` (one line per hook fault or ignored state file),
`checks.log` (one line per consult-history finding), `resume/<session id>` (the SessionStart
hook's resume marker, a few bytes, consumed by the next Stop), and `launchd/` with the plist and
the two logs launchd appends to. Any of the four logs over 256 KB
is renamed to `<log>.1` (replacing the last) at the start of a tick or a prune, so each is at
most 256 KB plus one run's lines and the pair at most twice that; `prune` removes a `.1`, a
popup outcome and a resume marker older than 30 days (a session that never reached a Stop), and
a `state.json.<pid>.tmp`, `state.lock.<pid>.stale` or
`popups/<token>.json.<pid>.tmp` a failed write or a crashed lock takeover left. It never removes
a `.1` it rotated in the same run (a tick launchd started may still be writing to it, so even
`--days 0` keeps it), the outcome of the popup `state.json` has pending, however old, or a temp
file whose `<pid>` is still running. `state.json`, `state.lock` and the plist are never pruned.

A `state.json` whose fields are out of shape (an episode that is not `up`/`strike`/`down`, a
negative or fractional strike count, a string where a timestamp belongs, an interval outside
30 s to 7 days) is treated as absent, with one `errors.log` line naming the field, and the next
tick rewrites it: a poisoned file cannot hold the popup off for an outage. Unknown fields are
dropped on read. A file written before 0.2.0 is migrated on read, not rejected: its one boolean
`popupShown` becomes the daemon latch, a pending popup with no `kind` is the daemon's, and a
strike or down with no `episodeKind` is a daemon episode.

## How it fails

Both hooks run under `lib/hook-runner.mjs` and exit 0 whatever happens; a fault (stdin not
JSON, a thrown error, no answer in 4 s) is one line in
`${XDG_STATE_HOME:-~/.local/state}/ctx-watch/errors.log` and a `systemMessage`, never a deny
or block. Inside the SessionStart hook the check runs on its own 3 s clock as described above;
a slow ctx is the hook's `check timed out` line, not the runner's fail-open line and not
silence. A daemon that is down, or a semantic index that is not ready, is not a hook fault: it
is the line above, and no errors.log entry.

ctx not on PATH (or the pinned path gone), timing out, or printing something that is not the
JSON this plugin reads is a failing probe with that as the reason (never a pass by default), and
the repair is not attempted. A child that ignores the bound is killed, with its process group.
A state file that is missing, unreadable, or out of shape is "never ticked" (the last with an
errors.log line); one that cannot be written is said in `tick`'s output and ignored by the
hook. `install` refuses a relative path, an interval outside 30 s to 7 days (the range
`state.json` can hold: one shared `INTERVAL_BOUNDS`), no `ctx` on PATH, a `--ctx` that is not
an executable file, and a plist `plutil -lint` rejects (exit 1, nothing written); without
`plutil` or `launchctl` (not macOS, or a sandbox that refuses them) it says so and still writes
the plist. An option that needs a value and has none (`prune --days`, `install --interval`) is
a usage error, exit 2, before anything runs. The popup not starting or not being delivered (no
`osascript`, no GUI session, a late failure) is one line in a tick's output and a retry on the
next failing tick; the episode still advances, and the SessionStart line still fires.

The repair changes ctx state (supervision, and the config file's mode when it was unset), so
it is guarded as described above; a repair that fails is reported with ctx's own line, and the
probe after it decides. What this plugin cannot do: tell why launchd refused ctx's bootstrap on
10-28 (the system log is sandboxed off), restart a daemon in `manual` mode, or rebuild the
semantic index (ctx 2.3.0 has no verb for it; the line names `ctx semantic enable --wait`).

The Stop hook never blocks on its own fault (`evals/stop-fresh-start.scenario.json` is a Stop
with nothing to say; `evals/stop-resume-warn.scenario.json`, `evals/stop-resume-block.scenario.json`,
`evals/stop-resume-ctx-consulted.scenario.json` and `evals/stop-phrase-warn.scenario.json` the
check's four answers; `evals/session-start-semantic-not-ready.scenario.json`,
`evals/session-start-daemon-down.scenario.json` and `evals/session-start-healthy.scenario.json`
the SessionStart line's): no `transcript_path`, or a transcript it cannot read, is nothing to scan (one errors.log line when a resume marker was pending, since that
resume went unchecked); a config file it cannot use is one errors.log line and `warn`; a
resume marker it cannot remove is one errors.log line and the check still runs (it will be
read once more on the next Stop); a `checks.log` it cannot append to is one errors.log line
and the message still goes out. The one `block` it can return is the check's own verdict in
`block` mode, and `stop_hook_active: true` turns that into a warning. What the check cannot
see: a ctx call made from a subagent (`isSidechain`, or a separate transcript) does not count
for the parent, by design (the parent did not read it); an OMP session (no adapter in 0.2.0).

Known limits, documented rather than fixed:

- Stale-lock recovery is age-based (30 s): a holder suspended longer than that can be displaced, and a third writer arriving during the move-aside window can lose a fresh lock. Worst case: one duplicate popup for the same outage.
- A pending popup recorded by a pre-0.1.0 layout (`popup.json`) is not migrated; it expires and the episode reopens once.
- Consumed popup outcome files are removed only by `ctx-watch prune`; ticks do not delete them.
- The resume trigger keys on the marker's time against the transcript's `timestamp`s (an entry without one is inside the window). A clock that jumps back between SessionStart and Stop can hide a call or count an old one; the phrase trigger does not use time.

The full table is [HOW-IT-FAILS.md](HOW-IT-FAILS.md). `test/hook-contract.test.mjs` proves the
five fault inputs for both hooks; `test/session-start.test.mjs` the output contract above, the
shared clock against a ctx that hangs, and the quoted timer line; `test/probe.test.mjs` the
judgments against captured ctx 2.3.0 output (`test/fixtures/`, including the semantic rows),
the hard bound against a child that ignores SIGTERM (with a grandchild), and the deadline
arithmetic; `test/consult-history.test.mjs` the switch, the marker's round trip from
SessionStart to Stop, what counts as a ctx call and as a prompt, both triggers, the topic, and
the Stop hook's three answers in-process and spawned; `test/state.test.mjs` the episode
machine, the delivery latch (pending, confirmed, failed late, never reported) and the field
validation; `test/launchd.test.mjs` the plist (pinned arguments, PATH filtering, shell quoting,
interval bounds) and the popup with `plutil`, `launchctl` and `osascript` injected (the popup's
error, early-exit and late-exit paths on a real supervisor over children that are not
osascript); `test/retention.test.mjs` what `prune` keeps and that a dry run plans the real run;
`test/cli.test.mjs` every verb, the `--state-dir` round trip from install to tick, and a PATH
that cannot shadow `--ctx`. `e2e/live-run.sh` hands off to plugin-kit's scenario runner: the
eight `evals/*.scenario.json` prove every event × outcome in `evals/manifest.json` offline (the
SessionStart ones against `evals/fixtures/fake-ctx.sh`), and `session-start-healthy` adds a
headless `claude -p` session when `claude` is on PATH. Run the tests with `node --test` from
inside `plugins/ctx-watch/`; the scenarios with `bash e2e/live-run.sh --no-live`.

## Changes in 0.2.0

Two additions from [jo-issues #330](https://github.com/thewolff/jo-issues/issues/330):

- **The semantic index** is part of the probe: `.daemon.jobs.semantic_index` of the same
  `ctx daemon status` output, failing when semantic search is enabled and the status is not
  `ready`, with `ctx semantic enable --wait` as the fix (ctx 2.3.0 has no rebuild verb). It
  shows up where the daemon rows do: one SessionStart line and, from the timer, one popup
  episode. `ctx index mode auto` is not tried for it. The healthy fixture is recaptured
  (2026-11-04 13:00, semantic `ready`); the 03:00 capture with `budget_exhausted` is
  `test/fixtures/ctx-daemon-status-semantic-not-ready.txt`.
- **The `consult-history` Stop check**: a resume, compaction or fork (SessionStart `source`),
  or a final message that says "we spoke previously", "earlier you said" or "as discussed",
  with no `ctx search` / `show session` / `show event` call since, is one line naming
  `` `ctx search '<first six words of the prompt>'` ``. `~/.claude/ctx-watch.json`
  `{"checks": {"consult-history": "off" | "warn" | "block"}}`, default `warn`;
  `~/.claude/.ctx-watch-off` turns this check off (not the SessionStart line or the timer).
  Claude Code only; OMP is documented above.
- **One popup latch per failure kind** on the timer (daemon, semantic), so a semantic popup
  cannot hold off a daemon outage's; the semantic latch re-arms after two passing ticks in a
  row. `state.json` gains `episodeKind`, `kindStrikes` and `passStreak`; `popupShown` becomes
  `{ daemon, semantic }`, and a pre-0.2.0 file is migrated on read.

Also: `hooks/hooks.json` registers `Stop`; `evals/` (manifest, eight scenarios, the fake ctx)
and `e2e/live-run.sh` now runs them through plugin-kit's runner instead of its own `claude -p`;
`plugin.json` `state` declares `checks.log`, `resume/`, the switch file and the flag file;
`prune` rotates `checks.log` and removes stale resume markers; the SessionStart hook honours
`CTX_WATCH_CTX`; the popup's second paragraph says "run the fix" instead of "The daemon has
failed", since the fix may now be the semantic one.

## Changes in 0.1.0

First release: the probe, the `ctx index mode auto` repair, the SessionStart line with its
dead-man's switch, the launchd timer and its popup.

Changes before release, from the second review: the popup's delivery is confirmed by its
supervisor's recorded exit instead of assumed from surviving the first second, and a late
failure reopens the episode; a shared deadline that is already spent skips the spawn instead
of running ctx with no limit; `install` refuses an interval its own state file would reject,
before writing anything; `prune --days` with no value is a usage error instead of a one-day
prune; and `prune` keeps the log it just rotated and a temp file still being written, with
`--dry-run` now reporting the same plan the real run carries out.

Changes before release, from the third review: a tick records its popup claim in `state.json`
under a lock before the dialog starts, instead of after, so two ticks at once ask for one popup
and a state directory that cannot be written starts none; the hook's first-seen stamp and
`install`'s interval take the same lock, so neither can overwrite a claim; and each popup's
outcome has its own file (`popups/<token>.json`) instead of a shared `popup.json`, so an
earlier episode's dialog ending late cannot erase the current one's delivery. `prune` removes
outcome files past `--days`, never the pending one's.

Changes before release, from the fourth review: every retry of the state lock is bounded by the
same deadline (the tick's 2 s, the hook's 200 ms), with a backoff of 5 ms doubling to 50 ms
instead of an immediate retry, and a filesystem error another attempt would repeat (EACCES,
EROFS, ENOSPC) fails at once as `could not lock <path>: …` instead of spinning; the stale-lock,
pre-0.1.0 popup and outcome-file limits above are documented.
