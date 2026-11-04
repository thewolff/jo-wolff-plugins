# Changelog

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
