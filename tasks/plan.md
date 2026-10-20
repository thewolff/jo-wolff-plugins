# Plan: ask-graham upkeep receipts (#171)

## Objective and baseline

Deliver one open, green PR on thewolff/jo-wolff-plugins for https://github.com/thewolff/jo-issues/issues/171. Do not merge. Every recommended package or tool must show upkeep evidence and conspicuous warnings, without turning upkeep into an exclusion rule.

Fetched origin/main and worktree HEAD were 8a820c0f91e22e34248980822d7e57bffd0a06da; `git show origin/main:plugins/ask-graham/.claude-plugin/plugin.json` returned version 0.5.0. The existing criteria already rank upkeep but the main output does not require an upkeep line. See `plugins/ask-graham/skills/ask-graham/references/comparables-criteria.md` headings “Rank survivors” and “Default options tables”, and `SKILL.md` heading “Output”.

`node --test` from plugins/ask-graham passed 116 tests on installed Node v24.13.0. CI runs that command on Node 24, Ubuntu and macOS (`.github/workflows/ask-graham.yml`, job “test”). Existing MODULE_TYPELESS_PACKAGE_JSON warning is unrelated; do not expand scope to silence it. Installed Bun 1.3.14 was also observed; neither installed version is a skill constant.

## Requirements

- R1: Generated upkeep lines contain last commit, last release, issue response/opened/closed counts, active human maintainers, and runtime compatibility, each receipted or explicitly unknown => code plugins/ask-graham/skills/ask-graham/scripts/upkeep.mjs; test plugins/ask-graham/skills/ask-graham/scripts/upkeep.test.mjs
- R2: Every recommended package or tool, including local recommendations when web research is declined, gets the generated upkeep line => prompt-only: the host agent chooses and writes recommendations outside the helper
- R3: At six calendar months without a release, one or zero active maintainers, absent measurable human issue responses, or missing upkeep evidence, show a warning naming risk and exit path => code plugins/ask-graham/skills/ask-graham/scripts/upkeep.mjs; test plugins/ask-graham/skills/ask-graham/scripts/upkeep.test.mjs
- R4: Upkeep affects ranking and warnings only, never eligibility, while stars and repository age remain context only => prompt-only: the host agent applies the existing qualitative gates and ranking without a ranking engine
- R5: Discover relevant runtimes installed on Jo's machine, receipt actual command output, compare selected-version support evidence, and report unavailable versions without guessing => prompt-only: the host agent determines relevant runtimes and gathers local and vendor evidence
- R6: Preserve web-research consent and existing essential compatibility/security gates, distinguishing an upkeep warning from an evidenced failed requirement => prompt-only: the host agent performs research and evaluates essential requirements outside the helper
- R7: Release all three plugin manifests together under the existing additive minor-version convention and document the change => test plugins/ask-graham/manifest.test.mjs; code plugins/ask-graham/README.md
- R8: Deliver a green open PR linked from jo-issues #171, never merge and never touch ~/.claude/skills => prompt-only: GitHub delivery and personal installation are outside plugin execution

## Design

### One upkeep contract, reached on every recommendation path

Add `references/upkeep.md` as the sole collection/reporting recipe. Link it from the local-search/recommendation completion criteria in SKILL.md, not only the approved-web branch. Add an Upkeep field to the completed output and comparison contract. A local recommendation with no approved internet research uses inspected local git/manifests/installed records and marks unavailable remote fields unknown with the consent/access reason; it must not fetch around the user's no. Pending-answer replies still omit verdicts and preserve the exact final question.

For each recommended package/tool, collect as-of date and selected artifact/version; last actual default-branch commit (distinguish bots/docs churn); latest selected-channel registry release and date, checking tags/registry when GitHub releases are absent; human issue responsiveness with window/sample, opened/closed counts, median first human reply and unanswered count; active human maintainers with window, evidence and concentration, not lifetime contributor totals. Missing/private data is unknown, not zero. Commercial tools get the same visible fields, using dated vendor support/continuity evidence where public development data is unavailable and explicitly marking inapplicable or undisclosed fields, never inventing dates or headcounts.

