---
name: handoff
description: Write an agent-authored handoff note to the repository's `.ai/handoffs/` before stopping, so the next session resumes with judgment intact instead of starting from amnesia. Records mid-flight state (what was in progress, what to try next, what was already ruled out, what is still uncertain), the layer the pre-compaction snapshot cannot derive. Invoke when the user says "hand off" or signals they are stopping mid-investigation; when the continuity context-pressure check has just said this session is near its compaction target; or on your own judgment when a session is pausing mid-flight with real state to lose. Not for trivial or finished work.
---

# Session handoff

Write notes to the next session, not to the team. The next session wakes with no memory of
this one; these files are the only thing it inherits beyond the repository itself.

The continuity plugin's PreCompact hook already saves the deterministic facts (branch,
uncommitted paths, files touched, recent asks) to its state directory and injects them after
compaction. It deliberately does not infer what was being attempted, what was ruled out, or
what is still open: only the session holds that, and only while it is running. This skill is
where that judgment is written.

**Top-level sessions only.** A subagent has no session of its own to hand a future session to;
its context ends when it reports back to its parent. A subagent with judgment worth preserving
puts it in its report, not in a handoff file.

## Step 0: confirm a trigger fired

Handoffs are sharded per `(session_id, lane)`, so a spurious run only touches its own lane's
file. Still, a run with no real state to capture adds a thin file the next session has to skim
past. Invoke when:

- The user asked for a handoff, or signalled they are stopping mid-investigation.
- The continuity context-pressure check (a `continuity: this session is roughly N% of the way
  to auto-compaction` line with your prompt, or a blocked stop carrying the same text) fired.
- You judge, unprompted, that the session is pausing mid-flight with next-move context worth
  preserving: not at the end of an ordinary completed task, and not because a pause feels
  natural.

If none of these hold, **stop and say so in one line**, "nothing in flight worth handing off",
and write no file. That is a successful outcome, not a skipped step.

## What a handoff is, and what it is not

A handoff records what is still in your hands: mid-flight state, the next move, live
uncertainty. It is transient (gitignored, read for 7 days, then ignored). Anything settled, a
decision and its reason, a durable flag for the team, belongs in the repository's own record
(a decision log, a PR description, a commit message), not here: these files are short-lived
and anything durable in them is lost with them. Finished something cleanly: record it there.
Stopping mid-investigation: write a handoff. Did both: handoff first, while context is deep.

## Resolving the handoff root

Resolve the root directory in this exact order. The reader (`lib/handoffs.mjs`, which the
PreCompact snapshot uses) resolves it the same way, and a divergence here writes the handoff
somewhere it never looks:

1. `$CLAUDE_PROJECT_DIR`, if set and the directory exists.
2. The main worktree root: run `git rev-parse --path-format=absolute --git-common-dir` and
   strip a trailing `/.git`. Use `--path-format=absolute`; plain `--git-common-dir` can return
   a relative path.
3. `git rev-parse --show-toplevel`.
4. The current working directory.

Handoffs live at `<root>/.ai/handoffs/`.

## Identifying this handoff: session_id and lane

- **`session_id`** is the `CLAUDE_CODE_SESSION_ID` environment variable, or the session id the
  host gave you. It identifies the top-level session; every lane written by this session shares
  it.
- **`lane`** is a kebab-case slug naming the workstream. Take it from an explicit lane argument
  if one was given (`/continuity:handoff redis-cache` gives lane `redis-cache`); otherwise derive
  it from the work in flight. A session that opens a new, unrelated workstream mid-session picks
  a new lane: each lane is one line of work, not one session.
- **`branch`** (the git branch) is recorded separately in frontmatter. It is not the lane: two
  lanes can share a branch, and a lane can outlive a branch switch.

## Write-or-update, not overwrite

Before writing, look in `<root>/.ai/handoffs/` for a file whose frontmatter `session_id`
matches this session **and** whose `lane` matches the target lane.

- **Match found**: update that file in place: refresh `created` to now, rewrite the body. Keep
  the existing filename.
- **No match**: create a new file. A new lane in the same session is always a new file. A
  different session is always a new file, even for a lane name that happens to repeat.

## Filename and frontmatter

Directory: `<root>/.ai/handoffs/` (create it if missing). Timestamp and author in the name, so
concurrent people and lanes never collide:

```
<root>/.ai/handoffs/<YYYY-MM-DD>--<HHMM>--<author>--<lane>.md
```

- `YYYY-MM-DD` / `HHMM`: local wall clock at write time, 24h zero-padded.
- `author`: engineer or agent name, lowercase, spaces to hyphens.
- `lane`: the kebab-case lane slug from above.

