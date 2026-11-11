# How coordinator fails

Every piece that can fail, how it fails, where the failure is visible, and what the person does
about it. Both hooks run under plugin-kit's fail-open runner: a fault lets the prompt through,
writes one line, and says so once; neither hook can block.

| Piece | Fails how | Visible where | The person does |
|---|---|---|---|
| any `hooks/*.mjs` | stdin not JSON; the handler throws; no answer in 4 s | one line in `${XDG_STATE_HOME:-~/.local/state}/coordinator/errors.log`; a `systemMessage` `coordinator <event> failed open: …` | nothing for one line; a repeating line is a bug: open an issue with the line |
| `hooks/clock.mjs` | the system clock returns an invalid date, or `Intl` cannot format the zone | no clock line; one `errors.log` line `UserPromptSubmit clock: …`; the skill's "The clock cannot be read" case applies | check the machine's clock and `TZ` |
| `hooks/clock.mjs` | a resumed session replays an old line | the line names its own time, so it reads as old | nothing |
| `hooks/model-notice.mjs` | `to_model` is an alias such as `opus`, not a `claude-` id | no notice; one line in `…/coordinator/skipped.log` | nothing; the line is the trace that the hook was awake |
| `hooks/model-notice.mjs` | the host is older than Claude Code 2.1.251 and never fires `PostModelSwitch` | no notice after a switch | update Claude Code; the first-reply model statement still covers the starting model |
| `hooks/model-notice.mjs` | the session's `cwd` is in no listed folder (the default) | no notice | add the folder to `folders` in the config |
| `config.json` | not JSON, not an object, a wrong-typed field | every field its default (model notice silent, clock on), plus one systemMessage naming the file and the field | fix the field the message names |
| `evals/*.scenario.json` | a scenario no longer matches the hook | `bash e2e/live-run.sh --no-live` exits 1 naming the scenario; `ledger gate check` row `evals` fails | fix the hook or the scenario; the eight are `evals/clock-prompt-line.scenario.json`, `evals/clock-off-by-config.scenario.json` and the six `evals/model-notice-post-switch-*.scenario.json` |
| `e2e/live-run.sh` (the canary) | `claude` missing or cannot log in | exit 75 with the reason on the last line | nothing; the canary tries again tomorrow |
| `scripts/prune.mjs` (retention, declared in plugin.json `state`) | the state directory is unreadable; a file cannot be removed | `pruned: … kept N` on stdout, the file named on stderr | nothing for one night; a repeating line is a permissions problem on the named file |
