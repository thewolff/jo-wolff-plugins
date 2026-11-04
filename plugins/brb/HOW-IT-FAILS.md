# How brb fails

The receipt the repository test bar asks for before a plugin ships: every piece that can fail,
how it fails, where the failure is visible, and what the person does about it. `ledger gate
check` checks the mechanical parts (the hooks survive five fault inputs; faults leave an
errors.log line and a systemMessage; every skill has a "When this can't run" section; every deny
text names a command); this table is the part a person reads.

| Piece | Fails how | Visible where | The person does |
|---|---|---|---|
| `hooks/user-prompt-submit.mjs`, `hooks/stop.mjs`, `hooks/session-start.mjs` | stdin not JSON; the handler throws; no answer in 4 s (`handle()` runs on a worker thread, the main thread's timer ends the run and a late answer is dropped) | one line in `${XDG_STATE_HOME:-~/.local/state}/brb/errors.log`; a `systemMessage` (`brb <event> failed open: …`) | nothing for one line; a repeating line is a bug: open an issue with the line |
| `away.json` (the hold) | does not parse, or has no `since` | read as home: the next `brb` starts a fresh hold, the Stop hook holds nothing, `back` says not away | type `brb` again; the digest file, if any, is still there and the next `back` prints it |
| `digest.md` | the state directory cannot be written | the Stop hook throws into the runner: one errors.log line, a `systemMessage`, the stop proceeds; the ask is still on screen in the agent's message | fix the directory's permissions; read the message on screen |
| `transcript_path` (tool-less stop counting) | unreadable, rotated, a different line shape | the fallback counts a stop whose message is byte-identical to the previous stop's as tool-less; `away.json` `lastStop.transcript` is `false` | nothing; the agent still stops on an `idle:` line and on the guard |
| the on-fire `osascript` notification (macOS) | `osascript` missing or refused; Notification Center off | nothing: the spawn is detached and ignored; the `systemMessage` and the OSC 9 `terminalSequence` still carry the line | nothing; `BRB_DESKTOP_NOTIFY=off` turns the attempt off |
| the OSC 9 `terminalSequence` | the terminal does not render OSC 9 | no banner; the `systemMessage` still shows in the transcript | nothing |
| `~/.config/brb/config.json` | missing, unreadable, malformed, a field that is not a non-negative integer | the defaults (`onFireCap` 3, `idleStops` 2), silently | fix the file; nothing is lost meanwhile |
| `omp/brb-omp.ts` (the OMP adapter) | the spawn fails, exits non-zero, prints junk, outruns its budget (5 s prompt/start, 10 s stop) | one `omp-adapter …` line in errors.log; the word is still handled (it never reaches the model), the turn starts without the context, the stop is allowed | nothing for one line; a repeating line names the hook, run it by hand with the same stdin |
| `evals/*.scenario.json` (one per hook event × outcome) | an outcome the hook returns with no scenario; a scenario whose `after` block fails | `ledger gate check` row `evals` fails naming the event, the outcome or the scenario | fill the scenario; `bash e2e/live-run.sh --no-live` replays them offline |
| `e2e/live-run.sh` (the canary) | `claude` missing or cannot log in | exit 75 with the reason on the last line; `ledger canary runs` shows `unavailable` | nothing; the canary tries again tomorrow |
| `scripts/prune.mjs` (retention, declared in plugin.json `state`) | the state directory is unreadable; a file cannot be removed | `pruned: … kept N` on stdout, the file named on stderr; `ledger canary status` shows the prune row | nothing for one night; a repeating line is a permissions problem on the named file |
