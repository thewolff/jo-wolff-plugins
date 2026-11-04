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

run from inside the repository the plugin is for, which writes `plugins/<name>/` under that
repository's git toplevel (`--dest <plugins dir>` names another destination; a cwd in no git
repository is refused naming `--dest`, so the kit's own checkout and the marketplace cache it is
installed from are never where a plugin lands):

| File | What it is |
|---|---|
| `lib/hook-runner.mjs` | a copy of this plugin's [`lib/hook-runner.mjs`](lib/hook-runner.mjs): `runHook(event, import.meta.url, { plugin, quiet })` reads stdin, parses it (empty is `{}`), runs the module's exported `handle(input, { env })` on a worker thread, prints its JSON, exits 0. Stdin not JSON, a thrown error, or no answer in 4 s (inside the host's 5 s budget, so the host never kills the hook and loses the message; the one timer lives on the main thread, which does nothing but wait, so it fires whatever the handler is doing: a stdin the host holds open, a promise that never settles, a synchronous loop that never yields; at the deadline the thread is terminated and an answer that would have come later is never printed as a late block) → one line in `${XDG_STATE_HOME:-~/.local/state}/<plugin>/errors.log` and `{ systemMessage: "<plugin> <event> failed open: <why>" }` (not on SessionEnd, whose output the host discards). A hook never exits 2. |
| `hooks/hooks.json` | one entry per event, `node "${CLAUDE_PLUGIN_ROOT}/hooks/<event>.mjs"`, timeout 5; tool events get a matcher |
| `hooks/<event>.mjs` | one handler per event, `handle(input, { env })` returning null (allow) until the rule is written; the header comment says what the runner does and what the handler owes. The handler runs on a worker thread (that is what makes the deadline hold), so it returns a plain JSON-able object or null and nothing else: never `process.exit()` (the thread ending is "ended without an answer", a logged fault), never its own stdout writes (only what the runner prints is the answer), a subprocess gets its `cwd` passed explicitly from `input.cwd` (the thread's `process.cwd()` is the runner's), and a child's environment goes on the spawn's `env`, not `process.env` |
| `test/hook-contract.test.mjs` | per hook: empty stdin, malformed JSON, an unknown event, an unwritable state directory, no config → exit 0 inside 5 s, no deny/block/`continue: false`; malformed JSON → one errors.log line and a systemMessage |
| `test/fixtures/README.md` | the rule that every captured `<x>.txt` has an `<x>.unavailable.txt` sibling, and how to capture one |
| `e2e/live-run.sh` | the nightly canary's live run, under the canary contract (exit 0 pass, exit 75 unavailable with the reason on the last line, stdout kept); proves the hooks ran under `claude -p`, with a slot for the plugin's own claim |
| `skills/<name>/SKILL.md` | frontmatter, steps, and the "When this can't run" section with the two bullets every plugin shares |
| `HOW-IT-FAILS.md` | the receipt: piece, fails how, visible where, the person does |
| `.claude-plugin/plugin.json`, `package.json`, `README.md` | manifests at 0.1.1 and a README with the install block and a "How it fails" paragraph |

The scaffold passes its own `node --test` and all three of `ledger gate check` as written; what
is left is the author's: the rule in each hook, the skill's steps, the receipt's rows, the
fixtures for any program shelled out to, the live run's own claim. The marketplace entry is added
by hand when the plugin is ready to publish.

The runner is copied, not imported across plugins, on purpose: an installed plugin never depends
on a sibling being installed, and a change to the kit's copy reaches a plugin only when someone
copies it again and runs that plugin's tests. The existing plugins (ledger, pattern-check,
paired-coding, …) keep their own runners; this one is for new ones.

## Agents

Two agents load from `agents/` (by the plugin-agent convention; nothing registers them), as
`plugin-kit:cross-lab-reviewer` and `plugin-kit:release-gate`. Name one in a prompt or
@-mention it to run it for certain; otherwise Claude routes by the description.

