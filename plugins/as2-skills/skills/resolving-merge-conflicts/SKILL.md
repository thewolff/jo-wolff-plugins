---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
---

<!-- owned: agent-system 2.0 row #8: `~/.agents/skills/resolving-merge-conflicts` copied once 2026-09-29 and owned from here (skills/VENDOR.md). No text changes. -->

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages, check the PRs, check original issues/tickets.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always resolve; never `--abort`.

4. Discover the project's **automated checks** and run them, typically typecheck, then tests, then format. Fix anything the merge broke.

5. **Finish the merge/rebase.** Stage everything and commit. If rebasing, continue the rebase process until all commits are rebased.

## How it fails

- The original intent of a conflicting change cannot be recovered (no PR, no ticket, a terse commit message): say which hunks were resolved on the code alone and what was assumed; do not invent behavior to bridge them.
- Both sides are incompatible and the merge's stated goal does not decide between them: stop and ask with the two readings and a recommendation; `--abort` is still not the answer.
- The project's checks cannot run after the resolution (missing toolchain, failing unrelated tests): finish the merge, report which checks did not run and which failures predate the merge.
- A conflict is in a generated or vendored file: regenerate or re-vendor from the source of truth rather than hand-merging the output; if the source is unknown, say so.
