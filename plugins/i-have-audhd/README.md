# I have AuDHD

How to write to someone who is ADHD and autistic: the rules, the research behind each one,
and a Stop hook that warns when a message buries what the reader needs.

The skill (`skills/i-have-audhd/SKILL.md`) carries eleven rules. The two halves of AuDHD
pull opposite ways — ADHD wants short and new, autism wants complete and exact — and the
rules resolve that by ordering, never by cutting content: what the reader must know goes
first, what they must choose goes last, and every reference survives without scrolling. The
reasons and sources per rule are in `skills/i-have-audhd/references/`.

The plugin delivers the rules in two ways:

- **At session start**, a hook injects the skill's first-turn core (the message skeleton, the
  options rule, reference survival, commands, and three machinery anchors) plus every rule
  heading, so the model has the shape before its first message and knows the full skill
  exists.
- **At every stop**, a hook checks the finished message against thirteen checks. A warn finding
  reaches the agent with its next turn (and you, as a one-line notice), and is logged to
  `warnings.log`. Every check warns by default; nothing blocks until you arm it.

Renamed from `communication-rules` in 1.0.0 (see "Changes").

## Install

It needs `node`: Claude Code runs the hooks as `node <hook>.mjs` from your `PATH`, and the OMP
adapter runs them under node resolved to an absolute path (`I_HAVE_AUDHD_NODE` pins one).

1. **Install.** Claude Code:

   ```
   /plugin marketplace add thewolff/jo-wolff-plugins
   /plugin install i-have-audhd@jo-wolff-plugins
   ```

   OMP:

   ```
   omp plugin marketplace add thewolff/jo-wolff-plugins
   omp plugin install i-have-audhd@jo-wolff-plugins
   ```

2. **Choose a judge.** Five of the thirteen checks (`do-not-batch-by-label`, `conclusion-first`,
   `restate-resumed-thread`, `report-what-you-did-not-do`, `bad-news-first`) need a model to
   read the message, and stay off until you choose one. Run the setup tool in a terminal:

   ```
   node ~/.claude/plugins/marketplaces/jo-wolff-plugins/plugins/i-have-audhd/tools/setup.mjs
   ```

   The OMP copy is
   `~/.omp/plugins/cache/marketplaces/jo-wolff-plugins/plugins/i-have-audhd/tools/setup.mjs`;
   either one configures both hosts, because both read the same profile (below). The tool:
   - checks that `node` is on `PATH`, and on a login shell's `PATH`;
   - lists the judges and requires a pick: the Claude Code CLI on Haiku, the Codex CLI, OMP
     with a model you name, a command you type, or none;
   - makes one test call to that judge through the Stop hook's own dispatch
     (`judge/ask.mjs`) and reports a failure, a wrong answer, or a judge slower than OMP's 20s
     judge budget;
   - prints the profile path and the full JSON it will write, and writes only after you type
     `yes`. Every other profile field is kept.

   Choosing none writes `"judgeCommand": null`: the five checks stay off and nothing nags you.
   Re-running is safe; the same choice again writes nothing. For a scripted install:
   `node <that path> --judge claude|codex|omp|custom|none [--command <cmd>] [--model <name>] --yes`
   (`--yes` still refuses a judge whose test call failed).

3. **Start a new session.** If you skipped step 2, the first session start shows a one-time
   notice (on Claude Code a hook message, on OMP a UI warning) naming the five checks that are
   off and the exact command to run.

On Claude Code both hooks run from `hooks/hooks.json`. OMP does not run `hooks.json`; the
install registers `omp/i-have-audhd-omp.ts` (declared in `package.json` under
`omp.extensions`), which runs the same two hooks for the main session. The manual-symlink
fallback and an isolated live probe are in `omp/REGISTRATION.md`.

**OMP installs are per profile.** `omp plugin install` puts the plugin under the active
profile's directory (the profile named by `OMP_PROFILE`; unset means the default profile).
Running the install from a plain shell reaches only the default profile. Run it once per
profile, with `OMP_PROFILE` set to that profile, for every profile that should have it.

**Settings and state are shared, not per profile.** The profile file
(`~/.claude/i-have-audhd.json`, or `$I_HAVE_AUDHD_PROFILE`), the state directory
(`~/.claude/.i-have-audhd-state/`) and the kill switch (`~/.claude/.i-have-audhd-off`) are
resolved from your home directory only (`lib/config.mjs`, `defaultProfilePath`;
`lib/state.mjs`, `stateDir` and `killSwitchPath`). Every harness and every OMP profile reads
the same files. For example, `enforcement.armOmp: true` arms blocking in every OMP profile at
once, and the kill switch turns the Stop hook off everywhere.

### Update

```
claude plugin update i-have-audhd@jo-wolff-plugins
omp plugin marketplace update jo-wolff-plugins   # once per OMP profile
omp plugin upgrade i-have-audhd                  # once per OMP profile
```

Refresh the marketplace before upgrading: `omp plugin upgrade` installs the version in OMP's
cached copy of the marketplace, so without the refresh it reinstalls the version you already
have. Then relaunch your OMP sessions. Updating Claude Code alone leaves OMP on its older copy,
because OMP's own install wins over Claude Code's for the same plugin;
`node scripts/check-omp-install.mjs` from a checkout of this repository reports any plugin whose
two installs differ.

### Uninstall

```
claude plugin uninstall i-have-audhd@jo-wolff-plugins
omp plugin uninstall i-have-audhd      # once per OMP profile
```

Uninstalling removes the plugin, not your files. `~/.claude/i-have-audhd.json`,
`~/.claude/.i-have-audhd-state/` (logs and resume markers) and `~/.claude/.i-have-audhd-off`
stay behind; delete them by hand if you want them gone. Because they are shared, keep them
while any harness or OMP profile still has the plugin installed.

## Check it's working

1. Confirm the install: `claude plugin list` or `omp plugin list` (in the profile you use)
   shows `i-have-audhd`.
