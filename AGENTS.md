# Test bar for every plugin in this repo

Every plugin meets this bar before its pull request opens. Run a plugin's suite from its own folder (`cd plugins/<plugin> && node --test`), never from the repository root.

1. **Unit tests for `lib/`.** Each module's exported behaviour has tests, including its error paths.
2. **Hooks are tested as spawned processes.** Every `hooks/*.mjs` is run with `node`, fed the JSON Claude Code sends on stdin, and its stdout is read back as JSON. Each hook exits 0 and allows (no deny, no block) when given empty stdin, malformed JSON, a missing database, an unwritable database, a missing config file, and a 5-second budget.
3. **One end-to-end script test per plugin.** It runs the real CLI and the real hook scripts over a temporary folder, database and git repository, and follows one complete user story from start to finish.
4. **External output is tested against captured output.** A parser of another tool's output is tested against fixtures saved from real runs of that tool, never against hand-written samples. The capture script lives beside the tests, runs by hand, and is kept out of `node --test`.
5. **One live run before any pull request.** Run `claude -p --plugin-dir <plugin>` once in a throwaway repository and save the transcript as `~/agent-scratch/jo-wolff-plugins/<plugin>/live-<date>.md`.
6. **Fault tolerance.** A hook's own fault never blocks the turn or the tool call. A hook denies only on a rule, never on an error. Every denial is recorded (the ledger's bounce rows) and its message states a written way out.

Ledger 0.3.1 will enforce items 2, 4 and 6 mechanically in its push gate, as a `hook-contract` check.
