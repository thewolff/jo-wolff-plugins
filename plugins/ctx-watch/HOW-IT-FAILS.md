# How ctx-watch fails

Every row is a case the tests exercise, or one named here as not exercised. The hook never
blocks: its worst case is silence plus one errors.log line.

## The SessionStart hook (`hooks/session-start.mjs`, under `lib/hook-runner.mjs`)

| Input or condition | What happens | Proof |
|---|---|---|
| stdin empty, not JSON, or not an object | exit 0, no stdout, one `errors.log` line naming the fault | `test/hook-contract.test.mjs` |
| the handler throws | exit 0, `{ systemMessage: "ctx-watch SessionStart failed: …" }`, one errors.log line | `test/hook-contract.test.mjs` |
| the handler does not answer in 4 s | exit 0, systemMessage naming the deadline, one errors.log line; the worker thread is killed | `test/hook-contract.test.mjs` |
| the check's own 3 s clock runs out (ctx hangs on any of its up-to-four spawns) | one line `ctx-watch: check timed out after 3000 ms (…); fix: …`, inside the runner's 4 s; the state stamp still lands; no errors.log line | `test/session-start.test.mjs` (in-process arithmetic, and a spawned hook against a fake ctx that sleeps) |
| the state file cannot be read | treated as never ticked; nothing logged | `test/state.test.mjs` |
| the state file is not JSON, not an object, or has a field out of shape | treated as never ticked; one errors.log line naming the file and the field; the next write replaces it | `test/state.test.mjs`, `test/session-start.test.mjs` |
| the state directory cannot be written (first-seen stamp) | the probe line still comes; a second line `ctx-watch: state not written to <file>: …`; one errors.log line | `test/session-start.test.mjs` |
| the timer line's path is long (an installed plugin's path) or has spaces | the line runs past 160 characters rather than cut the command; the path is shell-quoted | `test/session-start.test.mjs` |

## The probe (`lib/probe.mjs`)

| Condition | Result | Proof |
|---|---|---|
| ctx not on PATH | fail: `ctx could not run: ctx is not on PATH`; fix `ctx docs show getting-started`; repair not attempted | `test/probe.test.mjs`, `test/session-start.test.mjs` (spawned, empty PATH) |
| the pinned `--ctx` path no longer exists | fail: `ctx could not run: <path> does not exist (pinned at install; run install again)`; never falls back to PATH | `test/probe.test.mjs`, `test/cli.test.mjs` |
| ctx does not answer in the bound (10 s; 1.2 s in the hook) | fail naming the bound; the child gets SIGKILL and so does its process group | `test/probe.test.mjs` (a child that ignores SIGTERM, with a grandchild) |
| output not JSON, or no `.daemon` | fail with the exit code and the first output line | `test/probe.test.mjs` |
| `.daemon.running !== true` or `.daemon.status !== "running"` (missing, `stopped`, `stale_lock`) | fail naming both fields | `test/probe.test.mjs` (captured `stale_lock`; the healthy capture with `status` edited) |
| `.daemon.supervisor.status !== "installed"` | fail naming the field | `test/probe.test.mjs` (healthy capture, field edited to `install_failed`) |
| `.daemon.jobs.core_refresh.last_run_at_ms` missing | fail naming the field | `test/probe.test.mjs` |
| … not whole epoch milliseconds a Date can hold (negative, fractional, a string, past 8.64e15) | fail naming the field and the value; never a throw | `test/probe.test.mjs` |
| … more than 5 min ahead of this clock | fail: `core_refresh in the future (…)` | `test/probe.test.mjs` |
| … over 2 h old | fail naming the age | `test/probe.test.mjs` (by moving `now`, and by editing the field) |
| repair: indexing mode not `auto`, or ctx's config file missing | `not attempted: …`; the first probe stands | `test/probe.test.mjs` |
| repair: `ctx index mode auto` fails (CI, or anything else) | `attempted, ok: false` with ctx's line; the second probe decides | `test/probe.test.mjs` (captured CI refusal) |
| a shared deadline: each spawn's budget (the smaller of its bound and what is left) is computed once; a budget that is not positive skips the spawn, never runs it with timeout 0 | `budgetExhausted: true`; a failing result past the deadline says `check timed out after N ms (…)` (`deadlineMs: 0` spawns nothing: `no time left to probe ctx`); `runCtx` itself refuses a non-positive timeout; a pass is a pass however slow | `test/probe.test.mjs` |

Not exercised: the repair against a real managed ctx install (it would mean killing the running
daemon). The claim that `ctx index mode auto` repairs supervision is ctx's storage doc; what was
measured is a throwaway data root (see README).

## The timer, the state and the popup (`lib/state.mjs`, `lib/launchd.mjs`, `lib/popup.mjs`, `lib/popup-supervisor.mjs`, `lib/retention.mjs`, `scripts/ctx-watch.mjs`)