Default activity window: trailing six calendar months as of collection. Issue responsiveness uses a bounded, disclosed sample of recent non-PR issues in that window; state sample size, unanswered issues and bot exclusions rather than pretending it covers all history. Opened/closed totals use the same disclosed window; if only sampled counts are available label them sampled. Zero eligible issues means response time unmeasurable, not immediate response. Relevant unresolved blockers remain named. A six-month release warning is a signal, not proof of abandonment; quiet mature projects may still rank first on fit with the risk explained.

Every warning has a conspicuous `**Upkeep warning:**` label, specific evidence/risk, and a candidate-specific exit path (alternative, removable interface, pin/fork ownership, or data export). No automatic rejection, numeric health score, or blanket override of real incompatibility/license/security gates. Preserve qualitative ranking order; explain when upkeep decides between otherwise suitable candidates. Stars and repository age never affect the helper or a tie-break.

### Installed-runtime discovery

The recipe starts from the selected candidate's manifests/support matrix and the current project's runtime requirements. Identify relevant installed runtimes on Jo's machine using read-only executable lookup and direct version commands in the user's actual project context: e.g. `command -v node` then `node --version`, likewise Bun, Python, Ruby, Go, Rust, or host CLI only when relevant. Record executable path, command, raw output and collection date. Project pins/manifests describe intended versions, not proof of installation; distinguish them, and mention a mismatch. A remote sandbox's version is not Jo's machine: mark local discovery unavailable there.

Missing executable, failing command, unavailable local shell, unparseable output or unavailable version-specific support evidence produces explicit `unknown` with command/error/reason, not a guessed version or generic “works”. Compare each observed installed version against the selected package/tool version's documented support range or directly observed authorized trial. Label docs-supported vs tested; do not claim a trial occurred. Inspect local binaries only, never install or execute candidate packages during research. Known incompatibility with an essential runtime is the existing compatibility gate; missing upkeep statistics alone never make a candidate unknown-gate or fail.

### Small deterministic report helper (no collector or ranking engine)

Add `scripts/upkeep.mjs`: a pure exported report function plus a CLI reading a supplied JSON evidence file and printing Markdown. It neither fetches evidence, executes runtimes/candidates, installs software, nor changes Stop-hook behavior. This makes warning boundaries and incomplete evidence testable instead of testing prompt wording. The skill instructs the host to use its output for every recommendation and to retain the fields manually with a stated execution limit if the helper cannot run.

Fixed interface for independent hands:

- Input top level: `candidate` (selected name/version), `asOf` (YYYY-MM-DD), `window` (disclosed activity interval), `exitPath` (candidate-specific text).
- `lastCommit` and `lastRelease`: `{ date: YYYY-MM-DD | null, receipt: string, reason?: string }`.
- `issues`: `{ opened: number | null, closed: number | null, sampleSize: number | null, unanswered: number | null, medianFirstHumanResponseHours: number | null, receipt: string, reason?: string }`. Counts must disclose window/sample through `window` and reason; median considers human responses only.
- `maintainers`: `{ count: number | null, receipt: string, reason?: string }` for evidenced active humans in `window`.
- `compatibility`: array of `{ runtime: string, installed: string | null, detectionReceipt: string, status: 'supported' | 'unsupported' | 'unknown', supportReceipt: string, reason?: string }`. Empty/missing array is explicit unknown, never compatible.
- Receipt strings are actual fetched URLs plus observed result or exact command/output anchors. `asOf` dates collection. A positive value without its receipt is rendered unknown and warns. Omitted records/null fields become unknown with the supplied reason or “not collected”; malformed dates cannot silently produce a healthy result.
- Output: `**Upkeep — <candidate>:**` with all five fields, receipts/as-of/window; followed by warnings with exit path when triggered. No gate verdict, rank score or recommendation boolean in the API. Unknown compatibility is reported as unknown; human applies existing essential-runtime gate separately.
- Six-month threshold is inclusive and calendar-based, clamped for month ends in UTC. Test immediately before, at and after the boundary plus a month-end case. Recent commits do not clear stale-release warnings.

No dependencies added. Follow `.mjs`, node:test and node:assert/strict conventions. New permanent tests assert consumer-visible report behavior, not source text, copies, or prompt phrases. Remove the existing source-wording-only `vocabulary.test.mjs` rather than extending/re-pinning it; runtime verdict coverage remains in verdict.test.mjs and both host suites. Keep manifest version coherence tests.

