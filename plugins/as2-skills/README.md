# as2-skills

The 22 engineering skills of agent-system 2.0, packaged as one plugin so a claude.ai account's
marketplace sync can deliver them to Claude Code and to chat. Each skill loads on demand, matched
against its description, and runs on Claude Code as `/as2-skills:<name>`.

| skill | what it is for |
|---|---|
| `spec-and-plan` | a spec, then an ordered and sized task plan, before coding |
| `execute-plan` | run an approved plan task by task with a fresh implementer subagent and a review per task |
| `test-driven-development` | red, green, refactor for any logic change or bug fix |
| `debugging-and-error-recovery` | root-cause debugging when something fails |
| `code-review-and-quality` | multi-axis review of a diff or PR before merge |
| `git-workflow-and-versioning` | commits, branches, PRs, releases |
| `resolving-merge-conflicts` | an in-progress merge or rebase conflict |
| `security-and-hardening` | untrusted input, auth, secrets, dependencies, privacy |
| `documentation-and-adrs` | decision records and documentation |
| `research` | go to primary sources and write a cited findings file |
| `interview-me` | find out what an underspecified ask actually wants |
| `writing-for-agents` | skills, `AGENTS.md`, `CLAUDE.md` |
| `cross-model-review` | a second opinion from three labs on a diff, plan or document |
| `api-and-interface-design` | APIs, module boundaries, type contracts |
| `performance-optimization` | measure, fix one bottleneck, re-measure |
| `observability-and-instrumentation` | logging, metrics, tracing, alerting |
| `deprecation-and-migration` | removing old systems and moving users off them |
| `accessibility` | a WCAG 2.2 AA audit of changed files |
| `impeccable` | frontend design, critique and polish |
| `humanizer` | rewrite prose that reads as AI-written |
| `seo-audit` | an audit-only SEO and AI-search check of a live URL |
| `ctx` | search earlier agent sessions for a decision or attempt |

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install as2-skills@jo-wolff-plugins
```

On OMP, from a shell:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install as2-skills@jo-wolff-plugins
```

Some skills call tools that are not part of this plugin: `cross-model-review` drives the `codex`
and `kimi` CLIs, `impeccable` downloads its engine binary on first use, `ctx` needs the `ctx` CLI,
and `seo-audit`'s scripts run under Bun. Each skill says what it needs.

## Where the skills come from

Seventeen skills were copied from four upstream packs (`cross-model-review` only in part) and then
edited in agent-system 2.0; five (`ctx`, `resolving-merge-conflicts`, `writing-for-agents`,
`accessibility`, `seo-audit`) are Jo Wolff's own. `VENDOR.md` has the full record: every pack's
clone URL, tag and commit, the previous pin, the source path of every file, what each skill
absorbed, every owned edit, and the result of the latest re-pin.

| pack | pin | commit | licence |
|---|---|---|---|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | `0.6.15` | `8bfcc1f9916f` | MIT |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `skill-v4.8.0` | `414603bf14c7` | Apache 2.0 |
| [blader/humanizer](https://github.com/blader/humanizer) | `main` (no tag after `v3.1.0`) | `0ef9fe5bc357` | MIT |
| [obra/superpowers](https://github.com/obra/superpowers) | `v7.0.2` | `22f0b463e7a5` | MIT |

Every edit made after a copy is marked in the file with a `<!-- owned: … -->` comment, so
`grep -rn 'owned:' skills/` lists the delta from upstream. Those comments name the pin of the
first copy; `VENDOR.md` names the current one.

**execute-plan after the 2026-11-03 re-pin:** superpowers v7 moved the final review and finish
into `references/final-review.md`, so agent-system 2.0's edits there did not merge. They were
ported onto the v7 text by hand: the final reviewer uses `code-reviewer-prompt.md` with the
`code-review-and-quality` rubric, and the slice closes by pushing the branch and opening the PR
with "Rulings I made", never merging. `VENDOR.md` lists each hunk and the one line not carried.

## Licence

The upstream text keeps its upstream licence:

- agent-skills (MIT): `licenses/addyosmani-agent-skills.LICENSE`.
- impeccable (Apache 2.0): `licenses/impeccable.LICENSE` and `licenses/impeccable.NOTICE.md`. The
  `impeccable` skill is a modified copy; its owned edits are marked in the file and listed in
  `VENDOR.md`.
- humanizer (MIT): `skills/humanizer/LICENSE`.
- superpowers (MIT): `skills/execute-plan/LICENSE`.

The skills and edits written for agent-system 2.0 (`ctx`, `resolving-merge-conflicts`,
`writing-for-agents`, `accessibility`, `seo-audit`, the `cross-model-review` router and its
`triad`, `quorum` and `panel` references, and every owned edit) are MIT, under the repository's
`LICENSE`.

## Refreshing a pin

1. Clone the pack and check out the new tag. Note its commit and commit date.
2. For each row of `VENDOR.md` that names the pack, three-way merge every copied file: the file at
   the old pin is the base, the copy in `skills/` is ours, the file at the new pin is theirs
   (`git merge-file -p --diff3 ours base theirs`). A clean merge keeps both sides. Where an owned
   edit conflicts, decide whether to port it to the new text by hand or drop it, and record the
   choice in `VENDOR.md`.
3. Copy in upstream files that are new under a directory the row copies whole, and check every
   link in the skill still resolves inside the skill directory.
4. Update the *Packs* table in `VENDOR.md`: new tag, commit and date, with the old pin in the
   *previous* column. Refresh the matching file under `licenses/` from the new tag.
5. Run the tests and validate the plugin (next section), then bump `version` in
   `.claude-plugin/plugin.json`, `.omp-plugin/plugin.json` and `package.json` together.

## Developing

```
node --test skills.test.mjs
claude plugin validate .
```

The test parses every `SKILL.md` frontmatter and fails when a top-level key falls outside the six
that claude.ai uploads accept (`name`, `description`, `license`, `compatibility`, `metadata`,
`allowed-tools`; https://code.claude.com/docs/en/skills), when `name` does not match the skill's
directory, or when a field breaks an Agent Skills limit (https://agentskills.io/specification).
Move any other key under `metadata:`. A second test resolves every `. "…"` / `source "…"` line in
the skills' shell scripts and fails when the sourced file is missing or sits outside the script's
own skill directory. Run the test file by name: a bare `node --test` also picks up the Bun tests
under `skills/*/test/`, which do not run under Node.

## Changes in 0.1.2

- Every skill has a "How it fails" section (what the agent does when the tool it shells
  out to is missing, returns nothing, or cannot be trusted), the repository test bar ledger 0.3.5's
  `gate check` enforces, and `.claude-plugin/plugin.json` declares the one path a skill writes
  outside the worktree (`$TMPDIR/seo-audit-*`, per run, kept 0 days). With no hooks the gate's
  `evals` row is skipped.

## Changes in 0.1.1

- `cross-model-review`: the triad and quorum fan-out scripts no longer fail on first use. Both
  source `lib/leg-runner.sh`, which 0.1.0 did not ship; it is now vendored at
  `skills/cross-model-review/lib/leg-runner.sh` from newdle-claude-plugins `28e7356`, with one
  owned patch: the codex network-banner check now reads all of `head`'s output, so under the
  callers' `set -o pipefail` a leg whose banner is present is no longer reported as having no
  network when `head` dies of SIGPIPE.