| Agent | When | What it does | Tools, model |
|---|---|---|---|
| `cross-lab-reviewer` | a plugin branch is built and its suites pass, before a PR | runs a trust preflight, reviews one snapshot of the head commit, and sends the range `<base>..<head sha>` to OpenAI Codex with `codex exec --sandbox read-only` and the release review brief: security first (hook command parsing, fail-open paths), each prior finding marked closed, partial or open, the env-only failure set (tests failing in the credential-free run, stated against the CI node pin), the `/Users/<name>` path scrub, and a `Verdict: ship` or `Verdict: fix-first` line; writes `~/agent-scratch/<repo>/<plugin>/REVIEW-<version>-codex.md` (a `-round<N>` suffix when one exists) with its triage of each finding | Read, Grep, Glob, Bash, Write; sonnet |
| `release-gate` | before a version bump, PR or publish | runs a trust preflight and checks one snapshot of the head commit, reporting pass, fail or unavailable per check with command and output: the CI node pin from the workflow job that runs the plugin's tests, the path scrub, the version across `plugin.json`, `package.json`, the README "Changes in" headings and the marketplace entry, `node --test` and `ledger gate check` (throwaway `LEDGER_DB` and `LEDGER_CONFIG`) in a credential-free environment, and the README against the plugin's hooks, skills and agents | Read, Grep, Glob, Bash; haiku |

Both agents run code from the checkout only after a trust preflight passes: `gh repo view` on
the checkout's `origin` reports `ADMIN` or `MAINTAIN` for the current user, and every such
command runs under `env -i` with a fresh `HOME` and `XDG_CONFIG_HOME` and a `PATH` of the node
folder, `/usr/bin` and `/bin`, so no `GH_TOKEN`, API key or `SSH_AUTH_SOCK` reaches it. There is
no second run in the caller's own environment. That containment strips credentials from the
environment; it does not cut the network or hide files readable by path, which is why the
permission check comes first. A failed preflight means static review only: every executable
check is `unavailable`, the reviewer's verdict cannot be `ship` and the gate line is `fail`.
Every check reads a `git worktree add --detach` snapshot of the captured head sha, named in the
report; uncommitted changes are listed, never inspected. A CI pin that no single workflow job
supplies is `unavailable` and fails the gate; plugin-kit itself has no workflow yet, so the gate
fails on it until one exists. The reviewer refuses an output path whose `<repo>`, `<plugin>`
or `<version>` is not `[A-Za-z0-9._-]+`, is `.` or holds `..`, or resolves outside `~/agent-scratch/`.

Neither edits product source, pushes, merges or installs: the reviewer's Write is for its review
file, and the gate has no Write at all. A plugin agent cannot block a single Bash command (plugin
agents ignore `hooks` and `permissionMode`), so these limits are the agents' text plus their tool
lists; a push block belongs in settings deny rules. The reviewer sends the diff and the source
Codex reads to OpenAI on the account `codex` is logged in to. OMP loads both from the plugin but
drops their `model:` lines. Each agent's "How it fails" section covers the unavailable paths: a
failed trust preflight runs nothing from the checkout; no `codex` on PATH stops the review
before a brief exists, a `codex` failure after launch keeps the brief and hands over the retry
line, and neither falls back to a Claude-only review; no `ledger` checkout, no CI pin or a
sandbox refusal marks that check unavailable, never passed. `test/agents.test.mjs` checks each
file's frontmatter, the contract, that section, and that no `/Users/<name>` other than exactly
`example` appears.

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

## Changes in 0.1.2

Two agents, `cross-lab-reviewer` and `release-gate` (see "Agents"): the Codex review brief and
the release checklist that were written by hand for each plugin release, as files. Neither runs
code from the checkout without a passing trust preflight (maintainer permission on `origin`,
credential-free `env -i`), and both check one snapshot of the head sha. The scaffolder and the
runner are unchanged.

## Changes in 0.1.1

The scaffold lands in the `plugins/` of the git repository the cwd is in (`git rev-parse
--show-toplevel`), never beside the kit: from the marketplace install 0.1.0 wrote into the plugin
cache, and from a checkout into whichever checkout held the kit. A cwd in no git repository is
refused before anything is written, naming `--dest`. The template `e2e/live-run.sh` unsets
`LEDGER_DB`, `LEDGER_CONFIG` and `LEDGER_ENABLED` before setting its own state directory, so a
caller's store is never the one a canary run touches.

## Changes in 0.1.0

First release, with ledger 0.3.3's plugin gate.
