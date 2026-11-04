# as2-skills — vendored sources and pins

This plugin packages the 22 skills of agent-system 2.0 (`thewolff/agent-system-2.0`, `skills/` at commit `b48073ababd33629697c43994a9cda53e5625d38`, 2026-11-02), re-pinned to each upstream pack's latest release on 2026-11-03 (see *Re-pin 2026-11-03* below). The text below is that repo's `skills/VENDOR.md`, carried over with its pins table updated; "this repo" in it means agent-system 2.0, and repo-relative names such as `DESIGN-2.0.md`, `MIGRATION.md` and `research/…` are files there, not in this plugin. Machine-local paths were removed; the edits made while packaging are listed under *Plugin packaging edits* at the end.

Every directory under `skills/` is one of the 22 rows of DESIGN-2.0.md § C6.1. Rows 1–21 were copied from the source named here at the pin named here (§ C6.4, refreshed per `research/skill-pack-refresh.md` § 7) and then owned by this repo; row 22, `seo-audit`, was written in this repo (workload wl-mv5jz4vewt8mbk, `migration/items/seo-audit-skill.md`) and has no upstream. Nothing here tracks upstream automatically; a re-pin is a deliberate re-diff against the commit in this table. Every edit made after the copy is marked in-file with a `<!-- owned: … -->` comment at the edit, so `grep -rn 'owned:' skills/` lists the whole delta.

Copied 2026-09-29 by the M6 migration step (`MIGRATION.md` M6), from tag clones of the packs below; re-pinned in this plugin on 2026-11-03.

## Packs

| pack | clone URL | tag | commit | licence | date | previous (agent-system 2.0 copy) |
|---|---|---|---|---|---|---|
| addyosmani/agent-skills | https://github.com/addyosmani/agent-skills.git | `0.6.15` | `8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e` | MIT (`licenses/addyosmani-agent-skills.LICENSE`) | 2026-10-30 | `0.6.11` `2686b620fc1fed2e8f60c704839c766b8594c6b6`, 2026-09-29 |
| pbakaus/impeccable | https://github.com/pbakaus/impeccable.git | `skill-v4.8.0` | `414603bf14c7a344edb466bb1f85690c77ce8b7d` | Apache 2.0 (`licenses/impeccable.LICENSE`, `licenses/impeccable.NOTICE.md`) | 2026-10-26 | `skill-v4.3.1` `cd12f8660e2dde57b9615c8a6b8ea674101f9cfc`, 2026-09-29. Recorded there as `https://github.com/pmndrs/impeccable.git`, which does not resolve (`git ls-remote`: repository not found); the commit and tag are in `pbakaus/impeccable`. agent-system 2.0's `skills/VENDOR.md` still carries the wrong URL. |
| blader/humanizer | https://github.com/blader/humanizer.git | `main` (no tag after `v3.1.0`) | `0ef9fe5bc3572734fd3ae6c448fe00a30cd5dcf0` | MIT (`humanizer/LICENSE`) | 2026-10-28 | `v3.1.0` `225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8`, 2026-09-29 |
| obra/superpowers | https://github.com/obra/superpowers.git | `v7.0.2` | `22f0b463e7a5e579904dd6211a520321035526f7` | MIT (`execute-plan/LICENSE`) | 2026-11-03 | `v6.4.2` `8ca22dba9a94f28898bbce59f2537ff4d87c747d`, 2026-09-29 |
| newdle-claude-plugins (ours) | the newdle-claude-plugins repo, `plugins/newdle/skills/` | — | `2f7e67f8c1463df64895804815d16b88e266ff90` | ours | 2026-09-29 | unchanged |
| Jo's user skill dirs (ours) | `~/.claude/skills/`, `~/.agents/skills/` | — | not versioned; copied as found | ours | 2026-09-29 | unchanged |

"date" is the pinned commit's date. The "pack @ pin" column in *Rows* below, and the `<!-- owned: … -->` comments inside the skills, still name the pin of the 2026-09-29 copy; the current pin is the one in this table.