| Condition | Result | Proof |
|---|---|---|
| `install` with a relative path, an interval outside 30..604800 s (`INTERVAL_BOUNDS`, shared with the state reader), no `ctx` on PATH, a `--ctx` that is not an executable file, or a plist `plutil` rejects | exit 1; an interval or path refusal writes nothing at all (no directory, plist or state) | `test/launchd.test.mjs`, `test/cli.test.mjs` |
| an option that needs a value given none (`prune --days`, `install --interval`, `--state-dir`, `--ctx`) | usage, exit 2, before anything runs (never a one-day prune) | `test/cli.test.mjs` |
| `install` from a shell whose PATH has `.` or relative entries | they are dropped from the plist's PATH and never searched for `ctx` | `test/launchd.test.mjs` |
| `install` from a shell with `XDG_STATE_HOME` set; launchd runs the tick without it | the plist's `--state-dir` is the resolved directory; the tick stamps the file the hook reads | `test/cli.test.mjs` (install, then tick under a different HOME) |
| a `ctx` placed earlier on PATH after install | the plist's `--ctx` is the absolute path pinned at install; the shadow is never run | `test/cli.test.mjs` (spawned, two fake ctx on PATH) |
| `plutil` or `launchctl` missing or refused (not macOS, a sandbox) | said in the output; the plist is still written; `loaded` is `null`, not `false` | `test/launchd.test.mjs` |
| printed commands with a path containing spaces or shell metacharacters | one shell word each (`shellQuote`); the plist itself carries the path unquoted | `test/launchd.test.mjs` |
| a failing tick, then another | strike, then down with the popup; later failing ticks silent; a pass re-arms | `test/state.test.mjs`, `test/cli.test.mjs` |
| the popup cannot start (`osascript` missing, the spawn errors, the child dies inside a second: no GUI session) | `popup not shown: …` in the tick's line; `popupFailedAt` and the reason in the state; the latch stays open and the next failing tick tries again | `test/launchd.test.mjs` (a spawn double, and a real supervisor over children that are not osascript), `test/state.test.mjs`, `test/cli.test.mjs` |
| the popup outlives the grace, then osascript fails (exit 7) | pending, never latched; the detached supervisor records the exit in its token's `popups/<token>.json`; the next tick says `popup not delivered: … after the grace`, reopens the episode and pops again; no second dialog while pending | `test/cli.test.mjs` (a fake osascript that exits 7 after the grace), `test/launchd.test.mjs`, `test/state.test.mjs` |
| the popup outlives the grace and exits 0 (OK, or the give-up), or the person dismisses it (-128) | latched by the next tick from its token's `popups/<token>.json` | `test/launchd.test.mjs` (fake osascript exiting 0), `test/state.test.mjs` |
| an earlier episode's popup ends after the current one has (its dialog was still up when a pass re-armed) | it writes its own token's file; the current popup's outcome is untouched and the next tick latches it | `test/cli.test.mjs`, `test/launchd.test.mjs` (two real supervisors, two files) |
| two ticks at once (a manual tick beside launchd's) both reach the popup | the first records its claim in `state.json` under `state.lock` before the dialog starts; the second, locked after it, sees the claim and asks for nothing; the first applies its result to the state as the second left it | `test/cli.test.mjs` (two `main()` calls, the first paused inside its popup) |
| the popup's claim cannot be recorded (the directory turned read-only, the state write fails, another holder keeps `state.lock` past 2 s) | no dialog starts; the tick says `state not written to <state.json>: …` naming the lock or the write that failed, `; popup not started: …` when one was due; exit 0; every later tick the same until it can write | `test/cli.test.mjs`, `test/state.test.mjs` |
| a writer died holding `state.lock` (its pid is gone, or the lock is older than 30 s) | the next writer takes it over (set aside, checked, removed); a fresh lock a live process holds is waited for | `test/state.test.mjs` |
| the supervisor dies without recording (killed with the login session), or the tick dies between its claim and the dialog | after the give-up plus 10 min the pending popup is `popup not confirmed: …` and the episode reopens | `test/state.test.mjs` |
| the state file cannot be written by `tick` | said in the tick's output; exit 0; the temp file is removed | `test/cli.test.mjs`, `test/state.test.mjs` |
| a state file with a field out of shape (`strikes: -100`, `popupShown: "yes"`, …) | treated as absent with one errors.log line; the next failing tick is strike 1 | `test/state.test.mjs` |
| a log over 256 KB | renamed to `<log>.1` at the start of a tick or a prune (launchd opens a fresh one next run) | `test/cli.test.mjs` |
| `prune` | rotated logs and popup outcomes (`popups/<token>.json`) older than `--days` (30), and stray `state.json.<pid>.tmp` / `state.lock.<pid>.stale` / `popups/<token>.json.<pid>.tmp` removed; never a `.1` rotated by the same prune (even `--days 0`), the outcome of the popup `state.json` has pending, a temp file whose pid is running, `state.json`, `state.lock` or the plist; `--dry-run` removes nothing and reports the same plan as the real run | `test/retention.test.mjs`, `test/cli.test.mjs` |
| the tick itself throws (a bug) | the stack goes to the launchd error log, exit 1; the next tick runs on schedule | not exercised beyond the catch in `scripts/ctx-watch.mjs` |
| a plugin update moves the script the plist names | the timer's runs fail (launchd's log); the hook's dead-man's line says so within two intervals | the dead-man's rule in `test/session-start.test.mjs`; the launchd side not exercised |

Not exercised: a real `launchctl bootstrap` (the sandbox cannot, and the person runs it); a real
`osascript` dialog (never opened by a test), so how long a real GUI failure takes is unmeasured,
and the supervisor's reading of osascript's `(-128)` "User canceled" stderr is untested against
a real dialog (the latch it feeds is tested);
the supervisor surviving launchd's end of the tick job (it is spawned detached, in its own
process group, as osascript was before); log rotation racing a tick that launchd is still
writing when the rotation came from an earlier run (the renamed file keeps that tick's lines;
the next run opens a fresh one).
