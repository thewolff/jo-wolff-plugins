# communication-rules

A plugin that shapes a message around what it needs from its reader. Anything requiring a
decision goes above anything merely informative, one closing ask goes last, and each item stays
with the thing it is about instead of being collected into a questions section and a findings
section. It delivers that shape as text at session start; it never inspects what the agent
sends back.

The problem it addresses is a difference between two artifacts. A report is organised for the
record, and a message is organised for the one person who has to act on it. Agents write the
first when they mean the second, so the decision ends up on line 80 under three headings of
context.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install communication-rules@jo-wolff-plugins
```

## What happens at session start

The plugin registers exactly one hook event, `SessionStart`, which runs
`hooks/communication-rules-inject.mjs` and returns
`hookSpecificOutput.additionalContext`. That text is in force before the first tool call,
which is the point: the rules govern the shape of a message, and the first message of a
session is often the first turn, so a mechanism that fires *in response* to something is one
beat too late.

The hook does not carry its own copy of the rules. It reads them out of
`skills/communication-rules/SKILL.md`, from the span between `<!-- inject:start -->` and
`<!-- inject:end -->`, and emits exactly that span followed by a short pointer naming the skill
and restating that nothing here inspects what you send. Editing the skill is editing what
sessions receive; there is one copy of the text and it cannot drift.

The skill itself loads on demand, matched against its description, and carries the fuller
material: the enforceability verdict for each delivered rule, the profile schema, and the
shipped check's contract.

### It fails open, and says so

Every path through the hook exits 0. A broken hook must not break a session. But a hook that
fails silently is indistinguishable from one that is working, so each failure mode emits one
short line instead of nothing:

| Situation | What you see |
|---|---|
| No profile file at the resolved path | The rules, plus `No reader profile is configured, so these rules name no addressee.` |
| Profile exists but does not parse | The rules, plus one line naming the path and the parse error |
| Profile parses but is not a JSON object, or declares neither a reader nor traits | The rules, plus one line saying which |
| The skill's `inject` markers are missing | One line saying the core could not load |

So a fresh install with nothing configured is the normal case and it is loud rather than quiet:
you get the default shape and the sentence telling you no profile was found.

To turn the injection off without uninstalling, set the environment variable
`COMMUNICATION_RULES_INJECT=off`. The hook then emits nothing at all — zero bytes — and the
skill still loads on demand.

## Configuring a profile

The default shape holds for any reader. Anything reader-specific comes from a JSON file you
write on your own machine. The plugin ships the mechanism and no reader-specific content;
`example.communication-rules.json` is a complete generic illustration and describes nobody:

```json
{
  "reader": "the engineer who owns this service",
  "traits": [
    "reads the first two lines of any message and skims the rest",
    "wants the decision named before the reasoning that produced it",
    "treats an unanswered question as answered unless it is the last line"
  ],
  "markers": ["Needs you"],
  "minProseChars": 200,
  "graceChars": 0
}
```

Copy it and point the plugin at your copy:

```
export COMMUNICATION_RULES_PROFILE=~/.claude/communication-rules.json
```

Resolution order is `$COMMUNICATION_RULES_PROFILE`, then `~/.claude/communication-rules.json`.
Every field is optional and an empty object is valid.

**What the hook reads:** `reader` and `traits`, both emitted verbatim. A `reader` produces one
bold line addressing the rules to that person; `traits` become a bullet list, followed by a
standing instruction that where a trait conflicts with one of the delivered rules, the trait
wins and the agent says which rule it set aside.

**What the hook does not read:** `markers`, `minProseChars` and `graceChars`. Those are the
shipped check's option names, and the check takes its options as a function argument rather
than loading any file — it touches no filesystem, which is what keeps it testable. Putting
them in the profile keeps one place to record what a needs-you section looks like for whoever
wires the check up; no code path in this plugin reads them.

**Keep your profile out of version control if it describes a real person.** A sentence about how
somebody reads is information about somebody, it is attributable to whoever owns the repository
it sits in, and a pushed commit survives in forks and caches after any later deletion — so
genericising the wording does not anonymise the author.

## The one check, and why no hook invokes it

`checks/needs-you-first.mjs` answers one question about one message: **if a needs-you section
exists, does any substantive prose come before it?** It ships as a library and a small CLI, and
**no hook event in this plugin invokes it.**

That is a decision, not an omission. This plugin delivers text. The check is available to
whoever wants to enforce the predicate, on their own terms, and enforcement is left entirely to
them — because a structural check whose false-positive population is unmeasured on *your*
corpus must not be able to stop a turn. The cheapest way to satisfy a guard that fires on
correct output is to stop writing the thing it misreads.

```js
import { checkNeedsYouFirst } from "./checks/needs-you-first.mjs";

