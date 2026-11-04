# plugin-kit

Start a new Claude Code plugin in this repository that meets the test bar on day one.

The repository's `AGENTS.md` asks five things of every plugin, kind-agnostic: it can't break the
session (every hook exits 0 inside its budget on any input, never a deny or block for its own
fault), its failures are visible (an `errors.log` line and a `systemMessage`, and the unavailable
path of every program it shells out to is tested against a real capture), its text says what
to do when it can't (every skill and agent has a "When this can't run" section; every deny text
names a command), its behaviour is proved (an `evals/manifest.json` declaring what each hook
can return and one `evals/<x>.scenario.json` per event × outcome, replayed by the nightly
canary), and its state is declared and pruned (`state` in `.claude-plugin/plugin.json`, with a
prune command for anything kept for a number of days). `ledger gate check` (the ledger plugin,
0.3.5) enforces the five before a push. This plugin makes meeting them the default rather than
a retrofit.

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
| `e2e/live-run.sh` | the nightly canary's live run, under the canary contract (exit 0 pass, exit 75 unavailable with the reason on the last line, stdout kept); hands off to `lib/live-run.mjs` |
| `lib/live-run.mjs` | a copy of this plugin's [`lib/live-run.mjs`](lib/live-run.mjs), the scenario runner: replays every `evals/*.scenario.json` against the plugin's hooks in a sandbox (an empty HOME, XDG dirs and TMPDIR, a `git init`ed work directory; the caller's `LEDGER_*` and the plugin's own `<NAME>_*` env keys dropped), classifies the hooks' stdout as one outcome (`deny`, `ask`, `allow`, `systemMessage`, `silent`) and compares it with `expect`; then, when `claude` is on PATH, the pinned CLI-contract session and every scenario with a `session` under `claude -p` (`--setting-sources ""`, temp XDG dirs, `SHELL=/bin/bash`), and a `judge` rubric graded by `claude plugin eval`. Files the run left outside its work directory are printed as `wrote: <placeholder path>` for the gate's retention row. `--no-live` replays the hook phase only; `--only a,b` narrows the scenarios |
| `evals/manifest.json` | each registered event → `["silent"]` until the handler does more; `manual` for what no scenario can prove |
| `evals/<event>.scenario.json` | one stub per event, `"stub": true` with the event's well-formed input as `stdin` and `expect: "silent"`; `ledger gate check` fails the `evals` row naming it until the stub is filled |
| `scripts/prune.mjs` | the retention verb the `state` declaration names: `node scripts/prune.mjs [--days 30] [--dry-run]` removes files under `$XDG_STATE_HOME/<name>` older than that (errors.log kept) and prints `pruned: <n> file(s), <bytes> bytes freed` last; the canary records the bytes |
| `skills/<name>/SKILL.md` | frontmatter, steps, and the "When this can't run" section with the two bullets every plugin shares, naming the first event's scenario |
| `HOW-IT-FAILS.md` | the receipt: piece, fails how, visible where, the person does; rows for the scenarios, the live run and the prune verb |
| `.claude-plugin/plugin.json`, `package.json`, `README.md` | manifests at 0.1.0, with a `state` declaration (`$XDG_STATE_HOME/<name>` kept 30 days and pruned by `scripts/prune.mjs`; `$XDG_CONFIG_HOME/<name>/config.json` kept by design), and a README with the install block and a "How it fails" paragraph |

The scaffold passes its own `node --test` and four of the five `ledger gate check` rows as
written (`survives`, `visible`, `says`, `retention`); the `evals` row fails naming every unfilled
stub, which is the shape it is meant to have until the author fills the scenarios. What is left
is the author's: the rule in each hook, the skill's steps, the receipt's rows, the scenarios'
real inputs and expectations, the fixtures for any program shelled out to. The marketplace
entry is added by hand when the plugin is ready to publish.

