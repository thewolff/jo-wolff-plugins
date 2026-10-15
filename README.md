# jo-wolff-plugins

Five plugins about working with an agent: what its output is made of, what shape that output
arrives in, when it may write code at all, whether the thing is worth building in the first
place, and going through your reminders with it.

- **[output-types](#output-types)** — label every statement and attach the receipt that earns
  the label.
- **[i-have-audhd](#i-have-audhd)** — how to write to someone who is ADHD and autistic, with the
  research behind each rule and a Stop hook that warns when a message buries what they need.
- **[paired-coding](#paired-coding)** — pair with the agent one change set at a time, behind a
  gate that refuses writes you have not agreed to.
- **[ask-graham](#ask-graham)** — answer "should we build X?" with one engineer's stated
  judgment and a single verdict, when you ask or on every new idea.
- **[reminders-review](#reminders-review)** — go through your open Apple Reminders one at a
  time: the agent answers, confirms before acting, and closes each one only when you say yes.

output-types delivers text and does not read what the agent sends back; see its *delivers, does
not enforce* note. i-have-audhd delivers its rules and checks every finished message, warning by
default. paired-coding enforces at the tool boundary, within the limits in its *what this
enforces, and what it does not* note. ask-graham is a skill, a one-line prompt nudge you can
turn off, and a Stop check that blocks once per turn when an answer that read the skill has no
verdict line, which `/ask-graham stop-check off` turns off.
reminders-review is a skill only.

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install output-types@jo-wolff-plugins
/plugin install i-have-audhd@jo-wolff-plugins
/plugin install paired-coding@jo-wolff-plugins
/plugin install ask-graham@jo-wolff-plugins
/plugin install reminders-review@jo-wolff-plugins
```

On OMP, from a shell:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install output-types@jo-wolff-plugins
omp plugin install i-have-audhd@jo-wolff-plugins
omp plugin install paired-coding@jo-wolff-plugins
omp plugin install ask-graham@jo-wolff-plugins
omp plugin install reminders-review@jo-wolff-plugins
```

Inside a running OMP session the commands are `/marketplace add` and `/marketplace install`, with
the same arguments. `/plugin install` inside OMP installs nothing. On OMP output-types delivers its
skill only; its hooks do not run there. i-have-audhd and paired-coding install OMP extensions
that run their hooks, and ask-graham installs its prompt nudge (see each section).

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

A plugin that makes an agent label every statement it returns — CLAIM, CITE, GUESS, ACTION,
QUESTION — and attach the receipt that earns the label, so a reader can tell what was checked from
what was assumed.

The problem it addresses: an agent's report is one stream of confident prose. A fact read out of a
file, a fact half-remembered from training, a number nobody re-derived, and a change that actually
happened all read the same. Typing them separates them, because each type has a different receipt
and a different cost when it is wrong.

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

- **Six labels**, each with the receipt that earns it, and the rule that a receipt rather than
  confidence sets the type.
- **Graded guesses** — inference, pattern, recall — so a guess from something read this session is
  not filed beside one from memory.
- **Eight rules** that catch the most: third-party semantics are never vocabulary; a receipt
  licenses only what it literally shows; a figure reused in a new context is a new claim.
- **Four degradation tiers**, so an agent that could not meet the contract says so instead of
  emitting something that reads as though it did.
- A **reference file** with the report skeleton, a worked example, the parent-side handling rules,
  and the rules for handing a command to a person to run.
- A **session-start hook** that emits the operative core before the first tool call, reading it out
  of the skill file so there is only ever one copy of that text. Claude Code only; see *Install
  on OMP*.

### What this does, and what it does not do: it delivers, it does not enforce

Two pieces, and it is worth knowing which does what before you install.

**The session-start hook puts the core in front of the model before the first tool call.** A
contract that governs every assertion cannot be delivered by a mechanism that fires in response to
an assertion, and the first assertion of a session is usually in the first turn. So the hook emits
the operative core at session start, and it is in force from turn one. It reads that text out of
`skills/output-types/SKILL.md`, between the markers, rather than carrying its own copy. There is one
copy of the core and it cannot drift from the skill.

**The skill carries the fuller contract and loads on demand**, matched against its description: the
eight rules, the degradation tiers, the report skeleton, the worked example. Once it loads, its text
stays in context for the rest of the session.

**Nothing here enforces anything, and that is the part to be clear about.** Both pieces deliver
text. Neither one reads what the agent sends back. On the machine this was extracted from there is
also a conformance guard that inspects a returned report and tells the parent what it actually got
— unlabelled prose, a claim with no receipt, a missing envelope. **That guard is not in this
package and is not being extracted.** So do not read an installed copy of this plugin as a
guarantee: a report that comes back with every sentence bare will come back exactly that way, and
nothing here will catch it. What you get is a contract the model has read, not a contract the
model has been held to.

Two things help in practice. Name the skill in the delegation prompt for any agent you dispatch,
and say so in your own instructions if you want more than the core in force from the start.

If you want the injection off without uninstalling the plugin, set `OUTPUT_TYPES_INJECT=off` in the
environment; the hook then emits nothing and the skill still loads on demand.

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

It needs `node` on your `PATH`: Claude Code runs its hooks as `node <hook>.mjs`, and OMP runs
them through a login shell (`sh -lc`), so on OMP `node` has to be on a login shell's `PATH`.
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

2. **Choose a judge.** Five of the nine Stop-hook checks (`do-not-batch-by-label`,
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
`omp/i-have-audhd-omp.ts`, which runs the same two hooks for the main session: the session-start
injection, and the Stop check. Subagent sessions get neither; OMP has no blocking equivalent of
Claude Code's `SubagentStop`. `omp/REGISTRATION.md` carries the manual fallback and an isolated
live probe.

### What you get

- **The skill**: eleven rules, each with its reasons and sources in `references/`.
- **A session-start injection** of the skill's first-turn core — the message skeleton, the
  options rule, reference survival, commands, and three machinery anchors — plus every rule
  heading, read out of `skills/i-have-audhd/SKILL.md` between its markers so there is one copy.
- **A Stop hook** that checks every finished message with nine checks (four deterministic, five
  judge-gated) and names the skill rule behind each finding.
- **An optional operator profile** you write on your own machine, so the rules can name a real
  addressee and adapt to how that person reads. The repository ships only a generic example
  (`example.i-have-audhd.json`). **Keep your profile out of version control if it describes a
  real person.**

### What this does, and what it does not do: it warns, it does not block

Every check warns by default: findings land in `~/.claude/.i-have-audhd-state/warnings.log` and
the turn ends normally. A 2026-09-21 corpus adjudication found no check whose false-positive rate
supports blocking by default, so block is a deliberate profile setting, per check or global; on
OMP it also needs `enforcement.armOmp: true`. The five judge-gated checks stay inactive until you
choose a judge (install step 2), and each fired trigger is logged to `skipped.log`.

`touch ~/.claude/.i-have-audhd-off` disables the Stop hook within one turn.
`I_HAVE_AUDHD_INJECT=off` turns the injection off; the skill still loads on demand. The package
README and `skills/i-have-audhd/reference.md` carry the schema, every check's contract, and the
measured rates.

## paired-coding

A plugin for pairing with an agent on code, one change set at a time. The agent drives and you
navigate. Before each change set it shows you a **card** naming the decision inside the change,
the code it touches, the effect it will have and the exact files it will write. It writes only
after the two of you agree on that card, then shows you the real diff.

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
  its own writes land only in the agreed change set's files and temp directories. Every run
  sits under a sandbox (Seatbelt on macOS, Landlock or bubblewrap on Linux) that fences the
  files the run writes itself and its local Unix-socket connections, not the network, so a run
  can still ask a process outside the sandbox to write for it.
- **A journal** of every card, quote, verdict, refusal and diff, kept outside the worktree.
- **A stop only you can give:** pairing ends when you type `pair stop` as a message of its own.

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

## ask-graham

A skill that answers "should we build X?" the way Graham, a frontend engineer, says he decides:
five gate questions, a short list of red flags, the 2-minute rule from GTD, and fewer lines wins.
It ends in exactly one verdict: **do it now**, **start now**, **later**, or **don't build**,
with a breakdown scaled to the size of the work.

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
  backlog files) rather than put back to you. You are asked only what no tool can settle: who
  will own it, or which reason matters to you.
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
- **A level you set**, `ask` or `every-idea`, for how eagerly it runs (next section).

### When it runs

Two levels:

- **`ask`**, the default. The skill runs on `/ask-graham` or an explicit "should we build
  this?" / "is it worth building?". Its description is written so nothing else matches.
- **`every-idea`**. It also runs whenever you propose a new project, product, feature or tool
  that does not exist yet. A hook adds one short line to each of your messages telling the agent
  to run the check if the message is a new idea and to ignore the line otherwise. On Claude Code
  that is a `UserPromptSubmit` hook; on OMP an extension on the `before_agent_start` event. At `ask` neither
  adds anything.

At both levels it does not run on a ticket or issue, a bug fix, a task inside an
already-decided project, or a request to continue existing work. Deciding which messages are
new ideas is left to the agent: the hook does not classify anything, so a ticket can still
draw a check if the agent misreads it.

The level comes from the first of these that exists:

1. the nearest `.ask-graham` in the working directory or any directory above it, so one file
   at a workspace root covers every repository and worktree under it;
2. `${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/config`;
3. the default, `ask`.

Each file holds `intensity=ask` or `intensity=every-idea`. A file that names neither counts as
`ask`, so a typo in a file meant to turn the level down cannot turn it up. The same files take a
second line, `stop-check=off`, to turn off the Stop check that blocks once when an answer that
read the skill has no `**Verdict:**` line (default `on`). To change either from a session (on
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

## reminders-review

Go through the open reminders on your chosen Apple Reminders lists with the agent, one at a time.
A question gets a ready answer. An instruction gets the agent's reading of it and its plan, and
nothing happens until you say yes to both. A note gets a suggested next step. Anything unclear
gets a question. Before moving on, the agent asks "Can I close this one?" and marks the reminder
complete only on a yes. It never deletes reminders.

Needs macOS and [remindctl](https://github.com/openclaw/remindctl)
(`brew install steipete/tap/remindctl`). Run `/reminders-review` with list names, or save
defaults with `/reminders-review lists <name> ...`. Details are in
`plugins/reminders-review/README.md`.

## License

MIT. See `LICENSE`.
