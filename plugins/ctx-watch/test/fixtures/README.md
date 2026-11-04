# Fixtures

Captured real output of the programs this plugin shells out to, replayed by the tests so they run
without the program, its credentials or the network.

The rule (the repository test bar, checked by `ledger gate check` before a push): **every
`<x>.txt` has an `<x>.unavailable.txt` sibling.** `<x>.txt` is the program's output on a good
run; `<x>.unavailable.txt` is its real output when it cannot run, so the adapter's unavailable
path is tested against what the program really prints rather than what we imagine.

All captures: ctx 2.3.0, macOS, 2026-11-04, by `capture.sh` (run by hand; not part of
`node --test`). Scrubbed: `/Users/<you>` → `/Users/example`, the throwaway data root →
`/Users/example/.ctx`.

| File | What | How it was made |
|---|---|---|
| `ctx-daemon-status.txt` | a healthy daemon: `running: true`, `status: "running"`, `supervisor.status: "installed"`, a fresh `core_refresh.last_run_at_ms`, `jobs.semantic_index.status: "ready"` (recaptured 2026-11-04 13:00) | `CI=true ctx daemon status --format json` against the real managed install (read-only under CI) |
| `ctx-daemon-status.unavailable.txt` | ctx not on PATH | `env -i PATH=/usr/bin:/bin ctx daemon status --format json` (exit 127) |
| `ctx-daemon-status-not-running.txt` | a killed daemon: `running: false`, `status: "stale_lock"`, `supervisor.status: "fallback"` | a throwaway data root (`--data-root`), `ctx index mode auto` to start a fallback daemon, `kill <pid>`, then `ctx daemon status --format json` with CI removed |
| `ctx-daemon-status-not-running.unavailable.txt` | the same ctx-missing line (the sibling rule) | as above |
| `ctx-daemon-status-semantic-not-ready.txt` | the 2026-11-04 03:00 capture: daemon healthy, `jobs.semantic_index.semantic_enabled: true`, `status: "budget_exhausted"`, taken while `ctx search --format json` reported `semantic_status: unavailable` / `semantic_fallback: flat-F32 projection is missing, stale, partial, or not pinned to Core generation …` | `CI=true ctx daemon status --format json` against the real managed install at the time (it was the healthy fixture of 0.1.0; kept under this name when the healthy one was recaptured) |
| `ctx-daemon-status-semantic-not-ready.unavailable.txt` | the same ctx-missing line (the sibling rule) | as above |
| `ctx-index-mode.txt` | `ctx index mode --format json`: `config_path`, `indexing.mode: "auto"` | against the real install (read-only) |
| `ctx-index-mode.unavailable.txt` | ctx not on PATH | as above |
| `ctx-index-mode-auto.txt` | the repair succeeding: `daemon.running: true`, a new `pid`, `supervisor.status: "fallback"` (a custom data root has no launchd supervision) | throwaway data root, daemon absent, `ctx index mode auto --format json` with CI removed |
| `ctx-index-mode-auto.unavailable.txt` | the repair refused under CI: `Error: ctx daemon start was suppressed (ci); …` (exit 1) | throwaway data root, daemon absent, `CI=true ctx index mode auto --format json` |

Two cases the tests need and ctx could not be made to print without breaking a real
installation are **derived in the test** from `ctx-daemon-status.txt` by changing exactly one
field, named where it happens (`test/probe.test.mjs`): `supervisor.status` set to
`install_failed` (the 2026-10-28 failure, seen then in `~/.ctx/daemon/supervisor.json`), and
`core_refresh.last_run_at_ms` moved 3 h back (staleness is also tested by moving `now`); and
the semantic rows: `jobs.semantic_index.status` set to `pending`, `failed`, `unknown` or removed,
`semantic_enabled` set to `false`, and the whole `semantic_index` block removed.

`evals/fixtures/fake-ctx.sh` replays `ctx-daemon-status*.txt` (with every `last_run_at_ms` set
to now) and `ctx-index-mode.txt` for the hook scenarios, through `CTX_WATCH_CTX`.
