# communication-rules — reference

Three things live here: the enforceability verdict for every rule this plugin delivers, the
operator-profile schema, and the honest account of what the one shipped check does and does not
catch.

## Why the verdicts matter more than the rules

A rule that no mechanism can check is still worth writing down — but it should be written down as
a principle, not as a rule with the same weight as one a machine refuses on. Bolding a rule that
nothing will ever check teaches a reader that bolding means nothing, which devalues the rules that
are checkable. So each rule below carries its verdict, and four of them say *never*.

**Mechanically checkable** — a deterministic check over the emitted text decides it, with no model
in the loop.
**Model-graded** — only a model can score it; a deterministic check would be guessing.
**Unenforceable by construction** — no check of emitted text can ever decide it, most often
because the violation is an *absence*: the thing that should have been said is not there, and text
that is not present has no signature.

## The eight delivered rules

| Rule | Verdict | Check sketch | Its false positive |
|---|---|---|---|
| Needs-you before body | **Mechanically checkable**, conditional on a declared marker | Segment the message; locate the first needs-you marker; assert no substantive prose precedes it | A message with nothing needing the reader. A check demanding the section flags every routine answer, or gets satisfied by an empty *"Needs you: nothing."* — ceremony in the position read first. **This plugin's check therefore flags misordering only, never absence.** |
| One closing ask, last | **Mechanically checkable**, conditional on a declared marker | Count closing-ask markers; assert exactly one, and that it is the last substantive block | No such marker exists in ordinary prose. Absent a declared one, the check reads prose and guesses. Not shipped for that reason. |
| Do not batch by label | **Model-graded** | — | A deterministic version fights the needs-you rule directly: pulling what needs the reader to the top *is* a partial grouping. The two rules are in genuine tension and only judgment separates a useful lead section from a dumped one. |
| Conclusion before evidence | **Model-graded** | Trigger is detectable — first substantive sentence versus the rest | Whether a sentence is a conclusion or a framing is not decidable without reading for meaning. A keyword version fires on every message that opens with context for a good reason. |
| Name the file, command, or line | **Mechanically checkable**, weak | Assert at least one path-like, command-like or `file:line` token | A message that is genuinely about nothing on disk — a question, an acknowledgement — is correct and unnameable. Needs a length floor and an applicability gate, and even then this is a vocabulary check, not a correctness one. |
| Restate a resumed thread | **Model-graded**, mechanical trigger | Trigger is detectable — first message after a resume or a context crossing | Whether a restatement restates *content* rather than merely naming the thread is judgment. The mechanical half can only tell you the trigger fired. |
| Report what you did not do | **Unenforceable by construction** | — | The violation is silence. An omitted omission leaves no token to match. |
| Bad news in the first sentence | **Unenforceable by construction** | — | Requires knowing which of the message's facts is the bad one, which is the whole judgment. |

Two further rules that most operators will want and that this plugin deliberately does not
deliver, both **unenforceable by construction**, both for the same reason: *name a conflict
between two instruction sources where you act on it*, and *say when you are withholding
something*. In each case the violation is an absence. No check of emitted text detects either,
and a check that claims to is measuring vocabulary.

**A note on the shape of this table.** The rule set here is a generalisation. It was extracted
from a larger, reader-specific set on one machine, and that set is not published — not because it
is secret, but because a rule tuned to one reader is noise to everyone else, and because the
count, the ordering and the wording of a private instruction file are that file's business. What
generalises is the eight rules above and the verdict method. If you have your own set, the useful
move is to run the same three-way classification over it and find out how few of your rules are
mechanically checkable. The answer is usually *fewer than half*.

## The shipped check

`checks/needs-you-first.mjs`, exported as `checkNeedsYouFirst(text, options)`.

Returns a plain object and never throws:

```js
{
  applicable: true,          // false when the message is below the floor or has no marker
  flagged: false,            // true only when a marker exists and prose precedes it
  reason: "marker-first",    // stable machine-readable token
  markerLine: 3,             // 1-indexed line of the marker, or null
  prosePrecedingChars: 0,    // substantive characters before the marker
  proseChars: 812            // substantive characters in the whole message
}
```

`reason` is one of `below-floor`, `no-marker`, `marker-first`, `prose-precedes-marker`.

**Options**, all optional, all set by whatever code calls the check — no shipped code path reads
them from the operator profile:

| Option | Default | Meaning |
|---|---|---|
| `markers` | `["Needs you"]` | Line-anchored markers that open a needs-you section. Matched case-insensitively against a line's text after stripping heading hashes, bold markers, and a trailing colon. |
| `minProseChars` | `200` | Messages with less substantive prose than this are reported `applicable: false`. |
| `graceChars` | `0` | Substantive characters allowed before the marker before flagging. Raise it if your house style opens with a standing one-line preamble. |

**What counts as substantive prose.** Headings are navigation and are skipped. Fenced code blocks,
HTML comments, and blockquoted lines are skipped. Blank lines, list bullets and horizontal rules
contribute nothing. Everything else counts.

**What it deliberately does not do.** It does not block, refuse, rewrite, or exit non-zero on a
flag — the CLI exits 0 whether it flags or not, because a check whose false-positive population is
unmeasured on your corpus must not be able to stop a turn. It is wired to no hook event. It
inspects one message at a time and holds no state.

**Calibrate before you trust it.** Run it over a few hundred of your own real messages and
hand-adjudicate thirty flags before you believe its rate. A structural check that has not met your
corpus is a guess with a number attached.

## Operator profile schema

JSON. Every field optional; an empty object is valid and yields the defaults.

```json
{
  "reader": "the person you are reporting to",
  "traits": [
    "reads the first two lines of any message and skims the rest",
    "wants the decision named before the reasoning that produced it"
  ],
  "markers": ["Needs you"],
  "minProseChars": 200,
  "graceChars": 0
}
```

- **`reader`** — a short noun phrase. Emitted verbatim into the session-start text so the rules
  name a real addressee instead of "the reader".
- **`traits`** — zero or more plain sentences about how that person reads. Emitted verbatim as a
  list under the default rules. **This is the whole of the reader-specific surface.** The plugin
  has no opinion about what a trait says and ships none.
- **`markers`**, **`minProseChars`**, **`graceChars`** — defaults for the shipped check, so the
  check and the delivered text agree about what a needs-you section looks like.

Resolution order: `$COMMUNICATION_RULES_PROFILE`, then `~/.claude/communication-rules.json`. A
missing profile is normal and not an error. A profile that exists but does not parse is reported
in one line at session start rather than swallowed, because a silent config failure reads exactly
like a working config.

**Keep the profile out of version control if it describes a real person.** A trait sentence is
information about somebody, it is attributable to whoever owns the repository, and a pushed commit
survives in forks and caches after any later deletion.
