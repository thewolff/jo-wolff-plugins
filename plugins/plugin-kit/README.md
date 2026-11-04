# plugin-kit

Start a new Claude Code plugin in this repository that meets the test bar on day one.

The repository's `AGENTS.md` asks three things of every plugin, kind-agnostic: it can't break the
session (every hook exits 0 inside its budget on any input, never a deny or block for its own
fault), its failures are visible (an `errors.log` line and a `systemMessage`, and the unavailable
path of every program it shells out to is tested against a real capture), and its text says what
to do when it can't (every skill and agent has a "When this can't run" section; every deny text
names a command). `ledger gate check` (the ledger plugin, 0.3.3) enforces the three before a
push. This plugin makes meeting them the default rather than a retrofit.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install plugin-kit@jo-wolff-plugins
```

## What it does

`/plugin-kit:new-plugin` (skill `new-plugin`) runs the scaffolder:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/new-plugin.mjs" <name> --events PreToolUse,Stop --description "<one sentence>"
```

which writes `plugins/<name>/`:

| File | What it is |
|---|---|
| `lib/hook-runner.mjs` | a copy of this plugin's [`lib/hook-runner.mjs`](lib/hook-runner.mjs): `runHook(event, import.meta.url, { plugin, quiet })` reads stdin, parses it (empty is `{}`), runs the module's exported `handle(input, { env })` on a worker thread, prints its JSON, exits 0. Stdin not JSON, a thrown error, or no answer in 4 s (inside the host's 5 s budget, so the host never kills the hook and loses the message; the one timer lives on the main thread, which does nothing but wait, so it fires whatever the handler is doing: a stdin the host holds open, a promise that never settles, a synchronous loop that never yields; at the deadline the thread is terminated and an answer that would have come later is never printed as a late block) → one line in `${XDG_STATE_HOME:-~/.local/state}/<plugin>/errors.log` and `{ systemMessage: "<plugin> <event> failed open: <why>" }` (not on SessionEnd, whose output the host discards). A hook never exits 2. |
| `hooks/hooks.json` | one entry per event, `node "${CLAUDE_PLUGIN_ROOT}/hooks/<event>.mjs"`, timeout 5; tool events get a matcher |
| `hooks/<event>.mjs` | one handler per event, `handle(input, { env })` returning null (allow) until the rule is written; the header comment says what the runner does and what the handler owes |
| `test/hook-contract.test.mjs` | per hook: empty stdin, malformed JSON, an unknown event, an unwritable state directory, no config → exit 0 inside 5 s, no deny/block/`continue: false`; malformed JSON → one errors.log line and a systemMessage |
| `test/fixtures/README.md` | the rule that every captured `<x>.txt` has an `<x>.unavailable.txt` sibling, and how to capture one |
| `e2e/live-run.sh` | the nightly canary's live run, under the canary contract (exit 0 pass, exit 75 unavailable with the reason on the last line, stdout kept); proves the hooks ran under `claude -p`, with a slot for the plugin's own claim |
| `skills/<name>/SKILL.md` | frontmatter, steps, and the "When this can't run" section with the two bullets every plugin shares |
| `HOW-IT-FAILS.md` | the receipt: piece, fails how, visible where, the person does |
| `.claude-plugin/plugin.json`, `package.json`, `README.md` | manifests at 0.1.0 and a README with the install block and a "How it fails" paragraph |

The scaffold passes its own `node --test` and all three of `ledger gate check` as written; what
is left is the author's: the rule in each hook, the skill's steps, the receipt's rows, the
fixtures for any program shelled out to, the live run's own claim. The marketplace entry is added
by hand when the plugin is ready to publish.

The runner is copied, not imported across plugins, on purpose: an installed plugin never depends
on a sibling being installed, and a change to the kit's copy reaches a plugin only when someone
copies it again and runs that plugin's tests. The existing plugins (ledger, pattern-check,
paired-coding, …) keep their own runners; this one is for new ones.

## How it fails

The scaffolder refuses an existing directory, a name that is not lowercase kebab, an unknown
event, or no events, with the reason on stderr and exit 1; nothing is written on refusal and
nothing is ever overwritten or deleted. A template missing from the kit (a broken install) is the
same: exit 1 naming the file. The runner's own failure modes are in the table above; its test
(`test/hook-runner.test.mjs`) drives each one, including the deadline in a spawned process: a
handler holding a timer that never answers, a stdin held open, a synchronous `Atomics.wait` of
6 s under the default 4 s deadline (exit inside 4.5 s wall clock). The kit's tests are a bare
`node --test` (the contract-test template carries a `.template` suffix so the runner does not
pick it up: it has no plugin to test until it is scaffolded).

## Changes in 0.1.0

First release, with ledger 0.3.3's plugin gate.