The two runners are copied, not imported across plugins, on purpose: an installed plugin never
depends on a sibling being installed, and a change to the kit's copy reaches a plugin only when
someone copies it again and runs that plugin's tests. The plugins in this repository resolve
`lib/live-run.mjs` from `../plugin-kit/` (the template `e2e/live-run.sh` looks in the plugin's
own `lib/` first, then there), so one runner serves them all and a scaffold outside the
repository carries its own; they keep their own hook runners.

## Agents

Two agents load from `agents/` (by the plugin-agent convention; nothing registers them), as
`plugin-kit:cross-lab-reviewer` and `plugin-kit:release-gate`. Name one in a prompt or
@-mention it to run it for certain; otherwise Claude routes by the description.

| Agent | When | What it does | Tools, model |
|---|---|---|---|
| `cross-lab-reviewer` | a plugin branch is built and its suites pass, before a PR | needs a `Threat model:` line in the invoking prompt and asks for it otherwise; runs a preflight (execute authorization, permission, containment, output path), reviews one snapshot of the head commit written blob by blob with `git cat-file`, and sends the range `<base>..<head sha>` to OpenAI Codex with `codex exec --sandbox read-only` and the release review brief: security first inside the threat model (hook command parsing, fail-open paths), each prior finding marked closed, partial or open, the env-only failure set (tests failing in the credential-free run, stated as `exact` or `same major` to the CI node pin), the `/Users/<name>` path scrub, a `worst_case` and a `new-mechanism` line per finding, and a `Verdict: ship`, `ship-with-limits` or `fix-first` line under the review budget (see "Review budget"); writes `~/agent-scratch/<repo>/<plugin>/REVIEW-<version>-codex.md` (a `-round<N>` suffix when one exists) with its triage of each finding and the effective verdict | Read, Grep, Glob, Bash, Write; sonnet |
| `release-gate` | before a version bump, PR or publish | runs a preflight (execute authorization, permission, containment) and checks one snapshot of the head commit written blob by blob with `git cat-file`, reporting pass, fail or unavailable per check with command and output: the CI node pin from the workflow job that runs the plugin's tests, the path scrub, the version across `plugin.json`, `package.json`, the README "Changes in" headings and the marketplace entry, `node --test` in a credential-free environment, and the README against the plugin's hooks, skills and agents. `ledger gate check` is reported `unavailable` and never run: it checks live `HEAD`, not the captured sha, so the gate line is `fail` until ledger takes a pinned sha | Read, Grep, Glob, Bash; haiku |

Both agents run code from the checkout (the suites) only when the prompt
that invokes them carries `execute: <sha>` naming the full head sha, which the agent derives
again with `git rev-parse HEAD` and refuses on any mismatch, for example:

```
Run plugin-kit:release-gate on this checkout, plugin plugin-kit, base origin/main.
execute: <the full 40-character sha printed by git rev-parse HEAD>
```

The reviewer also needs the threat model, one line naming the attacker and the trusted
surfaces:

```
Run plugin-kit:cross-lab-reviewer on this checkout, plugin plugin-kit, base origin/main.
Threat model: a hostile repository author; trusted: my shell environment, CLI flags, ~/.claude settings
execute: <the full 40-character sha printed by git rev-parse HEAD>
```

The commands that run it then run under `env -i` with a fresh `HOME` and `XDG_CONFIG_HOME` and
a `PATH` of the node folder, `/usr/bin` and `/bin`, so no `GH_TOKEN`, API key or
`SSH_AUTH_SOCK` reaches them; there is no second run in the caller's own environment. That
containment strips credentials but not network access, and a test can still read any file you
can read by its path. So the authorization is your statement that this commit is yours to run
on this machine; write permission on `origin` (checked with `gh repo view` as well) says who may
push, not who wrote the commit, and never stands in for it. Without a matching authorization,
or with a failed permission or containment check, the run is static only: every executable
check is `unavailable: no execute authorization for <sha>` (or the reason), the reviewer's
verdict is at best `ship-with-limits` with the first limit `no executable check ran`, and the
gate line is `fail`.

