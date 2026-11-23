# Changelog

All notable changes to ctx-watch are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The 0.1.0 release is described under
*Changes in 0.1.0* in [README.md](README.md#changes-in-010).

## [0.4.5] - 2026-11-21

### Changed

- A failing tick whose status call timed out while the ctx daemon's pid runs and its query
  socket did not accept (an *unresponsive* daemon) asks for its popup on the third such tick in
  a row (`UNRESPONSIVE_STRIKES_TO_POPUP`), not the second. It still strikes and goes down on the
  second tick. On 2026-11-20 two such ticks, at 2:01 and 2:08 PM PST, popped up, and the socket
  accepted again at 2:13 PM. A dead daemon (pid not running, supervisor missing, any other
  daemon failure) keeps the second-tick popup, its unresponsive ticks counted among the daemon's
  strikes; any tick that is not unresponsive (a pass, slow, a live upgrade, another failure)
  zeroes the count.
- `daemonAlive` adds `running: true` to its answer when the pid runs and the socket did not
  accept. `state.json` gains `unresponsiveStrikes` (a file without it reads 0), and
  `lastProbe.kind` can be `"unresponsive"` (its `episodeKind` stays `"daemon"`). `status` shows
  `unresponsive N in a row`.

## [0.4.4] - 2026-11-19

### Changed

- The `consult-history` Stop check names `ctx search --refresh off '<topic>'` (bare:
  `ctx search --refresh off`) in its warn line, its `block` reason and `checks.log`; the skill's
  step 6, README and HOW-IT-FAILS say the same. `--refresh off` reads the existing index and
  never starts, wakes or recovers the daemon. On 2026-11-19 a default-mode `ctx search` (refresh
  `background`) booted out a healthy ctx daemon. Any `ctx search` still counts as consulting
  history.

## [0.4.3] - 2026-11-16

The timer's launchd job did not come back after the 2026-11-12 reboot, and nothing said so for
four days. Its plist lived in `${XDG_STATE_HOME:-~/.local/state}/ctx-watch/launchd/`, and launchd
reloads a person's agents at login only from `~/Library/LaunchAgents`.

### Changed

- `install` writes the plist to `$HOME/Library/LaunchAgents/com.jo-wolff-plugins.ctx-watch.plist`
  and the printed bootstrap line names that path. The logs stay in `<state>/launchd/`. `install`
  refuses (exit 1, nothing written) when `HOME` is unset or not absolute.
- A plist at the old `<state>/launchd/` path is removed only after `plutil -lint` ran and
  passed on the new one, and `install` says so. Without plutil the old file is kept and install
  says the move is not finished; a failed lint keeps it too.
- The printed command follows `launchctl print`, not whether this run moved a file: loaded,
  `launchctl bootout gui/<uid>/<label> && launchctl bootstrap gui/<uid> <new path>`; not
  loaded, the bootstrap alone; no answer, the same pair joined by `;`, on every install.
- `install` refuses, writing nothing, when `~/Library` or `~/Library/LaunchAgents` is a
  symlink, not yours, or writable by group or others, or when an existing plist is a symlink or
  not yours (`writeAgentPlist`). The plist goes to an exclusive temporary file and is renamed
  into place, 0644 whatever the umask.
- `install` refuses node, the CLI or ctx unless every entry on the way to it is owned by you or
  root: the path is walked from / with `lstat`, so each symlink met (the last one included) is
  itself checked and then followed. Every directory walked through must let no one else replace
  its entries: writable by every user only when sticky (`/tmp`), by its group only when sticky
  or the group is wheel or admin; the file must be writable by no one else
  (`untrustedReason`). A symlink someone else owns in `/tmp` pointing at a trusted node is
  refused (Codex, review round 2: a `stat`-based check followed it and passed). The path is
  resolved as the kernel resolves it: a link's raw target is never normalized, and `..` is the
  parent of the directory actually reached, so `/tmp/attacker-link/../good` checks the
  attacker's link and where it leads, not `/tmp/good` (Codex, review round 3).
- `uninstall` prints the `rm` of the plist as well as the bootout: a plist left in
  LaunchAgents is loaded again at the next login.
- `repair` restores a timer it paused from the plist `launchctl print` said the job came from,
  when that file still exists, else from the LaunchAgents one. Its unused `stateDir` option is
  gone.
- `status` says when launchd loaded the job from a plist other than the LaunchAgents one.

### Added

- The SessionStart hook checks the timer when a plist is installed at either path: one
  `launchctl print gui/<uid>/<label>` (`launchd.loaded`, which now also returns the job's
  `plist` and `args`), bounded at 500 ms and by what is left of the hook's 3 s clock.
  launchctl's 113 gives `ctx-watch: timer not in launchd gui/<uid>; fix: …`; a loaded job whose
  script no longer exists (a plugin update removed its versioned directory) gives `ctx-watch:
  timer's script no longer exists; fix: …`. The fix names `node <cli> install` and the
  launchctl line it prints, whole when it fits in 160 characters, else the verb, with the whole
  command in the agent's context. A timeout, a refusal, or launchctl missing says nothing.
  When this line fires, the dead-man's line is not repeated.
- `runCheck(bin, args, { timeoutMs })`: the bound is an option; the default stays 10 s.
- `launchd.loaded` reads a multi-word state (`state = not running`) whole.

## [0.4.2] - 2026-11-12

### Changed

- README, Install: an OMP install block, and what runs there: the skill, the CLI and the timer;
  none of the hooks, because ctx-watch ships no OMP extension. Docs only; no code changed.
- The description, the same in `plugin.json`, `package.json`, both marketplace catalogs and the
  repository README, says which notices are Claude Code only: the macOS popup and repair work on
  both hosts, the session-start and mid-session notes and the resume warning only on Claude
  Code. The OMP catalog had fallen behind the others, and the shared wording promised hooks OMP
  never runs.

## [0.4.1] - 2026-11-12

On 2026-11-12 three 0.4.0 timer ticks failed as "ctx could not run" while the ctx daemon was
running, so the "slow, not down" path did not engage. The liveness check had answered "not
alive", and its reason was dropped, so the log could not say which of its checks failed.

### Changed

- A timed-out status call whose liveness check says "not alive" carries that answer as
  `liveness` (`{ alive, pid, detail }`) on the result, and the tick's line ends its reason with
  `; not slow: <detail>`, naming the failed check: the endpoint file unreadable or without a pid,
  a path that is not ctx's socket, the pid not running, the connect's error code (`ENOENT`,
  `ECONNREFUSED`), or `no connection within <ms> ms`. When a heal ran, the line's top level is
  the re-probe, so the miss that led to the heal is logged as `| first probe not slow: <detail>`
  whatever the re-probe answered (a pass included), and a re-probe that misses too says
  `; re-probe not slow: <detail>`. The SessionStart line, `check` and the state file are
  unchanged.
- The liveness check's bound (`ALIVE_TIMEOUT_MS`) is 10 s, up from 2 s: the likelier cause of the
  three misses is the connecting node child not starting within 2 s on a loaded machine. A dead
  daemon still answers at once (no socket file: `ENOENT`; a socket no one listens on: refused).
  The SessionStart hook still caps it by what is left of its 3 s clock (at most 1.8 s). The
  configured bounds of the timer's check (status, liveness, upgrade read, indexing-mode read,
  heal with its grace, status and liveness again) add up to 195 s, up from 179 s, or 200 s with
  the heal wrapper's 5 s backstop, under the 300 s interval. They bound each step; the timer's
  check has no deadline over all of them.

