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

OMP:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install paired-coding@jo-wolff-plugins
```

Inside a running OMP session the commands are `/marketplace add` and `/marketplace install`, with
the same arguments; `/plugin install` inside OMP installs nothing. On OMP the gate is an
extension, `omp/paired-coding-omp.ts`, and the install registers it: `package.json` declares it
under `omp.extensions`, and `.omp-plugin/plugin.json` hides the bundled MCP server, which only
works on Claude Code. Tested on OMP 18.4.4: after the install, with no `-e`, the eight `pair_*`
tools were registered natively and no MCP route appeared; `pair_start` then refused a host
`write`, and a session that never called `pair_start` wrote normally and created no state. The
gate is then loaded in every omp process you run, in any repository, and stays inert until
`pair_start`. `omp plugin upgrade` keeps it registered, `omp --no-extensions` starts a process
without it, and `omp plugin uninstall paired-coding@jo-wolff-plugins` removes it.
[`omp/REGISTRATION.md`](omp/REGISTRATION.md) also gives two ways to load the gate without
installing the plugin, and their exact reversal.

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
  during one. Missing or damaged state in an activated session reads as `closed`, and so does a
  state file that says `inactive` when the gate itself never ended pairing (a typed `pair stop`
  or the session's end): editing the state file cannot switch the gate off. A session that never
  calls `pair_start` is untouched: host tools work and no state is written.
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
  create a hard link anywhere, even between two paths it could write. Both profiles also refuse
  connections to Unix-domain sockets, except the DNS resolver's, because a local daemon reached
  over a socket writes with its own rights. So the Docker CLI, `ssh-agent`, and a database on a
  local socket are out of reach from `pair_run`. TCP is not fenced: HTTPS and DNS lookups work.
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
| OMP, macOS | Built: an extension, registered by `omp plugin install` or loaded with `-e` | Verified on OMP 18.4.4, loaded with `-e`: tests 11 to 17, then the release checks below. After a plain `omp plugin install`, a scripted stand-in model saw the skill listed, the eight `pair_*` tools registered, and a host `write` refused after `pair_start`; tests 11 to 17 were not re-run that way |
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
nothing more. A quote with no letter or digit, such as `?` or `...`, is refused: "the quote has
no letter or digit; quote your partner's words". A misread go-ahead can open a change set, but
only for that card's files, and the quote sits in the journal for you to audit. The gate cannot
tell whether behavior inside the boundary drifted from what was agreed; that is the skill's
reopen rule and your read of the real diff.

**What counts as typed.** On OMP, a turn is trusted when the `input` event carries
`source: "interactive"`, which only the editor emits; text injected by an extension or sent over
RPC is not. On Claude Code, the hook input carries no source, so the gate reads the transcript
entry Claude Code writes for the prompt and trusts it only when its `promptSource` is `typed`,
its `origin.kind` is `human`, and it is the only entry with that prompt id. Scheduled prompts,
task notifications, `-p` and SDK prompts never count, and neither does anything you say through
a slash command: its prompt carries no typed source, so agreement given that way is refused.
Type it as a plain message. A message you type while a tool is running never counts either:
Claude Code folds it into the running turn without an ordinary transcript entry, so retype it
after the turn ends. If the agent quotes such a message to `pair_begin`, the refusal says so:
"your partner's words arrived while a tool was running, so they don't count as agreement; ask
them to say it again". Other untrusted text gets the ordinary quote refusal. The same rule
decides whether a typed `pair stop` counts.

**Trust waits briefly for the transcript.** Claude Code writes a prompt's transcript entry
after the prompt is submitted, and usually after the next tool call has started: measured on
2.1.287, the entry was missing when that call began in 11 of 11 checks, and appeared 51 to 105
ms later in the 6 that waited for it. So the hook polls for the entry for up to 2 seconds before
judging the turn. Without that wait every agreement would be refused. When several turns are
queued, they share that one 2-second wait, so an older turn whose entry lands late is still
judged on it. If an entry is still missing when the wait runs out, its turn reads as untrusted:
a slow write refuses agreement, it never grants it.

**A coarser `source` field is coming.** The Claude Agent SDK 0.3.287 declares an upcoming
`source` field on `UserPromptSubmit`, which Claude Code 2.1.287 does not send yet. It reports
typed prompts, queued prompts and accepted suggestions all as `user`, so it can serve only as a
fast refusal for anything that is not `user`. It cannot replace the typed-prompt check.

**Undocumented Claude Code fields, failing closed.** The transcript fields `promptSource` and
`origin` are not documented by Claude Code, and neither is `_meta["claudecode/toolUseId"]`, the id
the MCP server uses to tie each `pair_*` call to the hook that checked it. If the transcript
fields change, every turn reads as untrusted and no change set can open. If the id stops
arriving, every `pair_*` call is refused. Neither change can open the gate. Measured on 2.1.287,
the id matched the hook's `tool_use_id` in 11 of 11 live calls, while the documented
`CLAUDE_CODE_SESSION_ID` went stale after `/clear`, so it cannot do the same job. If the id
disappears, the fallback is a one-shot nonce that the hook passes into the call through
`PreToolUse` `updatedInput`, checked against the binding file. That fallback is not built, and
two of its edges are undocumented too: what happens when several hooks return `updatedInput`,
and whether `updatedInput` applies without a permission decision.

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

**Session changes fail closed.** On Claude Code, `/clear`, `/resume` and `/branch` start a new
session, and so does a fork (`/fork`, `--fork-session`). On OMP, `/new`, `/fork`, `/resume`,
`/branch` and the branch `/btw` makes do, and `/clear` resets the conversation inside the same
session. If pairing was active, the gate ends it (reaping runs, taking the final snapshot,
journaling any write it did not approve, finishing an open change set) and pairing continues
`closed`: no card, no open change set, host writes refused, `pair_note` and `pair_propose`
refused, and the journal records `carried-after-clear`. `pair_start` restarts pairing, and a
typed `pair stop` ends it. On OMP, `/clear` fires no extension event, so the gate notices the
reset marker OMP writes into the session at the next typed turn or tool call.

On Claude Code the hand-over is a marker. Every `SessionEnd` while pairing leaves one for the
worktree, whatever the reason: `/clear`, `/resume`, `/branch`, or quitting. It is written
before the final snapshot, so a `SessionEnd` cut short by Claude Code's hook time budget still
leaves it; what can be cut short is the old session's final snapshot. The marker is single-use,
tied to the worktree, and expires after 10 minutes. Only a session that replaces another takes
it: one that starts from `/clear`, a resume or a fork. So quitting while pairing and then
running `claude --resume`, `--continue` or `--fork-session` in the same worktree within 10
minutes starts closed, while a fresh `claude` launch stays untouched. A fork of a session that is
still pairing (the `/fork` background copy) is linked instead through the `forkedFrom` session
id Claude Code writes into the fork's transcript, since the hook input names no parent.

Four limits:

- On Claude Code, only `/clear` has been run live. Resume, `/branch`, quitting and forks are
  covered by unit tests only, and `forkedFrom` is undocumented.
- On Claude Code, a resume or fork starts untouched, not closed, when pairing had already ended
  with a typed `pair stop`, when the marker is older than 10 minutes, when it belongs to another
  worktree, or when an earlier `/clear`, resume or fork already took it.
- A fresh launch leaves the marker in place. If you quit while pairing, start a new
  conversation in the same worktree, and use `/clear` or `/resume` in it within 10 minutes,
  that session takes the marker and starts closed. Type `pair stop`, or let the agent call
  `pair_start`.
- On OMP, `/tree` keeps the session id and only moves within the session tree, so pairing
  carries on unchanged.

**One write gate per session, on OMP.** If another gate in your OMP sessions also owns write
enforcement, set `PAIRED_CODING_CONFLICTING_TOOLS` to a comma-separated list of tool names it
registers. `pair_start` refuses while any listed tool is in the session's tool list; see
`omp/REGISTRATION.md`. Claude Code does not read this variable.

**macOS only.** `pair_run` and the writes inside `pair_write` and `pair_edit` depend on Seatbelt
(`/usr/bin/sandbox-exec`). Elsewhere `pair_start` refuses and the skill works as conversation
only.

**Links inside the boundary become plain files.** `pair_write` and `pair_edit` write a new file
and rename it over the target, so they never write through a symlink or hard link at a boundary
path. The file the link pointed to is never touched, and the linked path becomes a plain copy
holding the new content. That includes links you keep on purpose, such as pnpm-style linked
files: an agreed write to one of them unlinks it.

**The sandbox fences file writes and local sockets, not the network.** Apart from file writes,
hard links and Unix-domain sockets, the Seatbelt profile allows everything. Local TCP is open:
a run reached `sshd` on `127.0.0.1:22`, and only the missing credentials stopped a login. If a
private key in `~/.ssh` is in your own `authorized_keys`, `pair_run` could probably log in and
get a shell outside the sandbox; that route was not tried. `open`, `osascript` and Apple Events
are not denied either, and were not probed.

**Escaped writers are caught late, and only inside the worktree.** A process that leaves its
run's process group survives the reap and keeps the write permission its run had (test 17). A
process that got out of the sandbox altogether would write with your own permissions; the one
route probed, `launchctl submit`, was denied, but no probe proves there is no other. Either kind
is caught only by content snapshots, at the next `pair_done`, which then stops the session: the
first write is not prevented. Snapshots cover the worktree only and leave out `.git`, so a write
outside the worktree, inside an excluded directory, or after the final snapshot is not detected.

## Files

Test files (`*.test.mjs`, beside each module) are left out.

The bundled MCP server is the Claude Code half of the `pair_*` tools. Claude Code runs it from
`.mcp.json`, and each tool's checks run inside the server, on the arguments the call finally
carries. Only Claude Code uses it; OMP gets the same verbs as extension tools registered by
`omp/paired-coding-omp.ts`. Both call into the same `lib/` modules.

- `.claude-plugin/plugin.json`: the plugin manifest.
- `.omp-plugin/plugin.json`: OMP's manifest; its empty `mcpServers` hides the bundled MCP server on OMP.
- `package.json`: declares `omp/paired-coding-omp.ts` under `omp.extensions`, so `omp plugin install` registers the gate.
- `.mcp.json`: registers the bundled MCP server `pair` with Claude Code.
- `README.md`: this file.
- `skills/paired-coding/SKILL.md`: the skill the agent follows while pairing.
- `core/gate.mjs`: the gate core: pairing state, verdicts and Seatbelt profiles, with no host imports.
- `lib/verbs.mjs`: the `pair_*` verbs and session lifecycle, shared by the MCP server, the hooks and the OMP adapter.
- `lib/host-io.mjs`: file, snapshot, lock and sandboxed-process I/O, shared the same way.
- `server/pair-server.mjs`: the MCP server over stdio that serves the `pair_*` tools to Claude Code.
- `server/binding.mjs`: ties each `pair_*` call to its session through a one-shot file the hook writes; a call the hook never saw is refused.
- `hooks/hooks.json`: registers the Claude Code hooks.
- `hooks/paired-coding-hook.mjs`: the Claude Code hook handler: refusals, typed input, stop, `/clear`.
- `omp/paired-coding-omp.ts`: the OMP extension, registering the same verbs as OMP tools.
- `omp/REGISTRATION.md`: how to load the OMP extension, and how to reverse it.

## License

MIT. See the repository root `LICENSE`.