Every git command either agent runs, `status` and `log` included, goes through one pinned `g`
function: `env -i` keeps only `PATH`, so no inherited `GIT_*` setting, `GIT_DIR` or global or
system config applies, and its command line turns off hooks, the pager, the `core.fsmonitor`
helper and signature verification (`log.showSignature`, which runs `gpg.program`), whatever the
repository's own `.git/config` names. A plain `git status` or `git log` runs those helpers
before any execute authorization, so the agents never run `git` another way.

Every check reads a snapshot of the captured head sha: `git ls-tree -r -z <sha>` lists every
entry and `git cat-file blob` writes each one's committed bytes into a plain file tree with no
`.git`, made without a checkout, so no checkout hook runs. Neither command reads attributes, so
no `filter` driver, `ident`, end-of-line or `export-*` conversion applies, whatever the
committed `.gitattributes`, `$GIT_DIR/info/attributes` or `core.attributesFile` says, and even
when one of them changes mid-run. Earlier drafts snapshotted with `git archive` behind an
attribute check; `git archive` rereads those sources when it runs, so a change after the check
could still start a driver, and there is no attribute check any more. `git cat-file` does not
check a blob's hash, so one `git hash-object --no-filters` over every written file must give
back each entry's blob id: a rewritten loose object, or an `objects/info/alternates` store that
answers for an id with other bytes, is `refused: hash mismatch`, not snapshotted. Last, the
sorted paths of the listing must equal, byte for byte, the sorted files on disk: a
case-insensitive volume such as default APFS puts `Docs/a.txt` and `docs/b.txt` in one folder
and cannot hold that commit, so it is `refused: name mismatch`. The block also refuses a
symlink, a submodule, a path with an empty, `.`, `..` or `.git` component, and any git or write
failure; a refused snapshot reviews nothing. On this repository (1222 files) the block took
23 s in bash and zsh, against 18 s for the earlier block without the hash and name checks: one
`cat-file` and one `mv` per blob, one `hash-object` for all of them. What can still make
the snapshot wrong is a wrong sha: it is exactly the commit `$head` names, verified blob by
blob, so both agents report that sha. Uncommitted changes are listed, never inspected. The CI
node pin comes from the one workflow job that runs the plugin's tests and is reported as
`exact` or `same major`, never as a CI result; a different major, or no single job, is
`unavailable` and fails the gate, as does a run that skips cases while the CI job sets `env:`
variables this run lacks. plugin-kit itself
has no workflow yet, so the gate fails on it until one exists. The reviewer refuses an output
path whose `<repo>`, `<plugin>` or `<version>` is not `[A-Za-z0-9._-]+`, is `.` or holds `..`,
and checks that each existing folder of `~/agent-scratch/<repo>/<plugin>/` is a real directory
(no symlink) resolving inside `~/agent-scratch/` before it creates any of them.

