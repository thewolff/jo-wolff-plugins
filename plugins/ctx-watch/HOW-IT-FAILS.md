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
| a shared deadline: each spawn gets the smaller of its bound and what is left; a step with nothing left is skipped | a failing result past the deadline says `check timed out after N ms (…)`; a pass is a pass however slow | `test/probe.test.mjs` |

Not exercised: the repair against a real managed ctx install (it would mean killing the running
daemon). The claim that `ctx index mode auto` repairs supervision is ctx's storage doc; what was
measured is a throwaway data root (see README).

## The timer, the state and the popup (`lib/state.mjs`, `lib/launchd.mjs`, `lib/popup.mjs`, `lib/retention.mjs`, `scripts/ctx-watch.mjs`)

| Condition | Result | Proof |
|---|---|---|
| `install` with a relative path, an interval under 30 s, no `ctx` on PATH, a `--ctx` that is not an executable file, or a plist `plutil` rejects | exit 1, nothing else written | `test/launchd.test.mjs`, `test/cli.test.mjs` |
| `install` from a shell whose PATH has `.` or relative entries | they are dropped from the plist's PATH and never searched for `ctx` | `test/launchd.test.mjs` |
| `install` from a shell with `XDG_STATE_HOME` set; launchd runs the tick without it | the plist's `--state-dir` is the resolved directory; the tick stamps the file the hook reads | `test/cli.test.mjs` (install, then tick under a different HOME) |
| a `ctx` placed earlier on PATH after install | the plist's `--ctx` is the absolute path pinned at install; the shadow is never run | `test/cli.test.mjs` (spawned, two fake ctx on PATH) |
| `plutil` or `launchctl` missing or refused (not macOS, a sandbox) | said in the output; the plist is still written; `loaded` is `null`, not `false` | `test/launchd.test.mjs` |
| printed commands with a path containing spaces or shell metacharacters | one shell word each (`shellQuote`); the plist itself carries the path unquoted | `test/launchd.test.mjs` |
| a failing tick, then another | strike, then down with the popup; later failing ticks silent; a pass re-arms | `test/state.test.mjs`, `test/cli.test.mjs` |
| the popup cannot start (`osascript` missing, the spawn errors, the child dies inside a second: no GUI session) | `popup not shown: …` in the tick's line; `popupFailedAt` and the reason in the state; the latch stays open and the next failing tick tries again | `test/launchd.test.mjs` (a spawn double, and real children that are not osascript), `test/state.test.mjs`, `test/cli.test.mjs` |
| the state file cannot be written by `tick` | said in the tick's output; exit 0; the temp file is removed | `test/cli.test.mjs`, `test/state.test.mjs` |
| a state file with a field out of shape (`strikes: -100`, `popupShown: "yes"`, …) | treated as absent with one errors.log line; the next failing tick is strike 1 | `test/state.test.mjs` |
| a log over 256 KB | renamed to `<log>.1` at the start of a tick or a prune (launchd opens a fresh one next run) | `test/cli.test.mjs` |
| `prune` | rotated logs older than `--days` (30) and stray `state.json.<pid>.tmp` removed; `state.json` and the plist never; `--dry-run` names and removes nothing | `test/cli.test.mjs` |
| the tick itself throws (a bug) | the stack goes to the launchd error log, exit 1; the next tick runs on schedule | not exercised beyond the catch in `scripts/ctx-watch.mjs` |
| a plugin update moves the script the plist names | the timer's runs fail (launchd's log); the hook's dead-man's line says so within two intervals | the dead-man's rule in `test/session-start.test.mjs`; the launchd side not exercised |

Not exercised: a real `launchctl bootstrap` (the sandbox cannot, and the person runs it); a real
`osascript` dialog (never opened by a test); log rotation racing a tick that launchd is still
writing (the renamed file keeps that tick's lines; the next run opens a fresh one).
