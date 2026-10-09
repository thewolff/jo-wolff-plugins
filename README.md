# jo-wolff-plugins

Three plugins about working with an agent: what its output is made of, what shape that output
arrives in, and when it may write code at all.

- **[output-types](#output-types)** — label every statement and attach the receipt that earns
  the label.
- **[communication-rules](#communication-rules)** — put what needs a decision where the reader
  looks first.
- **[paired-coding](#paired-coding)** — pair with the agent one change set at a time, behind a
  gate that refuses writes you have not agreed to.

The first two deliver text. Neither reads what the agent sends back; see each section's
*delivers, does not enforce* note. paired-coding is the one that enforces, at the tool boundary,
within the limits in its *what this enforces, and what it does not* note.

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install output-types@jo-wolff-plugins
/plugin install communication-rules@jo-wolff-plugins
/plugin install paired-coding@jo-wolff-plugins
```

On OMP, from a shell:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install output-types@jo-wolff-plugins
omp plugin install communication-rules@jo-wolff-plugins
omp plugin install paired-coding@jo-wolff-plugins
```

Inside a running OMP session the commands are `/marketplace add` and `/marketplace install`, with
the same arguments. `/plugin install` inside OMP installs nothing. On OMP the first two plugins
deliver their skill only; their hooks do not run there. paired-coding installs its gate as an
OMP extension (see each section).

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

## communication-rules

A plugin that shapes a message around what it needs from its reader: anything requiring a
decision goes above anything merely informative, one closing ask goes last, and items stay with
the thing they are about instead of being batched into a questions section and a findings
section.

The problem it addresses: a report is organised for the record, and a message is organised for
the one person who has to act on it. Agents write the first when they mean the second, so the
decision ends up on line 80 under three headings of context that the reader never reaches.

### Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install communication-rules@jo-wolff-plugins
```

#### Install on OMP

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install communication-rules@jo-wolff-plugins
```

Inside a running OMP session, use `/marketplace add thewolff/jo-wolff-plugins` and then
`/marketplace install communication-rules@jo-wolff-plugins`. `/plugin install` inside OMP installs
nothing: it prints the installed-plugin list and returns.

**On OMP only the skill loads.** Tested on OMP 18.4.4: OMP does not run a plugin's
`hooks/hooks.json`, so neither the session-start hook nor the `Stop` hook fires, and the rules
and your profile are never injected. The skill is listed and loads on demand. The plugin also
carries an OMP adapter for the `Stop` hook, `omp/communication-rules-omp.ts`; installing the
plugin does not register it, and its `omp/REGISTRATION.md` marks it unregistered.

### What you get

- **Eight rules** covering the shape of a message to a person, delivered before the first turn
  on Claude Code (on OMP, through the skill only; see *Install on OMP*).
- **An enforceability verdict for every one of them** — mechanically checkable, model-graded, or
  unenforceable by construction — because a rule nothing can ever check should be written down as
  a principle rather than bolded beside one a machine refuses on. Four of the eight say *never*.
- **One shipped check**, `checks/needs-you-first.mjs`: if a needs-you section exists, is it
  before the body? It flags misordering and never absence, it is log-only, and it is wired to no
  hook event. It ships with the false-positive cases as tests — `node --test
  plugins/communication-rules/checks/*.test.mjs`.
- **An operator profile** you write on your own machine, so the rules can name a real addressee
  and adapt to how that person actually reads.

### It ships with no reader traits, deliberately

The reader-specific half is the useful half and it is not in this repository. A trait sentence is
information about a real person; it is attributable to whoever owns the repository it sits in; and
a pushed commit survives in forks and caches after any later deletion, so genericising the wording
does not anonymise the author. So this package carries the mechanism and a generic example that
describes nobody (`example.communication-rules.json`).

Point it at your own file:

```
export COMMUNICATION_RULES_PROFILE=~/.claude/communication-rules.json
```

That path is also the default. If no profile exists, the session-start hook emits the default
rules plus one line saying no profile is configured — a hook that silently does half its job
reads exactly like one that works. **Keep your profile out of version control if it describes a
real person.**

### What this does, and what it does not do: it delivers, it does not enforce

**The session-start hook** emits the eight rules, plus your profile's reader and traits verbatim,
before the first tool call. It reads that text out of `skills/communication-rules/SKILL.md`
between the markers, so there is one copy and it cannot drift from the skill.

**The skill** carries the enforceability table, the profile schema, and the shipped check's
contract, and loads on demand.

**The one check is registered nowhere.** It is a function and a small CLI. It cannot block a turn,
cannot rewrite one, and exits 0 whether it flags or not. That is a decision rather than an
omission: a structural check whose false-positive rate is unmeasured on *your* corpus must not be
able to stop anything, because the cheapest way to satisfy a guard that fires on correct output is
to stop writing the thing it misreads. Calibrate it against a few hundred of your own messages —
and hand-adjudicate thirty flags — before you wire it to anything.

If you want the injection off without uninstalling, set `COMMUNICATION_RULES_INJECT=off`; the
hook then emits nothing and the skill still loads on demand.

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
  sits under a sandbox (Seatbelt on macOS, bubblewrap on Linux) that fences the files the run
  writes itself and its local Unix-socket connections, not the network, so a run can still ask
  a process outside the sandbox to write for it.
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
tested live on both, on macOS. On Linux it needs bubblewrap and unprivileged user namespaces,
and fences some writes per directory rather than per file; its sandbox was tested in an Ubuntu
container, and neither host has been run live on Linux. Codex is unverified. Elsewhere the
skill runs as conversation and nothing at the tool boundary stops a write.

**Some of it rests on undocumented host fields, and fails closed.** On Claude Code, "you typed
it" is read from transcript fields Claude Code does not document. If they change, every turn
reads as untrusted and pairing can never open a change set; it does not open one by mistake.

**The sandbox fences a run's own writes, not the network.** Local services over TCP stay
reachable from a run, `sshd` on `127.0.0.1` included, and `open`, `osascript` and Apple Events
are not blocked, so a run can ask a process outside the sandbox to write for it.

**A process that escapes the sandbox is caught late.** It is caught at the next read-back, and
only if it writes inside the worktree.

The plugin's own README carries the full list, with the evidence behind each line.

## License

MIT. See `LICENSE`.
