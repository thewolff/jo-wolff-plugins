# Output types — the remainder

**This file is deliberately not a standalone document, and does not restate a single type, rule, or
definition.** The six types and their receipts, the rule that a receipt rather than confidence sets
the type, the three GUESS bases, how a label is rendered, the eight rules, the absolute-path receipt
requirement, the envelope, and the four degradation tiers are all in `SKILL.md`, stated once. This
file carries only what that leaves out. **Every rule in this plugin exists in exactly one place,
which is a maintenance property rather than a stylistic one: two statements of one rule drift, and
nothing detects it.**

## What counts as a receipt, in order of preference

1. **Official vendor documentation, freshly fetched this session.** Not remembered.
2. **A live test actually run this session** — the API called, the SDK exercised, the code path run,
   the test executed, the page loaded.
3. **The code actually read** — the function under discussion, its callers, its tests; plus
   version-control history and the project's own written record for internal questions.
4. **A published changelog or migration guide.**

**Not receipts:** filenames, route paths, table and column names, environment-variable names,
prior-session memory, and training-data instinct ("X usually throws on ..."). If you cannot confirm a
hypothesis from a primary source, say so.

### A receipt proves what it proves, and no more

**CLAIM is defined by provenance, not by whether the subject is code.** An attributed statement
proves that the person or record supplied the statement; it does not prove every implication of the
statement. A live test proves what was observed in that test; it does not automatically establish a
universal rule about the tested system. A parent may preserve an upstream CLAIM only when it
preserves the receipt and does not broaden the conclusion.

### Receipts stay terse

`<repo-root>/src/server/routes/citations.ts:88` — not a pasted code block. `npm test → exit 1, 3
failing` — not the full log. The receipt proves the check happened; it is not the evidence dump.
**Terse means no surrounding evidence dump, not a shortened path:** an absolute path is long and
still terse, because every character of it is doing the work of making the reference openable.

### An empty result is not evidence of absence until you say what was searched

A sweep that reports "clean", "no matches", or "none found" must state what it actually covered — the
file count, the roots walked, the pattern used. `scanned 257 files across 2 roots, 0 hits` is a
receipt; `no issues found` is not, and whoever reads it should treat it as unverified. A command that
dies before scanning anything, or that silently skips its target, still prints a confident all-clear.

### An inherited list is not a measured population

The rule above governs an empty *result*. This governs a wrong *input*: a sweep whose file,
repository, or record list came from a document rather than from enumerating the thing itself returns
a confident **non-empty** result about the wrong set, and nothing signals the omission. Derive the
population with a command, and cite the command.

## Tables of assertions

Block labels cannot fit table syntax, which is why table rows ship bare by default. A table whose
rows are assertions gets a leading `Type` column — one label per row — and a `Receipt` column where a
receipt applies:

| Type | Statement | Receipt |
|---|---|---|
| CLAIM | `POST /v1/feeds` rejects unauthenticated requests | `curl ... :8080/v1/feeds → 401` |
| GUESS(pattern) | `/v1/feeds/legacy` probably skips the auth check | none — route file not read this session |

A single label scoping the whole table is acceptable only when every row is the same type — real
findings tables are usually mixed. Pure-layout tables — a glossary, a port listing, a file inventory
— are structure, not assertions, and are exempt; a rule that appears to demand labeling structure
gets ignored wholesale. If in doubt, it is an assertion table.

## Headers, bottom lines, and recommendations

Markdown headers are navigation, not assertions, and carry no label — labeling a header would mangle
the document for no gain. But the **first line under every header is a statement like any other and
must be labeled.** If a header's text itself asserts something ("Three endpoints are blockers"), the
assertion is restated as a labeled line directly beneath it; the header alone is never the record.

The summary or bottom-line sentence is the single most commonly bare statement in practice, and the
one the reader is most likely to act on directly — it gets a label like everything else, never a free
pass for coming last. The same applies to recommendation and "what to do" sections: a recommendation
is almost always a GUESS (a proposal, not a verified fact) or PMDW (an offer to proceed), and naming
it as such is the point, not a hedge.

