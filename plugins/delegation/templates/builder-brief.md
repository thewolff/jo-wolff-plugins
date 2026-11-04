# Builder brief

Copy this into the `prompt` of a builder-class spawn and fill every section. The spawn gate reads two headings literally (`## How it fails`, `## Spiral bound`; any heading level, case does not matter) and nothing else, so the headings stay as written. A refusal from the gate carries the missing section in full, so a brief can also be repaired from the refusal alone. The builder report ends with the `Stopped because:` line.

## Target

Repository, branch or worktree, the files in play, and what is out of scope.

## Change

The steps, in order, with the interfaces each one has to keep.

## Acceptance

What the parent will check, exactly: the command, what green looks like, what is reported back.

## How it fails

- What breaks if this is wrong, and where it shows first (a test, a log line, a user-visible surface).
- What recovery looks like: the undo command, the file to restore, the migration to roll back.
- The retry bound per failing step: one retry, then the failure is reported as a named item rather than chased.

## Spiral bound

- Retry bound: one retry per failing step. The second failure of the same step stops the work on that step.
- Commit budget: at most N commits (name N). Past it, stop and report what remains.
- When acceptance cannot be met: report what was tried, the exact failure, and the last green state. Do not loosen the check, skip the step, or substitute an easier problem.
- Time or tool budget, when there is one: name it.

## Report

End the report with exactly one of these lines, as the last line:

```
Stopped because: acceptance met
Stopped because: bound hit
Stopped because: told to stop
```

`acceptance met` means every acceptance check above passed once. `bound hit` means a retry, commit, time or tool bound stopped the work before acceptance; name which after it, as in `Stopped because: bound hit (commit budget)`. `told to stop` means the parent sent a stop. Nothing else is a valid value, and a builder-class report without the line draws a warning: shown to the user on Claude Code, added to the parent's context on OMP.
