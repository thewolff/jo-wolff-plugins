# How delegation fails

Every piece that can fail, how it fails, where the failure is visible, and what the person does
about it. The hooks all run under plugin-kit's fail-open runner: a fault lets the call through,
writes one line, and says so once; a gate never blocks because it broke.

| Piece | Fails how | Visible where | The person does |
|---|---|---|---|
| any `hooks/*.mjs` | stdin not JSON; the handler throws; no answer in 4 s | one line in `${XDG_STATE_HOME:-~/.local/state}/delegation/errors.log`; a `systemMessage` `delegation <hook> failed open: …`; the call goes through unchecked | nothing for one line; a repeating line is a bug: open an issue with the line |
| `hooks/session-start.mjs` | the runner fault above | the session starts untaught; the spawn gate still holds and its refusal carries the template | nothing |
| `hooks/spawn-gate.mjs` | `tool_input.prompt` is not a string | the spawn is allowed; one line in `…/delegation/skipped.log` | nothing; the line is the trace that the gate was awake |
| `hooks/spawn-gate.mjs` gate 2 | the cwd is in no git repository, or the payload has no cwd | the spawn is allowed; one skipped.log line | run the spawn from inside the repository if the receipt is wanted |
| `hooks/spawn-gate.mjs` gate 2 | pattern-check is not installed | the deny names `<pattern-check plugin root>` and says to install it | install `pattern-check@jo-wolff-plugins`, or set `requirePatternCheck: false` in `${XDG_CONFIG_HOME:-~/.config}/delegation/config.json` |
| `hooks/spawn-gate.mjs` model line | `lib/model-routing.json` is missing or malformed, or `tool_input.model` names no single family in it (`inherit`, another vendor's model) | the spawn is allowed with no model line; one skipped.log line `model not checked: …` | nothing for an unjudged model; a line naming the table file is a broken install: reinstall the plugin |
| `hooks/session-brief-gate.mjs` | `tool_input.prompt` is missing (and no `proposal_id`) or not a string | the start is allowed; one line in `…/delegation/skipped.log` | nothing; the line is the trace that the gate was awake |
| `hooks/session-brief-gate.mjs` | the model gives up after a refusal instead of re-issuing the call | no session starts; the refusal (`evals/session-brief-gate-deny-missing-headings.scenario.json`) is the last tool result | ask for the session again, or set `"checks": { "session-brief-gate": "warn" }` in `${XDG_CONFIG_HOME:-~/.config}/delegation/config.json` |
| `hooks/send-message-check.mjs` | the response has no `success` field (another host version) | nothing; the send's own result is the only signal | nothing |
| `hooks/subagent-stop.mjs` | `last_assistant_message` is absent (older host, or the agent ended on a tool call) | the warning says the report ended without the line | read the report; the warning is advisory |
| `omp/delegation-omp.ts` | a handler throws | returns undefined (OMP would otherwise turn a throw into a block of every `task` call); the teaching block is re-offered until a `context` event carries it | nothing |
| `hooks/delegation-guard.mjs` | the file is unreadable or binary; the state dir is unwritable | not counted, not flagged; the streak is lost, never the call | nothing |
| `hooks/worktree-spawn-guard.mjs` | git is missing, fails, or exceeds 3 s | nothing | nothing |
| `hooks/repo-rules-inject.mjs` | a rules file is unreadable | that file contributes nothing | nothing |
| `config.json` | not JSON, not an object, a wrong-typed field | defaults, plus one systemMessage naming the file and the field | fix the field the message names |
| `e2e/live-run.sh` (the canary) | `claude` missing or cannot log in | exit 75 with the reason on the last line | nothing; the canary tries again tomorrow |