## Report skeleton

A structured report follows this section order, each section leading with a label:

1. **Blockers and questions** — first, not last. Anything a decision depends on that could not be
   verified, and any choice that was not yours to make, with the options named.
2. **Findings** — the typed statements, tables included.
3. **Coverage** — what was actually checked and what was not, as ACTION.
4. **Bottom line** — the one decision-relevant sentence, labeled.

Adapt section names to the task; the ordering — blockers first, bottom line last but never unlabeled
— is what matters, not the exact headings.

## Worked example

A fictional auth check on three endpoints, chosen to demonstrate the four cases that drift most
often: a findings table, a section header, a bottom-line sentence, and a recommendation.

> ## Blockers and open questions
>
> **GUESS(recall)**
> I believe the mobile clients still call `/v1/feeds/legacy`; nothing in this session confirms it.
> The recommendation to delete the route depends on this — treat it as a blocker, not an assumption.
>
> **QUESTION**
> should `/v1/feeds/legacy` keep working at all? Adding the preHandler preserves whatever still calls
> it; deleting the route closes the gap outright. That is a product call rather than a verification
> gap — I guarded it in the recommendation below so nothing breaks while you decide.
>
> ## Findings
>
> | Type | Statement | Receipt |
> |---|---|---|
> | CLAIM | `POST /v1/feeds` rejects unauthenticated requests | `curl ... :8080/v1/feeds → 401` |
> | CLAIM | `GET /v1/feeds/:id` checks the JWT in a preHandler | `<repo-root>/src/server/routes/feeds.ts:41` |
> | GUESS(pattern) | `/v1/feeds/legacy` probably skips the preHandler | none — route file not read this session |
>
> ### The legacy route
>
> **CLAIM**
> `<repo-root>/src/server/routes/feeds.ts:107` registers `/v1/feeds/legacy` with no `preHandler`
> option, unlike the two routes above it.
>
> ## Recommendations
>
> **GUESS(inference)**
> Add the same preHandler to the legacy route rather than deleting it, until the mobile question
> above is answered. Based on the pattern at `<repo-root>/src/server/routes/feeds.ts:41`; not a
> verified requirement.
>
> ## Bottom line
>
> **CLAIM**
> One of the three endpoints (`/v1/feeds/legacy`) is missing auth —
> `<repo-root>/src/server/routes/feeds.ts:107`, confirmed by a 200 from an unauthenticated curl.
>
> ```
> <!-- output-types
> tier: 2
> CLAIM: 4
> CITE: 0
> GUESS: 3 (inference 1, pattern 1, recall 1)
> ACTION: 0
> PMDW: 0
> QUESTION: 1
> -->
> ```

**`<repo-root>` above is a slot, not a literal.** It appears here rather than a plausible-looking
path precisely because a plausible-looking path would be copied.

## Parent-side handling

The session that dispatched a subagent owns the other half of this contract:

- A report arriving with **zero labels** is Tier 3, no matter how well it reads. Do not act on it.
  Re-delegate with the contract restated, or verify the claims directly.
- A **Tier 1 or Tier 2** report is usable — but the parent carries its tier forward. Do not present a
  Tier 2 finding as though the whole surface was audited.
- **Guesses inherited from a subagent stay guesses, with their basis intact.** Summarizing,
  synthesizing, or restating in your own voice does not upgrade them.
- **Subagent output is the source of truth for its CLAIMs, and only for those.** A statement carrying
  a receipt is authoritative and gets acted on without re-reading the file. A statement without one
  is verified before anything depends on it. **A subagent report with no receipts anywhere is a
  hypothesis, not a source of truth** — send it back or check it directly.

### A brief's premises are yours the moment you write them down

Every factual claim you put into a brief for someone else is re-derived at the moment you write the
brief — not paraphrased from a note written days ago, not carried forward from what someone told
you, not recalled.

**The reason is blast radius rather than accuracy.** A wrong statement in a report gets read once and
corrected. A wrong premise in a brief becomes the frame the worker builds inside, and the worker has
no way to inspect where it came from — it arrives wearing the authority of whoever dispatched them.