Make sure `<root>/.ai/.gitignore` contains the line `handoffs/`; create the file if it is
absent. These files are never committed.

File contents: frontmatter plus the body sections below, in this exact order:

```markdown
---
session_id: <id>
lane: <kebab-slug>
author: <engineer or agent name>
branch: <git branch>
created: <ISO8601>
status: open
---

# Session handoff: <lane>

## Where I left off
One paragraph. What was actively in progress at the moment of stopping, and how far it got.

## Next move
The single most useful thing the next session should do first, and why that one.

## Already ruled out
Approaches tried and abandoned, each with the reason. This is the highest-value section:
it is the part the next session cannot reconstruct and will otherwise re-attempt.

## Live uncertainty
Open questions, unverified assumptions, decisions deferred. Carry any CLAIM/CITE labels and
the hedges forward exactly; something only remembered must not arrive next session reading as settled.

## Working state
Branch, uncommitted changes, anything half-applied, any command left running.
```

`status` is one of `open`, `consumed`, `superseded`. Always write `status: open` for a fresh or
refreshed handoff. The resuming session sets `consumed` when the lane's work is picked up and
finished, and a later handoff on the same lane sets the older one `superseded` when it replaces
that one's guidance without literally overwriting it. Only `open` handoffs are shown.

## Rules

- **Author it yourself.** The value of these files is that they are written by the session that
  holds the context. Do not summarize the transcript mechanically; the PreCompact snapshot
  already captures the deterministic facts. Do not duplicate what it records.
- **Label only receipted facts.** If the output-types plugin's contract is loaded, follow it:
  CLAIM with a receipt, CITE with a fetched source; everything else unlabeled. Without it, label
  nothing. A handoff is read by a session with no way to check your work, so a label on an
  unreceipted sentence here is the most expensive kind of error.
- **Never write secrets, tokens, or env values** into this file.
- **No git writes.** Writing the handoff is a file write and nothing more. Do not commit, stage,
  or branch as part of this skill.
- **Say it is written.** Report the path and a one-line summary so the person knows the handoff
  landed before the session ends.

## Consuming handoffs

Open handoffs under `.ai/handoffs/` less than 7 days old are inlined into the pre-compaction
snapshot, so a session that resumes after compaction sees them: the newest 3 in full (each cut
at 120 lines, with the cut named), one index line each for the rest, and the suppressed count.
A fresh session that is asked to resume reads `<root>/.ai/handoffs/` itself, newest first.

On reading them:

1. **Restate before continuing.** Before acting on a handoff, say in your own words what the
   lane is and what is pending on it: the content, not the file name or the lane slug. Assume
   zero carryover between sessions. Resuming a session is structurally a standup, and the
   failure mode is "I have no idea what I was doing since the last one".
2. Treat each as its author session's account, not as verified fact. Its CLAIMs carry receipts
   you can spot-check; its unlabeled statements are unverified.
3. Start from the most relevant lane's **Next move** unless the person directs otherwise.
4. Do not re-attempt anything under **Already ruled out** without saying why you are revisiting
   it.
5. A lane's file is stale the moment its work is picked back up. Update it in place (per
   Write-or-update above) rather than leaving a second file for the same lane, and set
   `status: consumed` when the lane is finished.
6. If a lane shows several open handoffs, start from the newest; mark the older ones
   `superseded` once their content is carried forward.

## When this can't run

- The snapshot's handoff section is absent after a compaction, or the restored state says
  `No handoff was written before compaction`: no open handoff under 7 days old was found at the
  resolved root. Look in `<root>/.ai/handoffs/` yourself (a handoff with `status: consumed`,
  or older than 7 days, is not shown); if there is none, say you are reconstructing, not
  resuming. The scenario that proves the inlining is `evals/pre-compact-with-handoff.scenario.json`;
  the restore is `evals/session-start-restore.scenario.json`.
- `git rev-parse` fails (not a repository, or `git` is missing): the root is the current working
  directory, step 4 above. Say which root you wrote under.
- `<root>/.ai/handoffs/` cannot be created or written (permissions, a read-only checkout): tell
  the person the path and the error, and put the five sections in your final reply instead, so
  the content reaches them in the transcript.
- The context-pressure line printed `continuity <event> failed open: <why>`: the hook let the
  turn through without its check; the line is also in
  `${XDG_STATE_HOME:-~/.local/state}/continuity/errors.log`. Tell the person once; do not treat
  the session as checked.
- No `/continuity:handoff` command (the plugin is not installed where `CLAUDE_PLUGIN_ROOT`
  points): write the file by hand following the shape above, and say that you did.
