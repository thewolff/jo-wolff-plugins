# communication-rules

A plugin that shapes a message around what it needs from its reader, and — as of 0.2.0 —
**enforces that shape with machinery**. Anything requiring a decision goes above anything
merely informative, one closing ask goes last, and each item stays with the thing it is
about. The shape is delivered as text at session start; a Stop hook then inspects every
substantive final message against eight rules and can block.

The problem it addresses is a difference between two artifacts. A report is organised for
the record, and a message is organised for the one person who has to act on it. Agents write
the first when they mean the second, so the decision ends up on line 80 under three headings
of context. Injection alone taught the rule and enforced nothing; DEC-040 (2026-09-16)
deferred enforcement to a separate commit, and 0.2.0 is that commit.

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install communication-rules@jo-wolff-plugins
```

## What happens at session start

The plugin registers `SessionStart` → `hooks/communication-rules-inject.mjs`, which returns
`hookSpecificOutput.additionalContext`: the rules read verbatim from
`skills/communication-rules/SKILL.md` between `<!-- inject:start -->` and
`<!-- inject:end -->`, plus any reader traits from your operator profile. Editing the skill
is editing what sessions receive; there is one copy of the text and it cannot drift.

The injector also parses the SessionStart payload. When the session's `source` is `resume`
or `compact` (or `clear` with a reason mentioning compact — an assumed shape, documented),
it writes a one-shot marker that arms the restate-the-resumed-thread rule for the Stop hook.

It fails open and says so: every path exits 0, and each failure mode emits one short line
instead of nothing (no profile, unparseable profile, missing inject markers). To turn the
injection off without uninstalling: `COMMUNICATION_RULES_INJECT=off`.

## What happens when you stop

`Stop` → `hooks/communication-rules-stop.mjs`. It reads the final assistant message —
`last_assistant_message` from the payload (OMP seats) or the transcript's last assistant
text entry (Claude Code) — and enforces:

| Rule | Instrument | Default mode |
|---|---|---|
| Needs you first | deterministic (`checkNeedsYouFirst`) | block |
| One closing ask, last | deterministic (`checkClosingAskLast`) | block |
| Do not batch by label | trigger + judge | block |
| Conclusion first | trigger + judge | block |
| Name the artifact | deterministic (`checkNamesArtifact`) | **warn** |
| Restate a resumed thread | injector marker + judge | block |
| Report what you did not do | todo trigger + judge | block |
| Bad news in the first sentence | lexicon gate + judge | block |

A model-graded check that runs automatically inside a hook is still machinery: it fires on a
deterministic trigger, it returns pass or fail, and every dispatch failure mode (timeout,
non-zero exit, unparseable output) is deterministic and fail-open. The judgment is the
model's; the enforcement is the hook's. The judge is whatever command you configure
(`enforcement.judgeCommand`); verdicts are cached per rule+text so the same message is
billed once. Without a judge command the five judge-gated rules are inactive and every fired
trigger leaves a line in `skipped.log` — a skipped check must be inspectable, never silently
dead.

A block names the rule, states exactly what to move or add, and asks for the corrected lines
only — never a resend of the whole message. The loop guard records the blocked text's hash
per session, so the same message arriving again with `stop_hook_active` passes: a model that
ignores the reason cannot loop forever.

**Kill switch:** `touch ~/.claude/.communication-rules-off` disables enforcement within one
turn (checked per invocation, never cached). `COMMUNICATION_RULES_ENFORCE=off` is a
secondary switch with the caveat that env is frozen for the host process's lifetime — it
costs a host relaunch to change. Everything fails open: a broken hook exits 0 with nothing
on stdout and one line in `errors.log`.

State lives in `~/.claude/.communication-rules-state/`: `warnings.log` (warn-mode findings),
`skipped.log` (fired triggers with no judge), `judge-failures.log`, `errors.log`, the loop
guard's `last-blocked-<session>.json`, resume markers, and the verdict `cache/`.

## Configuring a profile

Reader traits and enforcement live in one JSON file, resolved from
`$COMMUNICATION_RULES_PROFILE` then `~/.claude/communication-rules.json`. Every field is
optional; an empty object is valid.

```json
{
  "reader": "the engineer who owns this service",
  "traits": ["reads the first two lines of any message and skims the rest"],
  "enforcement": {
    "mode": "warn",
    "judgeCommand": "codex exec --skip-git-repo-check -",
    "rules": { "name-the-artifact": "block" }
  }
}
```

- **`mode`** — `block` | `warn` | `off`. Unset means each rule keeps its built-in default
  (warn for every rule — the measured defaults; the 2026-09-21 corpus adjudication and the
  recalibration path that re-earns block live in reference.md); setting it overrides
  built-ins in both directions.
- **`judgeCommand`** — `null`/absent = judge rules inactive (logged). A string with a
  `{prompt}` placeholder gets the shell-escaped prompt substituted; a bare command receives
  the prompt on stdin. The suggested command above is the stdin form probed working on
  2026-09-21 (`claude -p` was probed the same day and its OAuth was expired).
- **`rules`** — per-rule mode overrides beating both the global mode and built-ins.
- Precedence overall: kill-switch file > `rules[rule]` > explicit `mode` > built-in default.
- The injection half reads `reader` and `traits`. The check options (`markers`,
  `minProseChars`, `graceChars`, `headings`, `lexicon`, `reportVerbs`) are NOT profile
  fields — they remain call-site arguments, and the hook calls every check on its defaults.
- A missing file or field is silent defaults. An unparseable file is defaults plus one
  `errors.log` line.

**Keep your profile out of version control if it describes a real person.** See
`reference.md` for the full schema and every check's contract and options.

## The checks, and what they deliberately do not do

`checks/needs-you-first.mjs` — if a needs-you section exists, is it before the body? It
flags misordering, never absence: a check demanding the section would be satisfied by an
empty "Needs you: nothing." header — ceremony in the position read first.

`checks/closing-ask-last.mjs` — if a closing-ask marker exists, is it exactly one and last?
Same anti-ceremony stance: absence is never a finding, for the same reason, at the other end
of the message. The ask section is the marker plus its one following paragraph; substantive
prose in later paragraphs is the overtime finding.

`checks/name-the-artifact.mjs` — a report-shaped message (400+ substantive chars, speaking
in report verbs) that names no path, `file:line`, fenced block, inline code, URL, or
command-looking line. This is a vocabulary check — it answers "does the message name an
artifact", never "is the artifact right" — which is why it ships in warn mode.

The judge-gated rules and their triggers are documented in `reference.md`, including the one
boundary stated plainly: **report-what-you-did-not-do is enforced exactly where a todo list
exists. With no tracked plan the violation is silence and no instrument sees it.**

## Calibration, honestly

The floors (200 for the master floor and R1/R2/R8, 400 for R4/R5) are starting points, not
measurements of anyone's corpus. Run the checks and the logs over a few hundred of your own
real messages and hand-adjudicate about thirty flags before you trust the rates. A
structural check that has not met your corpus is a guess with a number attached — and the
judge questions default to `violation=false` when unsure for exactly that reason.

## The tension worth naming

*Needs you first* says pull anything requiring a decision to the top. *Do not batch by
label* says keep each item with the thing it is about. Pulling to the top IS a partial
grouping; only judgment separates a useful lead section from a dumped one. The R3 judge
question adjudicates this explicitly — the lead section is named compliant, the terminal
dump is the violation — and the deterministic checks are built so they cannot take a side:
R1 judges the first marker only, so an interleaved message is never punished for not
batching.

## Tests

```
node --test plugins/communication-rules/checks/*.test.mjs plugins/communication-rules/triggers/*.test.mjs plugins/communication-rules/judge/*.test.mjs plugins/communication-rules/hooks/*.test.mjs
```

133 tests, all passing. The proportion is deliberate: the majority prove what does NOT flag
— a structural check earns its place by what it leaves alone. The hook suites run the hooks
as subprocesses against an isolated `$HOME`, covering the kill switch, the loop guard, both
stdin shapes, mode precedence, marker consumption, and fail-open on malformed input. The
judge suite drives only fake judges — no real CLI, no bill.

## License

MIT. See the repository root `LICENSE`.