**The tell is the feeling, so learn the feeling.** The premises that fail are the ones that read as
settled background rather than as assertions, which is exactly why they slip past a self-check aimed
at finding unsupported claims. A sentence that sounds like context you already agreed on is the one
to re-run.

**And from the receiving end: check a delegating brief's factual claims before building on them.** A
brief's premises are the parent's measurements, not yours. Quoting one back in your own report
launders it into an apparent measurement of your own.

## Weighting by role

Agents are not evenly distributed across the types. Match the weight to what the agent does, not to
what it is called:

- **Lookup and retrieval** — finding a definition, listing matching files, running a test suite.
  Nearly all CLAIM plus receipt. One that cannot find something reports the empty result; it does not
  reason about where the thing probably is.
- **External research** — CITE-heavy. Already required to cite; the addition is that unfetchable
  sources become explicit GUESSes rather than quiet omissions.
- **Implementation and debugging** — ACTION-heavy. Every command run, every test result, every file
  written, plus the reversal path.
- **Planning and narrative** — legitimately mostly GUESS, and should say so. A plan is a proposal,
  not a set of verified facts. Marking it honestly is the point, not a defect.
- **Review and audit** — every finding is a CLAIM and needs a receipt, or it is a GUESS and gets
  ranked below the findings that have one.

QUESTION follows from whether the agent is in a position to make a choice at all. An agent producing
a diff or a plan is left holding a decision that is not its own when the brief is under-specified. A
reviewing or reading agent asks more narrowly: which artifact, which of several matching files, who
the audience is. An agent returning data against a fixed ask does not ask for decisions; an unclear
input is reported as what it is, not escalated as a choice.

## Scope — two exemptions

- **This governs the agent's own assertions, not the user's.** An observation a person reports is a
  starting constraint, not something to be downgraded. They have eyes on systems the agent does not —
  live interfaces, browser state, dashboards, error screens. Start from their reality and investigate
  the cause rather than first checking whether they are correct. If investigation shows they misread
  something, say so clearly, with evidence from the same system they are looking at. The rule is
  about sequencing: investigate first, correct second.
- **Conversational content is marked, not exempt.** Ordinary back-and-forth carries the PMDW marker.
  But a load-bearing statement inside a chat reply still gets its type label, and when a chat reply
  *is* the deliverable — an investigation result, a recommendation expected to be acted on — it is a
  report and the full contract applies, envelope included.

## Commands handed to a person to run

**Rule zero: hand over only what you cannot run yourself.** Another machine, credentials you do not
hold, an operation the person must gate, or something a permission boundary genuinely blocks.
Everything else you run yourself and report as an ordinary ACTION. This gate comes first because
without it the rules below make the problem worse: an elaborate protocol for handing commands over
quietly pulls work *into* someone's terminal that belonged in yours, and for a person who finds
terminal work costly the best handed-over command is the one that was never handed over.

When you do hand something over it is a **proposed ACTION**, carrying ACTION's full receipt burden
including the reversal path, and it has to survive being read in isolation, hours later, with no
memory of the turns above it.

Never make anyone assemble a runnable command out of scrollback. Assume zero carryover between turns,
and assume the same about their shell state. The rules against making a reader scroll all scan for
things that *look* like references — ticket identifiers, codenames, coined shorthand, plural
back-references — and a fenced command block passes that scan clean while doing the same damage.

1. **Every correction reissues the whole thing, runnable from cold.** Not the changed line, not the
   changed block, not "same as before but with X." The complete sequence again from the first step
   with the fix folded in. It will feel redundant. It is cheaper than making the reader diff two
   versions across four turns of scrollback.
2. **More than one command, or any interactive input, means a script file.** Write it somewhere
   outside every git repository and outside anything a repository's tooling cleans — a durable
   scratch directory under the user's home works; a session-scoped temporary directory does not,
   because it gets cleaned up and a `--restore` mode nobody can run any more is not a reversal path.
   The thing the person types is one unchanging line — the interpreter matching the script's shebang
   plus the path — and it stays byte-identical for the life of the task. Corrections edit the file;
   they re-run the same line.
