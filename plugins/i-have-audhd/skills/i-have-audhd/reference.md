# i-have-audhd — reference

What the plugin's hooks do with the rules in [`SKILL.md`](SKILL.md): the enforcement
scoreboard, every check's and trigger's contract, the judge machinery, the session-start
injection, and the operator-profile schema including `enforcement`. Rule numbers below are
the skill's.

## The scoreboard

**A model-graded check that runs automatically inside a hook is still machinery.** It fires
on a deterministic trigger, it returns pass or fail, and every dispatch failure mode
(timeout, non-zero exit, unparseable output) is deterministic and fail-open. It is a
different instrument with a different error profile, not a non-enforcement.

| Check id | Skill rule | Instrument | Trigger / condition | Default mode |
|---|---|---|---|---|
| `needs-you-first` | 1, Skeleton | Deterministic — `checkNeedsYouFirst` | A needs-you marker exists and substantive prose precedes it | warn |
| `closing-ask-last` | 1, Skeleton | Deterministic — `checkClosingAskLast` | A closing-ask marker exists; more than one, or substantive prose follows the ask section | warn |
| `do-not-batch-by-label` | 1, Skeleton (caveats beside what they qualify) | Judge-in-hook — `findTrailingBatchSection` | A trailing labeled section (Uncertainties, Open questions, Questions, Caveats, Notes — fixed; the hook calls it on these defaults) with substance | warn |
| `conclusion-first` | 1, Skeleton (body, conclusion first) | Judge-in-hook — `conclusionFirstApplicable` | The whole message, receipt blocks included: ≥ 400 substantive chars; the judge reads the message's opening 20 words | warn |
| `plural-back-reference` | 6, References survive without scrolling | Deterministic — `checkPluralBackReference` | A closing-ask marker exists and its ask uses *those, these, both, them, the two, either one* with no referent in the same sentence | warn |
| `handed-command` | 10, Commands handed to the user | Deterministic — `checkHandedCommand` | The message hands the reader a shell command (a `bash`/`sh`/`zsh`/`shell` fence, *run/paste/type/execute/enter* + a code span starting with a known binary, or prompt lines under such an instruction) that is not one `zsh /abs/path/file.sh` line whose script sits under a `handedCommand.scriptRoots` root and outside every git checkout, or a `handedCommand.allow` match; receipts are exempt; runs at any length | warn |
| `restate-resumed-thread` | 8, Resume by restating content | Injector marker + judge | Session source was resume/compact; first substantive message after it | warn |
| `name-the-artifact` | 11, Machinery anchors | Deterministic — `checkNamesArtifact` | Report-shaped (≥ 400 chars + a report verb) and no artifact token anywhere | warn |
| `link-the-reference` | 11, Machinery anchors | Deterministic — `checkLinkTheReference` | A substantive line names `PR #N`, `pull request N`, `issue N` or a bare `#NN` with no GitHub pull/issues URL for that N on the line, or a file name with a listed extension and no absolute, `~/`, `file://` or http(s) path containing it on the line; two more kinds (*the report*-style phrases, branch-name code spans) ship off; receipts, fences and `→` lines are exempt | warn |
| `report-what-you-did-not-do` | 11, Machinery anchors | Todo trigger + judge | The transcript's last todo write has items not completed | warn |
| `bad-news-first` | 11, Machinery anchors | Lexicon gate + judge | The whole message, receipt blocks included: ≥ 200 chars and a negative-lexicon word in substantive lines; the judge reads the message's opening 20 words | warn |

Every warning and block reason names its skill rule, for example
`Needs you first (i-have-audhd rule 1, Skeleton) — …`, so a finding points at text the
model has, or can load. Every block reason ends with one `Way out:` line: the kill-switch file
`~/.claude/.i-have-audhd-off`, and the `enforcement.rules` profile key that sets each blocked
rule to `"warn"`.

**The one boundary that stays absolute:** *report what you did not do* is enforced exactly
where a todo list exists. **With no tracked plan the violation is silence and no instrument
sees it** — no check of emitted text can detect an omission with no corresponding plan item.
Likewise no instrument here decides whether a named artifact is the *right* one; that
remains the reader's judgment.

**Measured, not claimed — 2026-09-21, one real corpus.** 304 final assistant messages, 46
sessions, 11 seats, 2026-09-16 → 09-21; every flag hand-adjudicated; judge dispatch via
`codex exec --skip-git-repo-check -` (75 calls, 0 errors, 0 unparseable, median ~10.7s).
These adjudicated false-positive rates are why every default in the table above is `warn`:

| Check | Measured on | Flags / violations | Adjudicated FP | Verdict and the fix that would re-earn block |
|---|---|---|---|---|
| needs-you-first | 45 applicable | 18 flags | **16 (89%)** — a type-label line plus a short opener counted as substantive preceding prose | warn; treat a label line + short opener as non-substantive, or graceChars covering it |
| closing-ask-last | 41 applicable | 18 flags | **17 (94%)** — the ask section ends before the question's paragraphs and the attached recommendation | warn; the ask section must extend through the question, a following fence, and an attached recommendation paragraph |
| name-the-artifact | 198 applicable | 4 flags | **0 (n=4)** — all four genuine artifact-less reports | warn; a second corpus at 0 FP justifies block |
| do-not-batch-by-label | 50 sampled | 0 triggers | unexercised | warn; unmeasured, not proven |
| conclusion-first | 46 judged | 3 violations | **3 (100%)** — receipt-first openers (the command and its result, then the verdict) read as buried conclusions | warn; add the receipt-first shape to the judge question's compliant list |
| bad-news-first | 29 judged | 15 violations | **10 (67%)**, with 5 true positives | warn; raise the judge's bar to present-unresolved-cost |
| restate-resumed-thread, report-what-you-did-not-do | — | — | not measurable retroactively (resume markers are runtime; todo triggers need transcript todo writes) | warn; unmeasured |
| plural-back-reference | — | — | not yet measured (new in 1.0.0) | warn; unmeasured |

**Arming block is one explicit config flip** — `enforcement.mode: "block"`, or per-rule —
and the re-arming criteria are the recalibration directions above plus a second corpus. A
check whose measured rate is ~90% FP must not stop turns by default. The same measurement
says the machinery catches real violations — 2 + 1 + 4 deterministic true positives and 5
judge true positives, including bad news buried behind "nothing is broken" — so the
instrument is live, not parked. The adjudications, with per-flag pointers, are kept in a
private file on the measuring machine (mode 0700) and are not published, because they
contain real message bodies.

