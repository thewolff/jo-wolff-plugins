# output-types

A plugin that makes an agent label every statement it returns — CLAIM, CITE, GUESS, ACTION,
QUESTION — and attach the receipt that earns the label, so a reader can tell what was checked from
what was assumed.

The problem it addresses: an agent's report is one stream of confident prose. A fact read out of a
file, a fact half-remembered from training, a number nobody re-derived, and a change that actually
happened all read the same. Typing them separates them, because each type has a different receipt
and a different cost when it is wrong.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install output-types@jo-wolff-plugins
```

## What you get

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

## What this does, and what it does not do: it delivers, it does not enforce

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

## License

MIT. See `LICENSE`.
