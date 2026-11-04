# Test bar for every agent-facing artifact in this repo

This bar covers everything an agent loads or runs: plugins, settings hooks, mods, skills, agent definitions, and MCP or CLI adapters. Each one meets it before its pull request opens. Run a plugin's suite from its own folder (`cd plugins/<plugin> && node --test`), never from the repository root.

1. **Unit tests for `lib/`.** Each module's exported behaviour has tests, including its error paths.
2. **Hooks are tested as spawned processes.** Every `hooks/*.mjs` is run with `node`, given on stdin the JSON Claude Code sends, and its stdout is read back as JSON. Each hook exits 0 and allows (no deny, no block) when given empty stdin, malformed JSON, a missing database, an unwritable database, a missing config file, or a 5-second budget.
3. **One end-to-end script test per plugin.** It runs the real CLI and the real hook scripts over a temporary folder, database and git repository, and follows one complete user story from start to finish.
4. **External output is tested against captured output.** A parser of another tool's output is tested against fixtures saved from real runs of that tool, never against hand-written samples. The capture script lives beside the tests, is run by hand, and stays out of `node --test`.
5. **One live run before any pull request.** Run `claude -p --plugin-dir <plugin>` once in a throwaway repository and save the transcript as `~/agent-scratch/jo-wolff-plugins/<plugin>/live-<date>.md`.
6. **Fault tolerance.** A hook's own fault never blocks the turn or the tool call. A hook denies only because a rule says so, never because of an error. Every denial is recorded (the ledger's bounce rows), and its message states a written way out.

Ledger 0.3.1 will enforce items 2, 4 and 6 mechanically in its push gate, as a `hook-contract` check.

## Per kind

| Kind | What it must have | How it is tested |
| :- | :- | :- |
| Hooks (plugin and settings) | Runs through the shared fail-open runner: a fault becomes an allow and one logged line, never a deny or a block. | As a spawned process, with the fault inputs from item 2. |
| Mods | Every handler is wrapped: an error is logged and passed on with `next(e)`, and the handler never throws past its wrapper. | With `claude plugin test`, the [Claude Code mod test harness](https://code.claude.com/docs/en/plugins/mods/test.md) (automated tests that run without a session), with the same fault inputs as hooks. |
| Skills | A required section, "When this can't be done". It has one line for each tool, file or command the skill names, saying what the agent does and what it tells the human when that thing is missing. | A check that the section exists and has one line for each tool, file or command the skill names. |
| Agent definitions (`.md`) | A "How it fails" section, and the model declared in the frontmatter. | A check that the section and the model field exist. |
| MCP and CLI adapters | A timeout; a path that records the tool as unavailable (missing binary, non-zero exit, timeout, empty reply) and never blocks on it. | Fixtures captured from real runs (item 4), including an unavailable fixture, with a test that the adapter maps it to unavailable. |

For skills and agent files the push check is structural (the section exists), not behavioural; whether the failure lines are followed is judged later from the bounce ledger.

A check whose waive rate exceeds about one third over a week is wrong, not the authors; the first bounce review decides which checks stay.
