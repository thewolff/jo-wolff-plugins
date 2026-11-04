# ctx-watch

Notice when the [ctx](https://github.com/ctxrs/ctx) daemon is dead, not supervised, or stale;
repair it with the one command ctx documents for that; and say so in two places: a line at
Claude Code's SessionStart and a macOS popup from a launchd timer that runs whether or not a
session is open.

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
re-probe) runs on one 3 s clock: each ctx spawn gets the smaller of 1.2 s and what is left, a
step with no time left is skipped, and the line then reads `ctx-watch: check timed out after
3000 ms (<what the last step said>); fix: …`, inside the runner's 4 s.

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
dialog within ten minutes, and a second outage shows a second one. The popup is one
`/usr/bin/osascript -e 'display dialog …'`, spawned detached so the ticks keep running while
it is up, giving up after an hour. It counts as shown only when osascript started and was still
running a second later; one that could not start (no osascript, no GUI session, it died at
once) is `popup not shown: …` in the tick's line, recorded in the state (`popupFailedAt`, the
reason), and tried again on the next failing tick, so an outage that began while nobody was
logged in still gets its dialog.

**The CLI** (`scripts/ctx-watch.mjs`):

| Verb | What |
|---|---|
| `check [--json]` | one probe (repair and re-probe on failure); the needs-you line or nothing; `--json` the whole result. Exit 0 always. |
| `tick` | the timer's run: rotate, probe, advance the episode, popup on the second failing tick. One summary line to the launchd log. |
| `install [--interval 300]` | write the plist (state directory and ctx pinned), `plutil -lint` it, ask `launchctl print` whether the job is loaded, print the bootstrap line. |
| `uninstall` | print the `launchctl bootout` line. Removes nothing. |
| `status` | the last probe, the episode (with the last popup, shown or not), the plist path, whether launchd has the job. |
| `prune [--days 30] [--dry-run]` | rotate the logs; remove rotated logs older than `--days` and stray state temp files; `pruned: N file(s), B bytes freed` last. |

Every verb takes `--state-dir <dir>` and `--ctx <executable>`; the plist passes both.

## Retention

Everything the plugin writes is under `${XDG_STATE_HOME:-~/.local/state}/ctx-watch`, declared
in `.claude-plugin/plugin.json` `state` with `prune` as its command (the nightly canary runs
it): `state.json` (one small file, rewritten each tick; its temp file is removed if a write
fails), `errors.log` (one line per hook fault or ignored state file), and `launchd/` with the
plist and the two logs launchd appends to. Any of the three logs over 256 KB is renamed to
`<log>.1` (replacing the last) at the start of a tick or a prune, so each is at most 256 KB plus
one run's lines and the pair at most twice that; `prune` removes a `.1` older than 30 days.
`state.json` and the plist are never pruned.

A `state.json` whose fields are out of shape (an episode that is not `up`/`strike`/`down`, a
negative or fractional strike count, a string where a timestamp belongs, an interval under 30 s)
is treated as absent, with one `errors.log` line naming the field, and the next tick rewrites
it: a poisoned file cannot hold the popup off for an outage. Unknown fields are dropped on read.

## How it fails

The hook runs under `lib/hook-runner.mjs` and exits 0 whatever happens; a fault (stdin not JSON,
a thrown error, no answer in 4 s) is one line in `${XDG_STATE_HOME:-~/.local/state}/ctx-watch/errors.log`
and a `systemMessage`, never a deny or block: this hook only talks. Inside the hook the check
runs on its own 3 s clock as described above; a slow ctx is the hook's `check timed out` line,
not the runner's fail-open line and not silence. A daemon that is down is not a hook fault: it
is the line above, and no errors.log entry.

ctx not on PATH (or the pinned path gone), timing out, or printing something that is not the
JSON this plugin reads is a failing probe with that as the reason (never a pass by default), and
the repair is not attempted. A child that ignores the bound is killed, with its process group.
A state file that is missing, unreadable, or out of shape is "never ticked" (the last with an
errors.log line); one that cannot be written is said in `tick`'s output and ignored by the
hook. `install` refuses a relative path, an interval under 30 s, no `ctx` on PATH, a `--ctx`
that is not an executable file, and a plist `plutil -lint` rejects (exit 1, nothing else
written); without `plutil` or `launchctl` (not macOS, or a sandbox that refuses them) it says
so and still writes the plist. The popup not starting (no `osascript`, no GUI session) is one
line in the tick's output and a retry on the next failing tick; the episode still advances,
and the SessionStart line still fires.

The repair changes ctx state (supervision, and the config file's mode when it was unset), so
it is guarded as described above; a repair that fails is reported with ctx's own line, and the
probe after it decides. What this plugin cannot do: tell why launchd refused ctx's bootstrap on
10-28 (the system log is sandboxed off), or restart a daemon in `manual` mode.

The full table is [HOW-IT-FAILS.md](HOW-IT-FAILS.md). `test/hook-contract.test.mjs` proves the
five fault inputs; `test/session-start.test.mjs` the output contract above, the shared clock
against a ctx that hangs, and the quoted timer line; `test/probe.test.mjs` the judgments
against captured ctx 2.3.0 output (`test/fixtures/`), the hard bound against a child that
ignores SIGTERM (with a grandchild), and the deadline arithmetic; `test/state.test.mjs` the
episode machine, the delivery latch and the field validation; `test/launchd.test.mjs` the plist
(pinned arguments, PATH filtering, shell quoting) and the popup with `plutil`, `launchctl` and
`osascript` injected (the popup's error paths on real children that are not osascript);
`test/cli.test.mjs` every verb, the `--state-dir` round trip from install to tick, and a PATH
that cannot shadow `--ctx`. `e2e/live-run.sh` is the nightly canary's live run. Run them with
`node --test` from inside `plugins/ctx-watch/`.

## Changes in 0.1.0

First release: the probe, the `ctx index mode auto` repair, the SessionStart line with its
dead-man's switch, the launchd timer and its popup.