2. Finish one turn in a new session, then look in `~/.claude/.i-have-audhd-state/`. A new
   line in `warnings.log` (a check fired) or `skipped.log` (a judge-gated trigger fired with
   no `judgeCommand`) proves the Stop hook ran. A clean message can leave no line in either,
   so try a long reply if nothing appears. After a `warnings.log` line, your next prompt shows
   an "i-have-audhd warned on the agent's last message" notice and the agent receives the fix.
3. On OMP, count adapter failures:
   `grep -c 'omp-adapter fail-open' ~/.claude/.i-have-audhd-state/errors.log`. Every adapter
   failure leaves one such line naming the hook and carrying the tail of its stderr
   (`omp/i-have-audhd-omp.ts`, the fail-open contract comment); a count that grows each turn
   means the adapter is installed but failing. The OMP UI also shows an error notice for each
   kind of failure, once, then hourly while it lasts. The hooks run under node resolved to an
   absolute path; set `I_HAVE_AUDHD_NODE` to pin one.

## What happens at session start

`hooks/i-have-audhd-inject.mjs` returns `hookSpecificOutput.additionalContext`: one line
saying the person in the session installed these rules, the span of `SKILL.md` between
`<!-- inject:start -->` and `<!-- inject:end -->`, and any reader traits from your profile.
Editing the skill is editing what sessions receive; there is one copy of the text. A rule the
profile switches off (`inject.rules`, see *What you can turn on and off*) is cut from that span
before it is sent: its core paragraph and its line in the rule list.

On Claude Code this runs on every SessionStart source. On OMP the adapter runs it on the
main session's start, on a session switch, and after a compaction, and attaches the context to
the next prompt as a hidden message. It stays attached until a model request has carried it,
so OMP re-running its prompt preparation does not lose it, and later prompts do not repeat
it (when a prompt is aborted before any model request, the next prompt carries it again).
Subagent sessions get no injection on OMP.

When the session's source is `resume` or `compact`, the injector also writes a one-shot
marker that arms the restate-the-resumed-thread check for the Stop hook. On OMP both hooks
key that marker on the session manager's id, so it survives OMP rotating the provider
session id under a fresh-session or context reset.

It fails open and says so: every path exits 0, and each failure emits one short line instead
of nothing. To turn the injection off without uninstalling: `I_HAVE_AUDHD_INJECT=off`.

## What happens when you stop

`hooks/i-have-audhd-stop.mjs` reads the final assistant message and runs:

| Check | Rule id (for `enforcement.rules`) | Skill rule | Instrument | Default |
|---|---|---|---|---|
| Needs you first | `needs-you-first` | 1, Skeleton | deterministic | warn |
| One closing ask, last | `closing-ask-last` | 1, Skeleton | deterministic | warn |
| Do not batch by label | `do-not-batch-by-label` | 1, Skeleton | trigger + judge | warn |
| Conclusion first | `conclusion-first` | 1, Skeleton | trigger + judge | warn |
| Plural back-reference in the closing ask | `plural-back-reference` | 6, References survive without scrolling | deterministic | warn |
| A handed command is one script line | `handed-command` | 10, Commands handed to the user | deterministic | warn |
| Restate a resumed thread | `restate-resumed-thread` | 8, Resume by restating content | injector marker + judge | warn |
| Name the artifact | `name-the-artifact` | 11, Machinery anchors | deterministic | warn |
| Link the reference | `link-the-reference` | 11, Machinery anchors | deterministic | warn |
| Links resolve | `links-resolve` | 11, Machinery anchors | deterministic (disk + local GitHub cache) | warn |
| Links judge: the target is what the sentence says | `links-judge` | 11, Machinery anchors | word-overlap prefilter + judge | off |
| Report what you did not do | `report-what-you-did-not-do` | 11, Machinery anchors | todo trigger + judge | warn |
| Bad news in the opening 20 words | `bad-news-first` | 11, Machinery anchors | lexicon gate + judge | warn |