const result = checkNeedsYouFirst(text, options);
```

It returns a plain object and never throws — including on `undefined`, `null`, a number, or an
unterminated code fence:

```js
{
  applicable: true,             // false below the floor, or when no marker is present
  flagged: false,               // true only when a marker exists and prose precedes it
  reason: "marker-first",       // stable token, one of four
  markerLine: 3,                // 1-indexed line of the marker, or null
  prosePrecedingChars: 0,       // substantive characters before the marker
  proseChars: 812               // substantive characters in the whole message
}
```

`reason` is one of four values:

| `reason` | Meaning | `applicable` |
|---|---|---|
| `below-floor` | Less substantive prose than `minProseChars`. Checked first, so a short message is below the floor even when it is misordered. | `false` |
| `no-marker` | Long enough, but no needs-you marker anywhere. | `false` |
| `marker-first` | A marker exists and no more than `graceChars` of prose precedes it. | `true` |
| `prose-precedes-marker` | A marker exists and body prose precedes it. This is the one finding. | `true` |

`flagged` is true only for `prose-precedes-marker`, and `flagged` always implies `applicable`.

The three options, with their defaults:

| Option | Default | Meaning |
|---|---|---|
| `markers` | `["Needs you"]` | Line-anchored markers that open a needs-you section, matched case-insensitively after stripping heading hashes, list bullets, emphasis characters and a trailing colon — so `## Needs you`, `**Needs you**` and `Needs you:` are one marker rather than three. A line matches when it equals a marker or begins with one followed by a space, so `Needs you — two things` opens the section too. Supplying your own **replaces** the default rather than extending it. |
| `minProseChars` | `200` | Below this much substantive prose, the message is reported `applicable: false`. |
| `graceChars` | `0` | Substantive characters tolerated before the marker. Raise it if your house style opens with a standing one-line preamble. |

Headings count as navigation: they contribute no prose and do not delay a marker. Blank lines,
horizontal rules, bare bullets, table separator rows, blockquoted lines, HTML comments, and
anything inside a fenced code block are all skipped — so a marker quoted from an earlier
message, or shown as an example inside a fence, is not this message's marker.

As a CLI it prints one JSON object and exits 0:

```
node plugins/communication-rules/checks/needs-you-first.mjs path/to/message.md
cat message.md | node plugins/communication-rules/checks/needs-you-first.mjs
```

Exit 0 is unconditional. It exits 0 when it flags, when it does not, and when it cannot read
its input at all — in that last case it prints `{"error": "could not read …"}` and still exits
0. It is log-only, including about its own failures.

## What the check deliberately does not do

**It flags misordering and never absence.** A message with nothing needing its reader is
correct, and the check reports `applicable: false` with `reason: "no-marker"`. Not applicable is
not a pass either; it is the check declining to have an opinion.

A check that demanded a needs-you section in every message would be worse than no check at all,
and it fails in one of two ways depending on how you write. Either it flags every routine
answer — most messages need nothing of their reader, so the finding rate approaches the message
rate and the signal is gone. Or, once people adapt to it, it is satisfied by an empty
`Needs you: nothing.` header, which puts ceremony in the position the reader reads first. The
position is the scarcest one in the message, and filling it with a header that says nothing
spends it.

It also holds no state, inspects one message at a time, and has nothing to say about whether the
needs-you section contains the right things.

## Calibration, honestly

**The 200-character floor is a starting point, not a measurement of anyone's corpus.** It exists
because short messages — an acknowledgement, a one-line answer, a question — are the
false-positive population for every structural check, and some floor is better than none. The
specific number was not derived from a body of real messages.

So before you trust the flag rate, run the check over a few hundred of your own real messages
and **hand-adjudicate about thirty flags**: for each one, decide yourself whether the message was
actually misordered. That will tell you both whether the floor is in the right place for how you
write and whether your markers are the ones you actually use. A structural check that has not met
your corpus is a guess with a number attached, and it is worth saying that here rather than
leaving it in the reference file.

## The tension worth naming

Two of the delivered rules pull against each other, and this is the most useful thing to know
before installing.

*Needs you first* says pull anything requiring a decision above anything merely informative.
*Do not batch by label* says keep each item with the thing it is about, rather than sweeping
every question into one section and every finding into another. But pulling what needs the
reader to the top **is** a partial grouping by label. The two rules are in genuine tension, and
only judgment separates a useful lead section from a dumped one. That is why the reference file
grades *do not batch by label* as model-graded rather than mechanically checkable: a
deterministic version of it would fight the other rule directly.

The check is built so it cannot take a side. It judges a message on its **first** marker only. A
message that interleaves — a needs-you item, then body, then a second needs-you item, then more
body — is not flagged, because the first marker leads. So the check can enforce the ordering rule
without punishing the message that refused to batch.

## Tests

```
node --test plugins/communication-rules/checks/*.test.mjs
```

13 tests, 13 passing. **Nine of the thirteen exist to prove what does *not* flag** — a message
needing nothing of its reader, a short misordered message, a heading above the marker, a marker
inside a code fence, a marker quoted from an earlier message, an interleaved message, a trailing
HTML-comment envelope, the marker's own three spellings, and a preamble within `graceChars`. Two
cover the finding the check exists for, and two cover the contract: that operator markers replace
the default, and that the function never throws and never reports `flagged` without `applicable`.

The proportion is deliberate. A structural check earns its place by what it leaves alone, so the
false-positive cases are the part of the suite that is load-bearing.

## License

MIT. See the repository root `LICENSE`.