Neither edits product source, pushes, merges or installs: the reviewer's Write is for its review
file, and the gate has no Write at all. A plugin agent cannot block a single Bash command (plugin
agents ignore `hooks` and `permissionMode`), so these limits are the agents' text plus their tool
lists; a push block belongs in settings deny rules. The reviewer sends the diff and the source
Codex reads to OpenAI on the account `codex` is logged in to. OMP loads both from the plugin but
drops their `model:` lines. Each agent's "How it fails" section covers the unavailable paths: no
matching `execute: <sha>` or a failed permission or containment check runs nothing from the
checkout; a refused snapshot reviews nothing, whether the refusal is a link, a git failure, a
blob that does not hash to its id or a name the volume folds; a helper named in the
repository's own config never runs, because every git call goes through `g`; no `codex` on PATH
stops the review before a brief exists, a `codex` failure after launch keeps the brief and hands
over the retry line, and neither falls back to a Claude-only review; no CI pin or a sandbox
refusal marks that check unavailable, never passed, and the gate's ledger check is always
unavailable.
`test/agents.test.mjs` checks each file's frontmatter, the contract, that section, that no
`/Users/<name>` other than exactly `example` appears, and that each agent carries the
`execute: <sha>` authorization sentence and the `git cat-file` snapshot block and never
`git archive` or `git worktree add`. It also runs each agent's snapshot block, as written, in
bash and zsh against throwaway repositories: a clean one and a hostile one (committed
`filter=evil`, `ident`, `eol=crlf` and `export-subst`, a configured smudge driver,
`$GIT_DIR/info/attributes`, a global config with its own `core.attributesFile`, and
`GIT_CONFIG_PARAMETERS`) both give a snapshot whose names, bytes and executable bits equal the
committed blobs, with the driver's marker file never written, while `git archive` in the same
repository writes it. A fake `git` that points `core.attributesFile` at a filter, writes
`info/attributes` and configures the driver between the block's `ls-tree` and its first
`cat-file` changes nothing either. A symlink, a submodule, a crafted `../` path and a `.GiT`
entry are refused, and an `ls-tree` that dies, answers nothing or cuts an entry short, or a
`cat-file` or `hash-object` that fails, stops the block with a named reason. An
`objects/info/alternates` store that answers for a committed blob id with other bytes (so
`git cat-file` hands those bytes back) is `refused: hash mismatch` with nothing placed, and on a
case-insensitive volume a commit holding `Docs/a.txt` and `docs/b.txt`, or `README` and
`readme`, is `refused: name mismatch` (on a case-sensitive one it snapshots exactly). Every
inline `g` command in each agent (`status`, `log`, `diff`, `show`, `grep`, `rev-parse`,
`remote`), run as written in both shells against a repository whose own config sets
`core.fsmonitor` and `gpg.program` with `log.showSignature` to a marker helper, never runs it,
nor does the snapshot block, while a plain `git status` and `git log` in that repository run
both; and neither agent contains `git -C` outside that one `g`.

## Review budget

The reviewer has three verdicts. `ship`: no in-scope finding is open. `ship-with-limits`: no
in-scope finding is `blocking`; every open should-fix and nit is listed with one line of README
or HOW-IT-FAILS wording that states the limit. `fix-first`: at least one in-scope finding is
`blocking`, and it is allowed only then. A finding is `blocking` only when its worst case is
data loss, a write to live state outside the plugin's own state, a crash or hang, delivery to
the wrong recipient, or a security boundary violation inside the stated threat model. Every
finding carries `worst_case: <one sentence>`; an unclear severity is `should-fix`, never
`blocking` by doubt.

The invoking prompt carries `Threat model: <attacker, trusted surfaces>`, and the brief carries
it verbatim. The repository default, which the brief template shows prefilled, is:

```
Threat model: none — every input is Jo's own; review for correctness and fail-safety, not adversarial inputs
```

The literal `none` plus a reason is a valid threat model, not a missing one: it names no
attacker, so every finding that needs an adversarial input goes under `Out of scope`, and
correctness and fail-safety findings stay in scope. Only a prompt with no `Threat model:` line,
or one with nothing after the colon, makes the reviewer ask and stop. A review of something
other people feed names them, for example:

```
Threat model: untrusted PR authors; trusted: CI secrets
```

A finding that needs an attacker the line does not name, or a surface it calls
trusted, goes under `Out of scope` and leaves the verdict alone. A finding whose fix adds a new
mechanism (a lock, a token file, a hash check, a migration) is tagged `new-mechanism: true`,
and the reviewer's report lists it under `Held for Jo`, so the dispatcher holds it for a person
instead of sending it to a builder.

The round is counted from the prior review file: one more than its highest `## Round N`
heading or `-round<N>` file name. From round 2 the review only verifies the prior findings
(closed, partial or open) and runs no new probes unless the prompt carries
`new probes: "<Jo's words>"`. From round 3 on it is blocking-only and its header says
`Mode: blocking-only (round <R>)`; prior should-fix items still open become limits of
`ship-with-limits`. The agent quotes the standard it follows: OpenAI's Codex rubric ignores
nits in its verdict and Codex on GitHub posts only P0 and P1; Google approves a change that
improves code health even if it is not perfect and labels the rest `Nit:`, `Optional` or
`FYI`; Sourcery caps re-reviews at five, Bugbot autofix at three attempts, OpenAI's repair-loop
cookbook at `max_iterations = 3`, and Harel's inspections found one new fault each in
iterations 4 and 5. None of them raises the bar at a fixed round; that rule is this
repository's, after the plugin-kit agents, paired-coding and ctx-watch took five, six and four
rounds this week, each round's blocker the previous round's fix.

