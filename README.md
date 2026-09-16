# jo-wolff-plugins

Two plugins about the same problem from opposite ends: what an agent's output is made of, and
what shape it arrives in.

- **[output-types](#output-types)** — label every statement and attach the receipt that earns
  the label.
- **[communication-rules](#communication-rules)** — put what needs a decision where the reader
  looks first.

Both deliver text. Neither reads what the agent sends back; see each section's *delivers, does
not enforce* note.

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install output-types@jo-wolff-plugins
/plugin install communication-rules@jo-wolff-plugins
```

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
  of the skill file so there is only ever one copy of that text.

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

### What you get

- **Eight rules** covering the shape of a message to a person, delivered before the first turn.
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

## License

MIT. See `LICENSE`.