3. **Every script is safe to run from the top, every time.** No step assumes a variable set by a
   previous run, and no step is "skip this if you already did it." Re-running from scratch is always
   correct, so there is never a question of which lines already ran. Interactive prompts live inside
   the script.
4. **Prose never sits between pasteable blocks.** Explanation goes above the block or below the whole
   sequence, never in the middle where a paste can swallow it and produce a `command not found` on
   your own sentence.
5. **Test the syntax before handing it over, against the shell they actually run. Do not assume a
   shell.** `echo $SHELL` or asking costs nothing, and guessing produces a command that fails on
   paste. Then prefer constructs that work in both bash and zsh so the question stops mattering:
   `printf 'Type MOVE to proceed: '` followed by `read -r REPLY` is the portable visible prompt and
   prints unconditionally in either. The traps are the shell-specific forms — `read -p "prompt"` is a
   bash-ism that fails in zsh with `read: -p: no coprocess`, and `read -rs "VAR?prompt: "` is the zsh
   form that also *hides* what is typed, correct for a password and wrong for a confirmation, where a
   user who sees no echo reasonably concludes the thing has hung. Both were live-tested to establish
   that; that is the bar.
6. **Scripts announce each step, stop on the first failure, and log themselves.** Announce before
   acting so a failure is locatable from the output alone; check the exit status of every step that
   can fail and stop there rather than continuing into a confident "done"; and tee the whole run to a
   fixed log path next to the script (`exec > >(tee "$LOG") 2>&1` — process substitution, available
   in bash and zsh but not POSIX `sh`; under `sh` pipe the whole body to `tee` instead). Then the
   failure message is one sentence: *"this broke — the log is already at `<path>`."* The agent reads
   the log with its own tools. **Never ask the person to diagnose, narrow it down, comment something
   out, or "try just this part."** Making them select the right span of terminal output and paste it
   back is assembling content out of scrollback — the exact thing rule 1 forbids, reintroduced on the
   return path, arriving at the moment they are most loaded. It gets through the self-check because
   it feels like helpful triage rather than a regression.
   - **Do not trust `set -e` to stop a compound sequence at the step that failed.** Check the
     artifact, not the exit status. Observed in practice: an inline script whose assertion raised,
     whose every downstream step then ran against an unmodified file, and which reported success
     throughout. **"nothing to commit" is a failure message when you believe you just made an edit** —
     it reads as benign because it is the normal output of a no-op.
7. **Destructive steps preview, confirm, and print their undo.** Anything that deletes, moves,
   overwrites, or writes to a shared system first prints exactly what it will touch, then blocks on a
   typed confirmation inside the script, then prints the command that reverses it. Prefer a reversible
   staging step (move to quarantine) over the irreversible one (delete), and let the irreversible step
   be a separate later decision.

This applies to any surface where a person is the one executing — terminal commands, SQL to paste into
a console, curl invocations, one-off scripts. It does not apply to commands an agent runs itself.

## Compatibility with a message-structure contract

A companion contract may govern the *shape* of a message rather than the *type* of its statements —
conclusion first, one closing ask, at most two open decisions, detail below. **The two appear to
disagree about where an open question goes, and they do not.**

This contract puts blockers and questions at the **top**. A message-structure contract puts a single
closing ask **last**. Both hold, because they describe different objects:

- A **blocker** is something the reader must **know** immediately — evidence that is missing and that
  a decision already depends on. It goes at the top, with its basis intact.
- A **closing ask** is the one thing the reader must **choose** right now. It goes last, restating its
  own subject in full so it survives being read alone.

A QUESTION can be both, and when it is, it appears twice: named at the top as the thing the reader
must know is outstanding, and restated in full at the end as the thing they are being asked to decide.
That is deliberate duplication, not a contradiction, and it is cheaper than making someone scroll back
to find out what the ask was about.
