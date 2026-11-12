# How coordinator fails

Every piece that can fail, how it fails, where the failure is visible, and what the person does
about it. Both hooks run under plugin-kit's fail-open runner: a fault lets the prompt through,
writes one line, and says so once; neither hook can block.

| Piece | Fails how | Visible where | The person does |
|---|---|---|---|
| any `hooks/*.mjs` | stdin not JSON; the handler throws; no answer in 4 s | one line in `${XDG_STATE_HOME:-~/.local/state}/coordinator/errors.log`; a `systemMessage` `coordinator <event> failed open: …` | nothing for one line; a repeating line is a bug: open an issue with the line |
| `hooks/clock.mjs` | the system clock returns an invalid date, or `Intl` cannot format the zone | no clock line; one `errors.log` line `UserPromptSubmit clock: …`; the skill's "The clock cannot be read" case applies | check the machine's clock and `TZ` |
| `hooks/clock.mjs` | the state directory cannot be written (read-only, or a file in its place) | the clock line still arrives; one `errors.log` line `UserPromptSubmit clock: the state directory … is not writable` when the log can still be appended to; a `systemMessage` naming the directory, on every prompt while it stays so | fix the permissions on the named directory |
| `hooks/clock.mjs` | a resumed session replays an old line | the line names its own time, so it reads as old | nothing |
| `hooks/model-notice.mjs` | `to_model` is an alias such as `opus`, not a `claude-` id | no notice; one line in `…/coordinator/skipped.log` | nothing; the line is the trace that the hook was awake |
| `hooks/model-notice.mjs` | `skipped.log` cannot be appended to (read-only state directory, a directory in its place) | a `systemMessage` naming the file; one `errors.log` line when that can be written | fix the permissions on the named path |
| `hooks/model-notice.mjs` | `to_model`'s family, or `expectedModel`'s, is not in `modelFamilyRank` and the two families differ | no notice; one `skipped.log` line; same-family versions are still compared | add the family to `modelFamilyRank` |
| `hooks/model-notice.mjs` | the host is older than Claude Code 2.1.251 and never fires `PostModelSwitch` | no notice after a switch | update Claude Code; the first-reply model statement still covers the starting model |
| `hooks/model-notice.mjs` | the session's `cwd` is in no listed folder (the default) | no notice | add the folder to `folders` in the config |
| `config.json` | not JSON, not an object, a wrong-typed field, or unreadable for any reason but absence (permissions, a directory in its place) | every field its default (model notice silent, clock on), plus one systemMessage naming the file and the field | fix the field the message names |
| `evals/*.scenario.json` | a scenario no longer matches the hook | `bash e2e/live-run.sh --no-live` exits 1 naming the scenario; `ledger gate check` row `evals` fails | fix the hook or the scenario; the eight are `evals/clock-prompt-line.scenario.json`, `evals/clock-off-by-config.scenario.json` and the six `evals/model-notice-post-switch-*.scenario.json` |
| `e2e/live-run.sh` (the canary) | the clock line is not in a UserPromptSubmit `hook_response` event (the phrase elsewhere in the transcript does not count) | exit 1, `fail 2` | fix the clock hook |
| `e2e/live-run.sh` (the canary) | the session's stream has no `result` event, or one that is not a completion | exit 1, `fail 0`; exit 75 when the result names credentials, network or a rate limit | read the transcript the canary kept |
| `e2e/live-run.sh` (the canary) | `lib/live-run.mjs` (and plugin-kit's copy) is missing | exit 1, `fail: no live-run helper`; no scenario ran | restore the helper |
| `e2e/live-run.sh` (the canary) | `claude` missing or cannot log in | exit 75 with the reason on the last line | nothing; the canary tries again tomorrow |
| `scripts/prune.mjs` (retention, declared in plugin.json `state`) | a state directory or subdirectory is unreadable; a file cannot be removed | `pruned: … kept N` on stdout, the directory or file named on stderr with the error; exit 0 | nothing for one night; a repeating line is a permissions problem on the named file |
