# REGISTRATION.md: how this adapter would go live (it has not)

Status: **unregistered**. `paired-coding-omp.ts` exists in this repo and is tested by the suite
beside it. Nothing loads it: no OMP seat profile or extension directory refers to it, and
`~/.omp/agent/extensions/` does not contain it. Registration should be a deliberate act with
a written reversal. It should never happen because a directory was auto-discovered.

Below, `<checkout>` is the absolute path of your clone of this repository.

## What it needs

- macOS with `/usr/bin/sandbox-exec`. `pair_run`, and the write inside `pair_write` and
  `pair_edit`, run under a Seatbelt profile that fences file writes, hard links and Unix-domain
  socket connections (the DNS resolver's excepted), and leaves TCP open. On any other platform
  `pair_start` refuses, and the session stays inert.
- OMP's extension API: `pi.on("tool_call" | "input" | "session_shutdown" |
  "session_before_switch" | "session_switch" | "session_before_branch" | "session_branch")`,
  `pi.registerTool`, `pi.getAllTools`, `pi.zod`, and `ctx.ui.notify` when a UI is present.
  Verified against `@oh-my-pi/pi-coding-agent` 18.4.4.
- Nothing else. The adapter imports `core/gate.mjs` and `lib/*.mjs`, which use Node built-ins
  only, so OMP's loader imports them as they are.

## Registration steps NOT TAKEN

Two sites. Pick one.

1. **One omp process only** (the right choice for a first use). Pass the file with `-e`
   (`--extension`) to a single omp started by hand:

   ```
   omp -e <checkout>/plugins/paired-coding/omp/paired-coding-omp.ts
   ```

   Only that process loads the adapter, and nothing on disk changes to register it. `-e` and
   `--extension` push onto the same list (`setExtension` in `src/cli/flag-tables.ts` of
   `@oh-my-pi/pi-coding-agent`). `main.ts` hands that list to the session as
   `additionalExtensionPaths`. Add `--no-extensions` to load this file and nothing from
   `~/.omp/agent/extensions/`. That flag switches discovery to `explicit-only`, and files
   named with `-e` still load (`mode: parsedArgs.noExtensions ? "explicit-only" : "merge"` in
   `src/main.ts`).

2. **Shared auto-discovery.** Symlink the file into the directory every omp process scans:

   ```
   ln -s <checkout>/plugins/paired-coding/omp/paired-coding-omp.ts \
         ~/.omp/agent/extensions/paired-coding-omp.ts
   ```

   Then every omp process on the machine loads it. The adapter does nothing in a session
   until `pair_start` is called there (see *Inert until pair_start*). A loaded but inactive
   adapter still adds the eight `pair_*` tools to every session's tool list: `pair_start`,
   `pair_note`, `pair_propose`, `pair_begin`, `pair_write`, `pair_edit`, `pair_run` and
   `pair_done`. None of them ends pairing.

### Environment

- `PAIRED_CODING_STATE_DIR`: where each session's state, journal and snapshots live, as
  `<dir>/<omp-session-id>/`. It defaults to `~/.local/state/paired-coding/`, which is also
  used when the value is not an absolute path. Keep it outside every checkout. `pair_run`'s sandbox
  denies writes to it, and `pair_write` / `pair_edit` refuse paths inside it.
- `PAIRED_CODING_CONFLICTING_TOOLS`: optional, tool names separated by commas. See *One write
  gate per session*.

### Inert until pair_start

Every handler first checks for the session's activation marker. That check is an `existsSync`,
and it creates no file. Without the marker, host tools pass untouched and no state directory
is created. `pair_start` writes the marker.

### One write gate per session

If another gate in your sessions also owns write enforcement, list one of its tools in
`PAIRED_CODING_CONFLICTING_TOOLS` so the two gates never run together. `pair_start` reads
`pi.getAllTools()`, and if a listed tool is registered in the session, it refuses and names
that tool. The adapter then stays inert. Entries are trimmed, and empty entries are ignored.
When the variable is unset or empty, the check is skipped.

A tool name is used because OMP's extension API offers no list of the other loaded
extensions. `getExtensionPaths` and `isExtensionActive` exist on the runner but not on
`ExtensionAPI` (`src/extensibility/extensions/types.ts`).

## Exact reversal

1. Remove the registration. For the one-process site, exit that omp process; there is nothing
   on disk to undo. For the shared site:
   `rm ~/.omp/agent/extensions/paired-coding-omp.ts`.
2. Optional: delete the session state, `rm -r "${PAIRED_CODING_STATE_DIR:-$HOME/.local/state/paired-coding}"`.
   The journal is the record of what pairing allowed and refused, so read it first if anything
   went wrong.
3. `git revert <this commit's sha>` in your clone.

## Ending pairing inside a live session

- Typing `pair stop` in the editor, as the whole message (case and surrounding spaces do not
  matter), ends pairing for the session in any phase. The adapter kills and reaps every
  `pair_run` process group, takes the final snapshot, journals any write it did not approve,
  journals `stop` with verb `typed-stop`, and returns the session to inactive. The same words
  arriving from an extension or over RPC end nothing.
- No tool ends pairing. The agent cannot stop the gate it works under.
- Exiting omp ends pairing. On `session_shutdown` the adapter kills and reaps every `pair_run`
  process group, takes the final snapshot and returns the session to inactive.
- `/new`, `/fork` and `/resume` keep this extension loaded but give the agent a new session id
  (`session_before_switch` and `session_switch`, reasons `new`, `fork` and `resume`, in
  `src/session/agent-session.ts`). `/branch`, and the branch `/btw` makes, do the same through
  `session_before_branch` and `session_branch`. If the session being left was pairing, the
  adapter ends it as on shutdown and starts the new session `closed`: no card, no open change
  set, host writes, `pair_note` and `pair_propose` refused, journal entry `carried-after-clear`
  with reason `omp:new`, `omp:fork`, `omp:resume` or `omp:branch`. The editor shows "paired
  coding carried into this session closed: call pair_start to restart it, or type pair stop to
  end it".
- `/tree` keeps the session id and only moves within the session tree (`session_tree`, which
  this adapter does not handle), so pairing carries on unchanged.
- OMP's own `/clear` drops the conversation but keeps the session id
  (`src/slash-commands/builtin-lifecycle.ts`, "Clear the conversation context in place, keeping
  the session"), and it fires no extension event. It does append a `reset_boundary` entry to the
  session (`appendResetBoundary` in `src/session/session-manager.ts`), which the extension can
  read through `ctx.sessionManager.getEntries()`. Before every `input` and `tool_call` the adapter
  looks for a new one. If pairing was active, it ends pairing as on shutdown, finishing any open
  change set, and keeps the same session `closed`, journaling `carried-after-clear` with reason
  `omp:clear`. The editor shows "paired coding is closed because the conversation was cleared:
  call pair_start to restart it, or type pair stop to end it".
- There is no separate kill switch. To run omp without the gate, start a process that does
  not load this file.

## What a typed turn means here

The trusted-input signal is OMP's `input` event. The interactive editor emits that event with
`source: "interactive"` (`src/modes/controllers/input-controller.ts`, the `emitInput(...,
"interactive")` call). Text that an extension injects with `pi.sendUserMessage` does not pass
through it. Text arriving over RPC carries `source: "rpc"`. Only `interactive` turns can carry
the agreement that `pair_begin` quotes, or a `pair stop`.

## Live proof

These runs used one omp process per test session, started with `--no-extensions -e
<this file>` in throwaway git repositories, with `PAIRED_CODING_STATE_DIR` pointing outside
them. Every verdict was judged by content snapshots of the repository: every path, including
untracked and ignored files, with its type and a content hash.

- The adversarial tests 11 to 17 listed in the plugin README behaved as expected, on OMP
  18.4.4 with the cheapest available model.
- Test 16 loaded a second extension that rewrote every `pair_write` path and every `pair_run`
  command to a target outside the boundary. Both writes were still refused.
- Test 14 killed and reaped the process group on abort and on timeout, checked by pid.
- A session with the adapter loaded but no `pair_start` let `write`, `bash` and `eval` create
  files, and created no state directory.

Those runs predate the typed stop, whole-word quotes and session carry-over. These were then
run with the same launch flags, judged from the journal and the tool results:

- A typed `pair stop` in a turn with no tool call ended pairing, and the next `write` was
  allowed. A `pair stop` injected with `pi.sendUserMessage` changed nothing, and the next
  `write` was refused.
- A `pair_begin` quote of `y` against a typed `why? …` was refused as not whole words.
- `/new` while pairing started the new session closed: `write` refused until `pair_start`.
- `/clear` with a change set open and a stray file in the worktree journaled the stray file as
  an unapproved write, closed the change set, and kept the session closed: `pair_write` refused
  with "no change set is open", `write` refused, `pair_start` restarted pairing, and a typed
  `pair stop` ended it.

Two things the runs did leave behind. First, omp's own prompt history
(`~/.omp/agent/history.db`) records prompts typed in the TUI, whatever extensions are loaded.
Second, omp's session files go wherever `--session-dir` points, or to omp's default sessions
directory.
