# communication-rules — reference

Four things live here: the enforcement scoreboard for the eight delivered rules, every
check's and trigger's contract, the judge machinery, and the operator-profile schema
including `enforcement`.

## The re-derived scoreboard (0.2.0)

Enforcement is wired. The old verdicts — "log-only", "registered nowhere",
"unenforceable by construction" for rules a machine can now judge in a hook — are
superseded. The governing reframe: **a model-graded check that runs automatically inside a
hook is still machinery.** It fires on a deterministic trigger, it returns pass or fail, and
every dispatch failure mode (timeout, non-zero exit, unparseable output) is deterministic
and fail-open. It is a different instrument with a different error profile, not a
non-enforcement.

| Rule | Instrument | Trigger / condition | Default mode |
|---|---|---|---|
| Needs you first | Deterministic — `checkNeedsYouFirst` | A needs-you marker exists and substantive prose precedes it | block |
| One closing ask, last | Deterministic — `checkClosingAskLast` | A closing-ask marker exists; more than one, or substantive prose follows the ask section | block |
| Do not batch by label | Judge-in-hook — `findTrailingBatchSection` | A trailing labeled section (Uncertainties, Open questions, Questions, Caveats, Notes — configurable) with substance | block |
| Conclusion first | Judge-in-hook — `conclusionFirstApplicable` | ≥ 400 substantive chars and ≥ 2 substantive paragraphs | block |
| Name the file, command, or line | Deterministic — `checkNamesArtifact` | Report-shaped (≥ 400 chars + a report verb) and no artifact token anywhere | **warn** |
| Restate a resumed thread | Injector marker + judge | Session source was resume/compact; first substantive message after it | block |
| Report what you did not do | Todo trigger + judge | The transcript's last todo write has items not completed | block |
| Bad news in the first sentence | Lexicon gate + judge | ≥ 200 chars and a negative-lexicon word in substantive lines | block |

**The one boundary that stays absolute:** *report what you did not do* is enforced exactly
where a todo list exists. **With no tracked plan the violation is silence and no instrument
sees it** — no check of emitted text can detect an omission with no corresponding plan item.
Likewise no instrument here decides whether a named artifact is the *right* one; that
remains the reader's judgment.

False-positive rates are **not claimed anywhere in this file** — the deterministic checks
and judge questions have not yet been measured against a real corpus of messages. The
floors and the judge questions' "when unsure, answer violation=false" defaults exist for
exactly that reason. Measure before you trust.

## The Stop hook

`hooks/communication-rules-stop.mjs`. stdin: the Stop payload (`session_id`,
`transcript_path`, `stop_hook_active`; OMP payloads additionally `last_assistant_message`).
stdout: one `{"decision":"block","reason":"…"}` object when a block-mode rule fired,
nothing otherwise. Exit 0 on every path.

Order of operations, each early return silent:

1. **Kill switch** — `~/.claude/.communication-rules-off`, `existsSync` per invocation
   (never a module-scope env read; env is frozen for the host process's lifetime).
   `COMMUNICATION_RULES_ENFORCE=off` is the secondary switch and costs a host relaunch.
2. Payload parse — unparseable stdin → `errors.log`.
3. Text extraction — `last_assistant_message` when a non-empty string, else the transcript
   JSONL scanned backwards for the last `type:"assistant"` entry with text content
   (tool-call-only entries are skipped).
4. **Loop guard** — with `stop_hook_active`, a text hash equal to the recorded one passes:
   never block the same message twice.
5. **Master floor** — under 200 substantive chars, nothing runs.
6. Deterministic checks per their modes.
7. Judge jobs where triggers fired; a fired trigger with no judge command → `skipped.log`.
8. One block-mode finding emits the block and records the hash; warn findings →
   `warnings.log`. Reasons name the rule, say what to move or add, and ask for corrected
   lines only — never a resend of the whole message.

Fail-open everywhere with `errors.log` as the single failure channel.

## The checks (deterministic)

All three: plain-object results, never throw, options as a second argument, `markers`
supplied by the caller REPLACE the default. Line semantics are shared (`checks/lines.mjs`):
headings are navigation; fences, HTML-comment envelopes, blockquotes, and blank/structural
lines carry nothing; markers are line-anchored and matched after stripping hashes, bullets,
emphasis, and a trailing colon — so `## Needs you`, `**Needs you**`, and `Needs you:` are
one marker, while `Needs you: two things` (content on the marker's own line) is not one.

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

### name-the-artifact

`checkNamesArtifact(text, options)` → `{applicable, flagged, reason, proseChars,
matchedVerb}`; `reason` ∈ `below-floor | no-report-verb | artifact-named |
no-artifact-named`. Options: `minProseChars` `400`, `reportVerbs` `[fixed, added, updated,
changed, removed, built, shipped, ran, verified, wrote, refactored, installed, committed,
pushed]` (whole-word, case-insensitive). Applicable only when report-shaped. Satisfied by
any of: an absolute / home / relative path, a `file.ext:NN[:MM]` token, a fenced block, an
inline code span, a URL, or a line whose first word (after an optional prompt) is a common
command. **A vocabulary check, labeled as one** — hence warn by default.

## The triggers (deterministic halves of judge rules)

- **`triggers/batch-heading.mjs`** — `findTrailingBatchSection(text, {headings})` →
  `{applicable, heading, headingLine, sectionText, sectionProseChars}`. The matched heading
  must be the last heading in the text; bold pseudo-headings (`**Notes**`) count; the
  section must contain prose. `batchJudgeContext(text, section)` marks the section for the
  judge.
- **`triggers/conclusion-first.mjs`** — `conclusionFirstApplicable(text, {minProseChars,
  minParagraphs})` → `{applicable, proseChars, paragraphs}`. Defaults 400 / 2. Paragraphs
  are prose runs broken by blanks, headings, or fences.
- **`triggers/todo-unfinished.mjs`** — `lastIncompleteTodos(jsonl)` → `{applicable,
  incomplete, total}`. Scans backwards for the last tool call whose name mentions `todo`
  (TodoWrite / todo), extracts items defensively (`content|subject|text|title`,
  case-insensitive statuses; `completed`/`done` are complete), and **skips on any parse
  miss** — a false "unfinished item" would be a false accusation in a block reason.
  `todoJudgeContext(text, todos)` appends the marked unfinished list.
- **`triggers/bad-news-lexicon.mjs`** — `badNewsGate(text, {lexicon, minProseChars})` →
  `{applicable, proseChars, hits}`. Lexicon `[failed, failure, error, broke, broken,
  blocker, regression, cannot, can't, rejected, lost, missed, wrong]`, matched at word
  start (so "errors" matches, "terror" does not) over SUBSTANTIVE lines only. Deliberately
  over-inclusive: "fixed the error" trips the gate and is exactly the message the judge
  must acquit.
- **The R6 trigger is split across the hooks**: the injector writes
  `state/resume-<session_id>` when the SessionStart source is `resume` or `compact` (or
  `clear` with a reason mentioning compact — an assumed shape, documented); the Stop hook
  consumes the marker on the first substantive message after it. Consumption precedes
  dispatch, so the judgment is one-shot even with no judge configured.

## The judge machinery

`judge/ask.mjs` — `askJudge(rule, question, contextText, config, options?)`; options
`{timeoutMs, stateDir}` exist for the test suite. Never throws.

- **Command** from `enforcement.judgeCommand`: with a `{prompt}` placeholder, the prompt is
  shell-escaped into the command; without one, the prompt is piped to the command's stdin.
  `null`/absent = judge rules inactive (the hook logs fired triggers to `skipped.log`).
- **Output**: STDOUT ONLY is captured (judges print banners on stderr; merging the streams
  puts noise in front of the JSON). The LAST JSON object on stdout is the verdict; a
  `{"type":"result","result":"…"}` envelope is unwrapped one level. The verdict must be
  strictly `{"violation": <boolean>, "reason": <string>}`.
- **Failures** — timeout (30s default), non-zero exit, unparseable output — return
  `{violation: false, error: …}` plus a `judge-failures.log` line. Fail-open, fail-loud-
  in-log. Failures are never cached.
- **Cache** — `sha256(rule + contextText)` → `state/cache/<hash>.json`, written only on a
  successful verdict. Questions are static per rule; all variable data (marked sections,
  todo lists) rides in `contextText`, so the key covers everything the judge sees.
- **Suggested command** (probed live 2026-09-21, stdin form): `codex exec --skip-git-repo-check -`.
  `claude -p` was probed the same day and failed auth (expired OAuth), so it is not
  suggested.

## Operator profile schema

JSON at `$COMMUNICATION_RULES_PROFILE` or `~/.claude/communication-rules.json`. Every field
optional; an empty object is valid and yields the defaults.

```json
{
  "reader": "the person you are reporting to",
  "traits": ["reads the first two lines of any message and skims the rest"],
  "enforcement": {
    "mode": "block",
    "judgeCommand": "codex exec --skip-git-repo-check -",
    "rules": { "name-the-artifact": "warn", "bad-news-first": "warn" }
  }
}
```

- **`reader`** — short noun phrase, emitted verbatim at session start.
- **`traits`** — plain sentences about how that person reads, emitted verbatim. This is the
  whole of the reader-specific surface; the plugin ships none.
- **`enforcement.mode`** — `block | warn | off`. Unset = each rule's built-in default (warn
  for name-the-artifact, block for the rest); set = overrides built-ins both ways.
- **`enforcement.judgeCommand`** — see the judge section.
- **`enforcement.rules`** — per-rule mode overrides; beat the global mode and built-ins.
- Precedence: kill-switch file > `rules[rule]` > explicit `mode` > built-in default.

A missing file or field is silent defaults. An unparseable file, or a value of the wrong
shape, is defaults plus one `errors.log` line — a config failure reads exactly like a
working config otherwise.

**Check options are not profile fields.** `markers`, `minProseChars`, `graceChars`,
`headings`, `lexicon`, `reportVerbs` are call-site arguments; the hook calls every check on
its defaults.

**Keep the profile out of version control if it describes a real person.** A trait sentence
is attributable to whoever owns the repository it sits in, and a pushed commit survives in
forks and caches after any later deletion.

## State files

All under `~/.claude/.communication-rules-state/`:

| File | What it holds |
|---|---|
| `warnings.log` | Warn-mode findings, one line each, rule named |
| `skipped.log` | Judge-rule triggers that fired with no judge command — a skipped check must be inspectable |
| `judge-failures.log` | Judge dispatch failures (timeout, exit, unparseable), rule and error named |
| `errors.log` | Every fail-open path: payload parse, config parse, hook exceptions |
| `last-blocked-<session>.json` | The loop guard's recorded text hash and rules |
| `resume-<session>` | The one-shot R6 marker (timestamped) |
| `cache/<hash>.json` | Judge verdicts |