`test/agents.test.mjs` pins the verdict table, the `fix-first` guard sentence and the blocking
definition (and that every line naming `fix-first` names the blocking condition), the brief
template's `Threat model:` default, `Round:`, `worst_case`, `new-mechanism`, `Out of scope` and verdict
lines, the refusal without a threat model, that `none` with a reason is documented as a valid
threat model (in the agent and here), the round-cap and verification-only sentences and
the cited sources.

## How it fails

The scaffolder refuses an existing directory, a name that is not lowercase kebab, an unknown
event, or no events, with the reason on stderr and exit 1; nothing is written on refusal and
nothing is ever overwritten or deleted. A template missing from the kit (a broken install) is the
same: exit 1 naming the file. The hook runner's own failure modes are in the table above; its
test (`test/hook-runner.test.mjs`) drives each one, including the deadline in a spawned process: a
handler holding a timer that never answers, a stdin held open, a synchronous `Atomics.wait` of
6 s under the default 4 s deadline (exit inside 4.5 s wall clock). The scenario runner: a
scenario that does not parse, names an unregistered event or an undeclared outcome, has no
stdin, or is still a stub is a `fail` naming the file (the gate says the same offline); `claude`
missing → the hook phase still runs and prints, then exit 75 with `unavailable: claude not found
on PATH` last; a live session whose result cannot be read, a model that never tried the
behaviour, or a `claude plugin eval` that could not run, log in or reach the API is
indeterminate, never a pass, and a judge scenario left indeterminate makes the whole run exit
75 whatever else passed (the gate's `evals` row trusts a canary pass to mean every rubric was
graded). `test/live-run.test.mjs` drives each of these against a fixture plugin and a fake
`claude`, and `test/scaffold.test.mjs` runs a scaffold end to end in a fresh repository: the
stub fails the live run and the gate, the filled scenario passes both. The kit's tests are a
bare `node --test` (the contract-test template carries a `.template` suffix so the runner does
not pick it up: it has no plugin to test until it is scaffolded).

The reviewer's review budget fails these ways:

| Failure | What happens |
| :- | :- |
| No `Threat model:` line in the invoking prompt, or one with nothing after the colon | The reviewer asks for it in one sentence and stops before the preflight; nothing is snapshotted, sent to Codex or written. A threat model in a file, a commit message or a prior review does not count. A line that says `none` with a reason is not this case: the review runs and adversarial-input findings go under `Out of scope`. |
| A round count that cannot be read (the prior review cannot be read, or a `## Round` heading is not followed by a number) | The review is round 1, a full review, and its header says `Round: 1 (round count unreadable: <reason>)`. |
| A severity that is unclear (marked `blocking` with a worst case outside the five, or no worst case) | The finding is `should-fix`; the triage says `disagree` and names the definition it misses. Doubt never makes a finding `blocking`, so it never makes the verdict `fix-first` by itself. |
| Codex writes `Verdict: fix-first` with no in-scope blocking finding | The triage states `Effective verdict: ship-with-limits`; Codex's text stays as written beside it. |

## Changes in 0.2.1

The cross-lab reviewer has a review budget (see "Review budget"), so a review loop ends. Three
verdicts, `ship`, `ship-with-limits` and `fix-first`, and `fix-first` only on a finding whose
worst case is data loss, a live-state write outside the plugin's own state, a crash or hang,
wrong-recipient delivery, or a security boundary violation inside the threat model. The
invoking prompt carries a `Threat model:` line, and the reviewer asks for it and stops without
one; findings outside it are `Out of scope`. The repository default is `Threat model: none —
every input is Jo's own; review for correctness and fail-safety, not adversarial inputs`, which
the brief template shows prefilled. Each finding has a one-sentence worst case and a
`new-mechanism` tag, and fixes that add a mechanism are held for Jo. Round 2 verifies the prior
findings only; from round 3 the review is blocking-only. A static-only review is now
`ship-with-limits` (first limit: no executable check ran) rather than `fix-first`. The release
gate, the scaffolder and the runner are unchanged.

