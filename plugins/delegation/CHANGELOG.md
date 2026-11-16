# Changelog

## 0.1.6 - 2026-11-12

- README, Config: a file with a wrong-typed field is ignored whole by every hook except the session-brief gate, which reads it field by field (`loadConfig`'s `partial`, since 0.1.5) and keeps `off: true` and its own `checks` entry. The README said every hook ignored such a file whole. Docs only; no code changed.

## 0.1.5 - 2026-11-11

- New `hooks/session-brief-gate.mjs`, PreToolUse on `mcp__ccd_session__start_session` (the desktop app's tool for starting or offering a session). A `tool_input.prompt` that lacks any of the heading lines `Target`, `Change`, `Acceptance`, `How it fails`, `Spiral bound` is denied; the reason starts `Session start refused:`, names the missing headings and the tool, says each heading line holds the heading alone (`# Target: the repo` does not match), and carries each missing section in full.
- Silent on a full brief, on a `proposal_id` call with no prompt (starting an offered card), and with `off: true`. A prompt that is missing or not a string is allowed with one skipped.log line.
- Config `checks["session-brief-gate"]`: `block` (default), `warn` (one additionalContext line, the call goes ahead), `off`.
- `lib/brief.mjs` gains `TARGET_SECTION`, `CHANGE_SECTION`, `ACCEPTANCE_SECTION` (held equal to `templates/builder-brief.md` by the tests), `SESSION_HEADINGS`, `missingSessionHeadings`, `sessionHeadingReason`, `sessionHeadingWarning`.
- The SessionStart block, the template intro and the skill's "When this can't run" each gain one sentence about the new gate. Four new scenarios in `evals/` and one manual item for the desktop proof.
- An unclosed code fence in the original prompt no longer swallows the sections the refusal tells the model to append (session gate only; the spawn gates keep the CommonMark reading). The heading match is a linear scan, so a line with thousands of trailing spaces no longer eats the 4 s deadline, and a very long prompt after an unclosed fence no longer overflows the stack. An invalid unrelated config field no longer discards `off: true` or this gate's `checks` entry (`loadConfig` also returns `partial`, read only by this gate; every other hook still gets defaults). The SessionStart skeleton puts each heading alone on its line, so it passes the gate it describes.
- `hooks/spawn-gate.mjs` appends one JSON line per Agent/Task spawn it examines to `${XDG_STATE_HOME:-~/.local/state}/delegation/routing.jsonl` (new `lib/routing-log.mjs`): timestamp, session id, cwd, `subagent_type`, the model set, the table's model and ceiling for the type, an outcome (`match`, `warned-above`, `no-model` (a listed type that set no model; the spawn inherits the parent model, which may be above the ceiling), `unmapped`, `not-checked`) and the spawn's description; never the prompt. Past 1 MiB the file is renamed to a unique archive, `routing.jsonl.<UTC stamp>-<pid>-<4 hex>`, so two hooks rotating at once can never overwrite each other's archive, and only the three newest archives (names matching that pattern exactly) are kept. The rename runs under an exclusive `routing.jsonl.lock` (a lock older than 10 s is moved aside and taken over only if it still holds the stale token seen; release removes only the releaser's own lock) with the size re-read under the lock, so a race at the cap does not cut a one-line archive that would displace a full one; a hook that finds the lock held just appends. A failed write is one errors.log line and changes no spawn decision; a failed rotation is one errors.log line `routing log not rotated: <code>`, and the line is still appended. Config `logModelRouting` (default `true`); `false` turns it off. New `routingOutcome` in `lib/model-routing.mjs`. Why: a one-week review reads this log beside the subagent transcripts.
- Why: a hook-input capture in the desktop app on 2026-11-11 showed PreToolUse firing for this tool with a string `prompt`, and the model issuing the call again after a deny.

## 0.1.4 - 2026-11-11

- The report guidance now says to lead with the outcome in the first sentence (what happened or what was found), then what changed, what was verified, what could not be confirmed, and anything needing the owner's decision. It sits in the Report section of `templates/builder-brief.md` (and `STOPPED_SECTION` in `lib/brief.mjs`, which the template must match), in `agents/builder.md`, in the `delegation` skill, and in the SessionStart brief. The `Stopped because:` rule is unchanged and stays the last line. Nothing new is enforced; no hook logic changed.
- Why: only 9 of 28 recent subagent reports led with the outcome. Anthropic's Opus 5 prompting guidance says a report's first sentence should say what happened.

## 0.1.3 - 2026-11-11

- `agents/reader.md` runs on `model: sonnet` (was `opus`), the routing table's model for reading and mapping code. It is the pilot: no other agent's model changed.
- `hooks/spawn-gate.mjs` reads `tool_input.model` on a spawn the gates allow and compares it with the routing table's ceiling for the `subagent_type`. Above the ceiling: one `additionalContext` line naming the agent type, the model asked for and the ceiling. No `model` on a listed type: one line naming the table's model for it. At or under the ceiling, or a type the table does not list: nothing. It never denies on model, and a refused spawn carries no model line; gates 1, 4 and 2 and their deny texts are unchanged.
- The table is data in one file, `lib/model-routing.json` (the family order `haiku`, `sonnet`, `opus`, `fable`, and a `model` and `ceiling` per agent name), read through `lib/model-routing.mjs`. A table that cannot be read, or a model string naming no single family (`inherit`), is one `skipped.log` line and no warning.
- Config `warnModelRouting` (default `true`); `false` turns the line off.
- Not checked, because the hook cannot see it: the effort level (the Agent tool's input has no such field), the model of the session doing the spawning, and the model an agent definition pins when a spawn sets none. The OMP adapter has no model line.

## 0.1.2 - 2026-11-04

- `scripts/prune.mjs` is plugin-kit 0.4.1's template, re-copied: after the age pass it rotates every log under the state directory past 256 KiB (errors.log included) to `<name>.1`, replacing the previous `.1` and counting its bytes as freed, so an appended log is bounded; `--dry-run` prints `would rotate …` per log. The `pruned:` line and the `state` declaration are unchanged. Only `*.log` rotates here: its `.jsonl` files are state read back whole.
- The re-copied prune skips symlinks (a linked `x.log` is never rotated over its `.1`) and a dry run no longer counts an expired `.1` twice: its totals are the real run's (plugin-kit 0.4.1's fix).
- `e2e/live-run.sh` honours `--no-live` on its own command line: it runs the offline hook phase, then exits 75 with `unavailable: live phase skipped (--no-live); N hook scenario(s) passed offline` last, like the other plugins' scripts. Before, it forwarded the flag only to the helper and always went on to its own `claude -p` run.

## 0.1.1

- `lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was 0.2.1's): the handler thread's
  env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, a process group
  the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits, and it now
  waits for stdout to drain before it exits, bounded by the same deadline, so an
  answer larger than one 64 KiB pipe buffer is no longer cut short (a host that never reads gets
  exit 0 at the deadline and one `stdout not drained` errors.log line). delegation's
  hooks register none, so what they answer is unchanged; the 4 s deadline, and the hooks.json
  timeout of 5 s against it, are unchanged.

## 0.1.0

First release: the delegation seam, on Claude Code and OMP. Teaching first, gates as backstop.

- The `delegation` skill (`skills/delegation/SKILL.md`): when to delegate and to which agent,
  the brief's sections in order, the Spiral-bound rules, the `Stopped because:` line, the
  CLAIM/CITE line, and one worked example.
- A SessionStart block (`hooks/session-start.mjs`; OMP: a hidden custom message once per
  session) under 25 lines with the brief skeleton inline, so a fresh session knows before its
  first spawn.
- Four spawn gates on `Agent`/`Task` (Claude Code, `hooks/spawn-gate.mjs`) and on the `task`
  tool (OMP, `omp/delegation-omp.ts`): a brief with no `## How it fails` heading is refused; a
  builder-class brief also needs `## Spiral bound` and a pattern-check receipt for the session
  (`<git root>/.pattern-check/<session_id>.md`, or pattern-check's state copy). The deny reason
  carries the missing section in full as a fill-in template (so the brief is repaired from the
  refusal alone), or the exact pattern-check command.
- A PostToolUse check on `SendMessage` (`hooks/send-message-check.mjs`): `success: false`
  becomes `decision: "block"` with the tool's own message plus "this message was NOT delivered;
  spawn a new agent or fix the name". On OMP, a failed `write agent://…` gets the same
  instruction as additionalContext.
- A SubagentStop warning (`hooks/subagent-stop.mjs`; OMP `task` results): a builder-class report
  without a final `Stopped because: acceptance met | bound hit | told to stop` line draws a
  systemMessage that quotes the exact line to add. Never a block.
- Eleven agents ported from newdle 0.2.175 (`agents/`): auditor, builder, changelog, checker,
  debugger, planner, reader, research, scout, storyteller, summarizer, with the shipyard, Linear
  and `.projects/` lines removed; the list is in the README.
- Three hooks ported from newdle 0.2.175: `delegation-guard` (oversized reads, long direct
  streaks, whole-tree searches; warns by default, `block` by config; newdle's `ask` tier is
  dropped), `worktree-spawn-guard` (a worktree spawn from a dirty tree or a workspace root; warns
  by default, `block` by config) and `repo-rules-inject` (the rules chain of a file the launch
  directory did not load, once per session per file).
- Config at `${XDG_CONFIG_HOME:-~/.config}/delegation/config.json`: `off`, `builderClass`,
  `requireHowItFails`, `requireSpiralBound`, `requirePatternCheck`, `checks`, the thresholds.
  Missing = defaults; malformed = defaults plus one systemMessage naming the file.
- Every hook runs under plugin-kit's fail-open runner with a 4 s budget; a gate that cannot judge
  its input lets the call through and writes one line to
  `${XDG_STATE_HOME:-~/.local/state}/delegation/skipped.log`.

### Before release, from the first review

- OMP: each task is judged on the shared `context` plus its own `task`; the single-task form is
  judged; a top-level `agent` applies to entries without one; the teaching block is offered
  again after `session_compact`.
- Headings: a trailing parenthetical is accepted; a heading inside a fenced code block no longer
  counts.
- `readOnlyAgents` config (default `reviewer-codex, reviewer, auditor, scout, reader, research,
  beefy-research, security-reviewer, summarizer, changelog, checker`): never builder-class, so
  no Spiral bound, receipt or stop warning; `## How it fails` still applies.
- Gate 2: skipped with a skipped.log line when pattern-check is not installed; the deny names
  `requirePatternCheck: false`; cache versions sort numerically.
- Stop warning: worded for the user (a SubagentStop `systemMessage` reaches the user, not the
  parent model); an empty `agent_type` is not builder-class; `Stopped because:` may carry a
  detail and backticks and must be the last non-empty line.
- delegation-guard: the streak resets on PostToolUse `Agent|Task`, so a denied spawn does not
  reset it; line counting stops at the threshold.
- hooks.json timeouts 5 s (the runner's deadline is 4 s).
- Every agent has a `## When this can't run` section; `research` drops `web_search` from
  `tools:`.
- `evals/manifest.json` and scenarios for every hook × outcome; `plugin.json` `state`;
  `scripts/prune.mjs`.

### Before release, from the second review

- OMP: a `readOnlyAgents` entry is exempt from every gate, `## How it fails` included, matching
  Plumb's own How-it-fails gate; the other entries of the same `task` call are still judged.
  Claude Code's spawn gate is unchanged.
- `e2e/live-run.sh` step 1 checks for a SessionStart `hook_response` in the stream-json
  (Claude Code 2.1.318 hook events carry no script path, so the old grep always failed the
  canary); step 2 still proves this plugin's teaching block arrived.
- Stop warning: the header comment says SubagentStop's `additionalContext` goes to the subagent,
  not the parent; the README documents two limits: in auto mode a report handed back through
  `SubagentHandback` is not in `last_assistant_message` and the SubagentStop input has no field
  for it, and a session run as `--agent builder` sees the warning for internal agents.
