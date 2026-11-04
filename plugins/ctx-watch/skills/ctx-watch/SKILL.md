---
name: ctx-watch
description: Check, repair, or install the watch on the ctx daemon when a session says "ctx-watch:", the person asks whether ctx is up, ctx search fails or falls back to lexical, or a Stop said "resumed without consulting history"; not for ctx searches themselves.
---

# ctx-watch

The ctx daemon keeps the local agent-history index fresh. It has died quietly before (its
launchd job had not loaded, and agent shells carry `CI=true`, under which ctx refuses to start
one). This plugin's `check` says whether it is running, supervised, fresh, and its semantic
index ready, and repairs what ctx documents a command for; `install` sets up the launchd timer
that watches it between sessions; the Stop hook's `consult-history` check says when a resumed
session never asked ctx about the thread. Use this skill when a SessionStart line begins
`ctx-watch:`, when the person asks whether ctx is running, when a ctx search reports a stale or
unavailable daemon or `semantic_status: unavailable`, or when a Stop line says `resumed without
consulting history`.

## Steps

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx-watch.mjs" check --json`. Read `ok`, `reason`,
   `fix`, and `healed.detail`. `ok: true` means running, supervised, and refreshed within 2 h;
   say so in one line and stop.
2. If `ok` is false and `healed.attempted` is true, the repair was tried from this shell. Tell
   the person the reason and what the repair reported, then ask them to run the `fix` command in
   their own Terminal: agent shells carry `CI=true`, and ctx's line for that is `ctx daemon start
   was suppressed (ci)`. Do not retry from here.
3. If `healed.detail` begins `not attempted`, say why (indexing mode `manual`, ctx not set up
   under this HOME, or `the daemon is running; \`ctx index mode auto\` does not touch the
   semantic index`) and leave the decision to the person; `ctx index mode auto` turns the daemon
   on, `ctx setup` creates an installation, and `ctx semantic enable --wait` (the `fix` of a
   `the ctx semantic index is not ready` reason) starts model indexing and waits for `ready`.
   The semantic fix is never run by the plugin and should not be run from here: it can take
   minutes and the person's own Terminal shows its progress. Until it is ready, `ctx search`
   still answers, lexically (`semantic_status: unavailable` in its JSON): say so instead of
   calling history unavailable.
4. If the line was `ctx-watch: timer has not run since …`, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx-watch.mjs" install` and hand the person the printed
   `launchctl bootstrap gui/<uid> <plist>` line to run from a GUI login Terminal. Never run
   `launchctl bootstrap` yourself; the timer belongs to their login session.
5. `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx-watch.mjs" status` shows the last tick, the episode
   (`up`, `strike`, `down`, with the last popup shown, pending, or not shown), the plist path, and whether
   launchd has the job, for a report. `prune` (same script) rotates the logs under
   `${XDG_STATE_HOME:-~/.local/state}/ctx-watch` and removes rotated ones older than 30 days;
   the nightly canary runs it, so it is rarely needed by hand.
6. If a Stop printed `ctx-watch: resumed without consulting history — \`ctx search '<topic>'\``
   (or `said "as discussed" …`), the session picked a thread up without reading what ctx holds
   on it. Run that `ctx search` (or the ctx MCP `search`) now and read the hits before going on;
   the topic is the first six words of the prompt and may want sharpening. In `block` mode the
   Stop was refused with the same command in the reason; running it clears the next Stop. The
   mode is `~/.claude/ctx-watch.json` `{"checks": {"consult-history": "off" | "warn" | "block"}}`
   (default `warn`); `touch ~/.claude/.ctx-watch-off` turns the whole plugin off. Change neither
   without the person's say-so.

## When this can't run

- `check` printed `ctx-watch: ctx could not run: ctx is not on PATH; fix: …`: ctx is not
  installed where this shell looks. Tell the person; `ctx docs show getting-started` is the
  install doc once ctx exists, and the plugin cannot do more without it.
- `check` printed `ctx-watch: ctx could not run: <path> does not exist (pinned at install; …)`:
  the ctx the timer was installed with has moved. Run step 4's `install` again (it pins the
  ctx now on PATH, or `--ctx <path>`) and hand over the printed bootout-and-bootstrap line.
