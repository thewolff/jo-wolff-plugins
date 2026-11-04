# Fixtures

Captured real output of the programs this plugin shells out to, replayed by the tests so they run
without the program, its credentials or the network.

The rule (the repository test bar, checked by `ledger gate check` before a push): **every
`<x>.txt` has an `<x>.unavailable.txt` sibling.** `<x>.txt` is the program's output on a good
run; `<x>.unavailable.txt` is its real output when it cannot run (no binary, no credential, no
network), captured by running it with an empty `HOME` and no credentials, so the adapter's
unavailable path is tested against what the program really prints rather than what we imagine.

How to capture: run the program once each way, save stdout and stderr, and scrub machine paths
(`/Users/<you>` → `~`, temp directories → `<scratch>`) and account identifiers before committing.
Name the capture in a comment at the top of the test that replays it, with the program's version.
