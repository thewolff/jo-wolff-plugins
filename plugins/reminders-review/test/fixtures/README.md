# Fixtures

Captured from remindctl 0.3.8 on macOS, 2026-11-04, with `capture.sh` (read-only, `show` only).

| File | What it is |
|---|---|
| `remindctl-show-today.json` | `remindctl show today --list <list> --json`, verbatim structure. Titles replaced: the real ones were personal. |
| `remindctl-show-overdue.json` | Shape of `remindctl show overdue --list <list> --json`. The capture at 02:21 PST returned `[\n\n]` (nothing overdue yet), so this file is the today capture's shape with one entry moved to the day before and one entry repeated from today (the overlap the hook dedupes). |
| `remindctl-show-empty.json` | The real empty answer, byte for byte: `[`, a blank line, `]`. |
| `remindctl-list-not-found.unavailable.txt` | stderr of `remindctl show today --list <unknown> --json`, which exits 1: the unavailable path. |

The not-authorized answer was not captured: this machine's remindctl is authorized (`remindctl status --json` → `"status" : "full-access"`), and revoking access to capture it would change the person's system. The hook maps any non-zero exit whose output mentions access, authorization, permission or privacy to the `remindctl authorize` fix, and any other non-zero exit to `remindctl doctor`.

Executable fixtures do not live here. Bare `node --test` runs every file under `test/` as a test, with the developer's real HOME, so a hook placed here writes to the real state directory. The runner's big-answer hook for `test/limits.test.mjs` is in `../../test-fixtures/big-answer-hook.mjs` and does nothing unless `REMINDERS_REVIEW_FIXTURE=1` is set. `test/discovery.test.mjs` fails if a file other than a `*.test.mjs` or `test/helpers.mjs` lands in discovery.
