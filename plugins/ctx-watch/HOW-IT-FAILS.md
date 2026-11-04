# How ctx-watch fails

Every row is a case the tests exercise, or one named here as not exercised. Neither hook blocks
on its own fault: the worst case is silence plus one errors.log line. The one block the Stop
hook returns is the consult-history verdict in `block` mode, and that mode is yours to set.

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
| `source` is `resume`, `compact` or `fork` | `<state>/resume/<session_id>` is written holding the time the hook started, before its probe (a prompt typed during the up-to-3 s probe is inside the window), for the Stop hook; `startup` and `clear` write nothing | `test/consult-history.test.mjs`, `evals/session-start-healthy.scenario.json` |
| the resume marker cannot be written (`resume` is a file, the directory is read-only) | one errors.log line naming the session; no message line; the Stop check has nothing to consume | `test/consult-history.test.mjs` |
| `~/.claude/.ctx-watch-off` exists | not read here: the probe line, the timer line and the resume marker are unchanged (the flag is the Stop check's switch) | `test/consult-history.test.mjs` |
| `CTX_WATCH_CTX` set | that path is spawned instead of `ctx` from PATH (the evals' fake ctx) | `evals/session-start-*.scenario.json` |

## The Stop hook: `consult-history` (`hooks/stop.mjs`, `lib/consult-history.mjs`, under `lib/hook-runner.mjs`)

| Input or condition | What happens | Proof |
|---|---|---|
| stdin empty, not JSON, or not an object; the handler throws; no answer in 4 s | exit 0, never a block; one errors.log line (and a systemMessage naming the fault for the last two) | `test/hook-contract.test.mjs` |
| `~/.claude/.ctx-watch-off` exists | nothing; the resume marker is still consumed | `test/consult-history.test.mjs` |
| `~/.claude/ctx-watch.json` `checks.consult-history` is `off` | nothing; the marker is still consumed | `test/consult-history.test.mjs` |
| the config file is not JSON, `checks` is not an object, or the mode is not `off`/`warn`/`block` | one errors.log line naming the file and the field; the check runs as `warn` | `test/consult-history.test.mjs` |
| a resume marker for this `session_id` and no ctx history call since its time | `warn`: `{ systemMessage: "ctx-watch: resumed without consulting history — `ctx search '<six words>'`" }`, one `checks.log` line; `block`: `{ decision: "block", reason }` naming the command and the way out | `test/consult-history.test.mjs` (in-process and spawned), `evals/stop-resume-warn.scenario.json`, `evals/stop-resume-block.scenario.json` |
| the same, but `stop_hook_active: true` in `block` mode | warns, never blocks twice | `test/consult-history.test.mjs` |
| a ctx history call since the marker (`mcp__ctx__search`, `mcp__ctx__show_session`, `mcp__ctx__show_event`, the single-underscore shape, or `ctx search` / `ctx show session` / `ctx show event` through Bash) | nothing; the marker is consumed | `test/consult-history.test.mjs`, `evals/stop-resume-ctx-consulted.scenario.json` |
| a ctx call before the marker's time, or in a `isSidechain: true` entry | does not count | `test/consult-history.test.mjs` |
| no marker (a fresh session, or a second Stop after the resume) and no phrase | nothing, nothing written | `test/consult-history.test.mjs`, `evals/stop-fresh-start.scenario.json` |
| the final message says "we spoke previously", "earlier you said" or "as discussed" and this turn made no ctx call | `said "as discussed" without consulting history — `ctx search '<this turn's prompt, six words>'`` in the same shapes as above | `test/consult-history.test.mjs`, `evals/stop-phrase-warn.scenario.json` |
| the resume window holds no prompt (a mid-turn compaction, a prompt stamped before the marker) | the topic is the last prompt before the marker; with no prompt anywhere, a bare `` `ctx search` `` and the line says the transcript has no prompt to take a topic from (`block`: add the thread's subject) | `test/consult-history.test.mjs` |
| both pending (a resume and a phrase) | one finding, the resume's | `test/consult-history.test.mjs` |
| `last_assistant_message` in the payload (OMP seats, some hosts) | it is the final message; the transcript's last assistant text otherwise | `test/consult-history.test.mjs` |
| no `transcript_path`, or a file that cannot be read | nothing to scan: no finding; one errors.log line when a marker was pending (that resume went unchecked) | `test/consult-history.test.mjs` |
| a torn line, a non-object line, an entry without `timestamp` | skipped; skipped; inside every window | `test/consult-history.test.mjs` |
| no `session_id` | no marker is read; the phrase trigger still runs | `test/consult-history.test.mjs` |
| the marker cannot be removed | one errors.log line; the check still runs; the marker is read again on the next Stop | not exercised beyond the branch |
| `checks.log` cannot be appended | one errors.log line; the message still goes out | not exercised beyond the branch |
| an OMP session | the hook is not run (no adapter in 0.2.0; OMP does not read hooks.json) | by construction |

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
| `.daemon.jobs.semantic_index` missing | fail naming the field; fix `ctx semantic status`; not healable (no `ctx index mode auto`) | `test/probe.test.mjs` |
| `.daemon.jobs.semantic_index.semantic_enabled === true` and `.status !== "ready"` (`budget_exhausted`, `pending`, `failed`, missing, …) | fail naming the field and ctx's `reason` when it gives one; fix `ctx semantic enable --wait`; not healable: `check` runs no `ctx index mode` spawn and says why in `healed.detail` | `test/probe.test.mjs` (the 2026-11-04 03:00 capture), `evals/session-start-semantic-not-ready.scenario.json` |
| `semantic_enabled` not `true` | pass, `semantic search not enabled` in the summary | `test/probe.test.mjs` |
| the daemon down and the semantic index not ready | one line, the daemon's; the heal runs | `test/probe.test.mjs` |
| repair: indexing mode not `auto`, or ctx's config file missing | `not attempted: …`; the first probe stands | `test/probe.test.mjs` |
| repair: `ctx index mode auto` fails (CI, or anything else) | `attempted, ok: false` with ctx's line; the second probe decides | `test/probe.test.mjs` (captured CI refusal) |
| a shared deadline: each spawn's budget (the smaller of its bound and what is left) is computed once; a budget that is not positive skips the spawn, never runs it with timeout 0 | `budgetExhausted: true`; a failing result past the deadline says `check timed out after N ms (…)` (`deadlineMs: 0` spawns nothing: `no time left to probe ctx`); `runCtx` itself refuses a non-positive timeout; a pass is a pass however slow | `test/probe.test.mjs` |

Not exercised: the repair against a real managed ctx install (it would mean killing the running
daemon). The claim that `ctx index mode auto` repairs supervision is ctx's storage doc; what was
measured is a throwaway data root (see README). `ctx semantic enable --wait` is never run by
this plugin; that it re-pins an already-enabled index was measured once on a throwaway root.

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
| the semantic index fails and its popup is shown, then the daemon dies | the daemon has its own latch: its popup comes on the second daemon tick in a row (each kind has `popupShown.<kind>`; a semantic failure means the daemon is up and re-arms the daemon latch) | `test/state.test.mjs`, `test/cli.test.mjs` (the review's P4 shape through `main(["tick"])`) |
| the semantic status flips: not ready, `ready` for one tick, not ready again | one popup: the semantic latch re-arms only after two passing ticks in a row (`STRIKES_TO_DOWN`) | `test/state.test.mjs` |
| a popup of one kind is pending when the other kind is due | no second dialog meanwhile; the other kind's popup comes on the first failing tick after the pending one settles | `test/state.test.mjs` |
| a `state.json` from before 0.2.0 (one boolean `popupShown`, a pending popup with no `kind`, no `episodeKind`) | migrated on read, no errors.log line: the boolean is the daemon latch, the pending popup and a strike or down are the daemon's | `test/state.test.mjs` |
| the popup cannot start (`osascript` missing, the spawn errors, the child dies inside a second: no GUI session) | `popup not shown: …` in the tick's line; `popupFailedAt` and the reason in the state; the latch stays open and the next failing tick tries again | `test/launchd.test.mjs` (a spawn double, and a real supervisor over children that are not osascript), `test/state.test.mjs`, `test/cli.test.mjs` |
| the popup outlives the grace, then osascript fails (exit 7) | pending, never latched; the detached supervisor records the exit in its token's `popups/<token>.json`; the next tick says `popup not delivered: … after the grace`, reopens the episode and pops again; no second dialog while pending | `test/cli.test.mjs` (a fake osascript that exits 7 after the grace), `test/launchd.test.mjs`, `test/state.test.mjs` |
| the popup outlives the grace and exits 0 (OK, or the give-up), or the person dismisses it (-128) | latched by the next tick from its token's `popups/<token>.json` | `test/launchd.test.mjs` (fake osascript exiting 0), `test/state.test.mjs` |
| an earlier episode's popup ends after the current one has (its dialog was still up when a pass re-armed) | it writes its own token's file; the current popup's outcome is untouched and the next tick latches it | `test/cli.test.mjs`, `test/launchd.test.mjs` (two real supervisors, two files) |
| two ticks at once (a manual tick beside launchd's) both reach the popup | the first records its claim in `state.json` under `state.lock` before the dialog starts; the second, locked after it, sees the claim and asks for nothing; the first applies its result to the state as the second left it | `test/cli.test.mjs` (two `main()` calls, the first paused inside its popup) |
| the popup's claim cannot be recorded (the directory turned read-only, the state write fails, another holder keeps `state.lock` past 2 s) | no dialog starts; the tick says `state not written to <state.json>: …` naming the lock or the write that failed, `; popup not started: …` when one was due; exit 0; every later tick the same until it can write | `test/cli.test.mjs`, `test/state.test.mjs` |
| a writer died holding `state.lock` (its pid is gone, or the lock is older than 30 s) | the next writer takes it over (set aside, checked, removed); a fresh lock a live process holds is waited for | `test/state.test.mjs` |
| the lock cannot be read, set aside or removed for a reason another attempt would repeat (EACCES, EROFS, ENOSPC, …), or it keeps changing under every attempt (another writer moves it each time) | a persistent error fails at once as `could not lock <state.lock>: <error>`; churn retries with a backoff of 5 ms doubling to 50 ms and stops at the same deadline as a busy lock (`still contended after <ms> ms`): the tick's 2 s, the hook's 200 ms. The tick says `state not written to <state.json>: …`, the hook its one stamp warning line | `test/state.test.mjs` (injected EACCES on the read and on the stale rename, ENOENT at every rename; both budgets, elapsed and attempts asserted) |
| the supervisor dies without recording (killed with the login session), or the tick dies between its claim and the dialog | after the give-up plus 10 min the pending popup is `popup not confirmed: …` and the episode reopens | `test/state.test.mjs` |
| the state file cannot be written by `tick` | said in the tick's output; exit 0; the temp file is removed | `test/cli.test.mjs`, `test/state.test.mjs` |
| a state file with a field out of shape (`strikes: -100`, `popupShown: "yes"`, …) | treated as absent with one errors.log line; the next failing tick is strike 1 | `test/state.test.mjs` |
| a log over 256 KB | renamed to `<log>.1` at the start of a tick or a prune (launchd opens a fresh one next run) | `test/cli.test.mjs` |
| `prune` | rotated logs (now four: `checks.log` too), popup outcomes (`popups/<token>.json`) and resume markers (`resume/<id>`) older than `--days` (30), and stray `state.json.<pid>.tmp` / `state.lock.<pid>.stale` / `popups/<token>.json.<pid>.tmp` removed; never a `.1` rotated by the same prune (even `--days 0`), the outcome of the popup `state.json` has pending, a temp file whose pid is running, `state.json`, `state.lock` or the plist; `--dry-run` removes nothing and reports the same plan as the real run | `test/retention.test.mjs`, `test/cli.test.mjs` |
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

Known limits (documented, not fixed):

- Stale-lock recovery is age-based (30 s): a holder suspended longer than that can be displaced, and a third writer arriving during the move-aside window can lose a fresh lock. Worst case: one duplicate popup for the same outage.
- A pending popup recorded by a pre-0.1.0 layout (`popup.json`) is not migrated; it expires and the episode reopens once.
- Consumed popup outcome files are removed only by `ctx-watch prune`; ticks do not delete them.
- The resume trigger keys on the marker's time against the transcript's `timestamp`s (an entry without one is inside the window). A clock that jumps back between SessionStart and Stop can hide a call or count an old one; the phrase trigger does not use time.
- A ctx call made by a subagent (its own transcript, or `isSidechain: true` in the parent's) does not count for the parent: the parent did not read it.
