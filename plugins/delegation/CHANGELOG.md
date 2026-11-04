# Changelog

## 0.1.1

- `lib/hook-runner.mjs` is plugin-kit 0.3.0's, byte for byte (was 0.2.1's): the handler thread's
  env also carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, and a process group
  the thread registers with `{ kitReap: <pgid> }` is killed when the runner exits. delegation's
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
