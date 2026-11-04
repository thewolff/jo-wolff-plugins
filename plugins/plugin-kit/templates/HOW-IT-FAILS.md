# How {{name}} fails

The receipt the repository test bar asks for before a plugin ships: every piece that can fail,
how it fails, where the failure is visible, and what the person does about it. `ledger gate
check` checks the mechanical parts (the hooks survive five fault inputs; faults leave an
errors.log line and a systemMessage; every skill has a "When this can't run" section; every deny
text names a command); this table is the part a person reads. Fill a row per piece; delete the
rows in parentheses that do not apply.

| Piece | Fails how | Visible where | The person does |
|---|---|---|---|
| `hooks/<event>.mjs` (each hook) | stdin not JSON; the handler throws; no answer in 4 s (stdin held open, a promise nothing settles, or a synchronous handler that never yields: `handle()` runs on a worker thread, the main thread's timer ends the run and a late answer is dropped) | one line in `${XDG_STATE_HOME:-~/.local/state}/{{name}}/errors.log`; a `systemMessage` (`{{name}} <event> failed open: …`), except SessionEnd | nothing for one line; a repeating line is a bug: open an issue with the line |
| (a config file the plugin reads) | missing, unreadable, malformed | treated as defaults; a systemMessage names the file once per session | fix the file; the message names it |
| (a program the plugin shells out to) | not installed; no credential; times out | `unavailable: <reason>` in the command's output; the deny or block it would have given is not given | install or log in as the reason says; the test fixture `<x>.unavailable.txt` is this output, captured |
| `e2e/live-run.sh` (the canary) | `claude` missing or cannot log in | exit 75 with the reason on the last line; `ledger canary runs` shows `unavailable` | nothing; the canary tries again tomorrow |
