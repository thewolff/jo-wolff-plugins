# jo-wolff-plugins

Plugins about working with an agent: what its output is made of, what shape that output
arrives in, when it may write code at all, whether it has looked for what the repository already
has, whether the thing is worth building in the first place, going through your reminders with
it, keeping a record of what it did and asked, and a vendored set of engineering skills.

- **[output-types](#output-types)** — label receipted facts, and only those, with the receipt
  that earns the label.
- **[i-have-audhd](#i-have-audhd)** — how to write to someone who is ADHD and autistic, with the
  research behind each rule and a Stop hook that warns when a message buries what they need.
- **[paired-coding](#paired-coding)** — pair with the agent one change set at a time, behind a
  gate that refuses writes you have not agreed to.
- **[ask-graham](#ask-graham)** — answer "should we build X?" with one engineer's stated
  judgment and a single verdict, when you ask or on every new idea.
- **[pattern-check](#pattern-check)** — before big work, the agent finds the existing pattern for
  each new piece and records reuse, replace or new; hooks hold writes, commits and PRs until it has.
- **[reminders-review](#reminders-review)** — go through your open Apple Reminders one at a
  time: the agent answers, confirms before acting, and closes each one only when you say yes.
- **[ledger](#ledger)** — a durable, id'd record of the questions an agent asks you and the
  choices it makes without asking, in one SQLite file. It records every session everywhere until
  you switch a folder off with `/ledger:disable`; hooks keep every question and your plain-words
  answer on a row.
- **[plugin-kit](plugins/plugin-kit/README.md)** — start a new plugin here that meets the test
  bar on day one: the fail-open hook runner, one handler per event, the five-fault contract test,
  the scenario runner and the canary live run, a scenario stub per event, the prune verb and
  state declaration, and a skill with its "When this can't run" section, scaffolded by
  `/plugin-kit:new-plugin`; `ledger gate check` passes on it, the `evals` row excepted, before
  the first rule is written, and that row fails naming the stubs until they are filled.
  Changes in plugin-kit 0.2.1: the `cross-lab-reviewer` agent has a review budget: verdicts `ship`, `ship-with-limits` and `fix-first` (only on a blocking finding), a required `Threat model:` line, a one-sentence worst case per finding, and blocking-only reviews from round 3.
  Changes in plugin-kit 0.2.0: the shared scenario runner `lib/live-run.mjs` and the evals, prune
  and state scaffold templates. Changes in plugin-kit 0.1.2: two agents, `cross-lab-reviewer` (a Codex review of the branch) and `release-gate` (the release checklist, report-only).
- **[as2-skills](plugins/as2-skills/README.md)** — the 22 engineering skills of agent-system 2.0,
  vendored from four upstream skill packs at pinned releases, with frontmatter claude.ai accepts.
  Install with `/plugin install as2-skills@jo-wolff-plugins`; skills only.
  Changes in as2-skills 0.1.2: every skill has a "How it fails" section, and the manifest
  declares the one path a skill writes outside the worktree (`$TMPDIR/seo-audit-*`), the bar
  ledger 0.3.5's `gate check` enforces; see the plugin's
  [release notes](plugins/as2-skills/README.md#changes-in-012). Changes in as2-skills 0.1.1:
  the triad and quorum fan-out scripts ship their `lib/leg-runner.sh`.
- **[ctx-watch](#ctx-watch)** — notice when the ctx daemon is dead, unsupervised,
  or stale, repair it with the one command ctx documents, and say so at SessionStart and in a
  macOS popup from a launchd timer; the SessionStart line also says when the timer itself has
  stopped. macOS; Claude Code hooks, plus a CLI that works anywhere.

output-types delivers text and does not read what the agent sends back; see its *delivers, does
not enforce* note. i-have-audhd delivers its rules and checks every finished message, warning by
default. paired-coding enforces at the tool boundary, within the limits in its *what this
enforces, and what it does not* note. ask-graham is a skill, a one-line prompt nudge you can
turn off, and a Stop check that blocks once per turn when an answer that read the skill has no
verdict line (or, for a structure check, no `**Found:**` or `**No similar:**` line), which
`/ask-graham stop-check off` turns off.
reminders-review and as2-skills are skills only. pattern-check enforces at the tool boundary: it
holds writes, commits and PRs past a file threshold until a receipt exists, and does not judge
the receipt.

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install output-types@jo-wolff-plugins
/plugin install i-have-audhd@jo-wolff-plugins
/plugin install paired-coding@jo-wolff-plugins
/plugin install ask-graham@jo-wolff-plugins
/plugin install reminders-review@jo-wolff-plugins
/plugin install pattern-check@jo-wolff-plugins
/plugin install ledger@jo-wolff-plugins
/plugin install as2-skills@jo-wolff-plugins
/plugin install plugin-kit@jo-wolff-plugins
/plugin install ctx-watch@jo-wolff-plugins
```

On OMP, from a shell:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install output-types@jo-wolff-plugins
omp plugin install i-have-audhd@jo-wolff-plugins
omp plugin install paired-coding@jo-wolff-plugins
omp plugin install ask-graham@jo-wolff-plugins
omp plugin install reminders-review@jo-wolff-plugins
omp plugin install pattern-check@jo-wolff-plugins
omp plugin install as2-skills@jo-wolff-plugins
omp plugin install plugin-kit@jo-wolff-plugins
omp plugin install ctx-watch@jo-wolff-plugins
```

Inside a running OMP session the commands are `/marketplace add` and `/marketplace install`, with
the same arguments. `/plugin install` inside OMP installs nothing. On OMP output-types delivers its
skill only; its hooks do not run there. i-have-audhd and paired-coding install OMP extensions
that run their hooks, and ask-graham installs its prompt nudge (see each section). plugin-kit
is a skill and a script, so it works on both. ctx-watch's SessionStart line is Claude Code
only; its skill, CLI and launchd timer work on both. ledger is Claude Code only.

To update, update each harness separately. On OMP, refresh the marketplace first, because
`omp plugin upgrade` installs the version in OMP's cached copy of it:

```
claude plugin update <plugin>@jo-wolff-plugins
omp plugin marketplace update jo-wolff-plugins
omp plugin upgrade <plugin>@jo-wolff-plugins
```

Then relaunch OMP sessions. OMP's own install wins over Claude Code's for the same plugin, so
updating Claude Code alone leaves OMP on the older copy. `node scripts/check-omp-install.mjs`
compares the two installs and prints the commands for any plugin that differs (exit 1).

## output-types

A plugin that makes an agent label the receipted facts it returns — CLAIM for what it checked this
session, CITE for what an outside source says — and attach the receipt that earns the label.
Everything else stays plain prose, and unlabeled means not backed by a receipt, so a reader can
tell what was checked from what was assumed.

The problem it addresses: an agent's report is one stream of confident prose. A fact read out of a
file, a fact half-remembered from training, and a number nobody re-derived all read the same.
Labeling only the receipted ones separates them: the reader trusts a label and weighs the rest
themselves.

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install output-types@jo-wolff-plugins
```

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install output-types@jo-wolff-plugins
```

Inside a running OMP session, use `/marketplace add thewolff/jo-wolff-plugins` and then
`/marketplace install output-types@jo-wolff-plugins`. `/plugin install` inside OMP installs
nothing: it prints the installed-plugin list and returns.

**On OMP only the skill loads.** Tested on OMP 18.4.4: OMP does not run a plugin's
`hooks/hooks.json`, so the session-start hook never fires and the core is never injected. The
skill is listed and loads on demand, so the contract is in force only once the model has read
it. Name the skill in your instructions if you want it from the first turn.

### What you get

- **Two labels**, each with the receipt that earns it, and the rule that a receipt rather than
  confidence sets the label.
- **Seven rules** that catch the most: third-party semantics are never vocabulary; a receipt
  licenses only what it literally shows; a figure reused in a new context is a new claim.
- **What unlabeled prose still owes**: actions state their command, result and undo; a decision
  for the reader goes last and restates its subject; a report that could not meet the contract
  says so at the top.
- The rules for **handing a command to a person to run**.
- A **session-start hook** that emits the operative core before the first tool call, reading it out
  of the contract file so there is only ever one copy of that text. Claude Code only; see *Install
  on OMP*.

Changes in 0.2.0: only receipted facts are labeled, as CLAIM or CITE. The GUESS, PMDW, ACTION and
QUESTION labels, the `<!-- output-types … -->` envelope and the numbered degradation tiers are
gone; unreceipted statements, actions, questions and degraded coverage are plain prose. The whole
contract now lives in `skills/output-types/reference.md`, which the skill points at and the hook
injects from.

Changes in 0.2.1: a hook fault (contract file missing, unreadable or without its markers, or the
hook's own module failing to load or loading broken) now appends one line naming the hook file
and the reason to `${XDG_STATE_HOME:-~/.local/state}/output-types/errors.log`, and the one-line
warning reaches you as well as the model and says where the reason went. `OUTPUT_TYPES_INJECT=off`
is read first, so it silences the hook even when the install is broken. The hook no longer waits
on a stdin pipe its caller leaves open: it reads for at most one second, then injects.

Changes in 0.2.2: the plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares
what the session-start hook can return (the core as a `systemMessage`, or silence under
`OUTPUT_TYPES_INJECT=off`), one `evals/<x>.scenario.json` proves each, and the core scenario
carries a `session` and a `judge` rubric the nightly canary runs under `claude -p` and grades
with `claude plugin eval`. `e2e/live-run.sh` hands off to plugin-kit's scenario runner.
`.claude-plugin/plugin.json` declares the one state path (`$XDG_STATE_HOME/output-types`, 30
days) and `scripts/prune.mjs` prunes it. The skill has a "When this can't run" section.

### What this does, and what it does not do: it delivers, it does not enforce

Two pieces, and it is worth knowing which does what before you install.

**The session-start hook puts the core in front of the model before the first tool call.** A
contract that governs every assertion cannot be delivered by a mechanism that fires in response to
an assertion, and the first assertion of a session is usually in the first turn. So the hook emits
the operative core at session start, and it is in force from turn one. It reads that text out of
`skills/output-types/reference.md`, between the markers, rather than carrying its own copy. There
is one copy of the core and it cannot drift from the contract.

**The skill points at the full contract and loads on demand**, matched against its description:
receipts, the seven rules, rendering, degraded reports, handed-over commands. Once read, the text
stays in context for the rest of the session.

**Nothing here enforces anything, and that is the part to be clear about.** Both pieces deliver
text. Neither one reads what the agent sends back. On the machine this was extracted from there is
also a conformance guard that inspects a returned report and tells the parent what it actually got
— unlabelled facts, a claim with no receipt. **That guard is not in this package and is not being
extracted.** So do not read an installed copy of this plugin as a guarantee: a report that comes
back with every fact bare will come back exactly that way, and
nothing here will catch it. What you get is a contract the model has read, not a contract the
model has been held to.

Two things help in practice. Name the skill in the delegation prompt for any agent you dispatch,
and say so in your own instructions if you want more than the core in force from the start.

If you want the injection off without uninstalling the plugin, set `OUTPUT_TYPES_INJECT=off` in the
environment; the hook then emits nothing and the skill still loads on demand.

If the core did not load, the session still starts and shows one line saying so. The reason is in
`${XDG_STATE_HOME:-~/.local/state}/output-types/errors.log`, one line per failure, or in the warning
itself when that log cannot be written.

### Developing output-types

The tests run with `node --test` from inside `plugins/output-types/`.

## i-have-audhd

How to write to someone who is ADHD and autistic. The two halves pull opposite ways — ADHD wants
short and new, autism wants complete and exact — and the rules resolve that by ordering, never by
cutting content: what the reader must know goes first, what they must choose goes last, and every
reference survives without scrolling.

Renamed from `communication-rules` in 1.0.0. Before uninstalling a configured old plugin,
follow the package README's [upgrade recipe](plugins/i-have-audhd/README.md#upgrading-from-communication-rules):
the opt-in tool preserves your private profile and disabled state without loader aliases.
Old logs stay archived; resume markers are not carried forward.

### Install

It needs `node`: Claude Code runs its hooks as `node <hook>.mjs` from your `PATH`, and the OMP
adapter runs them under node resolved to an absolute path (`I_HAVE_AUDHD_NODE` pins one).
Three steps:

1. **Add the marketplace and install.** Claude Code:

   ```
   /plugin marketplace add thewolff/jo-wolff-plugins
   /plugin install i-have-audhd@jo-wolff-plugins
   ```

   OMP, from a shell (inside a running OMP session the commands are `/marketplace add` and
   `/marketplace install` with the same arguments; `/plugin install` inside OMP installs
   nothing):

   ```
   omp plugin marketplace add thewolff/jo-wolff-plugins
   omp plugin install i-have-audhd@jo-wolff-plugins
   ```

2. **Choose a judge.** Five of the eleven Stop-hook checks (`do-not-batch-by-label`,
   `conclusion-first`, `restate-resumed-thread`, `report-what-you-did-not-do`,
   `bad-news-first`) need a model to read the message, and they stay off until you pick one. In a
   terminal, run the setup tool from the marketplace copy you just added:

   ```
   node ~/.claude/plugins/marketplaces/jo-wolff-plugins/plugins/i-have-audhd/tools/setup.mjs
   ```

   On OMP the same file is at
   `~/.omp/plugins/cache/marketplaces/jo-wolff-plugins/plugins/i-have-audhd/tools/setup.mjs`.
   Either copy configures both hosts: they read one profile, `~/.claude/i-have-audhd.json`.
   The tool checks `node`, lists the judges (the Claude Code CLI, the Codex CLI, OMP, a command
   you type, or none), makes one test call to the judge you pick, shows the JSON it will write,
   and writes `enforcement.judgeCommand` only after you type `yes`. Choosing none writes
   `"judgeCommand": null` and leaves those five checks off. Run it again any time to change the
   choice.

3. **Start a new session.** If you skipped step 2, the first session shows a one-time notice
   naming the five checks that are off and the exact setup command.

OMP does not run a plugin's `hooks/hooks.json`. The install registers the plugin's OMP extension,
`omp/i-have-audhd-omp.ts` (registered on omp 18.8.6), which runs the same two hooks, the
session-start injection and the Stop check, for the main session only, not for subagents; OMP has
no blocking equivalent of Claude Code's `SubagentStop`. `omp/REGISTRATION.md` carries the manual
fallback and an isolated live probe.

### What you get

- **The skill**: eleven rules, each with its reasons and sources in `references/`.
- **A session-start injection** of the skill's first-turn core — the message skeleton, the
  options rule, reference survival, commands, and three machinery anchors — plus every rule
  heading, read out of `skills/i-have-audhd/SKILL.md` between its markers so there is one copy.
- **A Stop hook** that checks every finished message with eleven checks (six deterministic, five
  judge-gated) and names the skill rule behind each finding.
- **A prompt hook** that delivers the last checked message's warn findings to the agent with
  your next prompt, once, as a short notice carrying the fix.
- **An optional operator profile** you write on your own machine, so the rules can name a real
  addressee and adapt to how that person reads. The repository ships only a generic example
  (`example.i-have-audhd.json`). **Keep your profile out of version control if it describes a
  real person.**

### What this does, and what it does not do: it warns, it does not block

Every check warns by default: findings land in `~/.claude/.i-have-audhd-state/warnings.log`, the
turn ends normally, and the agent gets the findings with your next prompt so the fix applies from
its next message on. A 2026-09-21 corpus adjudication found no check whose false-positive rate
supports blocking by default, so block is a deliberate profile setting, per check or global; on
OMP it also needs `enforcement.armOmp: true`. The five judge-gated checks stay inactive until you
choose a judge (install step 2), and each fired trigger is logged to `skipped.log`.

`touch ~/.claude/.i-have-audhd-off` disables the Stop hook within one turn.
`I_HAVE_AUDHD_INJECT=off` turns the injection off; the skill still loads on demand. The package
README and `skills/i-have-audhd/reference.md` carry the schema, every check's contract, and the
measured rates.

Changes in 1.6.1: `links-resolve` warns when a link in the message does not open: a local path
in backticks that does not exist, a GitHub URL with no such page shape, a sentence that calls an
issue a PR, or (from a local cache a detached helper fills, never a live call) a target GitHub
says is missing or is the other kind. A sentence that says the file is still to come is not
checked. `links-judge`, off by default, asks the judge whether the linked thing is what the
sentence says it is. Every judge failure line now names its cause (revoked credential, no
credential, rate limit, judge self-abort, hook deadline, bad JSON, other), with session,
harness, model, timing, section and a replayable prompt file; the notice states the cause and
its fix.

Changes in 1.6.0: two new checks. `handed-command` warns when a message hands you a shell command
that is not one `zsh /absolute/path/script.sh` line with its script in a scratch directory
(`~/agent-scratch` by default) outside every git checkout (rule 10); commands quoted as evidence do not
count. `link-the-reference` warns when a line names a PR, an issue or a file with no link to it on
the same line (rule 11); receipts, fenced code and `→` evidence lines never count. A new profile
field, `inject`, switches the session-start rules and the Stop checks independently (`full`,
`rules` or `none`) and, in its object form, switches each of the eleven rules on or off: a rule
switched off leaves the injection, and the checks bound to it go quiet. The package README's
*What you can turn on and off* lists every switch with its default. The kill-switch file still
wins over every value.

Changes in 1.5.2: the plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares
what each of the three hooks can return and seven `evals/<x>.scenario.json` prove them
(injection on and off, the pending-warning relay and the quiet prompt, the Stop hook's default
warn, its plural block, and the judge-gated warning replayed from the captured real-judge
output); `e2e/live-run.sh` hands off to plugin-kit's scenario runner. The three state paths are
declared (`~/.claude/.i-have-audhd-state`, 30 days, pruned by `scripts/prune.mjs`; the profile
and the off file kept by design) and the skill has a "When this can't run" section. Fix: the
Stop hook and the four check scripts compared `import.meta.url` with `file://${process.argv[1]}`
as strings, and node resolves the main module through symlinks, so reached through one (macOS's
`/var/folders` tmpdir, where `ledger gate check` snapshots the plugin) the Stop hook never ran
and exited 0 with nothing printed and nothing logged; the guards now compare real paths.

Changes in 1.5.1: a hook's own fault is no longer silent. Empty or malformed stdin, a throw, an
unparseable profile, or a state file that cannot be written leaves one line in `errors.log` and
one warning line; the hook still exits 0 and blocks nothing. Every block reason now ends with the
way out: `touch ~/.claude/.i-have-audhd-off`, or the check's `enforcement.rules` key set to
`"warn"`.

## paired-coding

A plugin for pairing with an agent on code, one change set at a time. The agent drives and you
navigate. Before each change set it shows you a **card** naming the decision inside the change,
the code it touches, the code it plans to write, the effect it will have and the exact files it
will write. It writes only after the two of you agree on that card, then shows you the real diff.

The problem it addresses: agent code arrives faster than a person can recognise the decisions
inside it, so a wrong direction is found after a whole feature exists. Pairing moves the
decision point to before each change set is written, while it is still cheap to steer.

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install paired-coding@jo-wolff-plugins
```

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install paired-coding@jo-wolff-plugins
```

Inside a running OMP session, use `/marketplace add thewolff/jo-wolff-plugins` and then
`/marketplace install paired-coding@jo-wolff-plugins`. `/plugin install` inside OMP installs
nothing: it prints the installed-plugin list and returns.

Tested on OMP 18.4.4, the install registers the gate as an OMP extension: the eight `pair_*`
tools appear natively in every omp process you run, in any repository, with no `-e`. It stays
inert until `pair_start`, so a session that never pairs is untouched. The bundled MCP server is
built for Claude Code and is hidden on OMP. `omp plugin upgrade` keeps the gate registered, and
`omp --no-extensions` starts a process without it. To remove it, run
`omp plugin uninstall paired-coding@jo-wolff-plugins`.
`plugins/paired-coding/omp/REGISTRATION.md` also has the routes that load the gate without
installing the plugin.

### What you get

- **A skill** that runs the session: define the work, recon into a roadmap of cards, then a
  loop of card, discussion, agreement, the change set, and a read-back with the diff.
- **A roadmap you can leave and come back to.** Cards can be marked not ready, and a later
  session in the same worktree offers to pick up the unfinished ones; you can decline.
- **A gate at the tool boundary** on Claude Code (hooks plus a bundled MCP server) and on OMP
  (an extension). While pairing, the host's own write, edit, shell, eval and sub-agent tools are
  refused; the agent writes and runs commands only through the plugin's `pair_*` tools, and
  its own writes land only in the agreed change set's files, temp directories and the state of
  the ledger and pattern-check plugins (see **Changes in 1.4.3**). Every run sits under a
  sandbox (Seatbelt on macOS, Landlock or bubblewrap on Linux) that fences the files the run
  writes itself and its local Unix-socket connections, not the network, so a run can still
  ask a process outside the sandbox to write for it.
- **A journal** of every card, quote, verdict, refusal and diff, kept outside the worktree.
- **A stop only you can give:** pairing ends when you type `pair stop` as a message of its own.

Changes in 1.4.4: the plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares
what each of the five hooks can return and nine `evals/<x>.scenario.json` prove them (the
write denied and the inert hook at PreToolUse, the pairing-on and stop-queued prompts, the
fresh and carried-over session start, the session end leaving its carry, the Stop hook judging
a queued turn; scenarios that need pairing on run `evals/pair-start.mjs`, the same `pair_start`
verb the MCP server exposes), with the typed-agreement path and `pair stop` listed under
`manual`; `e2e/live-run.sh` hands off to plugin-kit's scenario runner. Every refusal now ends
with the standing way out: pairing ends when your partner types `pair stop` as a whole message.
The journal directory (`~/.local/state/paired-coding`, 30 days, pruned by `scripts/prune.mjs`)
and the per-run temp directories are declared as state, and the skill has a "When this can't
run" section.

### What this enforces, and what it does not

**It enforces the write boundary, not your agreement.** The agent judges when you have agreed
and quotes your words to open a change set. The gate checks that the quote is whole words from
a turn you typed after the card, that the card has no open points and that its files have not
changed since you saw it. It cannot check that those words meant yes. A misread go-ahead can
open a change set, but only for that card's files, and the quote sits in the journal for you to
audit.

**It runs on macOS and Linux, on two hosts.** The gate is built for Claude Code and OMP and was
tested live on both, on macOS. On Linux it uses Landlock, through a small helper the plugin
ships, when the kernel has Landlock ABI 3 or later, and bubblewrap otherwise. Landlock fences
writes per file, except that new files under a glob entry are fenced per directory; bubblewrap
fences some writes per directory and needs unprivileged user namespaces. The Linux sandboxes
were tested in an Ubuntu container, and neither host has been run live on Linux. Codex is
unverified. Elsewhere the skill runs as conversation and nothing at the tool boundary stops a
write.

**Some of it rests on undocumented host fields, and fails closed.** On Claude Code, "you typed
it" is read from transcript fields Claude Code does not document. If they change, every turn
reads as untrusted and pairing can never open a change set; it does not open one by mistake.

**The sandbox fences a run's own writes, not the network.** Local services over TCP stay
reachable from a run, `sshd` on `127.0.0.1` included, and `open`, `osascript` and Apple Events
are not blocked, so a run can ask a process outside the sandbox to write for it.

**A process that escapes the sandbox is caught late.** It is caught at the next read-back, and
only if it writes inside the worktree.

The plugin's own README carries the full list, with the evidence behind each line.

Changes in 1.4.3: the ledger and pattern-check plugins keep working while pairing is on. Each
ends a reply with a Stop hook that demands its CLI run (`ledger.mjs ask`, `pattern-check.mjs
record`); with the host shell refused and `pair_run` fencing every write outside the agreement,
those runs failed (`EPERM` on `<worktree>/.pattern-check/`, "database read-only" on the
ledger's SQLite file) and the reply could neither finish nor be let go. Now `pair_run` may
write that state in both phases, boundary or no boundary, under every sandbox: the ledger's
database with its `-wal` and `-shm` sidecars at `~/.agent-system-2/ledger.db`, at the ledger's
default `~/.local/share/ledger/ledger.db`, and wherever `LEDGER_DB`, the ledger's config file
or the nearest `.ledger.json` points it; `<worktree>/.pattern-check/`; and
`~/.local/state/ledger/` and `~/.local/state/pattern-check/`. One list (`lib/sibling-state.mjs`)
feeds the Seatbelt profile, the bubblewrap binds and the Landlock rules, so the three grant the
same paths. A carve-out never reaches the worktree root, `.git`, the state directory or a
protected path, is dropped when it sits above one of them, and before every run the tree
under a carve-out directory is looked at on every backend, every entry of it, within a budget
(a hard-linked file, an entry that cannot be read, a `.git` entry, a mount point there, or a
tree too large to finish looking at refuses the run by name); snapshots leave
`.pattern-check/` out, so a receipt written there is not drift at `pair_done`. While pairing,
ledger and pattern-check calls go through `pair_run`: the host shell stays refused for every
command (the host runs it outside the fence, with its own environment), and the refusal for
a sibling call says to run the same command with `pair_run`, where the kernel decides where
its writes land. Before launching one, `pair_run` refuses by name a call whose shape no hook
demands (anything but `node <script> <subcommand> …` with the script `ledger.mjs` or
`pattern-check.mjs`, spelled plainly, existing and resolving inside
`~/.claude/plugins/cache/jo-wolff-plugins/` or `~/.claude/plugins/marketplaces/`, and a
subcommand among `ask`, `answer`, `note`, `outcome`, `pending`, `doctor`; `open`, `record`,
`status`; a `--cwd`, `--config` or `--db` argument; `disable`, which writes a product
`.ledger.json`) and one that, worked out the way the CLI does from the worktree root and the
environment the run gets, would write outside the carve-outs (the ledger's database from
`LEDGER_DB`, the nearest `.ledger.json` or the user config; pattern-check's `receiptDir`
under the nearest `.git` root; a config file planted inside a carve-out directory; a
backslash in any path, which the CLIs keep as a filename character), naming the destination
and the config that named it. The run's environment is the host's less `NODE_OPTIONS`,
`NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_V8_COVERAGE`, `NODE_REDIRECT_WARNINGS` and
`NODE_COMPILE_CACHE`, on every host, through one function. The plugin README's gate section
has the full table and the Linux limits (a grant there needs an existing inode). Also in
1.4.3: on Claude Code, `SessionEnd` removes the state directory of a session that never
called `pair_start` (it held only queued typed input and stashed notices), under the session
lock and after a second look for the activation marker, so a `pair_start` landing as the
session ends is kept, and the lock is released only by its holder (a token file named by
the holder's pid inside the lock, removed before the lock directory, which the kernel keeps
while anything else is inside; a release that cannot remove its token fails instead of
reporting success), so no release lets go of another holder's lock. A lock is taken over
only when the pid its token names is not running and the lock is stale, by removing that
one token by name; a lock whose holder is still running is never evicted on its age, and
the wait fails naming the pid and the recovery command, `node <plugin>/bin/pair.mjs unlock
--stale <lock directory>`, which makes the same check. That command acts only on
paired-coding's own lock directories inside the state base (any other path, or a symlink
out of it, exits 2 untouched); its refusal of a running pid explains pid reuse and never
advises ending a process, and `--force` clears a reused pid's lock only when that pid's
command line names neither `paired-coding` nor `pair-server`. A token naming the waiting
process itself is reported as a non-reentrant lock attempt. A release failure the locked
work's error cannot carry (a frozen error) goes to `errors.log`, and the work's error is
thrown unchanged. A session that paired keeps its
directory, journal and receipt included, and a directory that will not go is one warning
and one `errors.log` line, never a failed end.

Changes in 1.4.2: a fault in any hook appends one line to `errors.log` in the plugin's state
directory and shows one warning, and never blocks a session that is not pairing. While pairing,
for `pair_*` tools, or when the gate cannot tell whether pairing is on, the tool is still refused,
and the refusal names the tool and the way out (`pair stop`, or disabling the plugin). The OMP
adapter's `tool_call` handles these faults the same way.

Changes in 1.4.1: a prompt typed in the Claude Desktop app counts as typed. Any other
programmatic prompt is still refused as untrusted.

Changes in 1.4.0: every card shows the planned code before you agree, unprompted, and
`pair_propose` takes it as a `proposedCode` field on both hosts.

## ask-graham

A skill that answers "should we build X?" the way Graham, a frontend engineer, says he decides:
five gate questions, a short list of red flags, the 2-minute rule from GTD, and fewer lines wins.
It ends in exactly one verdict: **do it now**, **start now**, **later**, or **don't build**,
with a breakdown scaled to the size of the work.

Every check asks "Do you want me to research and see if something comparable exists?"
No keeps the search local; yes adds open-source and commercial options, screened by gates
then ranked with pros, cons, and dated, sourced stats; stars, age, forks, and followers stay context only.

The problem it addresses: an agent asked "can we build X?" hears "build X". It does not stop to
ask why, whether something already does it, or who will maintain it, so the backlog fills with
things that were cheap to start and expensive to keep.

Graham agreed to be named and quoted: "100%. Nothing would make me happier." His answers are in
the plugin, verbatim, typos included.

The package README is [`plugins/ask-graham/README.md`](plugins/ask-graham/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ask-graham@jo-wolff-plugins
```

Then ask "should we build X?", or type `/ask-graham <the thing to build>` on Claude Code or
`/skill:ask-graham <the thing to build>` on OMP. To have it run on every new idea as well, see
*When it runs* below.

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install ask-graham@jo-wolff-plugins
```

Inside a running OMP session, use `/marketplace add thewolff/jo-wolff-plugins` and then
`/marketplace install ask-graham@jo-wolff-plugins`. `/plugin install` inside OMP installs
nothing: it prints the installed-plugin list and returns.

Tested on OMP 18.8.6, the install lists the skill and registers the prompt nudge as an OMP
extension (`omp/ask-graham-omp.ts`, declared in the plugin's `package.json`): with the level at
`every-idea`, the nudge reached the model request ahead of the message, and with a repo file at
`ask` it did not. A Claude Code install alone does not give OMP the nudge; install on OMP too.

### What you get

- **Graham's five gate questions**, answered from evidence (the repo, its issue tracker, its
  backlog files) rather than put back to you. Apart from the comparables question, you are asked only what
  no tool can settle: who will own it, or which reason matters to you.
- **A search for what already exists** before anything else, delegated to a subagent when it
  spans repos.
- **Graham's red flags** for technical asks: an enum invented for a platform you do not control,
  a JSON round-trip, JSON built by hand, and a homegrown type system where an established one
  exists.
- **One verdict**, then a breakdown only as deep as the work needs: High Level Design, epics,
  stories, tasks of hours to a few days, each with acceptance criteria and no prescribed code.
- **Every rule tagged with its source**: *Graham #N* for his words, *Jo* for the author's
  overrides, *Skill* for mechanics the skill adds. The skill never presents its own mechanics as
  Graham's view.
- **A structure check** for tasks inside a decided project: before one writes a new table, a new
  column on an existing table, a new top-level module or a new service, the skill searches what
  else hangs off the same parent and reports what it found, or plainly that it found nothing
  similar. It gives no verdict and does not ask the comparables question.
- **A level you set**, `ask` or `every-idea`, for how eagerly it runs (next section).

Changes in 0.7.3: a reply that waits on the comparables question must also carry step 1's
`**Ask:**` line and step 3's five `**Gate questions**` bullets; the Stop check blocks it once
otherwise, naming what is missing, so the question can no longer stand in for the judgment.

Changes in 0.7.2: the plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares
what the two hooks can return and four `evals/<x>.scenario.json` prove them (the every-idea
nudge and the quiet prompt at `ask`; the Stop check blocking a reply with no verdict, with a
`session` and a `judge` rubric the nightly canary runs under `claude -p` and grades with
`claude plugin eval`, and letting one with a verdict through); `e2e/live-run.sh` hands off to
plugin-kit's scenario runner. The state directory (`$XDG_STATE_HOME/ask-graham`, 30 days) is
declared and `scripts/prune.mjs` prunes it; the skill has a "When this can't run" section.
Fix: `scripts/upkeep.mjs` compared `import.meta.url` with `file://${process.argv[1]}` as
strings, and node resolves the main module through symlinks, so reached through one it did
nothing and exited 0; the guard now compares real paths.

Changes in 0.7.1: the Stop check reads the reply from the Stop payload's
`last_assistant_message`, and no longer takes Claude Code's telemetry entries as the newest entry
of the conversation, which had let a reply with no verdict through and blocked one that had a
verdict. An unreadable block record now lets the stop through. The Claude Code hooks no longer
fail silently: a fault still lets the prompt or stop through, and now lands in `errors.log` with
the hook file and reason and shows one warning line.

Changes in 0.7.0: adds the structure check. Its reply opens with `**Structure check:**` and then a
`**Found:**` or `**No similar:**` line, which the Stop check requires in place of a verdict line.
The every-idea nudge names the structure check.

### When it runs

Two levels:

- **`ask`**, the default. The skill runs on `/ask-graham` or an explicit "should we build
  this?" / "is it worth building?". Its description is written so nothing else matches.
- **`every-idea`**. It also runs whenever you propose a new project, product, feature or tool
  that does not exist yet. A hook adds one short line to each of your messages telling the agent
  to run the check if the message is a new idea, to run the structure check if it is a task that
  creates a new table, column, top-level module or service, and to ignore the line otherwise. On
  Claude Code that is a `UserPromptSubmit` hook; on OMP an extension on the `before_agent_start`
  event. At `ask` neither adds anything.

At both levels it does not run on a ticket or issue, a bug fix, a task inside an
already-decided project (apart from the structure check above), or a request to continue
existing work. Deciding which messages are new ideas is left to the agent: the hook does not
classify anything, so a ticket can still draw a check if the agent misreads it.

The level comes from the first of these that exists:

1. the nearest `.ask-graham` in the working directory or any directory above it, so one file
   at a workspace root covers every repository and worktree under it;
2. `${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/config`;
3. the default, `ask`.

Each file holds `intensity=ask` or `intensity=every-idea`. A file that names neither counts as
`ask`, so a typo in a file meant to turn the level down cannot turn it up. The same files take a
second line, `stop-check=off`, to turn off the Stop check that blocks once when an answer that
read the skill has no `**Verdict:**` line (default `on`). A reply ending with the exact
comparables question alone on its final line may wait for an answer without a verdict, when a
`**Ask:**` line and the five `**Gate questions**` bullets come before it. To change either from a session (on
OMP, write `/skill:ask-graham` in place of `/ask-graham`):

```
/ask-graham intensity                    # show both settings and which file set each
/ask-graham intensity every-idea         # set your level
/ask-graham intensity ask --here         # override it for this repository
/ask-graham stop-check off               # turn the Stop check off for you
/ask-graham stop-check off --here        # turn it off for this repository only
```

Without a session, run the script directly with the same arguments:
`node <plugin dir>/skills/ask-graham/scripts/intensity.mjs [every-idea|ask | stop-check on|off] [--here]`.

A `.ask-graham` written with `--here` sits untracked in the repository's root. Add it to
`.git/info/exclude` if you do not want to commit it.

### Where Jo overrides Graham

Graham listed type systems as something he would kill or defer. The skill does not follow him
there: using types is never counted against an ask. Building your own type system when an
established one exists is a red flag, and that flag is Jo's, not Graham's.

### Your own open-work sources

Open work does not all live in the repo. List the other places on your machine in
`${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/sources.md`, one bullet per source with the
read-only command or path to check:

```markdown
- **Prior sessions:** `my-history-tool search --limit 5 -- "<the ask>"`
- **Open work items:** `sqlite3 -readonly ~/work/tracker.db "SELECT id, title FROM items WHERE status='open';"`
- **Decisions waiting on me:** `~/notes/HELD.md`
```

The file is optional; without it the skill checks the repo, its issue tracker, and any backlog
file the project's `AGENTS.md` or `CLAUDE.md` names. Keep it out of version control: it
describes your machine. Every source in it is read-only to the skill.

### Developing ask-graham

The tests run with `node --test` from inside `plugins/ask-graham/`. Uninstall, update, and the
rest of the details are in the package README.

## pattern-check

Before an agent does big work in a repository, it has to look for the repository's existing way
of doing each thing it is about to add, decide reuse, replace, or new-with-reason for each, and
write that down. A PreToolUse hook holds the work until it has: from the Nth distinct file a
session writes (3 by default), it denies further writes, `git commit` and `gh pr create` until
the session has a receipt.

The receipt is a table with one row per new piece and nine columns. The first four answer "what
exists already": `new piece`, `existing pattern (file:line)`, `reuse / replace / new`, `reason`.
The last five answer "how does it fail", before the piece is written: `fails how`, `next step`,
`restart-safe`, `bounded`, `evidence kept`. The script refuses a row whose fail cells are empty,
a placeholder (`-`, `?`, `TBD`, `todo`, `unknown`), or `n/a` without a reason, and names the row
and column it refused.

The problem it addresses: a design review that asks "where did this introduce a new pattern when
an existing one served?" keeps coming back with a long list. Agents start writing before they
have read what is already there. This plugin makes the reading mandatory and the result
inspectable. The package README is
[`plugins/pattern-check/README.md`](plugins/pattern-check/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install pattern-check@jo-wolff-plugins
```

Node 18 or later is needed on `PATH`.

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install pattern-check@jo-wolff-plugins
```

Inside a running OMP session, use `/marketplace add thewolff/jo-wolff-plugins` and then
`/marketplace install pattern-check@jo-wolff-plugins`.

### What you get

- **The skill**: the method. List every new piece, grep the repository for its nouns and verbs,
  read what sits beside it in the same router, registry or directory, and end each piece as
  `reuse`, `replace` or `new` with a reason, plus the five fail columns.
- **The script** (`scripts/pattern-check.mjs`): `open`, `record` and `status`. The receipt is
  Markdown at `<repo>/.pattern-check/<session>.md`. When the work adds no new piece,
  `record --no-new-pieces "<why>"` writes a one-line receipt.
- **A PreToolUse hook** that counts the distinct files a session touches through Edit, Write,
  MultiEdit, NotebookEdit and the obvious shell writes, and from the Nth file on denies those
  tools, `git commit`, `gh pr create`, redirects, `sed -i` and `tee` into the repository until
  the receipt exists. The deny text names the exact command to run.
- **A Stop hook** that refuses, once, a reply proposing a plan or design when the session has no
  receipt.
- **Configuration** in an optional user or repository JSON file: the threshold, extra commands
  to deny, the receipt directory, and each hook on or off.

### What this enforces, and what it does not

**It gates writes in the session, not the truth of the receipt.** The hooks check only that a
receipt exists for the session. They do not check that the pattern it names is the right one,
and they do not check that a `--no-new-pieces` receipt is true: an agent that records "no new
pieces" and then adds several is let through.

**The shell matchers catch the obvious write forms only.** `cp`, `mv`, `python -c`, a script
that writes from inside, and a write inside `eval` or `sh -c` are neither counted nor denied.
`git commit` and `gh pr create` are the backstop once a session is held, but a session that
writes everything through uncaught forms never reaches the threshold.

**The Stop hook's plan test is a fixed list of signals** (plan or design headings, openers such
as "Here's the plan"). A plan written without those shapes is not refused.

Both hooks fail open on the plugin's own faults: the call goes through, one warning is shown,
and the reason is appended to `errors.log` in the plugin's state directory.

Changes in 0.3.0: the receipt gains the five fail columns, and `record` refuses a row whose fail
cells are empty, placeholders, or `n/a` without a reason; four-column receipts already written
still count. The deny and Stop refusal texts ask both questions: what exists already, and how
does it fail. Bash write forms are read through a shell lexer, fixing two real commands the
redirect matcher miscounted. Hook faults are appended to `errors.log` as well as shown,
`hooks.json` sets a 5 s timeout, and NotebookEdit is counted.

Changes in 0.3.2: the plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares
what the three hooks can return and eight `evals/<x>.scenario.json` prove them (under the
threshold, the third file held, with a `session` and a `judge` rubric the nightly canary runs
under `claude -p` and grades with `claude plugin eval`, the receipt lifting the hold, a corrupt
config warning and letting the call through; a plan refused without a receipt, passed with one,
a report passing; SessionEnd cleaning its files); `e2e/live-run.sh` hands off to plugin-kit's
scenario runner. `pattern-check prune [--days 30]` removes receipt copies, stop guards and
session files older than that (errors.log and `current/` stay) and prints the bytes freed; the
state directory, the config file and the repository's `.pattern-check/` are declared as state.
The skill's "When this can't run" section names the scenarios.

Changes in 0.2.0: an OMP adapter (`omp/pattern-check-omp.ts`) runs the PreToolUse counter on
OMP's `tool_call` and the Stop refusal on `session_stop`, through the hooks' own functions and
state.

### Developing pattern-check

The tests run with `node --test` from inside `plugins/pattern-check/`.

## reminders-review

Go through the open reminders on your chosen Apple Reminders lists with the agent, one at a time.
A question gets a ready answer. An instruction gets the agent's reading of it and its plan, and
nothing happens until you say yes to both. A note gets a suggested next step. Anything unclear
gets a question. Before moving on, the agent asks "Can I close this one?" and marks the reminder
complete only on a yes. It never deletes reminders.

Needs macOS and [remindctl](https://github.com/openclaw/remindctl)
(`brew install steipete/tap/remindctl`). [rem](https://github.com/BRO3886/rem) is optional: with
it installed the agent also reads the link field you see in Reminders.app, which remindctl cannot
see. Run `/reminders-review` with list names, or save defaults with
`/reminders-review lists <name> ...`. Details are in `plugins/reminders-review/README.md`.

Changes in 0.2.0: due and overdue reminders from the lists you watch (`watch` in the config file,
or `REMINDERS_REVIEW_WATCH`) come up at session start and at most hourly after, on Claude Code and
OMP. The skill has a "When this can't run" section (`remindctl` missing or not authorized, `rem`
missing, a list name matching nothing, one `complete` failing, not macOS), and
`.claude-plugin/plugin.json` declares the state directory and its prune command. ledger 0.3.5's
five-row gate passes on it.

Changes in 0.1.2: reads the Reminders.app link field with `rem show` when rem is installed, and
gives its install line once when it is missing. remindctl stays the source for everything else,
and `remindctl complete` is still the only write.

Changes in 0.1.1: shows each reminder's notes and URL. When a reminder has neither, the agent
says in one line that a Reminders.app link may not have reached it and asks you to paste it,
instead of working from the title alone.

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install reminders-review@jo-wolff-plugins
```

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install reminders-review@jo-wolff-plugins
```

## ledger

A durable, id'd record of the questions an agent asks you (one-word answers, an optional spend
ceiling) and the notes it records when it decides without asking, in one SQLite file on your
machine. The agent asks in plain words and records your plain-words reply against the
question's row itself; ids stay on the agent's side. Hooks inject the open questions and recent
notes at session start, deny the AskUserQuestion tool until the question has a row, deny
`git push` and `gh pr create` until the session has a note or an outcome saying why, and send
back once a reply that ends without recording an answer you gave, asks with no row, or states a
decision without a note. Every hook fails open.

The hooks record every session until you switch a folder off with `/ledger:disable`
(`/ledger:enable` turns it back on). The plugin's tables are all prefixed `cc_`, so the database
can be a SQLite file another tool already uses.

Changes in 0.3.5 (with plugin-kit 0.2.0): the gate grows from three rows to five. `evals`
(behaviour is proved): `evals/manifest.json` declares, for every event `hooks.json` registers,
the outcomes the handler can return; one `evals/<x>.scenario.json` per event × outcome, with a
real stdin fixture, not a stub, proves it; and the newest canary row for the committed plugin
tree is a pass (or `unavailable` with its reason), at most 7 days old where a scenario is
judge-backed. `retention` (state is declared and pruned): `.claude-plugin/plugin.json` declares
every path the plugin writes outside the worktree, with a prune command for anything kept a
number of days, and every write the canary observed sits under a declared path. The canary row
keeps the committed tree it certifies (`tree_sha`) and the files the live run left outside its
work directory (`writes`), runs every declared prune after the live runs and records each as a
`cc_canary_prunes` row (`--no-prune` skips that), and `canary status` prints the last run, the
last pass and the last prune per plugin; schema 8. Every plugin in this repository has an
`e2e/live-run.sh` handing off to plugin-kit's scenario runner, and the ledger's own scenarios
cover its five events. The hooks' direct-invocation guards compare real paths, the fix the
i-have-audhd and ask-graham scripts needed: a hook reached through a symlink (macOS's
`/var/folders` tmpdir, where `gate check` snapshots the plugin) otherwise never ran.

Changes in 0.3.4 (with plugin-kit 0.1.1): two fixes to what 0.3.3 shipped. The canary no longer
hands its `e2e/live-run.sh` the caller's `LEDGER_*` environment; a `LEDGER_DB` in the shell
that ran `ledger canary run` outranked the script's throwaway config and pointed the seeded
question and the headless session at the real store (the scripts, ledger's and the kit's
template, also `unset` those keys for a run by hand). plugin-kit's `new-plugin` scaffolds into
the `plugins/` of the git repository the cwd is in, found with `git rev-parse --show-toplevel`,
instead of the directory above the kit (which, installed from the marketplace, was the plugin
cache); a cwd in no repository is refused naming `--dest`.

Changes in 0.3.3: the fault-tolerance gate and the feedback loop. `ledger gate check` runs the
repository test bar's checks (three then; five since 0.3.5) on every plugin changed since the base of a repository of
plugins (can't break the session: each hook on five fault inputs; failures visible: an
`errors.log` line and a `systemMessage`, and an `<x>.unavailable.txt` fixture beside every
`<x>.txt`; text says what to do: a "When this can't run" section in every skill and agent, a
backtick command in every deny text), records the rows for the committed tree it checked, and
the push gate denies a push or PR without rows or with a failed check, naming `gate check` and
`review waive` as the ways out. The labs read the author's pattern-check receipt before the
diff and tag a stated failure path the code lacks, or a silent one the receipt lacks,
`[blocking] fault-tolerance:`. Three verbs tell whether the hooks are doing anything: `canary
run` runs every plugin's `e2e/live-run.sh` under `claude -p` nightly (`canary install` writes
the launchd plist and prints the bootstrap line); `report` grades a week of bounces per rule,
with a cached judge overlay; `digest` posts the week's report as a comment on the configured
`owner/repo#number` issue (`digest install` likewise), and session start says when it is
overdue. Session end writes a decision-log entry in the `/wrap-up` shape under the
repository's `.ai/decision-log/` when the session answered or noted anything, and session
start injects the newest and the open or durable entries where the newdle plugin's hook will
not. Session start withdraws questions asked more than `sweep.autoWithdrawDays` ago (7) whose
session has ended, and `doctor` counts stale ones. Bounces keep the text that fired the rule
and the transcript path; `bounces` shows them; `review judge <key>` shows a cached answer. A
session-start question from another window is relayed to the human in one plain line (never
its id), an `ask` with no `--default` invents none, and every hook's store failure now leaves
an `errors.log` line beside its message. Schema 7 adds `cc_judge_cache`, `cc_canary_runs`,
`cc_gate_checks` and two `cc_bounces` columns; the plugin README's "Inspecting the database"
section says what an older ledger does with a schema-7 file. The new `plugin-kit` plugin
scaffolds a plugin that passes the gate on day one.

Changes in 0.3.2: a side pane for Claude Code Desktop. The ledger mod opens a pane listing the questions still open in other folders and the answers recorded since your last turn, and `/ledger answer <id> <reply>` (or the pane's own buttons and reply field) records through the ledger CLI without spending a model turn. Where no pane can draw (`claude -p`, narrow terminals, OMP) the same information lands as one block in the transcript. See the plugin README, "Ledger pane (Desktop)", for the two-window test.

Changes in 0.3.1: three fixes from the first live sessions on 0.3.0, each from a bounce that had
no way out. An `ask` that repeats a question still open from an earlier session or an untagged
CLI run in the same folder (same text, same set of options in any order) now adopts that row
(its session id and asked-at move to the asking session; its options and default stay) instead
of writing nothing; before, the session had no row of its own and the Stop ask rule sent every
reply back with "this session has no open question row". The ask rule itself now stands down on
any question open for the folder (this session's, or one in the cwd or a parent of it), and it
fires only on a question that asks for a decision: a request ("should I", "do you want", "ready
to"), an explicit choice ("whether", "do you prefer", an option list after a comma or colon), or
a wh-question carrying one ("How should we proceed?"). A greeting or a request for information
("What are we working on?", "Which file holds the config?", "Are the logs compressed or
uncompressed?") needs no row; a "why" question never does. Session start now lists the
questions waiting in other folders in full, folder by folder with each question's `pending` line
(default, id, name, body, the other options; a held one marked `held`), so a session can record
the human's answer to one of them without a lookup;
before, it only counted them. And a prompt that is just an option word of an open question
("local", "Remote.") gives Claude one line naming that question and the `answer` command, as a
hint only: nothing is recorded until Claude runs it. One more, in the review gate: the `glm`
lab no longer has a built-in `omp` profile. It runs with no `--profile` (omp's base profile)
unless `review.profiles.glm` names one; before, the default was `agent-system-2`, and a user
file with `"profiles": {"glm": ""}` (rejected by the loader, which wants a non-empty string)
silently ran every GLM review under that profile.

Changes in 0.3.0: the ledger checks itself and records its own bounces. `ledger doctor`
prints one `ok`, `warn` or `fail` line per check (the database opens read-write, the schema
version is current, which config layer set `db` and `enabled`, `hooks.json` lists every
event, `errors.log` lines in the last 7 days per hook, bounces left open for more than a day)
and exits 1 only when a check fails; it never writes the database. Session start adds one last
line, `ledger: doctor reports N issue(s)`, when the cheap subset of those checks (schema
version, recent `errors.log` lines) finds something; `inject.doctor: false` turns it off.
Every Stop block and PreToolUse deny now writes a row to a new `cc_bounces` table, marked
`satisfied` when the remedy happens later in the session and `bypassed` at session end
otherwise, and `ledger bounces [--since 7d]` counts them per rule, so the rules that only get
walked past can be found and retired. A cross-lab review gate now stands in front of `git push`,
`gh pr create` and `gh pr merge`: `ledger review` sends the branch's diff to the labs in
`review.labs` (`codex`, `kimi`, `claude`, and `glm` through `omp`) in parallel and records each
verdict for the HEAD commit in a new `cc_reviews` table; the push is denied while HEAD has no
review or has findings, a lab that cannot run is named and left out, and `ledger review waive
"<reason>"` lets a commit through with the human's reason on record. `review.mode` (`gate` by
default, or `advise`, or `off`) is read from the user config file only. Findings carry a
severity (`blocking`, `should`, `nit`); nits alone let the push through with a notice. Each
reviewed commit is a numbered round, and past `review.maxRounds` (default 3) the review stops
and says to ask the human. A judge model checks every claim that a finding is resolved, whether
a later review dropped it, listed it again only as a nit, or the agent ran `review addressed
"<why>"`; a `no` keeps the gate closed, and a judge that cannot answer counts the finding
resolved and says so. A lab that is skipped or unavailable keeps its findings open on the new
commit, and `review addressed` is refused while HEAD has findings of its own. The judge is
`review.judgeCommand`, or the i-have-audhd plugin's `enforcement.judgeCommand`; its passage is
capped at 8 kB and says when it was cut. Session start now also
shows the open and held questions asked in folders under the session's folder, each naming its
folder, and `pending` lists them the same way. Reviewers run without tools, from an empty
scratch folder, with an allowlisted environment. The gate checks the commit a command actually
publishes (`cd` and `git -C` folders, each in its own shell scope, refspecs, git's own choice
when no refspec is given, the branch `gh pr create --head` names as the remote has it now, read
with a `git ls-remote` that cannot prompt and is killed with its helpers after 5 seconds, the
pull request `gh pr merge` names, pushes inside `$(…)`), and
allows with a notice when it cannot tell, including a `-c` or `GIT_CONFIG*` setting that steers
the push and a remote that does not answer in 5 seconds; a merge not bound with
`--match-head-commit` gets a notice naming the commit checked. `review --base` narrows only the
diff the labs read, and a later review of an older commit clears nothing found on a newer one.
Opening a 0.2.3 database migrates it to schema
version 6 by creating new tables; no existing table is touched. A push missing both a note and a
review is denied once, naming both. The Stop ask rule now catches a question mid-line ("Should
I …? I'd say yes."); the decision rule stands down when the reply asks a question recorded that
turn, and `instead of` left the default phrase list. A bounce marked `bypassed` at SessionEnd
turns `satisfied` when the same session resumes and does the remedy. `errors.log` lines carry
the database they were written against, and `doctor` counts only its own.

Changes in 0.2.3: one database shared by every folder is now readable across folders.
`ledger pending --all` lists every open and held question in the database, grouped under the
path of the folder it was asked in, oldest first within a folder. Session start adds one line
when questions are waiting on you outside the session's folder (not the folder, a parent or a
subfolder of it): how many, in how many other folders, and the `pending --all` command to see
them. The line is kept after a compaction; set `inject.elsewhere` to `false` to turn it off.
`ledger pending` without `--all` is unchanged. An answer now reaches the session that asked
while it is still open: when a question is answered or withdrawn from another session or folder,
the asking session's next prompt carries one line saying so (`answered since your last turn:
<name> → <word>`), once. Set `inject.answers` to `false` to turn it off. Opening a 0.2.2 database
migrates it to schema version 5 in place by adding two columns; no table is rebuilt.

Changes in 0.2.2: an `outcome` lifts the push gate the same as a `note`, so one
`ledger outcome <ref> "<what and why>"` per push is enough. The Stop hook's decision rule still
wants a `note` in the turn that states the decision. A reply that is none of a question's options
is recorded as given: `ledger answer <q-id> "<reply>"` stores it as a free-form answer (up to 200
characters), and `log` shows it as `answered (freeform)`, so a question is no longer withdrawn
because your reply was off the list. A prompt line such as `approve q-…` still applies exact
options only, so a typo never becomes an answer. Opening a 0.2.1 database migrates it to schema
version 4 in place, rebuilding `cc_answers` and keeping every row.

Changes in 0.2.1: you never type a question id. The agent asks in plain words and records your
reply with `ledger answer`; the Stop hook sends a turn back once when you replied and the answer
is not recorded, and no longer requires a reply to name its row (`approve q-…` typed into a
prompt still works as a shortcut). The hooks are on by default, with `/ledger:enable` and
`/ledger:disable` to set a folder's switch. A question the agent forms but defers is `held`
(`ledger hold`, `ledger reopen`), never dropped, and is listed as *Waiting on you* at session
start; `ledger outcome <ref> [q-id] "<text>"` records what a decision produced (a PR, a commit, a
path). Opening a 0.2.0 database migrates it to schema version 3 in place, keeping every row. A
database at a configured `db` path that fails to open as SQLite (corrupt, or not a database) is
reported and left exactly as it is; only the plugin's own default file is moved aside to
`<path>.corrupt-<stamp>` and recreated.

Needs Node 22.13 or later (`node:sqlite`). Claude Code only; no OMP adapter. One allow rule
keeps the agent's ledger commands from prompting for permission; the plugin prints it at
session start. Verbs, config keys, the fail-open table and the known gaps are in
[`plugins/ledger/README.md`](plugins/ledger/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ledger@jo-wolff-plugins
```

### Developing ledger

The tests run with `node --test` from inside `plugins/ledger/`.

## ctx-watch

Notice when the [ctx](https://github.com/ctxrs/ctx) daemon is dead, not supervised, or stale,
and say so where you will see it. The probe is `ctx daemon status --format json` with `CI`
removed from the environment, judged on `.daemon.running`, `.daemon.supervisor.status` and
`.daemon.jobs.core_refresh.last_run_at_ms` (over 2 h is stale) and never on the exit code,
which is 0 either way. A failing probe is repaired with `ctx index mode auto`, the command
ctx's own docs give for "installs or repairs supervision and starts the persistent background
daemon" (verified on a throwaway data root; a non-CI `ctx daemon status` does not restart
anything), guarded so it never sets ctx up or flips a deliberate `manual` mode. Two surfaces:
a SessionStart line, `ctx-watch: <reason>; fix: \`<command>\``, plus a dead-man's line when the
timer itself has not run; and a launchd timer (`install` writes the plist and prints the one
`launchctl bootstrap` line, never running it) whose `tick` strikes once, goes down on the
second failing probe in a row, and shows one `osascript` dialog per episode. Built on
plugin-kit 0.1.0; macOS; Node 22.13 or later. The reasons, the repair's guard, the episode
rules and the failure table are in [`plugins/ctx-watch/README.md`](plugins/ctx-watch/README.md).

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ctx-watch@jo-wolff-plugins
```

Then, once, from your own Terminal: `node <plugin dir>/scripts/ctx-watch.mjs install` and the
`launchctl bootstrap gui/<uid> <plist>` line it prints.

### Developing ctx-watch

The tests run with `node --test` from inside `plugins/ctx-watch/`. The ctx captures in
`test/fixtures/` are re-made by `test/fixtures/capture.sh`, by hand.

## License

MIT. See `LICENSE`.
