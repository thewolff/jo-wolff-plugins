# REGISTRATION.md: how this adapter goes live on OMP

`pattern-check-omp.ts` is the OMP half of the PreToolUse counter and the Stop refusal, and is
tested by the suite beside it. Nothing loads it until you choose to, and each way of loading it
below has a written reversal. OMP never picks it up from a checkout on its own.

Below, `<checkout>` is the absolute path of your clone of this repository.

## What it needs

- OMP's extension API: `pi.on("tool_call" | "session_stop" | "session_start" |
  "session_switch")`, `ctx.cwd`, `ctx.sessionManager.getSessionId()`, and `ctx.ui.notify` for
  warnings. Written against `@oh-my-pi/pi-coding-agent` 18.8.6.
- Nothing else. The adapter imports the Claude Code hooks' `handle` functions
  (`hooks/pattern-check-pretooluse.mjs`, `hooks/pattern-check-stop.mjs`) and, through them,
  `scripts/lib/*.mjs`, which use Node built-ins only, so OMP's loader imports them as they are.
- `node` on `PATH` for the agent: the block and refusal texts name
  `node "<plugin>/scripts/pattern-check.mjs" record --session <id>`, which the agent runs from its
  bash tool.

## Registration routes

Pick one.

1. **Install the plugin** (the usual route). From a shell:

   ```
   omp plugin marketplace add thewolff/jo-wolff-plugins
   omp plugin install pattern-check@jo-wolff-plugins
   ```

   Inside a running session use `/marketplace add` and `/marketplace install` with the same
   arguments. The plugin's `package.json` declares this file under `omp.extensions`, which OMP
   loads for installed marketplace plugins. Every omp process you then run, in any repository,
   loads the adapter. `omp --no-extensions` starts one process without it.

   The versions in `package.json` and `.omp-plugin/plugin.json` move with
   `.claude-plugin/plugin.json` on every release, because OMP upgrades by version number
   (`manifest.test.mjs` fails when they drift).

2. **One omp process only** (a first try without installing). Pass the file with `-e`:

   ```
   omp -e <checkout>/plugins/pattern-check/omp/pattern-check-omp.ts
   ```

   Do not combine this with route 1: two loaded copies would each run on every call, and how
   their counts then interact was not checked.

3. **From another extension** (how a vendoring host such as an agent-system `plugins/index.ts`
   does it): import the default export and call it once with that extension's `pi`:

   ```ts
   import patternCheckOmp from "./pattern-check/omp/pattern-check-omp.ts";
   patternCheckOmp(pi, { env, home });
   ```

   The adapter calls only `pi.on`, only at factory time, never from an event handler, so a host
   that defers or gates `pi.on` (a trampoline that runs the handler only in a main session) works
   unchanged, and a repeated `session_start` registers nothing. A second call with the same `pi`
   object is a no-op.

## What it does on each event

| OMP event | What the adapter does |
|---|---|
| `tool_call`, tool `edit` | `input.path` and `input.paths` (OMP derives both from a hashline patch's file headers) become a Claude Code `Edit` payload, `file_path` plus `edits[]`, and go to the PreToolUse hook's `handle`. A deny becomes `{ block: true, reason }`. |
| `tool_call`, tool `write` | `input.path` becomes a `Write` payload. Same mapping. |
| `tool_call`, tool `bash` | `input.command` becomes a `Bash` payload: commit, PR and in-repo shell-write forms are blocked while the session is held. |
| `tool_call`, any other tool | Passes untouched. |
| `session_stop` | The final message's text becomes the Stop hook's `last_assistant_message`; a refusal becomes `{ decision: "block", reason }`. Once per turn (below). OMP fires this for the main session only. |
| `session_start`, `session_switch` | Forget this instance's memory of the turn last refused and of the warnings already shown. Nothing on disk changes. |

A path with a URL scheme (`xd://`, `local://`, `skill://`, ...) is not a file in the repository
and is never counted.

### One counter per session, whichever host

The session key is `ctx.sessionManager.getSessionId()`, passed as the payload's `session_id`.
The hooks' own resolver turns it into the same state file, receipt path and refusal record a
Claude Code hook would use for that id. When the id cannot be read, the payload carries none, the
resolver keys the session by its working directory, and the warning it adds is shown once.

### Once per turn

OMP sets `stop_hook_active` after any extension's continuation, so the hook's own
`stop_hook_active` guard would skip a stop that follows another extension's block. The adapter
passes it as false and instead remembers, per session, the turn it last refused: the last `user`
message in the event's `messages`. A later stop in that turn passes. OMP's continuation after a
block is a `custom` message, which does not open a new turn. The hook's hash guard (the same reply
text is refused once) still applies underneath. A stop with no user message in `messages` passes.

### Fail open

OMP turns a `tool_call` handler that throws or times out into a block. Every handler here catches
everything and returns nothing, so the call or the stop goes through, and shows one
`pattern-check: ...` warning through `ctx.ui.notify`. The hooks' own fault lines (a corrupt state
file, a config that does not parse, an unwritable state directory) are shown the same way. Each
distinct line is shown once per session.

### Off switch and config

Exactly the hooks': `hooks.preToolUse` and `hooks.stop`, `threshold`, `denyCommands` and
`receiptDir` in the nearest `.pattern-check.json` or the user config, resolved from the session's
working directory on every call.

## Known gaps on OMP

- `ast_edit`, `eval` and other tools that write files without naming them in their input are not
  counted. The commit and PR blocks are the backstop once the session is held, as for shell writes
  on Claude Code.
- A relative shell-write target is resolved against the session's working directory, not against
  the bash tool's `cwd` argument.
- Each subagent session has its own OMP session id, so its own counter: a receipt the parent
  recorded does not lift a subagent's block. A host that runs the adapter in the main session only
  (as agent-system's `plugins/index.ts` does for its adapters) does not meet this.

## Exact reversal

- Route 1: `omp plugin uninstall pattern-check@jo-wolff-plugins`.
- Route 2: start omp without the `-e` flag.
- Route 3: remove the import and the call.
- State: `${XDG_STATE_HOME:-$HOME/.local/state}/pattern-check/`, shared with the Claude Code hooks.
  Delete it to reset every counter, receipt copy and refusal record.