The impeccable skill runs a launcher (`impeccable/scripts/impeccable`) that downloads its engine binary on first use and verifies it against `impeccable/scripts/engine-checksums.txt`; at `skill-v4.8.0` the engine pin (`scripts/VERSION`) is `0.1.18` (it was `engine-v0.1.5` at `skill-v4.3.1`). Nothing in this plugin vendors the binary.

## Rows

"Source path" is relative to the pack's clone root (or to the plugin's `plugins/newdle/skills/` for ours). "Absorbed" names the upstream or 1.x skills whose text was folded in as skill-local `references/`; they are not discoverable as skills (nested `SKILL.md` files were renamed so OMP's provider counts exactly 22).

| # | skill dir | pack @ pin | source path(s) | absorbed into it | owned edits |
|---|---|---|---|---|---|
| 1 | `ctx` | Jo's dirs | `~/.claude/skills/ctx/SKILL.md` | — | header marker |
| 2 | `humanizer` | humanizer v3.1.0 | `SKILL.md`, `LICENSE` | — | header marker. 3.x has 26 numbered patterns (2.x had 35); no 2.0 text cites a pattern number (grepped 2026-09-29) |
| 3 | `spec-and-plan` | agent-skills 0.6.11 | `skills/spec-driven-development/SKILL.md` → `SKILL.md`; `skills/planning-and-task-breakdown/SKILL.md` → `references/planning-and-task-breakdown.md`; `references/definition-of-done.md` → `references/` | planning-and-task-breakdown; `~/.agents` `incremental-implementation` (dropped, superseded by execute-plan) | rename, merged description, planning pointers, Phase 4 → execute-plan, link rewrites |
| 4 | `test-driven-development` | agent-skills 0.6.11 | `skills/test-driven-development/`; `references/testing-patterns.md` → `references/` | `~/.agents` `tdd` (dropped) | link rewrite `../../references/` → `references/` |
| 5 | `debugging-and-error-recovery` | agent-skills 0.6.11 | `skills/debugging-and-error-recovery/` | `~/.agents` `diagnosing-bugs` (dropped) | header marker |
| 6 | `code-review-and-quality` | agent-skills 0.6.11 | `skills/code-review-and-quality/`; `references/{performance-checklist,security-checklist}.md` → `references/`; `skills/code-simplification/SKILL.md` → `references/code-simplification.md`; `skills/constraint-driven-development/references/floor-guard.md` → `references/floor-guard.md` | code-simplification; constraint-driven-development's Floor + Step 6 (as "Step 6: Guard the Bar") | header marker, Step 6 section, See Also pointers, link rewrites |
| 7 | `git-workflow-and-versioning` | agent-skills 0.6.11 | `skills/git-workflow-and-versioning/` | `split-to-prs`, `git-guardrails-claude-code` (dropped) | header marker |
| 8 | `resolving-merge-conflicts` | Jo's dirs | `~/.agents/skills/resolving-merge-conflicts/{SKILL.md,agents/openai.yaml}` | — | header marker |
| 9 | `security-and-hardening` | agent-skills 0.6.11 | `skills/security-and-hardening/`; `references/security-checklist.md` → `references/` | `newdle-security-audit`, `newdle-cso` (product, dropped) | link rewrites in SKILL.md and `references/hardening-patterns.md` |
| 10 | `documentation-and-adrs` | agent-skills 0.6.11 | `skills/documentation-and-adrs/` | — | header marker |
| 11 | `research` | agent-skills 0.6.11 | `skills/source-driven-development/SKILL.md` → `SKILL.md` | `~/.agents` `research` (its findings-file rule folded in as a section), `newdle-research` (dropped) | rename, description, "Findings file — the artifact" section |
| 12 | `interview-me` | agent-skills 0.6.11 | `skills/interview-me/`; `skills/idea-refine/` (whole dir) → `references/idea-refine/` (its `SKILL.md` → `idea-refine.md`) | idea-refine; plugin `grilling`, `grill-me`, `grill-with-docs`, `to-questionnaire` (dropped) | header marker, "Interaction with Other Skills" renamed to 2.0 skills |
| 13 | `writing-for-agents` | Jo's dirs | `~/.agents/skills/writing-for-agents/{SKILL.md,SKILL-MECHANICS.md,agents/openai.yaml}` | `create-skill`, `using-agent-skills` (dropped) | header marker |
| 14 | `cross-model-review` | ours 2f7e67f8 + agent-skills 0.6.11 | plugin `triad/` (whole dir) → `references/triad/` (`SKILL.md` → `triad.md`); plugin `quorum/` → `references/quorum/` (`SKILL.md` → `quorum.md`); `skills/doubt-driven-development/SKILL.md` → `references/doubt-driven-development.md`; `references/orchestration-patterns.md` → `references/` | triad, quorum, doubt-driven-development; `gaslight`, `council`, `newdle-triple-check`, `claudex-*`, `codex-*` (dropped) | new `SKILL.md` (router); doubt-driven carries the plugin's codex network-profile fix (plugin `doubt-driven-development/SKILL.md` at 2f7e67f8, measured 2026-08-14) in place of upstream's `--sandbox read-only`; link rewrites |
| 15 | `api-and-interface-design` | agent-skills 0.6.11 | `skills/api-and-interface-design/` | `codebase-design`, `domain-modeling`, `setup-pre-commit` (dropped) | header marker |
| 16 | `performance-optimization` | agent-skills 0.6.11 | `skills/performance-optimization/`; `references/performance-checklist.md` → `references/` | `newdle-performance-audit` (dropped) | link rewrite |
| 17 | `observability-and-instrumentation` | agent-skills 0.6.11 | `skills/observability-and-instrumentation/`; `references/observability-checklist.md` → `references/` | — | link rewrite |
| 18 | `deprecation-and-migration` | agent-skills 0.6.11 | `skills/deprecation-and-migration/` | `migrate-to-shoehorn` (dropped) | header marker |
| 19 | `accessibility` | ours 2f7e67f8 | plugin `newdle-a11y-audit/{SKILL.md,WCAG-AA-CHECKLIST.md}` | `newdle-responsive-audit` etc. (dropped) | rename to `accessibility`, description, plugin auditor-spawn block removed, verdict marker renamed |
| 20 | `impeccable` | impeccable skill-v4.3.1 | `.pi/skills/impeccable/` (whole dir: `SKILL.md`, `reference/`, `scripts/`) — the `.pi` variant, chosen because OMP leaves `${CLAUDE_SKILL_DIR}` unexpanded (M6 check 1) | — | `allowed-tools` frontmatter key dropped; base-directory note names the OMP location |
| 21 | `execute-plan` | superpowers v6.4.2 | `skills/subagent-driven-development/SKILL.md` → `SKILL.md`; `skills/subagent-driven-development/{implementer-prompt,task-reviewer-prompt,re-review-prompt}.md`; `skills/subagent-driven-development/scripts/{sdd-workspace,task-brief,review-package}` + `skills/executing-plans/scripts/{task-start,task-done}` → `scripts/`; `skills/executing-plans/SKILL.md` → `references/executing-plans.md`; `skills/requesting-code-review/code-reviewer.md` → `code-reviewer-prompt.md`; `LICENSE` | executing-plans; `incremental-implementation` | rename + description; `superpowers:*` refs → rows #3–#7; four stops → SPEC § A4 reserved list; `Ruling:` → ledger `assumption` entry; main-branch consent line and `finishing-a-development-branch` hand-off removed. Scripts unchanged (workspace path `.superpowers/sdd/` kept) |
| 22 | `seo-audit` | — (written in this repo, 2026-10-12) | — | supersedes the plugin's `newdle-seo-audit`; no text copied | not a copy: every rule row cites a primary source listed in `references/sources.md` |

## Discovery

In agent-system 2.0 these 22 directories are loaded through an OMP profile allowlist. In this plugin they are the plugin's `skills/` directory, which Claude Code scans by default, and each skill is namespaced as `/as2-skills:<name>`. Skill-local links are relative to the skill directory (`references/…`), because OMP's `skill://<name>/<path>` refuses `..`.

## Re-pin 2026-11-03

Each upstream-derived file was rebuilt by a three-way merge: base = the file at the previous pin, ours = the agent-system 2.0 copy (which carries the owned edits), theirs = the file at the new pin (`git merge-file`). A clean merge keeps both the upstream changes and the owned edits. Where an owned edit overlapped an upstream change, the upstream text was kept for that hunk and the owned edit is listed below as dropped. Files agent-system 2.0 had not changed were replaced by the new upstream file. Upstream files new under a directory the row copies whole were added. Files and skills marked "ours" were copied from agent-system 2.0 unchanged.

| skill | previous → new pin | upstream change in the copied files | owned edits |
|---|---|---|---|
| `ctx`, `resolving-merge-conflicts`, `writing-for-agents` | ours | — | copied unchanged |
| `accessibility`, `seo-audit` | ours | — | copied unchanged |
| `humanizer` | `v3.1.0` → `main` `0ef9fe5` | 0 files (only the pack's README and plugin manifest changed) | kept |
| `spec-and-plan` | agent-skills `0.6.11` → `0.6.15` | 1 file, +9/−1 | `SKILL.md` merged clean |
| `test-driven-development` | `0.6.11` → `0.6.15` | 2 files, +5/−2 | `SKILL.md` merged clean |
| `debugging-and-error-recovery` | `0.6.11` → `0.6.15` | 1 file, +1/−1 | merged clean |
| `code-review-and-quality` | `0.6.11` → `0.6.15` | 5 files, +37/−18 | `SKILL.md` merged clean; the 4 reference files had no owned edits and are upstream |
| `git-workflow-and-versioning` | `0.6.11` → `0.6.15` | 1 file, +3/−3 | merged clean |
| `security-and-hardening` | `0.6.11` → `0.6.15` | 3 files, +12/−5 | `SKILL.md` and `references/hardening-patterns.md` merged clean |
| `documentation-and-adrs` | `0.6.11` → `0.6.15` | 1 file, +13/−3 | merged clean |
| `research` | `0.6.11` → `0.6.15` | 1 file, +3/−2 | merged clean |
| `interview-me` | `0.6.11` → `0.6.15` | 1 file, +24/−7 (`references/idea-refine/idea-refine.md`) | `SKILL.md` unchanged upstream, kept |
| `cross-model-review` | ours + `0.6.11` → `0.6.15` | 1 file, +2/−0 | `references/doubt-driven-development.md` merged clean (codex network-profile fix kept) |
| `api-and-interface-design` | `0.6.11` → `0.6.15` | 1 file, +4/−2 | merged clean |
| `performance-optimization` | `0.6.11` → `0.6.15` | 3 files, +282/−258; new `references/optimization-patterns.md` | 1 dropped: the "Do not cache" link rewrite, because upstream moved that paragraph into `references/optimization-patterns.md`. The same link rewrite was made again by hand there and in `SKILL.md` (see packaging edits). The See Also link rewrite merged clean |
| `observability-and-instrumentation` | `0.6.11` → `0.6.15` | 0 files | kept |
| `deprecation-and-migration` | `0.6.11` → `0.6.15` | 1 file, +6/−1 | merged clean |
| `impeccable` | `skill-v4.3.1` → `skill-v4.8.0` | 41 files, +1549/−252; 7 new files | the `allowed-tools` removal merged clean; the owned header comment was dropped, because upstream rewrote the paragraph under it |
| `execute-plan` | superpowers `v6.4.2` → `v7.0.2` | 17 files, +445/−356; 8 new files (`references/{batching,cannot-verify,final-review,fix-loop,handling-reports,preflight,resuming}.md`, `scripts/sdd-repo`) | 5 hunks conflicted; 4 ported by hand, 1 not carried (see below) |

**execute-plan: owned edits ported by hand.** superpowers v7.0.0 moved the final review and the finish out of `SKILL.md` into `references/final-review.md`, and removed the Example Workflow sections. Every owned edit in that text overlapped the move, so the merge kept upstream there; the edits were then carried onto the v7 text by hand, each marked with an `owned:` comment:

- `SKILL.md` process graph: the final review is "Final review (references/final-review.md): dispatch final code reviewer (./code-reviewer-prompt.md)", then "Final findings? ONE fix dispatch, one scoped re-review, adjudicate residuals", and the graph ends at "Close the slice: PR open, rulings listed, merge is a reserved request" instead of `superpowers:finishing-a-development-branch`.
- `references/final-review.md`: the reviewer is `../code-reviewer-prompt.md` with `code-review-and-quality` as its rubric; only the reserved actions at the top of `SKILL.md` stop the final review; residual findings ride "Rulings I made" into the close; and the finish is the SPEC-2.0 § A4 close (push the feature branch, open the PR with "Rulings I made" in its body, record the PR in the ledger, never merge, never wait for an answer) in place of the `superpowers:finishing-a-development-branch` hand-off. Its "Part of" line names `execute-plan`.
- `references/executing-plans.md`: the close points at `final-review.md` § Finish, where the finish now lives.
- Not carried: the Example Workflow closing line ("Feature branch pushed, PR open …; merge is the orchestrator's") in `SKILL.md` and `references/executing-plans.md`. Upstream deleted both Example Workflow sections, so the line has no section to sit in; restoring it would mean restoring the v6 examples, which describe v6 script calls.
- The six other new `references/*.md` files still open with upstream's "Part of superpowers:subagent-driven-development". That line is descriptive; nothing in them hands off to a `superpowers:*` skill.

## Plugin packaging edits

Made when the skills were copied into this plugin, on top of the re-pin:

- `impeccable/SKILL.md`: the top-level `version: 4.8.0` key moved under `metadata:`, unchanged. claude.ai uploads accept only `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools` at the top level (https://code.claude.com/docs/en/skills, *Using skill frontmatter outside Claude Code*). No other `SKILL.md` carried another key.
- `performance-optimization/SKILL.md` (Missing caching bullet) and `performance-optimization/references/optimization-patterns.md` (lines 5 and 250): links to the pack-level `../../references/performance-checklist.md` / `../../../references/performance-checklist.md` rewritten to this skill's own `references/performance-checklist.md`, the same rewrite agent-system 2.0 made elsewhere in this skill.
- `execute-plan/references/final-review.md`: the link to `../../requesting-code-review/code-reviewer.md` points at this skill's `../code-reviewer-prompt.md`, where row 21 puts that file.
- `cross-model-review/references/triad/triad.md`: the home directory in the quoted kimi `EPERM` line reads `$HOME`, and the kimi session path reads `~/.kimi-code`.
- `cross-model-review/references/panel/panel.md`: the lane example reads `$HOME/agent-scratch/<project>/<wl>/…`.
- `seo-audit/references/research/survey.md`: the old skill's path is given relative to the newdle-claude-plugins repo.
- `resolving-merge-conflicts/agents/openai.yaml` and `writing-for-agents/agents/openai.yaml` stay inside their skills. They are Codex skill display metadata (`interface.display_name`, `interface.short_description`), not Claude Code agent files, so they do not belong in a plugin-level `agents/` directory.
- `cross-model-review/lib/leg-runner.sh` (added in 0.1.1): newdle-claude-plugins `plugins/newdle/lib/leg-runner.sh` at `28e7356`, under one added header line naming that source and the owned patch. Below the header it is byte-identical except line 210, the codex banner check, where `grep -q` became `grep … >/dev/null`: `grep -q` exits on the first match while `head -n 40` is still writing, `head` dies of SIGPIPE (141), and the callers' `set -o pipefail` turned that into a "no network" verdict on a leg that had network. The pattern and its `^…$` anchors are unchanged. Row 14 copied the triad and quorum scripts, which source it as `$SKILL_DIR/../../lib/leg-runner.sh`, without it. It sits inside the skill directory, where those lines already point, so the skill stays self-contained (see *Discovery*). It sources nothing itself.
- `cross-model-review/references/triad/triad.md` (line 608) and `cross-model-review/references/quorum/quorum.md` (lines 267–269) (0.1.1): the sentence naming where the runner lives now says the cross-model-review skill's `lib/leg-runner.sh`; upstream called it the plugin's `lib/leg-runner.sh`, which is not where this plugin keeps it.
- `licenses/` holds the agent-skills MIT licence and impeccable's Apache 2.0 licence and NOTICE at the new pins, which the copied skill directories do not carry.