## Slice cut and dependency order

Tasks tracked in this plan and the workload's ledger slices; jo-issues #171 is the external tracker. No separate tasks/todo.md.

1. **sl-upkeep-report** (change-small): owns `skills/ask-graham/scripts/upkeep.mjs` and `upkeep.test.mjs`. Implement the fixed interface, warning policy and deterministic tests. Acceptance: all fields retain provenance/unknowns; six-month/solo/no-response/missing evidence warnings carry risk and exit; no gates or popularity scoring. Verification: `node --test skills/ask-graham/scripts/upkeep.test.mjs`; direct CLI smoke with realistic scratch JSON. Inputs only this scripts cluster and read-only existing script conventions.
2. **sl-upkeep-skill** (change-small, parallel with report): owns `SKILL.md`, `references/comparables-criteria.md`, new `references/upkeep.md`. Acceptance: every recommendation path reaches the recipe; all five evidence fields plus runtime discovery; visible warnings/exit paths; upkeep ranking not rejection; stars/age context; consent and real gates intact. Verification after integration: exercise loaded skill with two supplied-evidence scenarios (research yes; no-web/local missing runtime), inspect actual answer and report limits. Inputs only this skill/reference cluster and this plan's fixed helper contract.
3. **sl-upkeep-release** (change-small, parallel with both): owns README.md, `.claude-plugin/plugin.json`, `.omp-plugin/plugin.json`, package.json and removal of vocabulary.test.mjs. Bump 0.5.0 to 0.6.0 in the three manifests (additive minor releases match history); README documents upkeep behavior, helper use/limits, tests and a dated change note. Marketplace entries carry no version today; do not add one. Acceptance: manifests coherent, docs describe warnings not gates, obsolete wording tests removed without losing runtime verdict tests. Verification after integration: `node --test`. Inputs only this release cluster and plan contract.
4. **sl-upkeep-review** (judge, after all changes settled): cross-lab read-only review of final diff, semantic tests and scenario receipts; findings only. Fix findings in new change slices with their own file clusters; re-review within round limit.
5. **sl-upkeep-deliver** (change-small, after review): own final GitHub/branch delivery artifacts, no competing writers. Fetch/rebase onto origin/main without rewriting pushed history; commit; run declared `node --test` on final clean tree; push alone, open PR, link https://github.com/thewolff/jo-issues/issues/171 in PR and comment the PR URL on that issue. Observe PR-head CI green, leave PR open/unmerged. Use lane_full_test only if this repo is served by the configured runner, never a manual full bun test. Record final receipt, release, no merge.

## Verification and risks

Behavior matrix: healthy multi-maintainer/current release with complete receipts; exactly-six-month release and just-newer control; month end; recent commit but stale release; one maintainer; zero/unknown maintainers; bots-only/no eligible responses; missing field or missing receipt; commercial undisclosed evidence; multiple relevant runtimes with supported/unsupported/unknown results; missing local executable; no-web/local recommendation; low-star young vs high-star old candidate with identical upkeep inputs must yield identical warning behavior. Semantic helper tests must not claim they prove agent collection or ranking. Use actual loaded-skill scenario runs to cover those prompt-only branches; if model execution is unavailable, report that gap, do not substitute regex tests or invented answers.

All scratch fixtures/probe sessions/output go under "$AS2_SCRATCH/...", never /tmp or the worktree. Commands use bash, never eval process starts. Declared proving commands run foreground with timeout below auto-background where feasible. No build or new lint stack: this plugin's CI contract is node --test. Do not silence the pre-existing module warning.

Tradeoff: a tiny offline reporter makes thresholds testable but cannot verify upstream honesty or force the model to use its output; the plan labels those limitations prompt-only.
Tradeoff: extra evidence collection may produce many honest unknowns for private/commercial tools; warn and explain ranking instead of rejecting them.

## Separate installation step for Jo (not this workload)

This PR does not update personal installed copies. If Jo wants the directly installed `~/.claude/skills/ask-graham` to receive 0.6.0, Jo must sync the complete updated skill directory including the new reference and helper after integration. The older workload wl-mv8vxm3q0kstfk owns sl-sync for its already-merged PR #21; do not perform, close, or alter that sync here. Marketplace installations can use the repo's existing update commands after merge; no install or sync is part of PR-only delivery.