## [0.4.0] - 2026-11-11

ctx dies in the middle of sessions (2026-11-04 three times in one afternoon, 2026-11-11 between
two repairs), and until now the agent heard about it only at SessionStart.

### Added

- `hooks/mid-session.mjs` on `UserPromptSubmit`, and on `PostToolUseFailure` of a ctx call
  (`Bash` with `if: "Bash(ctx *)"`, and `mcp__ctx__.*`). It spawns nothing: it reads the timer's
  `state.json` and a per-session latch, `sessions/<session id>.json`, and adds
  `additionalContext` once per session per episode: ctx down (daemon, stuck upgrade, or upgrade
  state unknown) since when, with `/ctx-watch:repair`; ctx back (one line), only once a tick
  probe after the telling passed (a missing, broken or reset state is not a recovery); the timer's state
  over 15 min old, so not trusted (one line). Healthy: no output. Measured median 56 ms per
  healthy prompt, 27 ms of it node's own start.
- The latch is claimed under `sessions/<session id>.json.lock`, so a prompt and a failed ctx
  call firing at once in one session say a thing once; a held lock means silence.
- `prune` removes session latches and their lock files older than `--days`; `plugin.json`
  `state` declares `sessions/`.
- Seven eval scenarios for the two new events (`evals/prompt-*`, `evals/failed-*`), with
  `evals/fixtures/write-state.mjs` writing the timer's state from the run's clock.

