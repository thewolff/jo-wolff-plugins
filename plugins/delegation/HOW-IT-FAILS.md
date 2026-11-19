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
| `hooks/spawn-gate.mjs` gate 5 | the `claudex: log:` path is relative and the payload has no absolute cwd, or the stat fails with anything but not-found | the spawn is allowed; one skipped.log line `claudex line not checked: …` | give the log as an absolute path |
| `hooks/spawn-gate.mjs` gate 5 | the stat hangs (an unresponsive mounted filesystem) | the runner's 4 s deadline allows the spawn; one errors.log line and a `failed open` systemMessage | give a log path on a local disk |
| `hooks/spawn-gate.mjs` gate 5 | the model gives up after the refusal, or writes a rote `claudex: skip:` reason | no spawn, or a spawn whose skip reason nobody checked; the gate cannot judge whether a reason is true | read the brief's `claudex:` line in the transcript; set `requireClaudexLoop: false` to drop the gate |
| `hooks/session-brief-gate.mjs` | a `start_session` brief carries no claudex line | not gated, by design: the started session is the host conversation claudex-loop plans in, and its builder spawns meet gate 5; a session that edits code without spawning a builder is not held | nothing |
| `omp/delegation-omp.ts` | gate 5 on OMP | not implemented: OMP runs judges inline with no deadline, so a stat on a prompt-supplied path cannot be bounded there | nothing; the Claude Code gate holds |
| `config.json` on OMP | `requireClaudexLoop` is not a boolean | every field falls back to its default (the loader's all-or-nothing rule) and OMP shows no message, so `off: true` or `requirePatternCheck: false` set beside it stop applying on OMP | fix the field; on Claude Code the spawn gate's systemMessage names it |
| `hooks/spawn-gate.mjs` model line | `lib/model-routing.json` is missing or malformed, or `tool_input.model` names no single family in it (`inherit`, another vendor's model) | the spawn is allowed with no model line; one skipped.log line `model not checked: …` | nothing for an unjudged model; a line naming the table file is a broken install: reinstall the plugin |
| `hooks/spawn-gate.mjs` routing log | the state directory is unwritable, or `routing.jsonl` cannot be appended to | the spawn is decided as it would have been; one errors.log line `routing log not written: <code>` | nothing for one line; a repeating line means the state directory needs fixing |
| `hooks/spawn-gate.mjs` routing log rotation | the full log cannot be archived or old archives cannot be pruned (a read-only state directory, a permissions fault) | the spawn is decided as it would have been; the line is appended to the full file; one errors.log line `routing log not rotated: <code>` | nothing for one line; a repeating line means the state directory needs fixing, and the log grows past 1 MiB until it is |
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
