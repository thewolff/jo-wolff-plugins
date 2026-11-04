# Changelog

All notable changes to ctx-watch are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The 0.1.0 release is described under
*Changes in 0.1.0* in [README.md](README.md#changes-in-010).

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
  episode from the timer. `ctx index mode auto` is not tried for it (`healable: false`), and
  `check` says so in `healed.detail`.
- The `consult-history` Stop check (`hooks/stop.mjs`, `lib/consult-history.mjs`), a
  deterministic transcript scan. Resume trigger: the first Stop after a SessionStart with
  `source` `resume` or `compact` (the SessionStart hook leaves `<state>/resume/<session_id>`;
  the Stop hook consumes it once) when no entry since is a ctx history call
  (`mcp__ctx__search`, `mcp__ctx__show_session`, `mcp__ctx__show_event`, the single-underscore
  shape, or `ctx search` / `ctx show session` / `ctx show event` through Bash). Phrase
  trigger: the final message says "we spoke previously", "earlier you said", "as discussed"
  or "last time" and this turn made no such call. One line:
  `` ctx-watch: resumed without consulting history — `ctx search '<first six words of the prompt>'` ``.
  Switch: `~/.claude/ctx-watch.json` `{"checks": {"consult-history": "off" | "warn" | "block"}}`,
  default `warn` (a `systemMessage` and a `checks.log` line); `block` returns
  `{ decision: "block", reason }` naming the command and the way out, and warns instead when
  `stop_hook_active` is true; `~/.claude/.ctx-watch-off` is off. Claude Code only: OMP does
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
