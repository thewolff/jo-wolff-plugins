# Fixtures

This plugin shells out to one program, `git` (`branch --show-current`, `status --short`,
`log --oneline`, `rev-parse`), and the tests run it for real against a repository they create
under a temp directory (`test/helpers.mjs` `box()`), so there is nothing to capture here: the
unavailable path (`git` missing, a cwd that is not a repository, a branch with no upstream) is
exercised in `test/lib.test.mjs` by pointing the snapshot at a plain directory, and every git
call in `lib/snapshot.mjs` and `lib/handoffs.mjs` swallows its failure to an empty string that
the snapshot names as an absent section.

The repository rule (every `<x>.txt` has an `<x>.unavailable.txt` sibling) applies the day a
fixture is added.
