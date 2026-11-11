---
name: repair
description: Repair a down ctx daemon or a stuck ctx upgrade when a SessionStart context or line from ctx-watch says ctx is not running or its upgrade is stuck, or the person asks to fix ctx; not while ctx-watch says an upgrade is in progress, and not for the semantic index.
---

# ctx-watch repair

The ctx history daemon has stayed down for days before: on 2026-11-05 ctx's automatic upgrade
died between `quiescing` and `applying`, left an upgrade state that fenced out every new daemon,
and later a heal recorded a launch environment without LANG. `repair` is the sequence that
brought it back on 2026-11-11, with that run's confirmations turned into checks that refuse.

## Steps

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx-watch.mjs" repair` from this shell. It takes up
   to about three minutes (ctx's own handoff waits up to 75 s); do not interrupt it.
2. Read the last line and the exit code:
   - exit 0, `repaired` or `healthy; nothing changed`: say so in one line. If it says automatic
     upgrades are now off, tell the person `ctx upgrade enable` turns them back on once a fixed
     ctx release is out.
   - exit 3, `refused: …`: nothing was changed. Say the reason. `upgrade in progress` or `owner
     pid … is alive` means wait; `wait Nm and run repair again` means exactly that; a missing
     LANG or an unreachable `gui/<uid>` launchd domain means the person runs the same command
     from their own Terminal; indexing mode `manual` is their decision.
   - exit 1, `failed: …`: say the line and hand the person the first line's JSON `steps` entry
     that failed. If it says the timer was NOT restored, hand over the `launchctl bootstrap`
     line `install` prints.
3. Never run `ctx upgrade --dry-run`, `ctx upgrade disable` or `launchctl` yourself in place of
   this command: `repair` runs them only after checking that no upgrade owner process is alive.
   The `--dry-run` release was observed to work on 2026-11-11; ctx does not document it.