- `check` printed `ctx-watch: check timed out after 3000 ms (…)` or `… did not answer in N s`:
  ctx is hung or very slow; the daemon's state is unknown, not healthy. Tell the person and
  ask them to run `ctx daemon status --format json` in their own Terminal.
- `check` printed `core_refresh in the future` or `invalid .daemon.jobs.core_refresh.last_run_at_ms`:
  the clock or ctx's stamp is wrong. Show the value from `check --json` and do not call it
  healthy.
- `check` printed `ctx-watch: … printed no JSON …`: ctx answered in a shape this plugin does not
  read (a newer ctx, or an error). Show the person the first line of ctx's output from
  `check --json` and do not call it healthy.
- `install` printed `plutil not found` or `launchctl not found` / `launchctl could not run`: not
  macOS, or a sandbox refused them. The plist was still written; tell the person to run
  `install` again from a normal Terminal, or to lint and bootstrap the printed path by hand.
- `install` exited 1 (`interval must be …` (30 to 604800 s), `no executable \`ctx\` on PATH`, `--ctx … is not an
  executable file`, `plutil -lint failed`): say the line; a lint failure is a bug in this
  plugin, so give the person the plist path to attach to an issue.
- `tick` printed `popup not shown: …` or `popup not delivered: …`: the dialog could not open
  or failed after it started (no GUI session, no `osascript`); it is tried again on the next
  failing tick. Nothing to do unless it repeats while the person is logged in, then tell them
  the reason. `status` saying `popup up since …, not confirmed yet` is a dialog that may still
  be on screen; it is not a failure.
- `status` or `tick` printed `state not written to <path>`: the state directory or its lock is
  not writable (`could not lock …: EACCES`), or (`… state.lock is held by pid <n>`, or `still
  contended after <ms> ms`) another tick was writing it. Tell the person
  the path; the probe and the line still work without it, but no popup starts until the state
  can be written.
- `check` printed `ctx-watch: the ctx semantic index is not ready (…); fix: \`ctx semantic enable --wait\``
  (`evals/session-start-semantic-not-ready.scenario.json` is that line at SessionStart):
  the daemon is up but hybrid search is lexical only. Hand the person the fix for their own
  Terminal (step 3); do not run it from here. `ctx semantic status --format json` shows the
  reason in detail if they ask.
- `check` printed `ctx-watch: \`ctx daemon status --format json\` has no .daemon.jobs.semantic_index; fix: \`ctx semantic status\``:
  a ctx whose status output this plugin does not read (older or newer than 2.3.0). Tell the
  person to run `ctx semantic status` by hand and open an issue naming the ctx version.
- The command printed `ctx-watch SessionStart failed open: <why>` or `ctx-watch Stop failed
  open: <why>`: the hook let the session go on without its check; the line is also in
  `${XDG_STATE_HOME:-~/.local/state}/ctx-watch/errors.log`. Tell the person once, and run step 1
  (or, for Stop, the `ctx search` of step 6 with the prompt's words) by hand.
- A Stop line fired on a resume (`evals/stop-resume-warn.scenario.json`; the block form is
  `evals/stop-resume-block.scenario.json`; a turn that did call ctx is silent,
  `evals/stop-resume-ctx-consulted.scenario.json`) where you did consult history through a subagent: the check
  reads this session's transcript only (a subagent's `mcp__ctx__search` is `isSidechain`, or in
  its own file). Say what the subagent found, in this thread, and move on; that is the point
  of the check.
- The Stop check is silent under OMP: this plugin has no OMP adapter in 0.2.0, so OMP seats
  run `ctx search` on a resume by their own rule (the shipyard ctx-first guard), not by this
  hook. Say so if asked why it did not fire.
- `~/.claude/ctx-watch.json` is not JSON, or names a mode that is not `off`, `warn` or `block`:
  one errors.log line and the check runs as `warn`. Show the person the line and the file; do
  not rewrite the file for them.
- The script is missing (`no such file`): the plugin is not installed where `CLAUDE_PLUGIN_ROOT`
  points. Tell the person; `ctx daemon status --format json` read by eye (`.daemon.running`,
  `.daemon.supervisor.status`, `.daemon.jobs.core_refresh.last_run_at_ms`) is the check by hand,
  and say that you did it that way.