### Changed

- `repair`'s launchd gate is a write: it bootstraps and boots out a throwaway LaunchAgent
  (`com.jo-wolff-plugins.ctx-watch.reach-probe.<pid>.<random>`, unique per run, `/usr/bin/true`,
  never started; its plist in a temp directory removed on every path) before pausing the timer,
  and refuses (exit 3, nothing changed, launchctl's line) if it cannot. `launchctl print
  gui/<uid>`, the 0.3.0 gate, passes in a sandboxed shell whose bootstrap fails with `Bootstrap
  failed: 5: Input/output error`, so repair would have booted the timer out and failed to
  restore it. Probes and temp directories of runs whose pid is dead are cleared first; a live
  run's are left alone. SIGINT, SIGTERM or SIGHUP during the probe ends the run once the probe's
  own cleanup has run (exit 128 + n, nothing changed); the reason claims an unload only when
  launchctl confirmed it, else keeps launchctl's error and names the label left loaded.
- The SessionStart hook records in the session's latch every outage it tells the agent of
  (down, stuck, ctx missing; not a live upgrade), even one the timer has not declared, so the
  first prompt does not repeat it and the recovery line still comes.

### Fixed

- `repair`'s JSON `timer.wasLoaded` is `null` (not checked) on the healthy return and on a
  refusal before the timer step; it read `false` there, even with the timer loaded.
- A slow ctx is no longer told as down. On 2026-11-11 (22:44-23:06Z, load average 78-183) the
  `ctx daemon status` call missed its 10 s twice while the daemon ran throughout, and two "ctx is
  down" popups were false. A status call that times out now asks whether the daemon's process
  is alive, without running ctx: the pid in `<data root>/daemon/query-endpoint.json` is running
  and the query socket that file names accepts a connection (a dead daemon's leftover socket
  refuses; the check does not prove the pid owns the listener, and a slow run is bounded).
  Alive: the tick logs `slow: …`, with no strike, no popup, no heal and no upgrade read; the
  SessionStart hook says nothing; the mid-session hook says one quiet line once the timer has
  seen it slow for 15 min ("ctx is answering slowly …; ctx searches may time out"), never
  "down" or a repair. Not alive: a failure, as before. A slow run that lasts 30 min
  (`SLOW_MAX_MS`) counts as down, since a hung daemon still accepts on its socket. `state.json`
  gains `slowSince`, and `lastProbe.kind` (what that probe itself found: a failure kind, `slow`
  or `upgrading`); the session latch gains `slow`. A slow or live-upgrade tick is never read as
  the daemon's recovery (it holds the episode's old kind). The endpoint's socket path must be
  one ctx 2.3.0 binds (`<data root>/daemon/query.sock`, or `ctx-q-<32 hex>/q.sock` under `/tmp`
  or `TMPDIR`, at most 90 bytes, transport `unix`); any other is not alive and never connected
  to, and the path reaches the connecting child in its environment, not its argv.

## [0.3.0] - 2026-11-11

From the 2026-11-05 to 11-11 outage: ctx 2.3.0's automatic upgrade died between `quiescing`
and `applying`, left a state that fenced out every new daemon, and a later heal recorded a
launch environment without `LANG`. ctx-watch popped once and went quiet for six days.

### Added

- The upgrade gate: on a failing probe, `ctx upgrade status --format json` and ctx's handoff
  marker (`<data root>/daemon/upgrade-handoff.json`, judged as ctx 2.3.0 does) are read before
  any heal. During a live upgrade (active state under 30 min old, or an active handoff) there
  is no heal, no strike and no popup; the line says `upgrade in progress`. An upgrade state
  that cannot be read (`ctx upgrade status` failing, timing out, or naming a state outside
  ctx 2.3.0's list) with no active marker is no heal either: `not healed: upgrade state
  unknown`.
- A stuck upgrade (active state 30 min or more, no active handoff) is a finding of its own
  kind, `upgrade`, with its own popup latch and the release sequence `ctx upgrade disable &&
  ctx upgrade --dry-run && ctx index mode auto` as its fix, marked observed-not-documented.
- `ctx-watch repair` and the `/ctx-watch:repair` skill: the 2026-11-11 hand-run repair,
  non-interactive. With no `LANG` in its shell (a Claude Desktop tool, which launchd started)
  it passes ctx the `LANG` ctx recorded in `supervisor-environment.json`, else one derived from
  `defaults read -g AppleLocale`, each only if `locale -a` lists it, and reports which in its
  JSON `lang.source` (and what it skipped in `lang.skipped`). Refuses (exit 3) when no usable
  `LANG` is found, without `launchctl` or a reachable `gui/<uid>`, with mode not `auto`, during
  a live upgrade or an unknown upgrade state, while a handoff owner is alive or its marker is
  under 15 min old, for a stuck state other than `quiescing`, or when `launchctl` cannot say
  whether the timer is loaded. Otherwise pauses the timer, releases, heals, verifies, and
  restores the timer in a `finally` (after a throw and on SIGINT/SIGTERM/SIGHUP too, exiting
  128 + n); the upgrade gate is read again before each state change, and a release needs the
  same stuck attempt. A timer it cannot restore makes the run a failure. After a release it
  leaves automatic upgrades off.
- SessionStart adds `hookSpecificOutput.additionalContext` for the agent when ctx is down,
  stuck, mid-upgrade or missing: what, since when, the exact command. Nothing when healthy or
  when only the semantic index is not ready.
- `install` carries `LANG`, `LC_ALL`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and ctx's
  `CTX_*` settings (never `CI`, never `CTX_SEMANTIC_EMBEDDING_TOKEN`) into the plist. With no
  `LANG` in the installing shell it uses the same fallback as `repair` and says where the value
  came from; with none found it warns. Existing installs get them on the next `install`.

### Changed

- The heal's bound is 120 s with SIGTERM and a 15 s grace before SIGKILL (`lib/bounded-run.mjs`),
  was 10 s with SIGKILL: ctx's own handoff waits up to 75 s for quiescence plus 5 s stop and
  5 s restart. `bounded-run` also ends the heal's process group when the heal exits on its own.
- `launchd.loaded()` reads only launchctl's 113 as "not loaded"; any other failure is unknown
  (`loaded: null`), not "not loaded".
- The SessionStart hook no longer heals (it had 1.2 s against ctx's 75 s); the timer and
  `repair` do.
- A popup that gave up with nobody answering re-arms after 4 h (`POPUP_REARM_MS`) while its kind
  still fails; one clicked or dismissed stays latched for the episode. The supervisor records
  osascript's `gave up:` answer (`gaveUp` in the outcome file).
- `state.json` gains `popupUnseenAt` and an `upgrade` latch in `popupShown`; 0.2.x files read as
  before.

## [0.2.2] - 2026-11-04

### Fixed

- `.daemon.jobs.semantic_index.status = "budget_exhausted"` is a pass when the job also reads
  `runtime_active: true`, no `last_error`, `last_run_status` `budget_exhausted` or `ready`, and
  a `last_run_at_ms` at most 2 h old (the Core staleness window) and at most 60 s ahead of this
  clock: the built-in-throttled indexer between budgeted runs. Observed: sampled every 8 s on
  2026-11-04 from 13:22 to 13:43, it cycled on its own (about 4 min `budget_exhausted`, about
  1 min `ready`); in all 92 `budget_exhausted` samples `last_run_status` read `budget_exhausted`
  (so a `ready` last run cannot be the healthy mark; accepting `ready` is derived, not sampled)
  and the job's own last run was 0.3 to 22 s old. 0.2.1 failed this state and showed two false
  popups on 2026-11-04 (12:54 and 13:19 PST), each for an index back to `ready` within five
  minutes with no one running `ctx semantic enable`. Inferred, not guaranteed: ctx's embedded
  JSON contract defines `budget_exhausted` ("bounded maintenance left backlog while search
  served the latest committed generation") for search's `freshness.status`, not for the
  semantic job; reading the semantic field that way is an analogy, and no upstream text
  guarantees the semantic job's `budget_exhausted` is healthy.
- A `budget_exhausted` without those marks still fails, and the reason names the last run:
  `the ctx semantic index is not ready (.daemon.jobs.semantic_index.status = "budget_exhausted", last run "failed")`.
- The resting shape with a missing, invalid, future, or stale semantic `last_run_at_ms` fails
  naming the age: `semantic index budget_exhausted: last run 24h ago (semantic_index.last_run_at_ms, over 2h)`.
  `runtime_active` means the query service is owned, not that iterations progress, and Core
  refresh runs independently, so without this bound a stalled indexer passed indefinitely on an
  old result (Codex review round 1).

### Changed

- `test/fixtures/ctx-daemon-status-semantic-not-ready.txt` is renamed
  `ctx-daemon-status-semantic-budget-exhausted-0300.txt` (it is the resting shape, now a pass);
  `ctx-daemon-status-semantic-budget-exhausted.txt` is a new 13:39 capture.
  `evals/session-start-semantic-not-ready.scenario.json` is now
  `evals/session-start-semantic-budget-exhausted.scenario.json` and expects silence; the semantic
  failure line is covered by `test/probe.test.mjs` and `test/cli.test.mjs`.

## [0.2.1] - 2026-11-04

### Changed

- `lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.2.1's): the handler thread's
  env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, a process group
  the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits, and it now
  waits for stdout to drain before it exits, bounded by the same deadline, so an
  answer larger than one 64 KiB pipe buffer is no longer cut short (a host that never reads gets
  exit 0 at the deadline and one `stdout not drained` errors.log line). ctx-watch's
  hooks register none, so what they answer is unchanged; the 4 s deadline is unchanged.

## [0.2.0] - 2026-11-04

Both from [jo-issues #330](https://github.com/thewolff/jo-issues/issues/330).

### Added

- The semantic index is part of the probe. `.daemon.jobs.semantic_index` of the same
  `ctx daemon status --format json` output (no second spawn: `ctx semantic status` took 2.8 to
  9 s and `ctx search` 2.9 s against 0.15 s) fails when `semantic_enabled` is true and `status`
  is not `ready`, naming the field and ctx's `reason`; the fix is `ctx semantic enable --wait`
  (ctx 2.3.0 has no rebuild verb; `enable` on an enabled index re-pins the projection). A
  missing block fails naming `ctx semantic status`. Semantic search not enabled is a pass. The
  failure takes the same two surfaces as the daemon rows: one SessionStart line, one popup
  episode from the timer, under its own latch (below). `ctx index mode auto` is not tried for
  it (`healable: false`), and `check` says so in `healed.detail`.
- One popup latch per failure kind on the timer: `daemon` and `semantic`. A daemon death after
  a semantic popup shows its own popup (on the second daemon tick in a row); the daemon latch
  re-arms on any tick where the daemon is up, the semantic latch only after two passing ticks in
  a row (`STRIKES_TO_DOWN`), so a semantic status that is `ready` for one tick between not-ready
  runs shows one popup. `state.json` gains `episodeKind`, `kindStrikes` and `passStreak`;
  `popupShown` becomes `{ daemon, semantic }`; a pending popup carries its `kind`. A file from
  before 0.2.0 is migrated on read (the boolean latch, a kindless pending popup and a strike or
  down are the daemon's). `status` shows the kind: `episode: down [daemon] (…)`.
- The `consult-history` Stop check (`hooks/stop.mjs`, `lib/consult-history.mjs`), a
  deterministic transcript scan. Resume trigger: the first Stop after a SessionStart with
  `source` `resume`, `compact` or `fork` (the SessionStart hook leaves
  `<state>/resume/<session_id>` holding the time it started, before its probe; the Stop hook
  consumes it once) when no entry since is a ctx history call
  (`mcp__ctx__search`, `mcp__ctx__show_session`, `mcp__ctx__show_event`, the single-underscore
  shape, or `ctx search` / `ctx show session` / `ctx show event` through Bash). Phrase
  trigger: the final message says "we spoke previously", "earlier you said" or "as discussed"
  and this turn made no such call. One line:
  `` ctx-watch: resumed without consulting history — `ctx search '<first six words of the prompt>'` ``;
  a window with no prompt takes the last prompt before the marker, and a transcript with none
  gets a bare `ctx search` and says so. A prompt is what the person typed: an entry whose
  `origin.kind` is not `human` (a subagent's `<task-notification>`, a peer's message) and, with
  no `origin`, text led by a tag other than a slash command's `<command-…>` are not prompts, so
  a notification neither ends the turn (a ctx call before it still counts) nor becomes the topic.
  Switch: `~/.claude/ctx-watch.json` `{"checks": {"consult-history": "off" | "warn" | "block"}}`,
  default `warn` (a `systemMessage` and a `checks.log` line); `block` returns
  `{ decision: "block", reason }` naming the command and the way out, and warns instead when
  `stop_hook_active` is true; `~/.claude/.ctx-watch-off` turns this check off (the SessionStart
  line and the timer do not read it). Claude Code only: OMP does
  not read `hooks/hooks.json` and this plugin ships no adapter (what one would need is in the
  README).
- `evals/manifest.json` and eight scenarios (three SessionStart against
  `evals/fixtures/fake-ctx.sh`, five Stop); `e2e/live-run.sh` hands off to plugin-kit's
  scenario runner instead of running its own `claude -p`.
- The SessionStart hook honours `CTX_WATCH_CTX` (an absolute path to spawn instead of `ctx`
  from PATH), for the evals sandbox.
- `test/fixtures/ctx-daemon-status-semantic-not-ready.txt`: the 2026-11-04 03:00 capture
  (`budget_exhausted`, taken while `ctx search` reported `semantic_status: unavailable`). The
  healthy fixture is recaptured at 13:00 (semantic `ready`).

### Changed

- `plugin.json` `state` declares `checks.log` and `resume/` (pruned at 30 days) and the switch
  and flag files (kept by design). `prune` rotates `checks.log` with the other logs and removes
  resume markers older than `--days` (a session that never reached a Stop).
- The popup's second paragraph says "Open a Terminal and run the fix" instead of "The daemon
  has failed", since the fix may be the semantic one.
- The healthy summary line ends with `semantic index ready` or `semantic search not enabled`.