## Changes in 0.2.0

The scaffold meets the five-row gate ledger 0.3.5 runs, not the three-row one. New in the
scaffold: `evals/manifest.json`, one `evals/<event>.scenario.json` stub per event,
`scripts/prune.mjs` and a `state` declaration in `plugin.json`, and `lib/live-run.mjs`, the
scenario runner `e2e/live-run.sh` now hands off to (19 files, from 13). The runner replays
every scenario's hook phase in its own sandbox with no model, then under `claude -p` runs the
pinned CLI-contract session and every scenario with a `session`. A `judge` rubric is graded by
`claude plugin eval`: the runner writes a `case.yaml` (the 2.1.318 case schema, JSON body) and
a `scaffold.sh` from the scenario's `setup` under `<plugin>/live-run-cases-<pid>/` (the CLI
takes only a relative `--eval-dir` inside the plugin), runs the eval with `--no-publish --json`
and reads the verdict from the JSON, never the exit code (a case that fails to load exits 0),
and removes the directory whatever happened; the operator-gated tools the scenario's
`allowedTools` names (Bash, Write, Edit, WebFetch, `mcp__*`) are granted with `--allow-tools`.
Live sessions run with `SHELL=/bin/bash` pinned: the CLI snapshots the user's shell at startup
and sources its rc, and given `sh` it falls back to zsh (measured on 2.1.318: `$SHELL` inside
the Bash tool was `/bin/zsh`, with `ZDOTDIR` unset and set alike), so a zsh rc that writes under
the sandbox's `XDG_CONFIG_HOME` (thefuck's settings, measured) read as the plugin's own write;
bash with no rc writes nothing. A judge scenario the eval could not grade (no `claude`, not
logged in, an API error) leaves the run `unavailable` (exit 75), never a pass, even when the
contract session passed. The scaffolder's CLI guard compares real paths on both sides
(`realpathSync` of `argv[1]` and of the module), the fix ledger 0.3.5 and the other plugins
carry for their hooks: node resolves the main module through symlinks, so the earlier string
compare made the scaffolder a silent no-op when reached through one (macOS's `/var/folders`
tmpdir included), exiting 0 with nothing written. `test/live-run.test.mjs` is new; the scaffold
test runs a scaffold end to end in a fresh repository through `ledger gate check` and `ledger
canary run`.

## Changes in 0.1.2

Two agents, `cross-lab-reviewer` and `release-gate` (see "Agents"): the Codex review brief and
the release checklist that were written by hand for each plugin release, as files. Neither runs
code from the checkout unless the invoking prompt says `execute: <sha>` for the exact head sha,
and then only in a credential-free `env -i`; both check one snapshot of the head sha, written
blob by blob with `git cat-file` and checked blob by blob against its id, so no hook, filter
driver or attribute conversion runs, even when attributes or config change mid-run, and a
substituted object or a name the volume folds is refused. Every git call, `status` and `log`
included, goes through one pinned function, so no fsmonitor, gpg or pager helper from the
repository's config runs. The release gate reports `ledger gate check` unavailable rather than
run it against live `HEAD`. The scaffolder and the runner are unchanged.

## Changes in 0.1.1

The scaffold lands in the `plugins/` of the git repository the cwd is in (`git rev-parse
--show-toplevel`), never beside the kit: from the marketplace install 0.1.0 wrote into the plugin
cache, and from a checkout into whichever checkout held the kit. A cwd in no git repository is
refused before anything is written, naming `--dest`. The template `e2e/live-run.sh` unsets
`LEDGER_DB`, `LEDGER_CONFIG` and `LEDGER_ENABLED` before setting its own state directory, so a
caller's store is never the one a canary run touches.

## Changes in 0.1.0

First release, with ledger 0.3.3's plugin gate.