Every finding names its skill rule. At the default, nothing blocks: a warn finding is
delivered to the agent with the next prompt, as a short notice carrying the fix ("warning
only; it was sent unchanged; apply each fix from your next message on"), and logged to
`~/.claude/.i-have-audhd-state/warnings.log`. On Claude Code the delivery is the
`UserPromptSubmit` hook (`additionalContext` for the agent, `systemMessage` for you); on OMP
the adapter queues it as a next-turn message and shows you a warning notice. The default is
measured: the corpus adjudications found no check whose false-positive rate supports
blocking by default; the rates are in `skills/i-have-audhd/reference.md`. Block is one
profile flip away, globally or per check.

The five judge-gated checks are inactive until you configure `enforcement.judgeCommand`;
each trigger that fires without one leaves a line in `skipped.log`, so a skipped check stays
inspectable.

On OMP the Stop hook runs for the main session only: OMP's `session_stop` never fires for
subagent sessions, and OMP has no blocking equivalent of Claude Code's `SubagentStop`. OMP
also caps every block to warn unless the profile sets `enforcement.armOmp: true`.

**Kill switch:** `touch ~/.claude/.i-have-audhd-off` disables the Stop hook within one turn.
`I_HAVE_AUDHD_ENFORCE=off` is a secondary switch that needs a host relaunch to change.
Everything fails open, and never silently: a hook fault (empty or malformed stdin, a throw, an
unparseable profile, an unwritable state directory) exits 0, blocks nothing, writes one
`<file> <reason>` line to `errors.log`, and shows one warning line naming the hook and the log.
A judge that cannot answer is never a pass: see the judge contract below.

## Configuring a profile

Optional. Reader traits and enforcement live in one JSON file, resolved from
`$I_HAVE_AUDHD_PROFILE` then `~/.claude/i-have-audhd.json`; `example.i-have-audhd.json` is a
generic starting point. Every field is optional:

```json
{
  "reader": "the engineer who owns this service",
  "traits": ["reads the first two lines of any message and skims the rest"],
  "enforcement": {
    "mode": "warn",
    "judgeCommand": "codex exec --skip-git-repo-check -",
    "rules": { "name-the-artifact": "block" },
    "armOmp": false
  }
}
```

`tools/setup.mjs` (install step 2) writes `judgeCommand` for you after testing it. You can also
write it by hand. The example `judgeCommand`, `codex exec --skip-git-repo-check -`, assumes the
Codex CLI is installed and signed in; it is an example, not a requirement.

**The judge contract** (`judge/ask.mjs`): `judgeCommand` is run by `/bin/sh -c`. If it contains
`{prompt}`, every occurrence is replaced by the shell-escaped prompt; otherwise the prompt is
piped to its stdin. It has to exit 0 within 30s (20s under OMP) and print, on stdout, a JSON
object `{"violation": <boolean>, "reason": "<string>"}`. Banner lines before it are fine; the
last such object wins, and one `{"result": "<json string>"}` envelope (what
`claude -p --output-format json` prints) is unwrapped. Anything else is a judge failure, and a
failed judge is never counted as a pass: `judge-failures.log` gets a line naming the rule, the
error kind, a `cause=`, the session, harness, model, elapsed and budget milliseconds, the judged
section (`<label>@<line>`, or `whole`), the prompt's cache key and the path of the prompt it was
asked (`cache/<key>.prompt.txt`, written on failure so `<judgeCommand> < <that file>` replays
it), then the tail of the judge's stderr and, for a judge that printed no verdict, the last 300
characters of its stdout. The rule becomes a "Judge unavailable" finding in the rule's own mode
(a warning by default; in block mode it blocks once, and the revision is only warned). You are
told once per rule and cause, through the hook's `systemMessage` (a UI warning on OMP), again
hourly while it keeps failing, and at once if it fails again after a stop where the judge
answered; the notice states the cause and its fix.

| `cause=` | What happened | The notice says to |
|---|---|---|
| `credential-revoked` | the judge's CLI got a 401, a revoked or invalid token | log that CLI in again, then re-test with the setup tool |
| `no-credential` | the judge's profile has no credential for the model (`no credential for <model> in profile …`, `not logged in`) | add one through the judge's CLI, or pick a judge that has one |
| `rate-limited` | 429, "rate limit", "overloaded", quota | wait, or move the judge to a quieter model |
| `judge-self-abort` | the judge gave up on its own request ("Request was aborted", a reset connection) before the hook's budget ran out | a faster model, or a longer judge-side timeout |
| `hook-deadline` | the hook's own timer fired (30 s, 20 s under OMP), whatever the judge was printing | a faster model; haiku-class answers in 2–4 s |
| `bad-json` | exit 0 and no `{"violation": …}` object on stdout | run the command by hand on the prompt file the line names |
| `other` | anything else: a bare exit 1, a command not found | read the stderr tail on the line; re-test with the setup tool |

No judge failure was reproduced live for 1.6.1: each cause is pinned by tests to a stderr
string that appeared in this machine's own `judge-failures.log` (`judge/fixtures/failure-corpus.mjs`).
A judge that is itself a Claude Code or OMP
session should run with `I_HAVE_AUDHD_ENFORCE=off I_HAVE_AUDHD_INJECT=off` in front, so this
plugin's hooks do not run inside the judge's own session; the setup tool's choices do.

To run without a judge, set `judgeCommand` to `null` (the setup tool's "none"). Left out
entirely, it means the same to the Stop hook, but the session-start notice treats it as "not
chosen yet". The seven deterministic checks still run; the five judge-gated checks stay
inactive and each fired trigger is logged to `skipped.log` with the profile path the hook
read (`rule=<rule> reason=no-judge-command profile=<path> session=<id>`):

```json
{
  "enforcement": { "mode": "warn", "judgeCommand": null }
}
```

The full schema, precedence, every check's contract, and the judge machinery are in
`skills/i-have-audhd/reference.md`. **Keep your profile out of version control if it
describes a real person.**

## What you can turn on and off

Every switch, with its default. All of them live in the profile
(`~/.claude/i-have-audhd.json`) except the flag file and the environment variables.

| Switch | Where | Values | Default |
|---|---|---|---|
| What runs: rules, checks, or both | `inject` (string) or `inject.mode` | `full`, `rules`, `none` | `full` |
| Rule 1, Skeleton, injected | `inject.rules.skeleton` | `true`, `false` | `true` |
| Rule 2, Layer, injected | `inject.rules.layer` | `true`, `false` | `true` |
| Rule 3, Blunt facts, declarative requests, injected | `inject.rules.blunt-facts` | `true`, `false` | `true` |
| Rule 4, Recommend; at most two open decisions, injected | `inject.rules.recommend` | `true`, `false` | `true` |
| Rule 5, Grade every signal, injected | `inject.rules.grade-signals` | `true`, `false` | `true` |
| Rule 6, References survive without scrolling, injected | `inject.rules.references` | `true`, `false` | `true` |
| Rule 7, Assumptions and intent, injected | `inject.rules.assumptions` | `true`, `false` | `true` |
| Rule 8, Resume by restating content, injected | `inject.rules.resume` | `true`, `false` | `true` |
| Rule 9, Durable means written, injected | `inject.rules.durable` | `true`, `false` | `true` |
| Rule 10, Commands handed to the user, injected | `inject.rules.commands` | `true`, `false` | `true` |
| Rule 11, Machinery anchors, injected | `inject.rules.machinery-anchors` | `true`, `false` | `true` |
| Every check at once | `enforcement.mode` | `block`, `warn`, `off` | unset (each check's own default) |
| Needs you first (rule 1) | `enforcement.rules.needs-you-first` | `block`, `warn`, `off` | `warn` |
| One closing ask, last (rule 1) | `enforcement.rules.closing-ask-last` | `block`, `warn`, `off` | `warn` |
| Do not batch by label (rule 1, judge) | `enforcement.rules.do-not-batch-by-label` | `block`, `warn`, `off` | `warn` |
| Conclusion first (rule 1, judge) | `enforcement.rules.conclusion-first` | `block`, `warn`, `off` | `warn` |
| Plural back-reference (rule 6) | `enforcement.rules.plural-back-reference` | `block`, `warn`, `off` | `warn` |
| Restate a resumed thread (rule 8, judge) | `enforcement.rules.restate-resumed-thread` | `block`, `warn`, `off` | `warn` |
| A handed command is one script line (rule 10) | `enforcement.rules.handed-command` | `block`, `warn`, `off` | `warn` |
| Name the artifact (rule 11) | `enforcement.rules.name-the-artifact` | `block`, `warn`, `off` | `warn` |
| Link the reference (rule 11) | `enforcement.rules.link-the-reference` | `block`, `warn`, `off` | `warn` |
| Links resolve (rule 11) | `enforcement.rules.links-resolve` | `block`, `warn`, `off` | `warn` |
| Links judge (rule 11, judge) | `enforcement.rules.links-judge` | `block`, `warn`, `off` | `off`; a global `enforcement.mode` does not turn it on, only this key |
| GitHub lookups for links-resolve | env `I_HAVE_AUDHD_NO_GH_FILL` | `1` (never spawn the cache helper) | unset |
| Report what you did not do (rule 11, judge) | `enforcement.rules.report-what-you-did-not-do` | `block`, `warn`, `off` | `warn` |
| Bad news first (rule 11, judge) | `enforcement.rules.bad-news-first` | `block`, `warn`, `off` | `warn` |
| Link the reference: PR and issue numbers | `linkTheReference.kinds.issue-ref` | `true`, `false` | `true` |
| Link the reference: file names | `linkTheReference.kinds.file-name` | `true`, `false` | `true` |
| Link the reference: "the report", "the plan" and kin | `linkTheReference.kinds.artifact` | `true`, `false` | `false` (measured, see below) |
| Link the reference: branch names | `linkTheReference.kinds.branch` | `true`, `false` | `false` (measured, see below) |
| The judge for the five judge checks | `enforcement.judgeCommand` | a shell command, or `null` | unset: those five stay off |
| Where a handed script may live | `handedCommand.scriptRoots` | absolute or `~/` directories | `["~/agent-scratch"]` |
| Extra handed-command line shapes | `handedCommand.allow` | globs, `*` matches anything | `[]` |
| OMP block cap: the OMP adapter tags its hook runs `I_HAVE_AUDHD_HARNESS=omp`, and under that tag every block is delivered as a warn | `enforcement.armOmp` | `true` (blocks deliver on OMP), `false` | `false` |
| Stop hook kill switch | the flag file `~/.claude/.i-have-audhd-off` | present, absent | absent |
| Injection, until relaunch | env `I_HAVE_AUDHD_INJECT` | `off` | unset |
| Checks, until relaunch | env `I_HAVE_AUDHD_ENFORCE` | `off` | unset |

The `inject` modes:

| `inject` | Rules injected at session start | Stop checks |
|---|---|---|
| `full` (default) | yes | yes, at their modes |
| `rules` | yes | none |
| `none` | no | yes, at their modes |

**One rule off.** `inject` can be an object: `mode` is one of the three values above
(`full` when left out), and `rules` switches single rules by id. A rule set to `false` is
left out of the session-start injection, its core paragraph and its line in the rule list,
and every check bound to it (the Skill rule column in *What happens when you stop*) defaults
to off. Rule 10 off, for a reader who does not mind running commands by hand:

```json
{ "inject": { "mode": "full", "rules": { "commands": false } } }
```

A check's own `enforcement.rules` entry still wins: `"enforcement": {"rules":
{"handed-command": "warn"}}` beside the profile above keeps that check warning while rule 10
stays out of the injection. A rule left out of `rules` is on. A malformed `inject` (an unknown
mode, key or rule id, a switch that is not `true` or `false`) is one `errors.log` line and the
default, `full` with every rule on.

**Checks only.** No rules in the session's context; one check, `handed-command`, warns, and
every other check is off:

```json
{
  "inject": "none",
  "enforcement": { "mode": "off", "rules": { "handed-command": "warn" } }
}
```

**Rules only.** The rules arrive at session start; nothing checks the messages:

```json
{ "inject": "rules" }
```

`{"inject": "full", "enforcement": {"mode": "off"}}` reaches the same place by turning every
check off one level down. The difference: under `rules` the Stop hook returns before reading
the profile's enforcement at all, and the session-start notice about choosing a judge is
not shown.

**What wins when settings disagree,** strongest first: the kill-switch file
`~/.claude/.i-have-audhd-off` > `inject` mode > the check's `enforcement.rules` entry > its
rule switched off in `inject.rules` (off) > a built-in off (`links-judge`) > `enforcement.mode` >
the built-in default (warn).
The kill-switch file turns every check off under every `inject` value, within one turn; it
never turns off the injection. `I_HAVE_AUDHD_INJECT=off` still silences the injection, and
`I_HAVE_AUDHD_ENFORCE=off` the checks, each until the host relaunches.

`handed-command` accepts one line of the shape `zsh /absolute/path/script.sh` (or `bash`,
`sh`, or a `~/` path) whose script sits under `~/agent-scratch` and outside every git
checkout. To let scripts live somewhere else, list the directories in
`handedCommand.scriptRoots`; to accept a line shape of your own as well, list it in
`handedCommand.allow` as a glob, where `*` matches anything:

```json
{ "handedCommand": { "scriptRoots": ["~/agent-scratch", "~/scratch"], "allow": ["just deploy-*"] } }
```

`link-the-reference` ships two of its four kinds on. Measured over 469 real final messages,
PR and issue numbers flagged 93 lines with 8 % false positives and file names 90 with 3 %;
"the report"-style phrases flagged 44 with 75 % false positives and branch names 2 lines with
1 false, so those two ship off. To turn one on:

```json
{ "linkTheReference": { "kinds": { "artifact": true } } }
```

### Links resolve, and the links judge

`links-resolve` asks whether a link the message hands you opens, with nothing but the local
disk and a local cache, so the Stop hook never waits on the network:

- A **local path** in a code span or a markdown link (`/absolute`, `~/`, `file://`) has to
  exist. A `file://` URL is decoded first; then line suffixes are stripped: `:41`, `:41-50`,
  `:307–321`, comma lists such as `:18,22` and `:13-14,56-59`, and `#L12`. A sentence that
  says the file is still to come ("will be written to", "I'll save it to", "Plan:", "Step 3:
  … save them to", "once it lands", "didn't save") or gone ("removed", "no longer exists") is
  not checked; `e.g.`, `i.e.`, `vs.` and a version number like `1.6.` do not end the sentence.
  Nor is a span that is a command (`rm /x`), a placeholder (`/path/to/<name>`, a glob,
  `$HOME/…`), a missing slash command or HTTP route (one segment with no dot, such as `/mcp`,
  `/wrap-up` or `/health`, or a `:param` segment such as `/messages/:id`), a relative path,
  or anything inside a fenced block, a blockquote, a heading, or a line carrying `→` (quoted
  evidence).
- A **GitHub URL** has to have the shape of a page: `/issues/N` or `/pull/N`, never `/issue/N`
  or `/pulls/N`. When the PR or issue word nearest before the URL (at most six words back, in
  the same clause) calls it a PR and the URL says `/issues/`, or the reverse, that is a finding
  too; GitHub redirects either way, so the page opens, but the word is what misleads. ("Opened
  PR `…/pull/79` for `…/issues/327`" is fine: each URL has its own word, or none.)
- Whether the GitHub target **exists**, and whether it **is** an issue or a PR, comes only from
  `~/.claude/.i-have-audhd-state/gh-cache.json`, read only when the message names
  `github.com`. An entry inside its TTL (a week for a hit, ten minutes for a 404) gives a
  verdict; anything else is **unknown, and unknown is never a finding**. The hook hands every
  unknown key to a detached helper, `scripts/gh-cache-fill.mjs`, and exits without waiting:
  the helper takes a lock, looks up at most 20 keys with `gh api --cache 10m
  repos/<owner>/<repo>/issues/<n>` inside 45 s, and merges what it learned through a temp file
  and a rename. gh's own cache keeps 404s too, so asking with `--cache 10m` keeps a PR named
  before it is opened from reading as dead for more than about twenty minutes (gh's cached
  404, then the plugin's ten minutes). The *next* stop that names the link reads the answer.
  `I_HAVE_AUDHD_NO_GH_FILL=1` keeps the hook from spawning the helper at all.
- `agent://<id>` references are not checked: neither Claude Code nor OMP writes a registry of
  agent ids to disk (looked for 2026-11-04 under `~/.omp` and `~/.claude`), so there is nothing
  to resolve them against.

Each finding names the line, the link and what is wrong with it (`no such file: …`,
`GitHub has no /pulls/ page`, `the sentence says PR but the URL is /issues/`, `GitHub answered
404 for o/r#1`, `o/r#2 is a pull request, the URL says /issues/`); the first five are shown and
the rest counted. Measured on a 200-link message, the check adds 5 ms to the Stop hook (37 ms
before, 42 ms after; 45 ms with the helper spawn). On the final messages of 100 real Claude
Code sessions (2026-10-05 to 2026-11-04) it gave 29 findings in 10 messages: 2 certainly wrong
(paths that live on a server, not this machine), 27 naming files deleted since, none
confirmed right; before the round-1 fixes it was 64 findings, 37 certainly wrong, in 31
messages. The details are in `skills/i-have-audhd/reference.md` under links-resolve.

`links-judge` is the question the disk cannot answer: is the thing behind the link what the
sentence says it is? A sentence that calls a test log "the comparables report" resolves and is
still wrong. It is **off by default** and a global `enforcement.mode` does not turn it on;
only `"enforcement": {"rules": {"links-judge": "warn"}}` does, because each unmatched link is
one judge call. When on, every link `links-resolve` opened goes through a word-overlap
prefilter: the sentence's words (three letters or more, common words and link vocabulary out)
against the target's name and first 1,500 bytes (only a regular file is read, and only those
bytes, so `/dev/zero` or a pipe is skipped; a GitHub link: its cached title; a directory: its
entries). One shared word is enough to skip the judge; no shared word is one judge job,
at most five per stop, in line order. The verdict reads like the other judge checks and
names the line and the link.

How the GitHub side fails, and what you see:

| What goes wrong | What happens | How you tell |
|---|---|---|
| The cache is stale (a PR merged after the hit was cached, an issue opened after the 404) | a hit is trusted for a week, a miss for ten minutes; a finding can lag by that much | the entry's `at` in `gh-cache.json` |
| The helper never ran (the host did not let the detached child outlive the hook, or `I_HAVE_AUDHD_NO_GH_FILL=1`) | every GitHub link stays unknown; path and shape findings are unaffected | no `gh-cache.json`, or one whose `helper.at` never moves; the detached child is not proven to survive Claude Code's hook process lifetime, which is why a missing cache has to be harmless |
| `gh` is not on `PATH`, or not logged in, or rate-limited | no entry is written for the key, `helper.error` names it (`gh-not-found`, `gh-not-logged-in`, `gh-rate-limited`), one `errors.log` line at once and then hourly | `helper.error` in `gh-cache.json`; the `errors.log` line names `scripts/gh-cache-fill.mjs` |
| `gh-cache.json` does not parse | read as empty: every GitHub link unknown; one `errors.log` line; the next helper run rewrites it | the `errors.log` line names `lib/gh-cache.mjs` |
| A second helper starts while one runs | the second sees the lock (younger than two minutes) and exits with nothing done | nothing; the first run's results arrive |

## Upgrading from communication-rules

1.0.0 reads only its own names; it never looks at the `communication-rules` profile, kill
switch, state directory or environment variables. If you configured `communication-rules`,
carry your settings over once, **before** you uninstall it, from the plugin's directory (a
checkout's `plugins/i-have-audhd`, or wherever your host installed it):

```
node tools/upgrade-from-communication-rules.mjs           # preview: writes nothing
node tools/upgrade-from-communication-rules.mjs --apply   # carry over
node tools/upgrade-from-communication-rules.mjs --undo    # remove what --apply made
```

Run it in the environment your host gives the hooks: it reads the old profile from
`$COMMUNICATION_RULES_PROFILE` (else `~/.claude/communication-rules.json`) and writes to the
path the new loader resolves (`$I_HAVE_AUDHD_PROFILE`, else `~/.claude/i-have-audhd.json`).
Set `I_HAVE_AUDHD_PROFILE` for the run to choose another target.

| Old | `--apply` does |
|---|---|
| `~/.claude/.communication-rules-off` | copied to `~/.claude/.i-have-audhd-off` first, so a disabled Stop hook stays disabled |
| the profile (`reader`, `traits`, `enforcement`) | copied byte-for-byte to the new path at mode 0600; the copy's file mode, bytes, and the enforcement the new loader derives from it are checked before it is put in place |
| each file it creates | gets a 0600 receipt beside it (`.i-have-audhd-off.upgrade-receipt`, `.i-have-audhd.json.upgrade-receipt`) recording its path, device, inode, change time, mode, size and SHA-256, never its contents |
| `~/.claude/.communication-rules-state/` | left where it is as an archive; its logs stay readable there and its resume markers are not carried |
| `COMMUNICATION_RULES_*` variables | named, with the `I_HAVE_AUDHD_*` replacement; the tool cannot change your shell's or host's environment, so edit wherever they are set and relaunch the host |

The cases:

- **Old file missing:** nothing to carry for that item; an existing new file is left as it is.
- **Target already exists:** identical bytes count as done, with no receipt, so `--undo` keeps
  it; different bytes are refused and never overwritten (exit 1). Compare the two by hand.
- **New name resolves to the old file** (for example `I_HAVE_AUDHD_PROFILE` pointing at it):
  nothing is copied, and `--undo` keeps it.
- **Profile does not parse as a JSON object:** refused; fix it and rerun.
- **Target's directory missing:** refused; the tool creates no directories.
- **Old variables set:** `COMMUNICATION_RULES_PROFILE`, `_INJECT` and `_ENFORCE` become the
  same value under `I_HAVE_AUDHD_`. `COMMUNICATION_RULES_PLUGIN_ROOT` points at the retired
  plugin: unset it, or point `I_HAVE_AUDHD_PLUGIN_ROOT` at this plugin. Unset
  `COMMUNICATION_RULES_HARNESS`; the OMP adapter sets its own tag.

The originals are never modified, moved or deleted, and nothing is migrated automatically.
The output names paths, file modes, rule ids and each rule's effective mode on Claude Code and
OMP; it never prints the profile's contents, a parse error (which can quote it), the judge
command, or an environment value. `--undo` removes a new-name file only when its receipt
exists and the file is still the one `--apply` created (same inode, change time, mode, size
and SHA-256), then the receipt, profile first. A file `--apply` did not create, an edited
file and a replaced one are kept.
Exit 0 means every item is done or had nothing to do, 1 means one was refused or failed.

## Changes

### 1.6.1

- New check `links-resolve` (rule 11, Machinery anchors; warn by default). A local path in a
  code span or markdown link (`/absolute`, `~/`, `file://` decoded first; line suffixes
  stripped, comma lists such as `:18,22` included) has to exist; a sentence that says the
  file is still to come or gone is skipped ("will be written", "I'll save", "Plan:", "Step
  3", "didn't save"; `e.g.` and a version number do not end a sentence), as are commands,
  placeholders, globs, fenced blocks, quoted evidence, and a missing slash command or HTTP
  route (`/mcp`, `/health`, `/messages/:id`). A github.com URL has to be `/issues/N` or
  `/pull/N`, and the PR or issue word nearest before it (six words, same clause) has to agree
  with it. Whether the GitHub target exists and which kind it is comes only from a local
  cache (`gh-cache.json` in the state directory, read only when the message names
  github.com; a week for a hit, ten minutes for a 404): a link with no fresh entry is unknown
  and never a finding. The hook hands unknown keys to a detached helper,
  `scripts/gh-cache-fill.mjs` (lock, at most 20 `gh api --cache 10m` lookups inside 45 s,
  atomic write), and exits without waiting; the next stop reads the answer. A cache that
  never fills costs nothing but those two sub-checks. `agent://<id>` references are not
  checked: neither host writes a registry to disk. Measured on a 200-link message: 37 ms
  before, 42 ms after (45 ms with the helper spawn). Measured on the final messages of 100
  real Claude Code sessions: 29 findings in 10 messages, 2 certainly wrong (paths on a
  server, not this machine), 0 confirmed right, 27 naming files deleted since (64 findings,
  37 certainly wrong, before the review fixes). The Stop hook entry in `hooks.json` now
  declares its timeout (35 s: the 30 s judge budget plus the checks).
- New judge check `links-judge` (rule 11), **off by default** and not armed by a global
  `enforcement.mode`: only `enforcement.rules["links-judge"]` turns it on. It asks the judge
  whether the thing behind a resolved link is what the sentence says it is, after a
  word-overlap prefilter (the sentence's words against the target's name, first 1,500 bytes,
  directory entries or cached GitHub title; one shared word skips the judge), at most five
  judge jobs per stop. Only a regular file's first 1,500 bytes are read; a device or FIFO
  (`/dev/zero`, a pipe) is skipped unopened.
- Every judge failure line in `judge-failures.log` now carries `cause=` (one of
  `credential-revoked`, `no-credential`, `rate-limited`, `judge-self-abort`,
  `hook-deadline`, `bad-json`, `other`, classified from the error kind and the judge's
  stderr), the session, harness, model (read off the judge command), elapsed and budget
  milliseconds, the judged section (`<label>@<line>` or `whole`), the prompt's cache key and
  the path of the prompt written on failure (`cache/<key>.prompt.txt`, replayable with
  `<judgeCommand> < <file>`). A judge that printed no verdict keeps the last 300 characters
  of its stdout on the line. The person-facing notice states the cause and its fix, once per
  rule and cause, then hourly as before. Each cause is pinned by a test to a stderr string
  from this machine's own failure log (`judge/fixtures/failure-corpus.mjs`); no failure was
  reproduced live. `skipped.log` lines name the profile path the hook read.
- The no-judge notice and the setup tool count thirteen checks, five of them judge-gated.

### 1.6.0

- New check `handed-command` (rule 10, Commands handed to the user). A final message that
  hands the reader a shell command (a `bash`, `sh`, `zsh` or `shell` fence, *run*, *paste*,
  *type*, *execute* or *enter* followed by code spans starting with a known binary, or `$`
  prompt lines under such an instruction) warns unless what it hands is one
  `zsh /absolute/path/script.sh` line, with the script under `handedCommand.scriptRoots`
  (default `~/agent-scratch`) and outside every git checkout, or matches
  `handedCommand.allow`. It runs on short messages too. Commands quoted as evidence do not
  count: a receipt under a `**CLAIM**` or `**CITE**` label, a command with its result
  attached (`→`, `exit 0` on the next line), a numbered *What I ran* list with results, a
  table row with a result column, a blockquote, or console output with no instruction above
  it. Warn by default, like every check.
  A script's path is resolved as the kernel resolves it, one existing component at a time,
  so a `..` after a symlink into a checkout is caught; a path that will not resolve (a
  symlink loop) is a finding. Code spans split across any number of consecutive lines are
  read as one command. Two known limits are listed in the reference, not fixed: a long
  literal after `*` in an `allow` glob can take about 250 ms, and `$` prompt lines inside a
  table cell are not read as handed.
- New check `link-the-reference` (rule 11, Machinery anchors). A line that names `PR #N`,
  `issue N`, `pull request N` or a bare `#NN` with no `https://github.com/…/pull/N` or
  `/issues/N` URL for it on the same line warns, as does a file name (`.md`, `.sh`, `.mjs`,
  `.json` and nine more) with no absolute, `~/` or `file://` path ending in it on the line.
  Receipts, fenced code, `→` evidence lines, blockquotes, headings and command lines never
  count. Two more kinds, "the report"-style phrases and branch names, are built and ship off:
  they measured 75 % and 50 % false positives. `linkTheReference.kinds` switches each kind.
  Both new checks detect a direct run by comparing real paths, the 1.5.2 symlink-safe guard.
- New profile field `inject`: `full` (default, unchanged behavior), `rules` (injection only,
  no Stop checks) or `none` (no injection, the checks still run), or an object
  `{"mode": …, "rules": {"<rule id>": false}}` that also switches single rules off. A rule
  switched off is cut from the session-start injection and every check bound to it defaults
  to off; a check's own `enforcement.rules` entry still wins. The eleven rule ids are defined
  once, in `lib/rules.mjs`. See *What you can turn on and off*, which now lists every switch
  with its default. The kill-switch file still wins over every value.
- The Stop hook's 200-character floor counts prose without calling any check, so a rule
  switched off never has its check run, not even to measure the floor.
- The no-judge notice and the setup tool count eleven checks, five of them judge-gated.

### 1.5.2

- The plugin meets ledger 0.3.5's five-row gate. `evals/manifest.json` declares what each of
  the three hooks can return and seven `evals/<x>.scenario.json` prove them: injection on
  (`session-start-inject`) and off (`session-start-off`), the pending-warning relay
  (`prompt-delivers-warning`) and the quiet prompt (`prompt-nothing-pending`), the Stop hook's
  default warn (`stop-warn-default`), its plural block (`stop-block-plural`), and the judge-gated
  warning replayed from the captured real-judge output (`stop-judge-warns`). `e2e/live-run.sh`
  hands off to plugin-kit's `lib/live-run.mjs`, which replays them nightly under `ledger canary
  run`; a live `claude -p` session cannot be isolated from the real state directory on macOS
  (the login lives in the keychain), so that is listed under `manual` in the manifest.
- The three state paths are declared in `.claude-plugin/plugin.json`: `~/.claude/.i-have-audhd-state`
  (30 days, pruned by `node scripts/prune.mjs --days 30`, which removes files older than that and
  keeps `errors.log`), the profile and the off file kept by design. The skill has a "When this
  can't run" section.
- Fix: the Stop hook and the four check scripts compared `import.meta.url` with
  `file://${process.argv[1]}` as strings. Node resolves the main module through symlinks, so a
  hook reached through one (macOS's `/var/folders` tmpdir, where `ledger gate check` snapshots
  the plugin) never ran `main()` and exited 0 with nothing printed and nothing logged: the
  gate's visible row failed `Stop hook on malformed JSON: no errors.log line, no systemMessage`,
  deterministic on that path. The guards now compare real paths, the form the other hooks
  already used.

### 1.5.1

- A hook's own fault is no longer silent. Empty or malformed stdin, a throw, an unparseable
  profile, or a state file that cannot be written leaves one `<file> <reason>` line in
  `errors.log` and one warning line in the hook's `systemMessage`; it still exits 0 and blocks
  nothing. Before, these exited with no output, and a state directory that could not be written
  lost even the `errors.log` line.
- Every block reason now ends with the way out: `touch ~/.claude/.i-have-audhd-off` turns the
  check off, or the `enforcement.rules` key for each blocked rule set to `"warn"`.
- Tests to the repository bar: every hook as a process against each fault and a 5 s budget
  (`hooks/fault-tolerance.test.mjs`), the verdict parser against a real judge's captured output
  (`judge/real-judge-output.test.mjs`, captured by `judge/fixtures/capture-real-judge.mjs`), and
  the main path end to end through setup and all three hooks (`e2e/main-path.test.mjs`).

### 1.5.0

- Per-section judging splits only at the two labels the output-types contract still uses
  (0.2.0 and later): bold `CLAIM` or `CITE` block labels. `PMDW`, `GUESS`, `ACTION` and
  `QUESTION` are retired there, so a line carrying one of them is ordinary prose and opens no
  section. A message with no labels at all, or with plain prose between labeled facts, needs no
  marker: unlabeled text is judged whole, or as the preamble or part of the section it falls in.

### 1.4.0

- A judge that times out, exits non-zero, cannot start, or prints no verdict is reported as
  "judge unavailable" for its rule, never counted as a pass. The rule's finding follows its
  mode (warn by default), `judge-failures.log` keeps the tail of the judge's stderr, and the
  person is told once per rule and error, then hourly while it lasts (`lib/alerts.mjs`).
- The OMP adapter runs the hooks under an absolute node path instead of `sh -lc node`, which
  exited 127 wherever the login profile has no node. It resolves the running node, or under
  Bun the first `node` on PATH and then fixed fallbacks; `I_HAVE_AUDHD_NODE` overrides.
- Every OMP adapter failure line names its hook and keeps the tail of the hook's stderr, and
  each kind of failure raises one UI error notice, then one an hour while it lasts.

### 1.3.0

- `tools/setup.mjs`, an install step that makes you choose a judge: it checks `node`, lists the
  Claude Code CLI, the Codex CLI, OMP, a custom command, or none, test-calls the choice through
  the Stop hook's own dispatch, previews the profile, and writes
  `enforcement.judgeCommand` only after a `yes`. See Install, step 2.
- A one-time session-start notice when no judge has been chosen (`judgeCommand` absent): it
  names the five checks that are off and the setup command. Claude Code shows it as the hook's
  `systemMessage`; the OMP adapter shows it as a UI warning. Choosing none (`null`) or any
  judge stops it; a marker in the state directory keeps it from repeating.

### 1.2.0

- A warn finding now reaches the agent. Until now it went only to `warnings.log`, which
  neither the agent nor its reader opens, so warn mode changed nothing. The Stop hook leaves
  the latest checked message's warn findings in `pending-warn-<session>.json`; the next turn
  consumes it. Claude Code: a new `UserPromptSubmit` hook (`hooks/i-have-audhd-prompt.mjs`)
  returns the notice as `additionalContext` and a one-line `systemMessage` for the person.
  OMP: the adapter queues the same notice with `sendMessage` (`deliverAs: "nextTurn"`) and
  shows the summary as a warning notice. A notice is delivered once and describes only the
  latest checked message; a clean stop clears an older one.
- Block reasons are unchanged. A warn notice drops the block's "paste the corrected lines"
  instruction: the message it describes has already gone out, so the fix applies forward.

### 1.1.0

- `conclusion-first` and `bad-news-first` judge each block-labeled section (each bold
  `PMDW`, `CLAIM`, `CITE`, `GUESS`, `ACTION` or `QUESTION` block) as its own message, the way
  the reader reads it. A message with no block labels is still judged whole. A section's
  heading belongs to it, the label line itself is never judged, and labels inside code
  fences, quotes and comments do not split anything. Each section gets its own gate (400
  characters for `conclusion-first`, 200 plus a lexicon word for `bad-news-first`) and its own
  judge call, and one finding per rule names every section that buries its point or its bad
  news, by label and line.
- "At the start" now means the first 20 words, counted by the hook and shown to the judge,
  not the first sentence: bad news at the end of a long first sentence is buried.
  `conclusion-first` no longer needs two paragraphs to fire, because one long paragraph can
  carry its point at word 40.
- An HTML comment opened mid-line (`Intro <!-- note`) now runs to its `-->` like one opened
  at the start of a line, the text before the `<!--` still counting, and a fence marker inside
  a comment no longer opens a code block. A comment can no longer invent or hide a section.
- The skill's "Bad news first" and the hook's fix guidance now name the opening 20 words
  rather than the first sentence, for unlabeled messages as for labeled sections.
- The judge verdict cache keys on the whole prompt, question included. Cached verdicts from
  1.0.x are not reused; each message is judged once more.

### 1.0.1

- `report-what-you-did-not-do` now fires in OMP. It read only Claude Code's `TodoWrite`
  shape and never saw OMP's `todo` tool; it now reads OMP's list state the way OMP does:
  the latest successful, non-view todo tool result or `user_todo_edit` entry (which the
  eval bridge and `/todo` write), passing over error and view results. It counts `blocked`
  and `abandoned` tasks as unfinished and shows the judge each item's status and phase.

### 1.0.0

- Renamed from `communication-rules` 0.2.x. No aliases: the profile is now
  `~/.claude/i-have-audhd.json`, state `~/.claude/.i-have-audhd-state/`, kill switch
  `~/.claude/.i-have-audhd-off`, and the environment variables `I_HAVE_AUDHD_PROFILE`,
  `I_HAVE_AUDHD_INJECT`, `I_HAVE_AUDHD_ENFORCE`, `I_HAVE_AUDHD_HARNESS`,
  `I_HAVE_AUDHD_PLUGIN_ROOT`. Existing logs and resume markers in the old state dir are not
  migrated. `tools/upgrade-from-communication-rules.mjs` carries an existing profile and
  kill switch over on request (see "Upgrading from communication-rules").
- The skill is now the AuDHD rules (eleven rules, with rationale, comparison and sources
  references). The session-start injection carries its first-turn core and every rule
  heading, introduced by a hook-owned line that names no one.
- The Needs-you section and closing ask are conditional on a real need or decision.
  Informational replies need neither; the structural checks enforce order, not ceremony.
- New deterministic check, `plural-back-reference`: the closing ask leaning on "those",
  "these", "both", "them", "the two" or "either one" with no referent in its own sentence.
  Warn by default.
- Every warning and block reason names the skill rule it enforces.
- OMP: the adapter is registered by the plugin install and now delivers the session-start
  injection as well as the Stop check. The injection survives OMP's prompt-preparation
  retries and is sent once per crossing; the resume marker and the loop guard follow the
  session manager's id rather than the rotating provider id.
- OMP judged stops use a 20-second judge deadline inside the adapter's 25-second budget,
  below the host's 30-second handler deadline. Claude Code keeps the 30-second judge deadline.
  Timed-out judge process groups are killed and pipe handles released.

## Tests

```
node --test plugins/i-have-audhd/checks/*.test.mjs plugins/i-have-audhd/triggers/*.test.mjs plugins/i-have-audhd/judge/*.test.mjs plugins/i-have-audhd/hooks/*.test.mjs plugins/i-have-audhd/omp/*.test.mjs plugins/i-have-audhd/tools/*.test.mjs plugins/i-have-audhd/e2e/*.test.mjs
```

Most tests prove what does not flag: a structural check earns its place by what it leaves
alone. The hook and adapter suites run the real hooks as subprocesses against an isolated
`$HOME`, each with a 5 s timeout. The judge suite drives fake judges, plus the stdout a real
judge printed, saved under `judge/fixtures/`; re-capture it with
`node plugins/i-have-audhd/judge/fixtures/capture-real-judge.mjs`, which reads the judge command
from your profile and calls it. `e2e/main-path.test.mjs` runs the main path through the real
processes in a temp home and git repo.

## License

MIT. See the repository root `LICENSE`.