**Second corpus — 2026-10-14, the 1.1.0 checks.** 469 final assistant messages (410 OMP seat,
59 Claude Code), 2026-10-07 → 10-15, every rule at warn, the 1.1.0 Stop CLI unchanged, judge
`anthropic/claude-haiku-5-5` (881 calls, $0.19 total, $0.0004 per message, p50 2.2s, p95
4.3s, 0 failures). Every flag got three independent votes: `claude-opus-5-5`, `codex exec`
(gpt-6-astra) and `gpt-5.6-sol`; the FP rate below is the majority of three. The bar for
block was FP ≤ 10% on ≥ 15 flags.

| Check | Gate fired | Flags | FP, majority of 3 | Verdict |
|---|---|---|---|---|
| needs-you-first | 62 | 12 | 4 (33%) | warn |
| closing-ask-last | 39 | 6 | 3 (50%) | warn |
| plural-back-reference | 39 | 5 | 2 (40%) | warn |
| name-the-artifact | 271 | 2 | 0 (n=2) | warn; too few flags |
| do-not-batch-by-label | 0 | 0 | unexercised | warn |
| conclusion-first | 329 | 13 | 3 (23%) | warn |
| bad-news-first | 186 | 19 | 2 (11%) | warn; just over the bar, and opus-5-5 alone called 37% FP |
| report-what-you-did-not-do | 45 | 39 | 1 (3%) | warn: the 39 flags come from two sessions (32 and 7) re-checking the same unfinished todo lists, so they are two observations, not 39; opus-5-5 alone called 21% FP, mostly "the todo list is stale and the message implies each status" |
| restate-resumed-thread | 15 | 0 | — | warn |

No check earned block on independent evidence. The measurement scripts, corpus and votes
stay on the measuring machine for the same reason as the first corpus.

## The session-start injection

`hooks/i-have-audhd-inject.mjs`. stdin: the SessionStart payload (`session_id`, `source`,
optionally `reason`). stdout: one `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`
object. Exit 0 on every path.

`additionalContext` is, in order: one hook-owned line saying the person in this session
installed these rules and that they apply to every message to that person; the span of
`SKILL.md` between `<!-- inject:start -->` and `<!-- inject:end -->` (the first-turn core
and every rule heading); the profile's `reader` and `traits`, when set; and one line
pointing at this file and the kill switch. The span is read from the skill file each time,
so there is one copy of the core and it cannot drift. `I_HAVE_AUDHD_INJECT=off` silences the
emission (the resume marker below is still written). So does the profile's `inject: "none"`
(a checks-only install): no `additionalContext`, the resume marker still written, the
one-time judge notice still shown as `systemMessage`. Under `inject: "rules"` the core is
emitted and the judge notice is not, because the Stop hook checks nothing there.

When `source` is `resume` or `compact` (or `clear` with a reason mentioning compact, an
assumed shape), the injector writes the one-shot resume marker the Stop hook consumes for
rule 8.

**Delivery per host.** Claude Code runs the hook from `hooks/hooks.json` on every
SessionStart source (startup, resume, clear, compact). OMP does not run `hooks.json`; the
plugin's OMP extension, `omp/i-have-audhd-omp.ts`, spawns the same hook on the main
session's `session_start` (source `startup`, or `resume` when the session already holds
messages), on `session_switch` (`new` → `clear`, `resume`/`fork` → `resume`) and on
`session_compact` (`compact`). It offers the returned `additionalContext` to every
`before_agent_start` as a hidden custom message tagged with a per-crossing delivery id, so a
re-run of the preparation chain for the same prompt keeps it, and stops offering it once a
`context` event shows a model request carried that delivery. Subagent sessions get neither
the injection nor the Stop hook.

## The Stop hook

`hooks/i-have-audhd-stop.mjs`. stdin: the Stop payload (`session_id`,
`transcript_path`, `stop_hook_active`; OMP payloads additionally `last_assistant_message`).
stdout: one `{"decision":"block","reason":"…"}` object when a block-mode rule fired,
nothing otherwise. Exit 0 on every path.

Order of operations, each early return silent:

1. **Kill switch** — `~/.claude/.i-have-audhd-off`, `existsSync` per invocation
   (never a module-scope env read; env is frozen for the host process's lifetime).
   `I_HAVE_AUDHD_ENFORCE=off` is the secondary switch and costs a host relaunch. Then the
   profile's `inject`: `"rules"` means injection only, and the hook checks nothing. The flag
   file is read first and wins over every `inject` value.
2. Payload parse — empty stdin, unparseable stdin, or a non-object → a fault (below).
3. Text extraction — `last_assistant_message` when a non-empty string, else the transcript
   JSONL scanned backwards for the last `type:"assistant"` entry with text content
   (tool-call-only entries are skipped).
4. **Loop guard** — with `stop_hook_active`, a text hash equal to the recorded one passes:
   never block the same message twice. This runs before any check, on both harnesses.
5. **Master floor** — under 200 substantive chars only `handed-command` runs (a command-only
   handoff is short by nature); every other check and judge job needs the floor. The floor's
   prose count is rule-free (`proseCharCount`, `checks/lines.mjs`), so a disabled rule's check
   never runs.
6. Deterministic checks per their modes.
7. Judge jobs where triggers fired; a fired trigger with no judge command → `skipped.log`.
8. **Harness cap** — only when the env carries `I_HAVE_AUDHD_HARNESS=omp` (the OMP
   adapter sets it on its child; Claude Code never does). Every block-mode finding becomes
   warn when `enforcement.armOmp` is not `true`, or when it is and the payload carries
   `stop_hook_active`: a revision after a block is re-checked but never blocked twice. On
   OMP that payload flag is the adapter's, not the host's: OMP sets its own flag after any
   extension's continuation, so the adapter sends `true` only when the host flag is set and
   its previous result for the session was a block.
9. One block-mode finding emits the block and records the hash; warn findings, capped ones
   included, → `warnings.log` with their real rule id, and replace the session's
   `pending-warn-<session>.json` (a stop with none removes it). Reasons name the check and its
   skill rule and say what to move or add. A block also asks for corrected lines only — never
   a resend of the whole message; a warn does not, because its message has already gone out.
10. **Warn delivery, next turn.** `lib/pending.mjs` turns the warn findings into a short
   notice for the agent ("warning only; it was sent unchanged; apply each fix from your next
   message on", one capped line per finding) and a one-line summary for the person. Claude
   Code: `hooks/i-have-audhd-prompt.mjs` on `UserPromptSubmit` consumes the file and returns
   the notice as `additionalContext` and the summary as `systemMessage`. OMP: the adapter
   spawns the same CLI right after the stop and queues the notice with `sendMessage`
   (`deliverAs: "nextTurn"`, no `triggerTurn`), which OMP adds to the next prompt; the
   summary is a UI warning notice. Consumption deletes the file, so a notice arrives once.

Fail-open everywhere, never fail-silent. A fault (empty or malformed stdin, a throw, an
unparseable profile, a state file that cannot be read or written) leaves one `errors.log` line,
`<time> <file> <reason>`, and the hook's reply carries one warning line in `systemMessage`
naming the hook, the reasons and `errors.log`. A fault never blocks: the hook exits 0, and any
finding it did reach is still emitted.

On OMP the hook runs only for the main session: OMP's `session_stop` never fires for
subagent sessions, and OMP has no blocking equivalent of Claude Code's `SubagentStop`. The
plugin registers no `SubagentStop` hook on Claude Code either.

## The checks (deterministic)

All six: plain-object results, never throw, options as a second argument, `markers`
supplied by the caller REPLACE the default, and a stdin-or-file CLI that prints one JSON
object and exits 0. Line semantics are shared (`checks/lines.mjs`): headings are
navigation; fences, HTML-comment envelopes, blockquotes, and blank/structural lines carry
nothing (a comment opened mid-line runs to its `-->`, the text before the `<!--` still
counting; a fence marker inside a comment is comment text; a `<!--` in inline code is text);
markers are line-anchored and matched after stripping hashes, bullets, emphasis,
and a trailing colon — so `## Needs you`, `**Needs you**`, and `Needs you:` are one marker,
while `Needs you: two things` (content on the marker's own line) is not one.

### needs-you-first

`checkNeedsYouFirst(text, options)` → `{applicable, flagged, reason, markerLine,
prosePrecedingChars, proseChars}`; `reason` ∈ `below-floor | no-marker | marker-first |
prose-precedes-marker`. Options: `markers` `["Needs you"]`, `minProseChars` `200`,
`graceChars` `0`. Flags misordering only, never absence — the anti-ceremony argument the
README carries. Judged on the FIRST marker, so an interleaved message is not punished.

### closing-ask-last

`checkClosingAskLast(text, options)` → `{applicable, flagged, reason, markerLine,
markerCount, proseAfterChars, proseChars}`; `reason` ∈ `below-floor | no-marker |
single-ask-last | multiple-markers | prose-after-ask`. Options: `markers`
`["Closing ask"]`, `minProseChars` `200`, `graceChars` `0`. The ask SECTION is the marker
line plus the one paragraph after it (blanks skipped; a heading or fence directly after the
marker ends it empty). That paragraph is the ask itself; substantive prose in any later
paragraph or under any later heading is the overtime finding. Counts every marker — two is
the `multiple-markers` finding.

### plural-back-reference

`checkPluralBackReference(text, options)` → `{applicable, flagged, reason, markerLine,
askText, hits}`; `reason` ∈ `no-marker | empty-ask | no-plural-reference | referent-in-sentence |
referent-outside-sentence`; each hit is `{word, line, sentence}`. Options: `markers`
`["Closing ask"]`, `lexicon` `["those", "these", "both", "them", "the two", "either one"]`
(whole word, case-insensitive). The ask is the first marker's section, exactly as
`closing-ask-last` defines it. No length floor of its own: the Stop hook's 200-char master
floor gates it. Inline code is never searched for lexicon words.

A hit is acquitted when its sentence names the referents itself:

- a correlative — `both A and B`, `either one of A or B` — where A is not `of`, `and` or
  `or`, so `both of the files named above` stays a hit;
- an apposition — the word, at most one noun after it, then `:`, `(` or a dash and a list
  joined by `and`, `or` or commas (`merge the two branches: the auth fix and the cache fix`);
  or a `,` followed by two or more named items (``merge the two, `a.ts` and `b.ts` ``), so a
  following clause (`merge them, or leave them`) stays a hit;
- a named antecedent — `them`, `those`, `these` or `both` preceded in the same sentence by
  two or more named items (inline code spans or double-quoted strings).

Everything else is flagged, because the referent is outside the sentence:
`Should I merge those?` and `Should I merge both of the files named above?` flag;
``Should I merge both `foo.ts` and `bar.ts`?`` does not. Warn by default and unmeasured.

### name-the-artifact

`checkNamesArtifact(text, options)` → `{applicable, flagged, reason, proseChars,
matchedVerb}`; `reason` ∈ `below-floor | no-report-verb | artifact-named |
no-artifact-named`. Options: `minProseChars` `400`, `reportVerbs` `[fixed, added, updated,
changed, removed, built, shipped, ran, verified, wrote, refactored, installed, committed,
pushed]` (whole-word, case-insensitive). Applicable only when report-shaped. Satisfied by
any of: an absolute / home / relative path, a `file.ext:NN[:MM]` token, a fenced block, an
inline code span, a URL, or a line whose first word (after an optional prompt) is a common
command. **A vocabulary check, labeled as one** — hence warn by default.

### handed-command

`checkHandedCommand(text, options)` → `{applicable, flagged, reason, findings}`; `reason` ∈
`no-handed-command | script-line-only | bare-command | script-location` (`script-location`
when every finding is about where a script lives). Each finding is `{line, command, where,
problem}` with `where` ∈ `fence | inline | prompt` and `problem` ∈ `bare-command |
in-checkout | outside-script-roots | unresolvable-path`; `in-checkout` adds `checkout` (the
directory holding `.git`), `outside-script-roots` adds `roots` (as configured),
`unresolvable-path` adds `error` (the errno code, `ELOOP` for a symlink loop). Options: `allow`, glob patterns
(`*` any run of characters, `?` one, everything else literal) matched against the whole
command line by a bounded matcher (O(pattern × line), no regex backtracking);
`scriptRoots`, default `["~/agent-scratch"]`; `home`, what `~/` expands to (default the
user's home directory). The hook passes the profile's `handedCommand.allow` and
`handedCommand.scriptRoots`. No length floor: the Stop hook runs it under its master floor
too.

Handed means one of:

- a fenced block tagged `bash`, `sh`, `zsh` or `shell`;
- an untagged fenced block whose first command starts with a known binary, under a paragraph
  that tells the reader to *run, paste, type, execute* or *enter* it;
- a `console`, `text` or `shell-session` fenced block, or unfenced lines starting with a
  `$ `/`% ` prompt, whose first prompt line's command starts with a known binary, under a
  paragraph with that same kind of instruction ("Run this in your terminal:"). Only the
  prompt lines are commands; output lines are not;
- an inline code span starting with a known binary, after a clause on the same line that
  tells the reader to run, paste, type, execute or enter (`Run`, `then paste`, `Once it
  merges, run`, `you can run`). Every such span after the line's first imperative counts,
  not only the first. Spans separated only by whitespace are one command (`` `gh` `pr
  list` `` is `gh pr list`), and a span group that ends its line continues into a span group
  that opens the next line, and on through every following line that is one span group
  continuing the same way (`zsh` / `~/x.sh` / `--force` on three lines is one command);
  prose before or after a span on a line ends it. `I ran` and `I'll run` are the agent's own runs, not handed. A
  table row's cells are read one by one.

Known binaries are `name-the-artifact`'s command list plus `rm, sudo, open, launchctl,
defaults, kill, pkill, ln, tar, unzip, export, source, omp, claude, codex, just, vercel, fly,
op, security`.

Evidence never counts:

- **a receipt** — the block under a `**CLAIM**` or `**CITE**` label line: its first
  paragraph, then explanatory paragraphs (none tells the reader to run anything), fenced
  blocks and result lines. It ends at a heading, another label, a later paragraph with an
  imperative, or, once a fenced block is taken, the next paragraph that is neither a fence
  nor a result line;
- **an attached result** — any line or fenced block carrying `→`, and any line or fenced
  block whose very next line is a result line (opens with `→`, `exit N`, `exited N` or
  `Exit code: N`). A result after a blank line does not attach;
- **a retrospective list** — a numbered list item under a `What I ran`, `Ran` or
  `Verification` heading (a `#` heading, a bold-only line, or a line ending in a colon)
  whose own text carries a result (`→`, `exit 0`, `Exit code: 0`), fenced blocks inside it
  included;
- **a result table row** — a row with an entry in a column headed `Result`, `Exit`,
  `Output`, `Outcome` or `Status`, or with a result-line cell;
- blockquotes, HTML comments, and fences tagged anything else (a language).

A handed block or span passes when it holds exactly one command line of the shape
`zsh|bash|sh <absolute or ~/ path>.sh`, with no arguments and no shell operators, whose
script sits under one of `scriptRoots` and not inside a git checkout (a `.git` file or
directory in any parent, so worktrees count; a checkout listed as a root is still a
checkout); or one matching an `allow` glob, wherever it points. The script's path is
resolved as the kernel resolves it: each existing component through its real path before
the next is applied, so a `..` after a symlink climbs from the link's target
(`~/agent-scratch/jump/../x.sh`, `jump` linking into a checkout, is in that checkout); a
suffix that does not exist yet is kept lexically under its deepest existing ancestor; and a
path that will not resolve for any other reason (a symlink loop, `ELOOP`; a denied
directory) is the finding `unresolvable-path`. A leading `$ `/`% ` prompt
and `# …` comment lines are ignored. Two commands in one block are a finding even when both
are script lines. Every failing block or span is a finding; the warn or block reason names
the first one's line and command — plus the checkout, or the roots and the profile field,
for a location finding — counts the rest, and carries rule 10's text: more than one command,
or any interactive input, is a script file outside every git repository, and the reader
types one byte-identical line. Warn by default and unmeasured.

Where the heuristics cannot tell instruction from evidence, they stay silent only for text
under a label or with a result attached (a receipt, an attached result, a retrospective
list, a result table row) and warn everywhere else: any later code span starting with a
known binary on an instruction line is handed, and a console block or prompt line under any
imperative is handed.

Known limits (measured by the round-2 review, not fixed):

| Limit | Effect |
|---|---|
| A long literal after a `*` in an `allow` glob, against a near-miss command (`just *` + 2,048 × `a` + `z` against a 32,774-char line) | One check takes about 250 ms: the matcher is O(pattern × line), not a fixed bound |
| `$ cmd` prompt lines inside a table cell, under an instruction above the table or in an adjacent cell | Not handed: table cells are read for inline code spans only, so the prompt line is never classified |

### link-the-reference

`checkLinkTheReference(text, options)` → `{applicable, flagged, reason, findings}`; `reason` ∈
`no-prose | all-linked | unlinked-reference | no-kind-enabled`. Each finding is `{line, where,
kind, excerpt}`, one per offending line, naming the line's first unlinked reference. Option:
`kinds`, `{<kind>: boolean}`; a kind left out keeps its default. The hook passes the profile's
`linkTheReference.kinds`. No length floor of its own; it runs above the Stop hook's master
floor like every check but `handed-command`. One pass over the lines, regexes with no nested
quantifiers: a 1.9 MB message checks in tens of milliseconds
(`checks/link-the-reference.test.mjs` holds it under 400 ms).

| Kind | Flags | The link that clears it, on the same line | Default |
|---|---|---|---|
| `issue-ref` | `PR #N`, `PR N`, `pull request N`, `issue N`, and a bare `#N` of two digits or more not inside a URL, path or code span | an `https://github.com/…/pull/N` or `/issues/N` URL for that same N | on |
| `file-name` | a name ending in `.md .sh .zsh .mjs .ts .js .json .yaml .yml .txt .log .sql .py`, alone or ending a relative path | an absolute, `~/`, `file://` or http(s) path containing that name; a name that is itself part of such a path is the link | on |
| `artifact` | `the report`, `guide`, `handoff`, `inventory`, `review`, `spec`, `plan`, `script`, `log` or `transcript` | a URL, absolute or `~/` path, or markdown link after it in the same sentence | off |
| `branch` | a code span holding `[a-z0-9]+(-[a-z0-9]+)+` on a line that also says `branch` or `PR` | a PR URL or an absolute path on the line | off |

Never counts: every line `checks/lines.mjs` does not call prose (fences, HTML comments,
blockquotes, headings, structural lines); a receipt under a `**CLAIM**` or `**CITE**` label
(the same `receiptLines` definition `handed-command` uses), and a line that opens with its own
bold `**CLAIM**` or `**CITE**` label (a receipt written inline); any line carrying `→`; a line, or
a code span, whose first word is a known command (`handed-command`'s list plus `head, tail,
wc, diff, less, sort, xargs, env, tee`), whose file names are arguments rather than references.

**Measured** on the 2026-10-14 corpus, 469 real final messages from Claude Code and OMP
sessions (private: the corpus holds real message bodies), every kind on: 229 flagged lines in
138 messages. Every flag was classified by hand as a true reference the reader cannot open
from the line, or a false positive:

| Kind | Flagged lines | False positives | Rate | Shipped |
|---|---|---|---|---|
| `issue-ref` | 93 | 7 | 8 % | on |
| `file-name` | 90 | 3 | 3 % | on |
| `artifact` | 44 | 33 | 75 % | off |
| `branch` | 2 | 1 | 50 % | off (two flags; too few to trust either way) |

A kind over 30 % ships off. The `artifact` false positives are the phrase used generically
("the review flow", "the plan is to", the reader's own spec under discussion), with nothing to
link. `linkTheReference.kinds` turns either off kind on.

### links-resolve

`checkLinksResolve(text, options)` → `{applicable, flagged, reason, findings, lookups, links}`;
`reason` ∈ `no-prose | all-resolve | unresolved-link`. One finding per link, `{line, where,
kind, excerpt, …}`, in line order; `kind` ∈ `missing-path` (with `path`), `gh-shape` (with
`segment`), `gh-word` (with `word`, `urlKind`), `gh-missing` (with `key`), `gh-kind` (with
`key`, `urlKind`, `actualKind`). `lookups` is every GitHub key (`owner/repo#n`) with no fresh
cache entry, once each; `links` every link that resolved, `{line, sentence, href, kind:
"path"|"gh", path | key, ghKind, title}`, for the judge stage. Options (tests): `home`,
`exists`, `ghCache` (a parsed cache, `lib/gh-cache.mjs` `readGhCache`), `now`. The hook
passes the real cache, read only when the message contains `github.com` (a corrupt cache file
is reported on the stops that could use it, not on every stop); no profile field shapes this
check.

| Candidate | Resolved by | Finding |
|---|---|---|
| a code span holding only `/abs…`, `~…` or `file://…`, or a markdown link with such a target; a `file://` URL decoded first (`%E2%80%93` → `–`), then a trailing `:N`, `:N-M`, `:N–M`, a comma list (`:18,22`, `:13-14,56-59`), `:N:C`, `#LN`, `#LN-LM` and punctuation stripped | `existsSync` after `~` and `file://` expansion | `missing-path`, unless the missing path is a slash command or an HTTP route (`ROUTE_RE`: one segment with no dot, `/mcp`, `/wrap-up`, `/health`; or a `:param` segment, `/messages/:id/delivered`) |
| `https://github.com/<owner>/<repo>/<seg>/<n>` where `seg` is `issue`, `issues`, `pull` or `pulls` | the segment | `gh-shape` unless `issues` or `pull` |
| the same, with the nearest `PR`/`pull request`/`issue` word among the `WORD_WINDOW` (6) tokens before the URL, in the same clause (not past the sentence start, a `,`/`;`/dash, or an earlier URL); for a markdown link target, its link text supplies a word only as `PR #N` / `issue #N` with N the URL's own number (`[PR #79](…/issues/79)` is judged; `[the fix for the flaky-test issue](…/pull/80)` is not), and the window otherwise ends at the `[` | the word against the segment | `gh-word` when they disagree; no word near the URL, no finding |
| the same, with a cache entry inside its TTL (`HIT_TTL_MS` a week, `MISS_TTL_MS` ten minutes) | the entry's `kind` | `gh-missing` for `missing`; `gh-kind` when the kind and segment disagree; else a resolved link |
| the same, with no fresh entry | nothing: unknown | none; the key goes to `lookups` |

Never counts: every line `checks/lines.mjs` does not call prose, a line of an indented code
block (four spaces or a tab after a blank line, outside a list item; `indentedCodeLines`,
local to this check), any line carrying `→`, a
span that is a command (`link-the-reference`'s `isCommand`), a placeholder (`<…>`, `…`, a
glob character, `$VAR`, `/path/to/`, `/absolute/`), a relative path, a span holding more than
the path, and a path whose sentence (its own words, not the path's) says the file is still
to come or gone: `will|would|shall|should|going to|about to|planned|…|I'll|we'll|…` within 60
characters of `be|write|written|create|produce|generate|save|land|exist|appear|live|…`; `to
be written|produced|created|…`; `once|when it|that|the X lands|exists|merges|is written|…`;
`not|never|no longer|isn't|doesn't [yet] exist|there|present|written|saved|…`;
`didn't|did not|haven't|hasn't [yet] write|save|create|produce|generate` (any tense); `plan:`;
`step N`; `yet to be`; `removed|deleted|dropped|moved|renamed|unlinked|pruned|cleaned
up|gone|absent|missing`; `rm `. The sentence is the span from the previous `. `, `; `, `! ` or
`? ` (or line start) to the next, where the dot of `e.g.`, `i.e.`, `vs.` or of a dotted
version number (`1.6.`) does not end a sentence; a later sentence's tense does not cover an
earlier path.

**The GitHub cache**, `lib/gh-cache.mjs`: `<state dir>/gh-cache.json`, `{"entries": {"<owner>/<repo>#<n>":
{"kind": "issue"|"pr"|"missing", "title", "at"}}, "helper": {"at", "error", "loggedAt"}}`. An
unreadable or malformed file reads as empty (one `errors.log` line; a missing file is the
normal first state and logs nothing). **The helper**, `scripts/gh-cache-fill.mjs <cache>
<key>…`: spawned by the hook with `detached: true, stdio: "ignore"`, `unref()`, never
awaited; takes `<cache>.lock` (a lock younger than `LOCK_TTL_MS`, two minutes, means another
fill is running: exit, nothing done); looks up at most `FILL_MAX_KEYS` (20) keys with
`gh api --cache 10m repos/<owner>/<repo>/issues/<n> --jq …` (the issues endpoint answers for
PRs too, with `pull_request` set), each under 10 s and all inside `FILL_BUDGET_MS` (45 s);
HTTP 404 → `missing`; `gh` not on PATH, not logged in, 401, 403/429 → no entry, the loop
stops (the rest would fail the same way), `helper.error` is set and one `errors.log` line is
written at once, then at most hourly for the same error; writes entries through a temp file
and a rename, dropping entries past `HIT_TTL_MS`. `I_HAVE_AUDHD_NO_GH_FILL=1` in the hook's
environment skips the spawn. The fixtures in `scripts/fixtures/` are real `gh` captures
(`CAPTURED.txt` names the date and version; `capture-gh-api.sh` re-captures them).

Not checked: `agent://<id>`. Neither Claude Code nor OMP writes a registry of agent ids
anywhere on disk (`~/.omp` holds `agent/agent.db`, extensions and session files, none of
them a roster; `~/.claude` holds projects and plugins), so an id cannot be resolved against
anything and the sub-check is not built.

Measured (2026-11-04, this machine, a 200-link message: 100 existing paths, 50 missing, 25
issue URLs, 25 PR URLs, none cached): Stop hook wall time 37 ms median before, 42 ms after,
45 ms with the helper spawn; the check alone under 10 ms (`checks/links-resolve.test.mjs`
holds it under 50 ms).

False positives on a corpus (2026-11-04): the final messages of the 100 most recent real
Claude Code sessions (2026-10-05 to 2026-11-04, eval sandboxes excluded), checked against
this machine's disk. Before the round-1 fixes: 64 findings in 31 messages, 37 certainly wrong
in 25 messages (29 slash commands such as `/mcp` and `/health`, 1 route with a `:id`
segment, 3 not-yet-written sentences, 2 comma line lists, 2 paths on another machine), 0
confirmed right, 27 naming files deleted since. After: 29 findings in 10 messages, **2
certainly wrong** in 2 messages (`/dev/net/tun` and `/usr/local/etc/as2/`, paths on a server,
not this laptop), **0 plausibly or confirmably right**, 27 naming files deleted since the
message was written (old worktrees, removed HTML pages, archived decision logs), which cannot
be judged now. Most of those 27 name a file the message reports as just written or just read,
so the check would likely have been silent on them at the time.

Known limits:

| Limit | Effect |
|---|---|
| A detached child's survival past the hook's exit is not proven under Claude Code's hook process lifetime | the cache may never fill; GitHub existence and kind stay unknown, and unknown is silent |
| `gh api --cache` keeps 404s too | the helper asks with `--cache 10m`, matching the plugin's ten-minute miss TTL, so a PR named before it is opened reads as `missing` for at most about twenty minutes (gh's cached 404, then the plugin's entry) |
| A path quoted from another machine (a server's `/dev/net/tun`, a spec's `/usr/local/etc/as2/`) | read as a local path and flagged when this machine lacks it; the 2 certain false positives left in the corpus are this kind |
| A GitHub URL inside a markdown link's text, or any URL not on github.com | not checked at all: only github.com issue and pull URLs are read, and only their path |

### links-judge

`triggers/links-judge.mjs` — `linksJudgeJobs(links, {fs, maxJobs})` over `links-resolve`'s
resolved links → judge jobs `{rule: "links-judge", question, contextText, link, line}`. Off
until the profile names it (`lib/config.mjs` `BUILT_IN_MODES`): `enforcement.mode` does not
arm it, only `enforcement.rules["links-judge"]`. The prefilter: `significantWords` (runs of
three or more letters or digits, lowercased, minus English stopwords and link vocabulary:
`file path link url report doc issue pull request pr github …`) of the sentence with its
spans, links and URLs blanked, against the same of the target's descriptor — a file's basename
(separators as spaces) plus its first 1,500 bytes when it holds no NUL (a regular file only;
just those bytes are read, `openSync` + one `readSync`), a directory's name and first 40
entries, a GitHub link's cached title. A device, FIFO or socket (`/dev/zero`, a pipe) is not
a regular file and is never opened. One shared word, or a sentence with no significant
words, or a target that cannot be read or is not a regular file or directory, skips the
judge; otherwise one job, at
most `MAX_JOBS` (5) per stop in line order. The question asks for `violation=true` only when
the target is clearly not what the sentence names, `false` when unsure. The finding lists
each hit's line, link and the judge's reason. Unmeasured.

## The triggers (deterministic halves of judge rules)

- **`triggers/batch-heading.mjs`** — `findTrailingBatchSection(text, {headings})` →
  `{applicable, heading, headingLine, sectionText, sectionProseChars}`. The matched heading
  must be the last heading in the text; bold pseudo-headings (`**Notes**`) count; the
  section must contain prose. `batchJudgeContext(text, section)` marks the section for the
  judge.
- **`checks/sections.mjs`** — the receipt label line and the opening window.
  `labelOf(entry)` → the label a classified line carries, or null. A label line is a prose
  line (never fenced, commented or quoted) that is exactly one bold label, `CLAIM` or `CITE`,
  optionally with a parenthetical inside the bold (`**CITE(vendor docs)**`) and a trailing
  colon; an inline or bulleted bold label is not. The retired output-types labels (`PMDW`,
  `GUESS`, `ACTION`, `QUESTION`) are ordinary prose since 1.5.0. `checks/handed-command.mjs`
  reads the block under a label line as a receipt. `openingWords(text, 20)` is the message's
  opening window: the first 20 words of its heading and prose lines (markup stripped,
  crossing line and sentence breaks). The label set and the window size are constants, not
  profile settings.
- **Receipt blocks are not judge units** — `conclusion-first` and `bad-news-first` each send
  at most one judge job, its `contextText` the whole message verbatim, label lines and receipt
  blocks included. A receipt block (a `**CLAIM**` or `**CITE**` label line and its evidence)
  backs the point made around it, so it is judged with that point. From 1.1.0 to 1.7.1 the
  hook judged each labeled block alone; a blind re-measure on 2026-11-10 traced every
  conclusion-first false alarm on two judge models to a receipt block judged that way, because
  a receipt opens with its evidence by design. The question carries the message's window
  (`The reader's first 20 words here are: "…"`) outside the judged message.
- **`triggers/conclusion-first.mjs`** — `conclusionFirstApplicable(text, {minProseChars})`
  → `{applicable, proseChars}`. Default 400, over the whole message. The two-paragraph minimum it carried
  until 1.1.0 is gone: with "at the start" meaning the first 20 words, a single 400-char
  paragraph can bury its point at word 40.
- **`triggers/todo-unfinished.mjs`** — `lastIncompleteTodos(jsonl)` → `{applicable,
  incomplete, total}`. Scans backwards; the first todo snapshot decides. Claude Code:
  a `tool_use` whose name mentions `todo` (TodoWrite / todo), items from `input.todos`.
  OMP: the state is read exactly the way OMP rehydrates it (`canonicalTodoPhases`). A
  snapshot is a `custom` `user_todo_edit` entry (written by the eval bridge, `/todo` and the
  HUD editor) or a `toolResult` with `toolName` exactly `todo` that is not `isError` and whose
  `details.op` is not `view`; each carries the full list as `phases[].tasks[]`. Error and
  view results, and entries without a `phases` array, are passed over as OMP passes over them,
  and their calls do not end the scan; a todo call met before its own result (result
  missing) is a miss. A snapshot that fails OMP's `isTodoPhase` shape (string phase `name`,
  `tasks` array, string task `content`, status one of `pending`, `in_progress`, `completed`,
  `abandoned`, `blocked`) is unreadable, never an `[unknown]` item. Claude items are read
  defensively (`content|subject|text|title`, case-insensitive statuses); `completed`/`done`
  are complete, everything else is unfinished, including OMP's `blocked` and `abandoned`
  (dropped). It **skips on any parse miss** — a false "unfinished item" would be a false
  accusation in a block reason. `todoJudgeContext(text, todos)` appends the unfinished list,
  each item with its exact status and, for OMP, its phase (`- [abandoned] (Ship) Open PR`).
- **`triggers/bad-news-lexicon.mjs`** — `badNewsGate(text, {lexicon, minProseChars})` →
  `{applicable, proseChars, hits}`, over the whole message. Lexicon `[failed, failure, error, broke, broken,
  blocker, regression, cannot, can't, rejected, lost, missed, wrong]`, matched at word
  start (so "errors" matches, "terror" does not) over SUBSTANTIVE lines only. Deliberately
  over-inclusive: "fixed the error" trips the gate and is exactly the message the judge
  must acquit.
- **The rule 8 trigger is split across the hooks**: the injector writes
  `state/resume-<session_id>` when the SessionStart source is `resume` or `compact` (or
  `clear` with a reason mentioning compact — an assumed shape, documented); the Stop hook
  consumes the marker on the first substantive message after it. Consumption precedes
  dispatch, so the judgment is one-shot even with no judge configured. On OMP the adapter
  sends both hooks the session manager's id rather than the provider id in the
  `session_stop` payload, which a fresh-session or context reset rotates (that payload id
  stands in only when the manager id is unreadable); the marker it writes is the one its
  Stop consumes.

## The judge machinery

`judge/ask.mjs` — `askJudge(rule, question, contextText, config, options?)`; options
`{timeoutMs, stateDir, env}` exist for the test suite, `{meta: {session, section}}` is who is
asking, for the failure line. Never throws. Since 1.7.0 the resolution and the dispatch are
plugin-kit's shared judge, `lib/judge.mjs`, vendored byte for byte (the kit's test diffs it);
`ask.mjs` keeps the prompt, the verdict shape, the cache, the budget and the failure line.

- **Command** (`resolveJudge`, the kit's order): `enforcement.judgeCommand` in the profile,
  else `command` in `${XDG_CONFIG_HOME:-~/.config}/judge/config.json` (the shared file,
  written by `node lib/judge.mjs setup`). `null`/absent in the profile = no override. With a
  `{prompt}` placeholder, the prompt is shell-escaped into the command; without one, the
  prompt is piped to the command's stdin. The judge's environment carries
  `I_HAVE_AUDHD_ENFORCE=off I_HAVE_AUDHD_INJECT=off`. No command anywhere, or a malformed
  shared file, = judge rules inactive (the hook logs fired triggers to `skipped.log`:
  `rule=<rule> reason=no-judge-command profile=<path> shared=<path> session=<id>
  [malformed="<path>: <error>"]`). The budget is the harness's, never the shared file's
  `timeoutMs`.
- **Output**: STDOUT ONLY is parsed (judges print banners on stderr; merging the streams
  puts noise in front of the JSON; stderr's tail goes to the failure log). The LAST JSON object on stdout is the verdict; a
  `{"type":"result","result":"…"}` envelope is unwrapped by the kit, a bare `{"result":"…"}`
  by `ask.mjs`. The verdict must be strictly `{"violation": <boolean>, "reason": <string>}`.
- **Failures** — timeout, non-zero exit, a judge that cannot start, unparseable output —
  return `{unavailable: true, error, detail, cause, model, budgetMs, source, stderr?, stdout?}`
  with no verdict, plus one `judge-failures.log` line: `<time> rule=<rule> error=<kind>
  cause=<cause> session=<id> harness=<claude-code|omp> model=<model|unknown> elapsedMs=<n>
  budgetMs=<n> section=<label@line|whole> cache=<sha256> prompt=<state/cache/<sha256>.prompt.txt>
  detail="<the kit's: exit 127, no exit within 30000 ms, an errno>" source="<profile key or shared path>"
  [stderr="<last 300 chars>"] [stdout="<last 300 chars, bad-json only>"]`. `error` is one
  of the kit's `ERRORS`: `timeout`, `nonzero`, `unparseable`, `spawn-failed` (1.6.1 wrote
  `judge-timeout`, `judge-exit-<n>`, `judge-unparseable`, `judge-spawn-<errno>`). `cause`
  (`CAUSES`, `classify(error, stderr)`), in order: `timeout` → `hook-deadline` whatever
  stderr says; `unparseable` → `bad-json`; then stderr: `401`, `revoked`, `invalid api key|token`,
  `authentication_error`, `unauthorized` → `credential-revoked`; `no credential`, `not logged
  in`, `login required`, `no api key`, `gh|codex|claude login` → `no-credential`; `429`,
  `rate limit`, `too many requests`, `overloaded`, `quota` as a word of the error sentence
  (never a path segment such as `/tmp/quota/config.json`), `529` → `rate-limited`; `request
  was aborted` (a bare `aborted`, as in "parse aborted at byte 3", is not), `AbortError`,
  `ECONNRESET`, `socket hang up` → `judge-self-abort`;
  else `other`. `model` is read off the judge command (`modelOf`: `--model x`, `--model=x`,
  `-m x`, else the last `provider/model` token, else `unknown`); `session` and `section` come
  from the caller's `options.meta` (the Stop hook passes its session id only, so its lines read
  `section=whole`). The prompt is written on failure so the line's cache
  key is replayable: `<judgeCommand> < <prompt path>`. Each cause is pinned by
  `judge/failure-causes.test.mjs` to a stderr string from this machine's own log
  (`judge/fixtures/failure-corpus.mjs`); none was reproduced live. The Stop hook reports the
  rule as "Judge unavailable" in the rule's own mode, never as a pass, and tells the person
  once per rule and cause with that cause's fix (`causeFix` in the hook), then hourly
  (`lib/alerts.mjs`, keys `judge-unavailable:<rule>:<cause>`). Verdicts are never cached for
  a failure; the prompt file falls under the state directory's 30-day prune.
- **Timeout** — 30s on Claude Code; 20s when the stop core runs under the OMP adapter's
  `I_HAVE_AUDHD_HARNESS=omp` tag, because OMP drops a `session_stop` handler's result at 30s
  and the adapter kills the core at 25s. Nothing in the profile changes either value.
- **Cleanup** — the judge runs in a process group of its own; when it answers, fails, or
  times out, the whole group is killed and its pipes are released: a pipeline stage or a
  child still in the group does not outlive the stop, and a process that left the group
  cannot hold the hook open.
- **Cache** — `sha256(prompt)` → `state/cache/<hash>.json`, written only on a successful
  verdict. The key is the whole prompt (rule, question, message), because the
  `conclusion-first` and `bad-news-first` questions carry the message's opening window. Same
  prompt, same verdict, one bill; cache files from before 1.1.0 stop matching.
- **Example command** (stdin form): `codex exec --skip-git-repo-check -`. Any command that
  prints the verdict object on stdout and exits 0 inside the timeout works; run the one you
  configure once by hand, with a short prompt on stdin, before relying on it.

## Operator profile schema

JSON at `$I_HAVE_AUDHD_PROFILE` or `~/.claude/i-have-audhd.json`. Every field optional; an
empty object is valid and yields the defaults.

```json
{
  "reader": "the person you are reporting to",
  "traits": ["reads the first two lines of any message and skims the rest"],
  "inject": { "mode": "full", "rules": { "commands": true } },
  "linkTheReference": { "kinds": { "artifact": false } },
  "handedCommand": { "allow": ["just deploy-*"], "scriptRoots": ["~/agent-scratch"] },
  "enforcement": {
    "mode": "block",
    "judgeCommand": "codex exec --skip-git-repo-check -",
    "rules": { "name-the-artifact": "warn", "bad-news-first": "warn", "links-judge": "warn" },
    "armOmp": false
  }
}
```

- **`reader`** — short noun phrase, emitted verbatim at session start.
- **`traits`** — plain sentences about how that person reads, emitted verbatim after the
  skill's core. The plugin ships none.
- **`inject`** — `full | rules | none`, or an object `{"mode": "full|rules|none", "rules":
  {"<rule id>": true|false}}`; default `full`, every rule on. The string form is the object
  with that mode and every rule on; a missing `mode` is `full`. What the plugin runs,
  independent of the enforcement modes: `full` is the session-start injection and the Stop
  checks; `rules` is the injection only, and the Stop hook checks nothing; `none` is no
  injection, and the Stop checks still run. A rule set to `false` is cut from the injected
  core (its `**Name (rule N).**` block and its `- N.` list line, `lib/rules.mjs`
  `compileCore`), and every check bound to it defaults to `off`. Rule ids, defined once in
  `lib/rules.mjs` `RULES`: `skeleton` (1), `layer` (2), `blunt-facts` (3), `recommend` (4),
  `grade-signals` (5), `references` (6), `assumptions` (7), `resume` (8), `durable` (9),
  `commands` (10), `machinery-anchors` (11); the check-to-rule binding is `lib/rules.mjs`
  `CHECKS` (the Skill rule column of the scoreboard). Read by both hooks (`lib/config.mjs`
  `loadSwitches`); any invalid shape (an unknown mode, key or rule id, a non-boolean switch)
  is one `errors.log` line naming every problem, and the whole field reads as `full` with
  every rule on.
- **`linkTheReference.kinds`** — `{"issue-ref"|"file-name"|"artifact"|"branch": boolean}`;
  a kind left out keeps its default (`issue-ref` and `file-name` on, the other two off). Any
  other shape → one `errors.log` line and every kind's default.
- **`handedCommand.allow`** — glob patterns the `handed-command` check accepts besides
  `zsh /abs/path/file.sh`. Not an array of non-empty strings → one `errors.log` line, ignored.
- **`handedCommand.scriptRoots`** — directories a handed script may live under, absolute or
  `~/` paths, default `["~/agent-scratch"]`. A script outside all of them, or inside any git
  checkout, is a finding. Not a non-empty array of absolute or `~/` paths → one `errors.log`
  line, and the default applies.
- **`enforcement.mode`** — `block | warn | off`. Unset = each rule's built-in default (warn
  for every rule but `links-judge`, whose built-in is off); set = overrides built-ins both
  ways, except that a rule whose built-in is off stays off: `links-judge` is armed only by
  its own `enforcement.rules` entry.
- **`enforcement.judgeCommand`** — this plugin's override of the shared judge file; see the judge section.
- **`enforcement.rules`** — per-rule mode overrides, keyed by check id; beat the global
  mode and built-ins.
- **`enforcement.armOmp`** — boolean, default `false`. Read only under the OMP harness tag
  (stop-hook step 8): `true` lets OMP seats block on a first stop; anything else keeps them
  at warn. Under the tag a non-boolean is one `errors.log` line and reads as `false`;
  without the tag the field is never read, so a malformed value logs nothing.
- Precedence: kill-switch file > `inject` mode > `rules[rule]` > the check's rule switched
  off in `inject.rules` (→ `off`) > a built-in `off` (`links-judge`) > explicit `mode` >
  built-in default, then the OMP harness
  cap last (OMP seats only: unarmed → warn; armed + a revision after this plugin's own block
  → warn). The same-text loop guard precedes all of it. The kill-switch file turns the Stop
  checks off under every `inject` value; it never touched the injection and still does not.

A missing file or field is silent defaults. An unparseable file, or a value of the wrong
shape, is defaults plus one `errors.log` line and the hook's warning line.

**Check options are not profile fields.** `markers`, `minProseChars`, `graceChars`,
`headings`, `lexicon`, `reportVerbs` are call-site arguments; the hook calls every check on
its defaults.

**Keep the profile out of version control if it describes a real person.** A trait sentence
is attributable to whoever owns the repository it sits in, and a pushed commit survives in
forks and caches after any later deletion.

## State files

All under `~/.claude/.i-have-audhd-state/`:

| File | What it holds |
|---|---|
| `warnings.log` | Warn-mode findings, one line each, rule named — the record |
| `pending-warn-<session>.json` | The latest checked stop's warn findings, waiting for the next turn — the delivery; deleted when consumed |
| `skipped.log` | Judge-rule triggers that fired with no judge command — a skipped check must be inspectable |
| `judge-failures.log` | Judge dispatch failures (timeout, exit, unparseable), rule and error named |
| `errors.log` | Every fault, one `<file> <reason>` line each: payload parse, config parse, unwritable state, hook exceptions, OMP adapter fail-opens |
| `last-blocked-<session>.json` | The loop guard's recorded text hash and rules |
| `resume-<session>` | The one-shot rule 8 marker (timestamped) |
| `cache/<hash>.json` | Judge verdicts |
| `alerts.json` | When each failure alert was first raised and last told, per error key — the once-then-hourly cadence (`lib/alerts.mjs`) |
| `judge-notice-shown` | Present once the session-start hook has shown its no-judge notice (timestamped); the notice is not shown again |
