# Fixtures

Captured from remindctl 0.3.8 on macOS, 2026-11-04, with `capture.sh` (read-only, `show` only).

| File | What it is |
|---|---|
| `remindctl-show-today.json` | `remindctl show today --list <list> --json`, verbatim structure. Titles replaced: the real ones were personal. |
| `remindctl-show-overdue.json` | Shape of `remindctl show overdue --list <list> --json`. The capture at 02:21 PST returned `[\n\n]` (nothing overdue yet), so this file is the today capture's shape with one entry moved to the day before and one entry repeated from today (the overlap the hook dedupes). |
| `remindctl-show-empty.json` | The real empty answer, byte for byte: `[`, a blank line, `]`. |
| `remindctl-list-not-found.unavailable.txt` | stderr of `remindctl show today --list <unknown> --json`, which exits 1: the unavailable path. |

The not-authorized answer was not captured: this machine's remindctl is authorized (`remindctl status --json` → `"status" : "full-access"`), and revoking access to capture it would change the person's system. The hook maps any non-zero exit whose output mentions access, authorization, permission or privacy to the `remindctl authorize` fix, and any other non-zero exit to `remindctl doctor`.
