# Changelog

All notable changes to i-have-audhd are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries before 1.5.2 live in the
README's *Changes* section.

## [1.7.0]

- The judge command is plugin-kit's shared judge. `lib/judge.mjs` is the kit's dispatch,
  vendored byte for byte (the kit's `test/judge.test.mjs` diffs every vendored copy), and
  `judge/ask.mjs` keeps only what is this plugin's: the prompt, the strict verdict shape, the
  cache, the harness budget, and the failure line with its `cause=`. Resolution is the kit's
  order: the profile's `enforcement.judgeCommand` first, else `command` in
  `${XDG_CONFIG_HOME:-~/.config}/judge/config.json`. **An existing profile with
  `enforcement.judgeCommand` keeps working unchanged**: the plugin key wins, and `null`
  there means "no override" (the shared file applies), not "no judge". The shared file's
  `timeoutMs` is not used; the hook's own budget (30 s, 20 s under OMP) is unchanged.
- `node lib/judge.mjs setup` writes the shared file (the kit's CLI, in the vendored copy;
  its `which` is the kit's generic resolver, not this plugin's effective judge: it does not
  read the override first and reports the shared or default timeout). `tools/setup.mjs` is
  this plugin's override only: it now shows the shared file and the judge that resolves for
  this plugin before asking, and "none" reads "none of its own" and previews the shared file
  alone, never the override it is removing. The session-start notice names both files and
  both commands and shows only when neither has a command; a malformed shared file is one
  fault line, not a notice, whether the profile's key is absent or `null`.
- `judge-failures.log` lines carry the kit's error kinds (`timeout`, `nonzero`,
  `unparseable`, `spawn-failed`; 1.6.1 wrote `judge-timeout`, `judge-exit-<n>`,
  `judge-unparseable`, `judge-spawn-<errno>`), plus `detail="exit 127"` and the `source=`
  the command came from; `cause=` values are unchanged. `skipped.log` lines name
  `shared=<path>` and, when it is the reason, `malformed=`. "Judge unavailable" findings
  name the source. Eval `stop-judge-shared-config` replays the real-judge capture with the
  command in the shared file and no profile.

Tickets: thewolff/jo-issues #327 (i-have-audhd) and #333 (shared judge).

## [1.6.1]

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
- Review nits: markdown link text gives a GitHub link its PR or issue word only as `PR #N` /
  `issue #N` with the URL's own number; an indented code block is not prose for
  `links-resolve`; GitHub cache keys are lower-cased; the helper takes its lock with `wx` and
  a second helper exits quietly while it is held; `quota` inside a path and a bare `aborted`
  no longer pick a cause (`other` instead); a credential alert names the judge's profile
  when the judge's stderr does; a test pins the Stop `timeout` (35 s) to the judge budget
  plus 5 s.

## [1.6.0]

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

## [1.5.2]

- Meets ledger 0.3.5's five-row gate (evals manifest and seven scenarios, declared state paths with `scripts/prune.mjs`), and the Stop hook and check scripts compare real paths in their direct-invocation guards.
