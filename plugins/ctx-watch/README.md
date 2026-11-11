# ctx-watch

Notice when the [ctx](https://github.com/ctxrs/ctx) daemon is dead, not supervised, or stale,
or its semantic index is not ready; repair what ctx documents a command for; and say so in three
places: a line at Claude Code's SessionStart, a note to the agent mid-session when ctx goes down
or comes back, and a macOS popup from a launchd timer that runs whether or not a session is
open. And, at Stop, notice a session that picked a thread back up (a resume or a compaction, or
a reply that says "as discussed") without asking ctx what the thread was: the
`consult-history` check.

The hooks (`hooks/hooks.json`, Claude Code only):

| Event | Script | What it says |
|---|---|---|
| `SessionStart` | `hooks/session-start.mjs` | probes ctx; one line to the person, a block to the agent when ctx is down |
| `UserPromptSubmit` | `hooks/mid-session.mjs` | reads the timer's state only; tells the agent once when ctx goes down, once when it is back |
| `PostToolUseFailure` (a failed `ctx` Bash call or `mcp__ctx__*` tool) | `hooks/mid-session.mjs` | the same, at the failed call, sharing the latch |
| `Stop` | `hooks/stop.mjs` | the `consult-history` check |

Why: from 2026-10-28 to 10-31 the ctx daemon was down and nothing said so. Its launchd job had
never loaded (ctx's own `launchctl bootstrap` had failed with "Bootstrap failed: 5: Input/output
error"), so `KeepAlive` never applied; agent shells carry `CI=true`, under which ctx refuses to
start a daemon, so no agent's ctx call brought it back; and `ctx daemon status` exits 0 either
way, so a script that read the exit code saw nothing wrong.

And from 2026-11-05 to 11-11 it was down again, for a different reason: ctx 2.3.0's automatic
upgrade to 2.4.1 died between `quiescing` and `applying`, left an upgrade state that fenced out
every new daemon, and a later heal recorded a launch environment without `LANG`, which ctx then
called `environment_invalid`. ctx-watch saw it, popped once, and went quiet for six days. 0.3.0
does not heal into a live upgrade, names a stuck one, keeps raising an unanswered popup, carries
`LANG` into the timer, tells the agent as well as the person, and gives the agent a `repair`
verb that runs the sequence that worked on 2026-11-11.

And ctx dies in the middle of sessions (2026-11-04 three times in one afternoon, and 2026-11-11
between two repairs), while until 0.4.0 the agent heard about it only at SessionStart. 0.4.0
tells it at its next prompt, or at the failed ctx call, from the state the timer already keeps,
and makes `repair` test that it can load a LaunchAgent before it pauses the timer.

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

Since 0.3.0 the plist carries `LANG` and ctx's other launch-environment settings from the
installing shell (see *The timer and the popup*). A shell without `LANG` (one launchd started,
such as Claude Desktop's) gets a fallback: the `LANG` ctx itself recorded for its daemon, else
one derived from macOS's `AppleLocale`; `install` says which. **An existing install gets them
only on the next `install`** and the printed bootout-and-bootstrap line; until then a heal the
timer runs may record a daemon launch environment without `LANG`.

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
| … `.semantic_enabled === true` and `.status !== "ready"`, except the resting `budget_exhausted` below | `the ctx semantic index is not ready (.daemon.jobs.semantic_index.status = "budget_exhausted", last run "failed")`; fix `ctx semantic enable --wait` |
| … the resting `budget_exhausted` shape with `.last_run_at_ms` missing, invalid, over 2 h old, or over 60 s ahead of this clock | `semantic index budget_exhausted: last run 24h ago (semantic_index.last_run_at_ms, over 2h)`; fix `ctx semantic enable --wait` |

**The semantic rows** (0.2.0) read the same `ctx daemon status` output: no second spawn. On
2026-11-04 at 03:00 `ctx search --format json` reported `semantic_status: unavailable` and
`semantic_fallback: flat-F32 projection is missing, stale, partial, or not pinned to Core
generation …` while the daemon was healthy, and `ctx daemon status` read
`.daemon.jobs.semantic_index.status = "budget_exhausted"` at the same time
(`test/fixtures/ctx-daemon-status-semantic-budget-exhausted-0300.txt`); at 13:00 search reported `ready`
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

**`budget_exhausted` is a pass** (0.2.2) when the job also reads `runtime_active: true`, no
`last_error`, `last_run_status` `budget_exhausted` or `ready`, and its own `last_run_at_ms` is at
most 2 hours old (the Core staleness window) and at most 60 s ahead of this clock. The support for
this rule is of three kinds, and only the first is measured:

- **Observed.** Sampled every 8 s on 2026-11-04 13:22 to 13:43, the field cycled on its own,
  about 4 minutes `budget_exhausted` and about 1 minute `ready`, with no one running
  `ctx semantic enable`. In all 92 `budget_exhausted` samples `last_run_status` was
  `budget_exhausted` too (never `ready`; accepting a `ready` last run is derived, not sampled),
  `runtime_active` true, `last_error` absent, `indexed_chunks` absent in 84, and the job's own
  `last_run_at_ms` 0.3 to 22 s old. 0.2.1 failed this state and popped twice that afternoon
  (12:54 and 13:19) for an index that recovered within five minutes each time. Capture:
  `test/fixtures/ctx-daemon-status-semantic-budget-exhausted.txt` (13:39).
- **Inferred.** ctx 2.3.0's embedded JSON contract defines `budget_exhausted` for search's
  `freshness.status` ("daemon-owned bounded maintenance left backlog while search served the
  latest committed generation", listed apart from `failed`). Reading the semantic job's
  `budget_exhausted` the same way is an analogy: the contract's `daemon.jobs.semantic_index`
  section does not define it. On that reading, hybrid search answers lexically while the index
  rests, and `ctx semantic enable --wait` would only wait for the next ready window.
- **Not guaranteed.** No upstream ctx text was found that makes the semantic job's
  `budget_exhausted` safe. `runtime_active` means the query service is owned, not that
  iterations are progressing, and Core refresh runs independently, so a fresh `core_refresh`
  says nothing about the semantic job. That is why its own `last_run_at_ms` is bounded: without
  the bound a stalled indexer would pass on an old result indefinitely.

A `budget_exhausted` without those marks (a failed last run, `runtime_active: false`, a
`last_error`, no `last_run_status`) still fails, naming the last run; one with them but a
missing, invalid, future, or stale `last_run_at_ms` fails naming the age.

The supervisor check is the 10-28 failure (`install_failed`); the staleness check is a hung
daemon, which launchd's `KeepAlive` cannot see. A status that contradicts `running` (missing,
`stopped`, `stale_lock` with `running: true`) is a failing probe, not a pass by default; a stamp
from the future is a broken clock or a broken ctx, and is said rather than read as fresh.

The read-only spawns' bound is hard: a ctx that ignores the polite kill signal is killed with
SIGKILL at the bound, together with everything in its process group, so neither the hook nor
the timer can be held by a stuck child. The heal is different (below): it changes state, so it
is asked to stop first.

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

**The heal's bound** (0.3.0) is 120 s, with SIGTERM at the bound and SIGKILL only 15 s later
(`HEAL_TIMEOUT_MS`, `HEAL_GRACE_MS` in `lib/probe.mjs`; the heal runs under
`lib/bounded-run.mjs`, which signals the heal's process group, and also ends that group when the
heal exits on its own, so nothing it left in it outlives the run; ctx's daemon is not in it,
since ctx starts the daemon with `setsid()` in a session of its own). Until 0.2.2 it was 10 s, and
1.2 s inside the SessionStart hook, with SIGKILL at once. ctx 2.3.0's own daemon handoff waits
up to 75 s for installation quiescence, then up to 5 s to stop and 5 s to restart a daemon
(`daemon_autostart.rs`), so any bound under 85 s can kill `ctx index mode auto` in the middle of
ctx's own work; a SIGKILL there is the likeliest way ctx's supervisor files were left recording
a launch environment without `LANG` on 2026-11-10. 120 s covers the 85 s with room; the 15 s
grace lets ctx leave its files whole. The timer's tick can then take about 2.5 minutes in the
worst case, which a 300 s `StartInterval` absorbs (launchd does not start a second run while one
is running). The heal no longer runs in the SessionStart hook at all: the hook runner allows
4 s, which cannot hold ctx's 75 s, so the hook only reads (see below) and leaves the heal to the
timer and to `repair`.

**Upgrades** (0.3.0). Before any heal, on a failing probe, the check reads
`ctx upgrade status --format json` and ctx's upgrade handoff marker,
`<data root>/daemon/upgrade-handoff.json` (`CTX_DATA_ROOT`, else `~/.ctx`), judged the way ctx
2.3.0 judges it (`handoff_marker_state_at`: active while the phase is not `completed`/`aborted`,
the file is under 15 min old, `DAEMON_UPGRADE_HANDOFF_STALE_AFTER`, and its owner pid,
`owner_pid` or `helper_pid` by phase, is alive). While ctx hands the daemon over,
`ctx daemon status` reads `running: false` although the daemon is alive and copying files, so
`daemon.running` cannot be the gate; owner liveness is.

- **Upgrade in progress**: an active upgrade state (`staged`, `quiescing`, `applying`,
  `scheduled`, `recovering`: ctx's `is_active_upgrade_status`) under 30 min old, or a handoff
  marker ctx calls active. No heal, no strike, no popup; the tick's line is
  `wait: upgrade in progress: …`, and the SessionStart line names it with
  `fix: ctx upgrade status --format json`. Healing here is the suspected cause of the
  2026-11-05 death.
- **Stuck upgrade**: an active state 30 min old or more with no active handoff (owner dead,
  marker stale, or none). Its own finding kind, `upgrade`, with its own popup latch, and its fix
  is the sequence that worked on 2026-11-11: `ctx upgrade disable && ctx upgrade --dry-run &&
  ctx index mode auto` (without the `disable` when automatic upgrades are already off). The
  `--dry-run` step is **observed, not documented**: on 2026-11-11 it moved the state from
  `quiescing` to `dry_run`; ctx's docs do not describe it as a release. The watcher runs none of
  it; `repair` does, behind its own gates.
- **Upgrade state unknown**: `ctx upgrade status` failed, timed out, printed no `.state.status`,
  or named a state outside ctx 2.3.0's list (the five active ones plus `""`, `checking`,
  `available`, `up_to_date`, `applied`, `dry_run`, `disabled`, `error`), with no active handoff
  marker. Nothing then says that no upgrade is running, so the heal is not run: the line is the
  probe's reason plus `not healed: upgrade state unknown`, with `ctx upgrade status --format json`
  as its fix (when ctx itself cannot run, that stays the finding and its fix). It still strikes
  and pops up like the probe's failure.

**The mid-session hook** (0.4.0, `hooks/mid-session.mjs`, `lib/mid-session.mjs`). Registered on
`UserPromptSubmit` (every prompt, including a scheduled task or a background subagent reporting
back) and on `PostToolUseFailure` of a ctx call (matcher `Bash` with `if: "Bash(ctx *)"`, and
matcher `mcp__ctx__.*`; the hook checks the command again, since `if` is best-effort). It runs no
ctx and no launchctl: it reads the timer's `state.json` and the session's latch,
`<state>/sessions/<session id>.json`, and answers with `hookSpecificOutput.additionalContext`
only (the person has the popup). Measured on 2026-11-11 (Apple silicon, node 24, 40 spawns of a
healthy prompt): median 56 ms, p90 62 ms, against 27 ms for `node` running an empty file; the
hook's own read and latch take under 10 ms (`test/mid-session.test.mjs`). What it says, each once
per session per episode:

- **Down**: the timer's episode is `down` (two failing ticks in a row; one is a blip) of kind
  daemon (which includes `not healed: upgrade state unknown`) or upgrade (stuck). Two lines: what
  is down since `downSince`, the timer's last probe reason, and `/ctx-watch:repair` (or `node
  <cli> repair`). Latched on `downSince`, so a second outage in the same session is told again.
- **Back**: a session told of an outage, once a tick probe made after the telling has passed
  (or failed only on the semantic index: the daemon is back, and the line says the index is not
  ready). One line. A state file that is missing, unreadable, out of shape, reset, still
  failing, or whose last pass is from before the telling is not a recovery: the latch stays.
- **Stale**: the tick stamp (or, never ticked, the first SessionStart's) is over 15 min old, or
  three intervals, whichever is longer. One line naming the stamp, since a state the timer
  stopped writing cannot say ctx is up; while stale nothing else is said. Latched on the stamp.

Healthy, a strike, a semantic-only episode, no session id, or already told: nothing printed, and
no lock taken. The latch, `{ down, toldAt, stale }`, is claimed under its own lock
(`sessions/<session id>.json.lock`), so two hooks of one session firing at once (a prompt and a
failed ctx call) say a thing once: the second waits up to 200 ms and reads what the first wrote,
or, when the lock is still held, says nothing. The SessionStart hook writes the same latch when it
tells the agent of an outage (down, stuck, ctx missing; not a live upgrade), including one only
its own probe saw before the timer declared it, so the first prompt does not repeat it, the
timer's later `down` is adopted silently, and the recovery line still comes. A latch that cannot
be written still lets the note out, saying it may repeat. A failed ctx call is told only what the timer's
state says: the hook does not read ctx's error text (not a contract), so a call that failed while
the state is healthy and fresh says nothing, and a daemon that died since the last tick is told
at the next tick's second failure (up to ten minutes at the default interval).

**`repair`** (0.3.0) is the repair an agent can run: `node <plugin dir>/scripts/ctx-watch.mjs
repair`, no prompts, about three minutes at most. It needs a `LANG` for its ctx calls and takes
the first of: its shell's `LANG`, as given; the `LANG` ctx recorded for its daemon in
`<CTX_DATA_ROOT or ~/.ctx>/daemon/supervisor-environment.json` (read only; `supervisor.json`
holds the names, not the values); one derived from `defaults read -g AppleLocale` (`en_GB` →
`en_GB.UTF-8`). A fallback is used only when `locale -a` lists it (`en_GB.utf8` counts as
`en_GB.UTF-8`): a recorded value from another machine, or an AppleLocale pair such as `en_DE`
that has no locale, is skipped and named in the JSON's `lang.skipped`, and so is every fallback
when `locale -a` cannot be read. A Bash tool in Claude Desktop has no `LANG` of its own, since
launchd starts Desktop, so the fallback is the usual path from there.

It refuses (exit 3, no ctx change) when no usable `LANG` is found, when `launchctl` is missing or
this shell cannot load a LaunchAgent into launchd's `gui/<uid>` domain, when indexing mode is not
`auto`, during a live upgrade, while the upgrade state is unknown (as above), while any handoff
owner pid is alive, while the handoff marker is under 15 min old, when the stuck state is not
`quiescing` (the only one the release was seen to work on), or when `launchctl print` cannot say
whether the ctx-watch timer is loaded (anything but loaded, or launchctl's 113 "no such
service"). The launchd test (0.4.0) is a write, not a read: it bootstraps a throwaway LaunchAgent
(`com.jo-wolff-plugins.ctx-watch.reach-probe.<pid>.<random>`, a label of its own per run, so two
repairs at once never unload each other's; `/usr/bin/true`, never started: no `RunAtLoad`, no
interval), from a plist in a fresh temp directory, then boots it out, and removes the directory
on every path. Probes and temp directories a killed run left (its pid in the label or directory
name, and not running) are booted out and removed first; a live run's are left alone. SIGINT,
SIGTERM or SIGHUP during the probe ends the run once the probe's own cleanup has run: exit
128 + n, nothing changed, the timer untouched; the reason says the probe was unloaded only when
launchctl confirmed it, and otherwise keeps launchctl's error and names the label that may still
be loaded (it runs nothing; the next repair boots it out). A failure is the
refusal, with launchctl's own line. Until 0.4.0 the test was `launchctl print gui/<uid>`, which a
sandboxed agent shell passes while its `launchctl bootstrap` fails with `Bootstrap failed: 5:
Input/output error` (seen 2026-11-11): `repair` would have booted the timer out and failed to
put it back.
Otherwise it pauses the timer (`launchctl bootout`, so a tick cannot heal into the repair),
releases a stuck `quiescing` upgrade as above, runs the heal under its 120 s bound, polls
`ctx daemon status` until the daemon reads running, supervisor `installed` and no
`restart_required`, and restores the timer. Its first line's JSON `timer` is `{ wasLoaded,
paused, restored }`: `wasLoaded` is `true` or `false` as `launchctl print` said before the
pause, and `null` when it was not checked (a healthy daemon, or a refusal before the timer step;
until 0.4.0 these read `false` even with the timer loaded); `restored` is `null` when nothing
was paused.

The preflight is a snapshot, so the upgrade gate is read again just before each command that
changes ctx state: before `ctx upgrade disable` and `ctx upgrade --dry-run` it must still show
the same stuck `quiescing` attempt (same `attempt_id`), and before `ctx index mode auto` no
upgrade at all; a live owner, a young marker or an unknown state found there stops the run
(exit 3 when nothing had changed yet, else 1). The read and the command are not atomic: the
window is the gap between two ctx spawns. The timer is restored in a `finally`, after a refusal
found there, a failure, a step that throws, or SIGINT, SIGTERM or SIGHUP (a signal that arrives
while a ctx command runs takes effect when that bounded command returns; the exit is then
128 + the signal number). A restore that fails makes the whole run a failure (exit 1, `timer
NOT restored` and the bootstrap error), even when the daemon came back. SIGKILL cannot be
handled; after one, run `install`'s bootstrap line.

The first output line is JSON (`ok`, `changed`, `refused`, `reason`, `lang` with its `value`,
`source` (`env`, `ctx-recorded`, `AppleLocale`, or null) and `skipped`, `steps`, `timer`,
`verified`), the last a summary; exit 0 repaired or already healthy, 1 failed. The
`/ctx-watch:repair` skill runs it.

**Automatic upgrades stay off after a release.** Releasing a stuck upgrade first runs `ctx
upgrade disable`, and `repair` never turns automatic upgrades back on: turned on, ctx would try
the same upgrade that hung on 2026-11-05 again. The summary line says they are off; `ctx
upgrade enable` turns them back on, once a ctx release fixes the hang or after a manual
`ctx upgrade` has gone through. A repair with no stuck upgrade leaves the setting as it was.

**The SessionStart line.** Healthy and on time: nothing. Otherwise one or two lines in a
`systemMessage`:

```
ctx-watch: the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock"); fix: `ctx index mode auto`
ctx-watch: timer has not run since 2026-11-04T09:25:11.882Z; run `node '/Users/…/scripts/ctx-watch.mjs' install` and the printed launchctl line
```

The probe line is at most 160 characters (a long reason is cut with `…`; the fix command never
is). The timer line is as long as the plugin's installed path makes it, quoted for the shell:
a path cut to fit would not be a command. The check inside the hook (probe, then on a failure
the upgrade read) runs on one 3 s clock and never heals: each ctx spawn's budget, the smaller
of 1.2 s and what is left, is worked out once; a step whose budget is not positive is skipped
rather than run with timeout 0 (which `spawnSync` reads as no limit), and the line then reads
`ctx-watch: check timed out after 3000 ms (<what the last step said>); fix: …`, inside the
runner's 4 s. The 1.2 s bound is unchanged in 0.3.0 because both spawns are read-only
(`ctx upgrade status` answered in 0.85 s on 2026-11-11).

**The agent's context** (0.3.0). A `systemMessage` reaches the person only. When ctx is down,
stuck in an upgrade, mid-upgrade, or missing, the hook's answer also carries
`hookSpecificOutput.additionalContext`, which Claude Code adds to the session's context for the
model ([hooks reference](https://code.claude.com/docs/en/hooks), SessionStart decision
control). One short block: what is down, since when (the timer's episode start when it has
one, else this probe), and the exact command: `node '<plugin dir>/scripts/ctx-watch.mjs'
repair`, the hand-run fix, and, for a stuck upgrade, the release sequence marked
observed-not-documented. Mid-upgrade it says not to heal. Healthy, or only the semantic index
not ready (the daemon is up and the person's line covers it): no context, so a healthy session
start costs the model nothing.

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

Since 0.3.0 the plist's environment also carries, when set in the installing shell, `LANG`,
`LC_ALL`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and ctx's own settings (`CTX_DATA_ROOT`,
`CTX_DAEMON_ENABLED`, `CTX_DAEMON_MODE`, `CTX_UPGRADE_AUTO`, `CTX_UPGRADE_CHANNEL`,
`CTX_UPGRADE_INTERVAL_SECONDS`, `CTX_SEARCH_SEMANTIC`, `CTX_ANALYTICS_ENABLED`,
`CTX_LOCAL_USAGE_ENABLED`, `CTX_SEMANTIC_EMBEDDING_TOKEN_ENDPOINT`): the names in ctx 2.3.0's
supervisor environment-snapshot allowlist (`ctx daemon status --format json`
`.daemon.supervisor.environment_snapshot.allowlist`) that decide how ctx runs. A heal is where
ctx records its daemon's launch environment, and a heal from a launchd job that set only `PATH`
recorded one without `LANG`, which ctx reported as supervisor `environment_invalid` with
`restart_required` (2026-11-11). Never `CI` and never `CTX_SEMANTIC_EMBEDDING_TOKEN` (a
credential; the plist is a plain file). `HOME` is launchd's own. With no `LANG` in the
installing shell, the plist gets the same fallback `repair` uses (the `LANG` in ctx's
`supervisor-environment.json`, else one from `AppleLocale`), and `install` names where it came
from; with none of the three it writes no `LANG` and warns what that costs. `install` prints the
carried names. Existing installs get this on the next `install`.

Each `tick` rotates any log over 256 KB (see Retention), probes (and repairs) as above, then
advances an episode in `<state>/state.json`: one failing tick is a strike, the second in a row
is down and shows the popup, later failing ticks stay silent, and a passing tick closes the
episode and re-arms it. So a blip between two ticks shows nothing, a real outage shows one
dialog within ten minutes, and a second outage shows a second one. Each failure kind has its
own popup latch: *daemon* (every row the repair is tried for: ctx missing or not answering, the
daemon down, the supervisor missing, `core_refresh` stale), *semantic* (the semantic-index
rows, `healable: false`) and, since 0.3.0, *upgrade* (a stuck upgrade). A tick during a live
upgrade holds the episode where it was. A kind's popup comes after two failing ticks of
that kind in a row, so a daemon death after a semantic popup still shows its own dialog. The
daemon and upgrade latches re-arm on any pass; the daemon latch also on a semantic failure
(the daemon is up). The
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

**An unanswered popup is raised again** (0.3.0). Until 0.2.2 a dialog that gave up after its
hour with nobody clicking counted as delivered, latching its kind for the rest of the episode:
the six-day outage got one dialog. Now the supervisor records osascript's own answer (`gave
up:true` or `gave up:false` on its stdout); a delivery nobody answered (`gave up:true`, or no
answer recorded) stamps `popupUnseenAt` for its kind, and while that kind keeps failing its
latch opens again 4 h later (`POPUP_REARM_MS` in `lib/state.mjs`). Four hours, not every
tick: an outage that outlasts a meeting is raised again the same day, and someone at the desk
who did not see the first dialog is not asked every five minutes. A popup someone clicked OK
on, or dismissed, stays latched for the episode, as before.

**The CLI** (`scripts/ctx-watch.mjs`):

| Verb | What |
|---|---|
| `check [--json]` | one probe (on a failure: the upgrade gate, then repair and re-probe); the needs-you line or nothing; `--json` the whole result. Exit 0 always. |
| `tick` | the timer's run: rotate, settle a pending popup, probe, advance the episode, popup on the second failing tick (again after 4 h when unanswered). During a live upgrade: one `wait:` line, nothing else. One summary line to the launchd log. |
| `repair` | the agent-runnable repair (see *`repair`* above). Exit 0 repaired or healthy, 1 failed, 3 refused with nothing changed. |
| `install [--interval 300]` | write the plist (state directory and ctx pinned, `LANG` and ctx's settings carried; interval 30 s to 7 days), `plutil -lint` it, ask `launchctl print` whether the job is loaded, print the bootstrap line. |
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
hook's resume marker, a few bytes, consumed by the next Stop), `sessions/<session id>.json` (the
mid-session hook's latch, a few bytes, rewritten only when that session is told something), and
`launchd/` with the plist and the two logs launchd appends to. Any of the four logs over 256 KB
is renamed to `<log>.1` (replacing the last) at the start of a tick or a prune, so each is at
most 256 KB plus one run's lines and the pair at most twice that; `prune` removes a `.1`, a
popup outcome, a resume marker (a session that never reached a Stop) and a session latch older
than 30 days, and a `state.json.<pid>.tmp`, `state.lock.<pid>.stale`,
`popups/<token>.json.<pid>.tmp` or `sessions/<id>.json.<pid>.tmp` a failed write or a crashed
lock takeover left. It never removes
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
probe after it decides. It is never run during a live upgrade (owner liveness, not
`daemon.running`, decides), and the watcher never runs the stuck-upgrade release: auto-running
`ctx upgrade --dry-run` while an upgrade is genuinely live would release its state and let a
second daemon start mid-upgrade, so only `repair`, with its owner and 15 min gates, does. An
upgrade state ctx-watch cannot read or does not know, with no active marker, is no heal (fail
closed); with a known settled state and no active marker the heal runs as before 0.3.0. What
this plugin cannot do:
tell why launchd refused ctx's bootstrap on 10-28 (the system log is sandboxed off), restart a
daemon in `manual` mode, rebuild the semantic index (ctx 2.3.0 has no verb for it; the line
names `ctx semantic enable --wait`), or release a stuck upgrade in a state other than
`quiescing` (`repair` refuses it and names `ctx docs show upgrade`).

OMP sessions get none of the SessionStart output and none of the mid-session notes (0.4.0 does
not change this): ctx-watch has no OMP adapter (its hooks are Claude Code's `hooks/hooks.json`
only). The timer's popup and `repair` work the same whichever harness an agent runs in.

The Stop hook never blocks on its own fault (`evals/stop-fresh-start.scenario.json` is a Stop
with nothing to say; `evals/stop-resume-warn.scenario.json`, `evals/stop-resume-block.scenario.json`,
`evals/stop-resume-ctx-consulted.scenario.json` and `evals/stop-phrase-warn.scenario.json` the
check's four answers; `evals/session-start-semantic-budget-exhausted.scenario.json`,
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
arithmetic; `test/upgrade.test.mjs` the 0.3.0 behaviours (a live upgrade skips the heal, a
stuck one is its own finding, the heal's bound and SIGTERM grace, `LANG` in the plist, the 4 h
re-arm, and the agent's context present when down and absent when healthy);
`test/repair.test.mjs` every gate and step of `repair` against a stateful fake ctx and a fake
launchctl (0.4.0: the reach probe refusing in the sandbox case, before the timer is touched, and
its plist removed on every path); `test/mid-session.test.mjs` the mid-session hook (once per
session per episode, the recovery line, the stale line, silence when healthy, the latch shared
with SessionStart and PostToolUseFailure, prune, and spawned: no ctx or launchctl run, timed);
`test/consult-history.test.mjs` the switch, the marker's round trip from
SessionStart to Stop, what counts as a ctx call and as a prompt, both triggers, the topic, and
the Stop hook's three answers in-process and spawned; `test/state.test.mjs` the episode
machine, the delivery latch (pending, confirmed, failed late, never reported) and the field
validation; `test/launchd.test.mjs` the plist (pinned arguments, PATH filtering, shell quoting,
interval bounds) and the popup with `plutil`, `launchctl` and `osascript` injected (the popup's
error, early-exit and late-exit paths on a real supervisor over children that are not
osascript); `test/retention.test.mjs` what `prune` keeps and that a dry run plans the real run;
`test/cli.test.mjs` every verb, the `--state-dir` round trip from install to tick, and a PATH
that cannot shadow `--ctx`. `e2e/live-run.sh` hands off to plugin-kit's scenario runner: the
fifteen `evals/*.scenario.json` prove every event × outcome in `evals/manifest.json` offline (the
SessionStart ones against `evals/fixtures/fake-ctx.sh`, the mid-session ones against a
`state.json` written by `evals/fixtures/write-state.mjs`), and `session-start-healthy` adds a
headless `claude -p` session when `claude` is on PATH. Run the tests with `node --test` from
inside `plugins/ctx-watch/`; the scenarios with `bash e2e/live-run.sh --no-live`. The ctx
captures in `test/fixtures/` are re-made by hand with `bash test/fixtures/capture.sh` (needs ctx
on PATH; it only reads the real install, works on a throwaway data root it prints, and is not
part of `node --test`); `ctx-daemon-status-semantic-not-ready.txt` is a one-off capture it does
not remake. `ctx-upgrade-status.txt` is the 2026-11-11 `ctx upgrade status --format json`
(state `dry_run`, after the release); the tests derive `quiescing` and `applying` from it,
since no capture of a live upgrade exists that did not break a real install.

## Changes in 0.4.0

From ctx dying in the middle of sessions (see *Why* at the top):

- **The agent is told mid-session.** `hooks/mid-session.mjs` on `UserPromptSubmit` and on
  `PostToolUseFailure` of a ctx call reads the timer's `state.json` (no ctx, no launchctl) and
  tells the agent once per session per episode when ctx is down or its upgrade stuck or unknown,
  once when it is back, and once when the timer has not stamped the state in over 15 min. See
  *The mid-session hook*. Latches live in `sessions/<session id>.json`, pruned after 30 days.
- **`repair` tests launchd write access.** Before pausing the timer it bootstraps and boots out
  a throwaway LaunchAgent with a label of its own per run; a shell that cannot (a sandbox:
  `Bootstrap failed: 5: Input/output error`) is refused with exit 3 and nothing changed. Until
  0.4.0 `launchctl print gui/<uid>` passed there, and repair would have booted the timer out and
  failed to restore it. A killed run's probe is cleared by the next; a signal during the probe
  ends the run after the probe unloads itself.
- The SessionStart hook writes the mid-session latch when it tells the agent about an outage,
  including one the timer has not declared yet.
- The recovery line needs a tick probe after the telling that passed: a missing, broken or reset
  state is not a recovery. The latch is claimed under a per-session lock, so concurrent hooks of
  one session say a thing once.
- `repair`'s JSON `timer.wasLoaded` is `null` (not checked) on the healthy return and on a
  refusal before the timer step; it read `false` there, even with the timer loaded.

## Changes in 0.3.0

From the 2026-11-05 to 11-11 outage (see *Why* at the top):

- **A live upgrade is not healed.** On a failing probe the check reads `ctx upgrade status` and
  ctx's upgrade handoff marker first; during an upgrade (or while a handoff owner is alive) it
  skips the heal, strikes nothing, and says `upgrade in progress`. An upgrade state it cannot
  read or does not know is no heal either (`not healed: upgrade state unknown`).
- **A stuck upgrade is its own finding** (`upgrade` kind, own popup latch) naming the release
  sequence `ctx upgrade disable && ctx upgrade --dry-run && ctx index mode auto`, marked
  observed-not-documented. The watcher runs none of it.
- **`repair`**, a new verb and the `/ctx-watch:repair` skill: the 2026-11-11 hand-run sequence,
  non-interactive, behind gates (owner dead, marker over 15 min old, upgrade state known, a
  `LANG` found, `gui/<uid>` reachable, mode `auto`, the timer's state known), re-read before
  every state change, pausing the timer and restoring it in a `finally` (signals included),
  verifying before it says repaired. With no `LANG` in its shell (Claude Desktop's tools) it
  uses the `LANG` ctx recorded, else one from `AppleLocale`, each only if `locale -a` lists it.
  After releasing a stuck upgrade it leaves automatic upgrades off.
- **The heal's bound** is 120 s with a 15 s SIGTERM grace (was 10 s, SIGKILL), and the
  SessionStart hook no longer heals (it had 1.2 s).
- **`install` carries `LANG`** and ctx's other launch-environment settings into the plist, with
  the same `LANG` fallback as `repair`. Existing installs get them on the next `install` and its
  bootout-and-bootstrap line.
- **An unanswered popup is raised again** 4 h later while its kind still fails (was: once per
  episode, a give-up counting as seen).
- **The agent is told.** SessionStart adds `hookSpecificOutput.additionalContext` when ctx is
  down, stuck, mid-upgrade or missing; nothing when healthy.
- `state.json` gains `popupUnseenAt` and the `upgrade` latch; files from 0.2.x read as before.

## Changes in 0.2.2

A semantic index at `budget_exhausted` is a pass when the job also reads `runtime_active: true`,
no `last_error`, `last_run_status` `budget_exhausted` or `ready`, and a `last_run_at_ms` at most
2 hours old and at most 60 s ahead: the built-in-throttled indexer between budgeted runs (see
*The semantic rows* above for what was observed, what is inferred, and what ctx does not
guarantee). 0.2.1 failed it and popped twice on 2026-11-04 (12:54 and 13:19) for an index that
came back to `ready` within five minutes each time. A `budget_exhausted` without those marks
still fails, and its line now names the last run (`…status = "budget_exhausted", last run
"failed"`) or its age (`semantic index budget_exhausted: last run 24h ago …`). The 03:00 capture is
renamed `ctx-daemon-status-semantic-budget-exhausted-0300.txt`, a 13:39 capture is added, and
the SessionStart scenario for it is now `session-start-semantic-budget-exhausted` (silent).

## Changes in 0.2.1

`lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.2.1's). The handler thread's
env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, a process group
the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits, and the runner
waits for stdout to drain before it exits (bounded by the same deadline), so an answer larger
than one 64 KiB pipe buffer is no longer cut short. ctx-watch's
hooks register none, so every hook answers as before, under the same 4 s deadline.

## Changes in 0.2.0

Two additions from [jo-issues #330](https://github.com/thewolff/jo-issues/issues/330):

- **The semantic index** is part of the probe: `.daemon.jobs.semantic_index` of the same
  `ctx daemon status` output, failing when semantic search is enabled and the status is not
  `ready`, with `ctx semantic enable --wait` as the fix (ctx 2.3.0 has no rebuild verb). It
  shows up where the daemon rows do: one SessionStart line and, from the timer, one popup
  episode. `ctx index mode auto` is not tried for it. The healthy fixture is recaptured
  (2026-11-04 13:00, semantic `ready`); the 03:00 capture with `budget_exhausted` is
  `test/fixtures/ctx-daemon-status-semantic-budget-exhausted-0300.txt` (named
  `ctx-daemon-status-semantic-not-ready.txt` until 0.2.2, which passes it).
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
