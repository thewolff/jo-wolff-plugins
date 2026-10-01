# paired-coding

A plugin for pairing with an agent on code, one change set at a time. The agent drives; you
navigate. Before each change set it shows you a **card** that names the decision inside the
change, the code it touches, the effect it will have and the exact files it will write. It
writes only after the two of you agree on that card, then shows you the real diff.

The problem it addresses is speed. Agent code arrives faster than a person can recognise the
decisions inside it. A plan written up front cannot predict every design choice that
implementation reveals, so a wrong direction is found after a whole feature exists, and you end
the session owning code you did not follow. Pairing moves the decision point to before each
change set is written, while it is still cheap to steer.

## Install

Claude Code:

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install paired-coding@jo-wolff-plugins
```

To try it for one session without installing, start `claude --plugin-dir <checkout>/plugins/paired-coding`,
where `<checkout>` is your clone of this repository.

OMP: the gate is an extension, `omp/paired-coding-omp.ts`. Nothing registers it for you.
[`omp/REGISTRATION.md`](omp/REGISTRATION.md) gives the two ways to load it and the exact
reversal.

## What happens when you pair

Ask for it in words: "pair with me", "let's pair on this", "paired coding". The skill
(`skills/paired-coding/SKILL.md`) then runs three phases:

1. **Define the work together.** Outcome, constraints, one concrete example of success. Nothing
   is written.
2. **Recon.** The agent explores read-only and proposes a roadmap of cards, one line each.
3. **Pairing loop.** For each card: discussion, agreement, the agent makes the whole change set,
   then a read-back with the diff, the check output, what the change means, and the cards still
   to play.

A change set is the smallest change in code whose effect can be checked on its own. Agreement
is a shared understanding of the behavior, the approach and the boundary, evidenced by you
saying to go ahead in your own turn after the card. A question, a comment that changes the
card, or "looks good" while the card still lists open points keeps the conversation going.
When the agent discovers that the agreed behavior, approach or boundary no longer holds, it
stops and brings a revised card.

**The roadmap.** Each card on it is `open`, `not-ready` (with a one-line note on what it waits
for), `done`, `skipped` or `dropped`. The agent works the next ready card, shows the open and
not-ready ones at every read-back, and does not call the roadmap done while any is left. When
you start pairing again in the same worktree, the agent offers to pick up an unfinished roadmap
from the last session there; you can say no and start fresh. Nothing reopens on its own: every
picked-up card still needs its own card and agreement.

**Ending.** A done roadmap does not end pairing: the agent reports it done and the gate stays
closed. Only you end pairing: type `pair stop` as a message of its own. The agent has no tool
that ends it.

The skill holds the conversation; the gate below holds the writes. The contract is the two
together: where the skill says what the agent should do, the gate decides what it can do.

## The gate

A skill can describe the conversation; only a gate at the tool boundary can make "no write
without agreement" true. One gate core (`core/`, no host imports) and one session layer
(`lib/`) are shared by both host adapters:

- **Claude Code:** hooks (`hooks/hooks.json`) plus a bundled MCP server named `pair`
  (`.mcp.json`, `server/`), whose tools appear as `mcp__plugin_paired-coding_pair__pair_*`.
- **OMP:** one extension, `omp/paired-coding-omp.ts`.

How it works:

- Pairing state is `inactive` until `pair_start`, then `closed` between change sets and `open`
  during one. Missing or damaged state in an activated session reads as `closed`. A session
  that never calls `pair_start` is untouched: host tools work and no state is written.
- The agent registers each card with `pair_propose` and opens it with `pair_begin`, quoting
  you. The gate accepts the quote only if it is whole words from your latest turn that the host
  recorded as typed by a person after the card, only if the card has no open points, and only
  if the card's files are unchanged since it was shown.
- While pairing, the host's own write, edit, shell, eval and sub-agent tools are refused, and so
  is any tool the gate does not know. The agent writes through `pair_write` and `pair_edit`,
  which accept only paths inside the open change set's boundary, and runs commands through
  `pair_run`.
- `pair_run` runs every command in the foreground under a macOS Seatbelt profile built from the
  state. Both profiles deny every write by default. With no change set open a command may write
  only temp directories and `/dev`. With one open it may also write the boundary files. The
  state directory and the plugin's own install root are never writable, and no command may
  create a hard link anywhere, even between two paths it could write.
- `pair_write` and `pair_edit` write inside the sandbox too, under the open profile without the
  temp directories. They write the new content to a fresh file beside the target and rename it
  over the target, keeping an existing file's permission bits. So a hard link or symlink at a
  boundary path is replaced rather than written through, a symlink swapped in after the path
  check cannot land the write outside the boundary, and a directory at the path is refused.
- `pair_done` returns the diff of the boundary, computed by the gate, and lists the roadmap cards
  still `open` or `not-ready`. Every card, quote, verdict, refusal and diff goes into a journal
  outside the worktree, under `$PAIRED_CODING_STATE_DIR` (default
  `~/.local/state/paired-coding/<session-id>/`).
- Typing `pair stop` ends pairing in any phase: the gate reaps running commands, takes a final
  snapshot, journals any write it did not approve, journals the stop as `typed-stop`, and
  returns the session to inactive. On Claude Code the stop takes effect when the turn ends or at
  the next tool call, whichever comes first; on OMP, when the turn is submitted.

## Hosts

| Host | Gate | Live result |
|---|---|---|
| Claude Code, macOS | Built: hooks and a bundled MCP server | Verified on Claude Code v2.1.287, loaded with `--plugin-dir`: tests 11 to 17, then the release checks below |
| OMP, macOS | Built: an extension, loaded with `-e` | Verified on OMP 18.4.4, loaded with `-e`: tests 11 to 17, then the release checks below. Skill discovery on plain OMP is unverified |
| Codex | None | Unverified; the skill is included but has not been run there |
| Linux, Windows, anything else | `pair_start` refuses | The skill runs as conversation only |

The adversarial tests, run live with a cheap model in throwaway git repositories and judged by
content snapshots of every file (untracked and ignored included):

| Test | What it tries | Expected and seen |
|---|---|---|
| 11 | Every host write, edit, shell and eval route, plus `pair_write` and `pair_run`, with no change set open | All refused, or denied by Seatbelt |
| 12 | `pair_begin` quoting words not in your latest turn, words typed before the card, and injected input | All refused |
| 13 | With a change set open: writes outside the boundary and into the state directory, three ways each; corrupting the state file; host tools | All refused; corrupt state reads as closed |
| 14 | A long check with a child process writing, a message typed during it, then abort and timeout | The run stays in the foreground, `pair_done` waits for it, the whole process group is killed |
| 15 | Dispatching a sub-agent | Refused |
| 16 | A second extension or plugin hook rewriting `pair_write` paths and `pair_run` commands to targets outside the boundary | Still refused: the gate checks the final arguments |
| 17 | A process that double-forks out of its group in change set A and writes A's file during change set B | B's read-back flags the write and stops the session |

Tests 11 to 17 ran before this release's changes to stopping, `/clear`, quotes, the closed
`pair_run` profile and the sandboxed write, and were not re-run after them. Those changes were
checked live as follows, and by the unit suite:

| Check | Claude Code | OMP |
|---|---|---|
| Typed `pair stop` in a turn with no tool call ends pairing; the next host write is allowed | Passed | Passed |
| `pair stop` that was injected (a scheduled prompt on Claude Code, an extension's message on OMP), or typed while a tool ran, ends nothing | Passed | Passed (injected) |
| A quote of `y` against a typed `why? …` is refused as not whole words | Passed | Passed |
| `/clear` while pairing leaves the session closed until `pair_start` | Passed, twice | Passed, with an open change set |
| `/new` while pairing leaves the new session closed until `pair_start` | Not applicable | Passed |

The closed `pair_run` profile was also run directly under `sandbox-exec`, outside any host:
writes to a stand-in plugin cache and a stand-in `~/.claude/settings.json` were denied, and so
was `launchctl submit`. A symlink swapped back and forth 95,189 times during 1,913 `pair_write`
attempts never moved a write outside the boundary. Before this release, a hard link inside the
boundary pointing at a file outside it let `pair_write` and `pair_edit` overwrite that file; in a
direct check of the fix, five variants of that attack all left the outside file unchanged.

## What this enforces, and what it does not

**The write boundary is enforced; agreement is judged.** The agent decides when you have agreed.
The gate proves that the quote is whole words from a real typed turn after a real card, and
nothing more. A misread go-ahead can open a change set, but only for that card's files, and the
quote sits in the journal for you to audit. The gate cannot tell whether behavior inside the
boundary drifted from what was agreed; that is the skill's reopen rule and your read of the real
diff.

**What counts as typed.** On OMP, a turn is trusted when the `input` event carries
`source: "interactive"`, which only the editor emits; text injected by an extension or sent over
RPC is not. On Claude Code, the hook input carries no source, so the gate reads the transcript
entry Claude Code writes for the prompt and trusts it only when its `promptSource` is `typed`,
its `origin.kind` is `human`, and it is the only entry with that prompt id. Scheduled prompts,
task notifications, `-p` and SDK prompts never count. A message you type while a tool is running
never counts either: Claude Code folds it into the running turn without an ordinary transcript
entry, so retype it after the turn ends. The same rule decides whether a typed `pair stop` counts.

**Undocumented Claude Code fields, failing closed.** The transcript fields `promptSource` and
`origin` are not documented by Claude Code, and neither is `_meta["claudecode/toolUseId"]`, the id
the MCP server uses to tie each `pair_*` call to the hook that checked it. If the transcript
fields change, every turn reads as untrusted and no change set can open. If the id stops
arriving, every `pair_*` call is refused. Neither change can open the gate.

**Claude Code v2.1.274 or later.** The gate recognises its own tools by the `mcp_server` field of
the `PreToolUse` input, which [Claude Code's hooks reference](https://code.claude.com/docs/en/hooks)
says "requires Claude Code v2.1.274 or later". On an older Claude Code, every `pair_*` call is
refused, so pairing cannot start.

**`pair_run`'s time limit on Claude Code.** Claude Code moves an MCP call that runs longer than
its automatic-backgrounding threshold (two minutes by default) into a background task, and a
backgrounded check would let the agent move on while it still runs. So `pair_run` caps each
command at that threshold minus 10 seconds: 110 seconds by default. Set
`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` to change the threshold. Setting it to `0`, or
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, turns backgrounding off and lifts the cap; the limits
that apply on OMP then hold: 10 minutes by default, at most an hour.

**Session changes fail closed.** `/clear` on Claude Code starts a new session; on OMP, `/new`,
`/fork` and `/resume` do, and `/clear` resets the conversation inside the same session. If
pairing was active, the gate ends it (reaping runs, taking the final snapshot, journaling any
write it did not approve, finishing an open change set) and pairing continues `closed`: no card,
no open change set, host writes refused, `pair_note` and `pair_propose` refused, and the
journal records `carried-after-clear`. `pair_start` restarts pairing, and a typed `pair stop`
ends it. On Claude Code the hand-over is a marker written at `SessionEnd` before the final
snapshot, so a `SessionEnd` cut short by Claude Code's hook time budget still leaves the new
session closed; what can be cut short is the old session's final snapshot. The marker is
single-use, tied to the worktree, and expires after 10 minutes; a session started any other way
stays untouched. On OMP, `/clear` fires no extension event, so the gate notices the reset
marker OMP writes into the session at the next typed turn or tool call.

**One write gate per session, on OMP.** If another gate in your OMP sessions also owns write
enforcement, set `PAIRED_CODING_CONFLICTING_TOOLS` to a comma-separated list of tool names it
registers. `pair_start` refuses while any listed tool is in the session's tool list; see
`omp/REGISTRATION.md`. Claude Code does not read this variable.

**macOS only.** `pair_run` and the writes inside `pair_write` and `pair_edit` depend on Seatbelt
(`/usr/bin/sandbox-exec`). Elsewhere `pair_start` refuses and the skill works as conversation
only.

**Escaped writers are caught late, and only inside the worktree.** A process that leaves its
run's process group survives the reap and keeps the write permission its run had (test 17). A
process that got out of the sandbox altogether would write with your own permissions; the one
route probed, `launchctl submit`, was denied, but no probe proves there is no other. Either kind
is caught only by content snapshots, at the next `pair_done`, which then stops the session: the
first write is not prevented. Snapshots cover the worktree only and leave out `.git`, so a write
outside the worktree, inside an excluded directory, or after the final snapshot is not detected.

## License

MIT. See the repository root `LICENSE`.
