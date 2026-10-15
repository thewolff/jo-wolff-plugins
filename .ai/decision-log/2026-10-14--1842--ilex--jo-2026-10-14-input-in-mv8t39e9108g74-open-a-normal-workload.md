---
date: 2026-10-14T18:42-07:00
engineer: Ilex
session: wl-mv8t3hv9iowf0g
status: resolved
durable: false
supersedes:
workload: wl-mv8t3hv9iowf0g
---

# Jo (2026-10-14, input in-mv8t39e9108g74): "Open a normal workload: i-have-audhd judges conclusion-first and bad-news-first per block-labeled section (each PMDW/CLAIM/ACTION/... block is its own unit), not per whole message. Jo reads each section as a separate message. Land after the 1.0.1 bugfix PR." Context: the repo is thewolff/jo-wolff-plugins, and the plugin is plugins/i-have-audhd. The 1.0.1 bugfix PR comes from workload wl-mv8s8swa3yumf4 (ask-graham nudge pile-up plus the i-have-audhd OMP todo trigger), so branch from main after that PR merges, or merge it in. The local clone /Users/jowolff/code/jo-wolff-plugins is stale, so start from the fetched origin/main.

done: The i-have-audhd conclusion-first and bad-news-first judgments treat each block-labeled section (each bold PMDW/CLAIM/CITE/GUESS/ACTION/QUESTION block) as its own unit instead of the whole message. This is shown by tests on multi-section messages and lands in one PR on thewolff/jo-wolff-plugins, after the 1.0.1 bugfix PR (wl-mv8s8swa3yumf4) merges, which Jo merges.
done-because: PR https://github.com/thewolff/jo-wolff-plugins/pull/19 (head 9966855, based on origin/main e90b6a0, which contains the merged 1.0.1 PR #17) makes the i-have-audhd conclusion-first and bad-news-first judgments run per block-labeled section. checks/sections.mjs splitLabeledSections cuts at bold PMDW/CLAIM/CITE/GUESS/ACTION/QUESTION label lines; the stop hook gates and judges each section alone on its first 20 words; a message with no labels is still one unit. Multi-section tests prove it: checks/sections.test.mjs, plus 9 per-section hook tests in hooks/i-have-audhd-stop.test.mjs that run against a content-sensitive fake judge. `npm test` → 232 pass, 0 fail. The cross-lab review passed on round 3 (REVIEW-pr19-r3.md). Per Jo's in-mv8u0kven6kjk0 the lane stops at this reviewed, green PR, and Jo merges it.

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-10-15T00:34:23.925Z.

## What changed

- sl-t3-plan: Plan: cut per-labeled-section judging for conclusion-first and bad-news-first into slices; review on another lab; ask Jo to approve — artifact: Jo approved q-mv8u8vwj7vyqyo (in-mv8uhs8sokm0hs); plan /Users/jowolff/agent-scratch/agent-system-2.0/wl-mv8t3hv9iowf0g/PLAN.md; review pass /Users/jowolff/agent-scratch/agent-system-2.0/wl-mv8t3hv9iowf0g/PLAN-REVIEW-r4.md
- sl-t3-build: Implement PLAN.md design items 1-6 and its Tests section: sections.mjs (splitLabeledSections, openingWords), per-section gates/jobs in the stop hook, 20-word window questions, prompt-keyed cache, findings per rule, docs, version 1.1.0 — artifact: commit d1d5bd7 on wl/wl-mv8t3hv9iowf0g; `node --test 'plugins/i-have-audhd/**/*.test.mjs'` → tests 229, pass 229, fail 0 (incl. 9 per-section hook tests, 16 sections.test.mjs tests); git status clean
- sl-t3-integrate: Merge origin/main into wl/wl-mv8t3hv9iowf0g, rerun the proving command on the merged tree, push, open the PR — artifact: origin/main merged (already up to date at e90b6a0); `npm test` in plugins/i-have-audhd → 229 pass, 0 fail; pushed wl/wl-mv8t3hv9iowf0g at d1d5bd7; PR https://github.com/thewolff/jo-wolff-plugins/pull/19
- sl-t3-review: Cross-lab review of the PR diff against PLAN.md and the done: line; findings only — artifact: Round 3 verdict pass, no findings, openai-codex/gpt-6-sol: /Users/jowolff/agent-scratch/agent-system-2.0/wl-mv8t3hv9iowf0g/REVIEW-pr19-r3.md (PR 19 head 9966855). Rounds 1-2 asked for revisions (REVIEW-pr19-r1.md, r2.md), fixed in sl-t3-fix1 (9ff7401) and sl-t3-fix2 (9966855).
- sl-t3-land: Stop at the reviewed, green PR: confirm green at head, tell Jo it is ready to merge; the lane never merges — artifact: PR https://github.com/thewolff/jo-wolff-plugins/pull/19 OPEN, MERGEABLE, head 9966855 (contains origin/main e90b6a0, which has 1.0.1); `npm test` on that tree → 232 pass, 0 fail; review pass REVIEW-pr19-r3.md; no CI checks configured; the test runner does not serve this repo (lane_full_test refused: not in testRunner.repos). Lane does not merge, per Jo's in-mv8u0kven6kjk0.
- sl-t3-fix1: Fix PR 19 review r1 findings: comment/fence ordering and inline comment start in classifyLines; reasons prescribe opening 20 words; SKILL.md first-sentence wording aligned to 20 words — artifact: commit 9ff7401 pushed to PR 19; `npm test` in plugins/i-have-audhd → 232 pass, 0 fail; the hand's fails-before run showed the 2 comment probe tests fail on d1d5bd7's lines.mjs
- sl-t3-fix2: Fix PR 19 review r2: mask inline code spans by matching equal-length backtick runs in commentOpenAt, with regression tests — artifact: commit 9966855 pushed to PR 19; `npm test` in plugins/i-have-audhd → 232 pass, 0 fail; the new double-backtick test fails against 9ff7401's lines.mjs (scratch fb2: pass 19, fail 1)

## Decisions made (and why)

- jo (surface): Jo: "wl-mv8t3hv9iowf0g plan revision: landing slice stops at a reviewed, green PR that Jo merges. Judge "at the start" means the first ~20 words of the section, not its first sentence: Jo labels bad news at the end of a long first sentence as buried." — reading: Two revisions to the per-section judging plan. First, the landing slice (sl-t3-land) stops at a reviewed, green PR that Jo merges; the lane never merges it. Second, for the judge, "at the start" of a section means its first ~20 words, not its first sentence, because Jo counts bad news at the end of a long first sentence as buried.
- jo answered "revise" to q-mv8tdw25x4yups (/Users/jowolff/agent-scratch/agent-system-2.0/wl-mv8t3hv9iowf0g/PLAN.md
- sl-t3-build: split messages at bold label lines; gate and judge each section alone for both rules; prompt-keyed cache; tests; docs; 1.1.0
- sl-t3-integrate: after the 1.0.1 PR merges, merge origin/main, resolve conflicts, rerun tests, push, open the PR
- sl-t3-review: cross-lab review of the integrated PR diff; fix slices on blocking/major findings
- sl-t3-land: merge the PR once review passes and tests are green at its head; tell Jo in one line
tradeoff: per-section floors: a message made only of short labeled sections never triggers either judge
tradeoff: one judge call per qualifying section (parallel, cached): more bills on long labeled reports
tradeoff: label set hardcoded to the six output-types labels; no config knob
review: pass, openai-codex/gpt-6-sol, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mv8t3hv9iowf0g/PLAN-REVIEW-r2.md)
- jo answered "approve" to q-mv8u8vwj7vyqyo (/Users/jowolff/agent-scratch/agent-system-2.0/wl-mv8t3hv9iowf0g/PLAN.md
- sl-t3-build: split at bold label lines; judge each section alone; "start" = first 20 words, shown to the judge; prompt-keyed cache; tests; docs; 1.1.0
- sl-t3-integrate: merge origin/main (1.0.1 already in, e90b6a0), rerun tests on the merged tree, push, open the PR
- sl-t3-review: cross-lab review of the PR diff; fix slices on blocking/major findings
- sl-t3-land: stop at the reviewed, green PR; tell Jo it is ready; the lane never merges, Jo merges
tradeoff: per-section floors (200/400 chars): a short section never reaches a judge even if its point sits past word 20
tradeoff: conclusion-first drops its 2-paragraph minimum, so more single-paragraph sections get a judge call
tradeoff: fixed 20-word window and fixed six labels, no config knobs; one judge call per qualifying section
review: pass, openai-codex/gpt-6-sol, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mv8t3hv9iowf0g/PLAN-REVIEW-r4.md)
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.30 judge typesafe/jev-1.13.0
- assumption (classifier): pair-exposure: lane-mv8t3hv9iowf0g-1 on
- assumption (classifier): pair-signal: taste no 0.96 ambiguous yes 0.36 judge typesafe/jev-1.13.0 tokens 757 cost 0.000031794
- assumption (lane-mv8t3hv9iowf0g-1): builder-lab: anthropic lane lane-mv8t3hv9iowf0g-1 model anthropic/claude-opus-5-5
- assumption (lane-mv8t3hv9iowf0g-1, sl-t3-plan): hand-spawn: dt-mv8t7ssk31ac6519 session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-plan review yes group dg-mv8t7ssked5f7fc2 row openai-codex/gpt-6-sol,moonshot/kimi-k2.7-code
- assumption (lane-mv8t3hv9iowf0g-1, sl-t3-plan): hand-settled: dt-mv8t7ssk31ac6519 routing rt-mv8tavuf71wl4w
- assumption (lane-mv8t3hv9iowf0g-1, sl-t3-plan): review-round: sl-t3-plan round 1 token dt-mv8t7ssk31ac6519 group dg-mv8t7ssked5f7fc2 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":2,"design":2,"tests":1},"minor":{"other":1}},"titles":[{"severity":"major","kind":"correctness","title":"Heading before a label attributed to preceding section"},{"severity":"major","kind":"correctness","title":"Changed judge questions reuse old unlabeled cache verdicts"},{"severity":"major","kind":"design","title":"Generated metadata is first sentence of judged message"},{"severity":"major","kind":"tests","title":"Fixed-verdict tests do not establish section-specific outcomes"},{"severity":"major","kind":"design","title":"Integration conflicts are resolved after only diff review"},{"severity":"minor","kind":"other","title":"Pending 1.0.1 branch tip is stale in plan"}]}
- assumption (lane-mv8t3hv9iowf0g-1, sl-t3-plan): review-loop-end: sl-t3-plan reason pass
- assumption (lane-mv8t3hv9iowf0g-1, sl-t3-plan): hand-spawn: dt-mv8tc11m07b6a069 session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-plan-2 review yes group dg-mv8tc11m2acba755 row openai-codex/gpt-6-sol,moonshot/kimi-k2.7-code
- assumption (lane-mv8t3hv9iowf0g-1, sl-t3-plan): hand-settled: dt-mv8tc11m07b6a069 routing rt-mv8tdni2z8gnpc
- assumption (lane-mv8t3hv9iowf0g-1, sl-t3-plan): review-round: sl-t3-plan round 1 token dt-mv8tc11m07b6a069 group dg-mv8tc11m2acba755 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mv8t3hv9iowf0g-1, sl-t3-plan): review-loop-end: sl-t3-plan reason pass
- assumption (classifier): pair-exposure: lane-mv8t3hv9iowf0g-2 on
- assumption (lane-mv8t3hv9iowf0g-2): builder-lab: anthropic lane lane-mv8t3hv9iowf0g-2 model anthropic/claude-opus-5-5
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): hand-spawn: dt-mv8u325n9a752b2d session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-plan-3 review yes group dg-mv8u325na360d025 row openai-codex/gpt-6-sol,moonshot/kimi-k2.7-code
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): review-withheld: dt-mv8u325n9a752b2d
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): builder-lab: openai hand dt-mv8u325n9a752b2d model openai-codex/gpt-6-sol
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): hand-settled: dt-mv8u325n9a752b2d routing rt-mv8u4u6y3ro64g
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): review-round: sl-t3-plan round 1 token dt-mv8u325n9a752b2d group dg-mv8u325na360d025 verdict withheld blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): hand-spawn: dt-mv8u52ao5e3eb5ac session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-plan-4 review yes group dg-mv8u52ao51fc6618 row moonshot/kimi-k2.7-code
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): provider-refused: moonshot status 429 token dt-mv8u52ao5e3eb5ac
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): hand-settled: dt-mv8u52ao5e3eb5ac routing rt-mv8u5gznc7pr0g
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): review-round: sl-t3-plan round 2 token dt-mv8u52ao5e3eb5ac group dg-mv8u52ao51fc6618 verdict failed-dispatch blocking unknown counts unknown
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): review-same-lab-rule: in-mv5xafhywe3w8w slice sl-t3-plan token dt-mv8u5ok18f3b77a4 labs openai,anthropic kimi moonshot/kimi-k2.7-code (its provider refused on dt-mv8u52ao5e3eb5ac (status 429))
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): hand-spawn: dt-mv8u5ok18f3b77a4 session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-plan-5 review yes group dg-mv8u5ok101fae400 row openai-codex/gpt-6-sol,anthropic/claude-opus-5-5
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): hand-settled: dt-mv8u5ok18f3b77a4 routing rt-mv8u72b5vl3bwg
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): review-round: sl-t3-plan round 2 token dt-mv8u5ok18f3b77a4 group dg-mv8u5ok101fae400 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"design":1,"tests":1},"minor":{}},"titles":[{"severity":"major","kind":"design","title":"Landing slice waits for Jo's merge instead of stopping at the reviewed green PR"},{"severity":"major","kind":"tests","title":"Unchanged-trigger-tests instruction contradicts removal of conclusion-first paragraph minimum"}]}
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): review-loop-end: sl-t3-plan reason pass
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): review-same-lab-rule: in-mv5xafhywe3w8w slice sl-t3-plan token dt-mv8u7ifk4fc34c93 labs openai,anthropic kimi moonshot/kimi-k2.7-code (its provider refused on dt-mv8u52ao5e3eb5ac (status 429))
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): hand-spawn: dt-mv8u7ifk4fc34c93 session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-plan-6 review yes group dg-mv8u7ifkb392dfbf row openai-codex/gpt-6-sol,anthropic/claude-opus-5-5
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): hand-settled: dt-mv8u7ifk4fc34c93 routing rt-mv8u8pci5hjgn4
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): review-round: sl-t3-plan round 1 token dt-mv8u7ifk4fc34c93 group dg-mv8u7ifkb392dfbf verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mv8t3hv9iowf0g-2, sl-t3-plan): review-loop-end: sl-t3-plan reason pass
- assumption (classifier): pair-exposure: lane-mv8t3hv9iowf0g-3 on
- assumption (lane-mv8t3hv9iowf0g-3): builder-lab: anthropic lane lane-mv8t3hv9iowf0g-3 model anthropic/claude-opus-5-5
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-build): artifact-command: node --test 'plugins/i-have-audhd/**/*.test.mjs'
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-build): hand-spawn: dt-mv8uijq405c09954 session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-build review no group dg-mv8uijq47a503d1b row anthropic/claude-opus-5-5
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-build): hand-settled: dt-mv8uijq405c09954 routing rt-mv8uw8iwc3rwg0
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-build): Accepted the builder's two choices outside the plan's letter. (1) Four existing hook tests that relied on conclusion-first's dropped 2-paragraph minimum now use a 340-char fixture, under the 400 floor, with their assertions unchanged. (2) Paragraph counting is removed from conclusionFirstApplicable (the minParagraphs option and the `paragraphs` field are gone), because nothing else read them and the plan calls for a clean cutover.
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-integrate): artifact-command: npm test
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): review-same-lab-rule: in-mv5xafhywe3w8w slice sl-t3-review token dt-mv8uyoac949d56e7 labs openai,anthropic kimi moonshot/kimi-k2.7-code (its provider refused on dt-mv8u52ao5e3eb5ac (status 429))
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): hand-spawn: dt-mv8uyoac949d56e7 session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-review review yes group dg-mv8uyoace3b8bb54 row openai-codex/gpt-6-sol,anthropic/claude-opus-5-5
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): hand-settled: dt-mv8uyoac949d56e7 routing rt-mv8v1sjanyodfk
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): review-round: sl-t3-review round 1 token dt-mv8uyoac949d56e7 group dg-mv8uyoace3b8bb54 verdict accepted blocking unknown counts unknown
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-fix1): hand-spawn: dt-mv8v2fsse156049a session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-fix1 review no group dg-mv8v2fss119bc8a5 row anthropic/claude-opus-5-5
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-fix1): hand-settled: dt-mv8v2fsse156049a routing rt-mv8v6susnnnzsw
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-fix1): artifact-command: npm test
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): review-same-lab-rule: in-mv5xafhywe3w8w slice sl-t3-review token dt-mv8v7whc84e2eba7 labs openai,anthropic kimi moonshot/kimi-k2.7-code (its provider refused on dt-mv8u52ao5e3eb5ac (status 429))
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): hand-spawn: dt-mv8v7whc84e2eba7 session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-review-2 review yes group dg-mv8v7whc6cb32a89 row openai-codex/gpt-6-sol,anthropic/claude-opus-5-5
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): hand-settled: dt-mv8v7whc84e2eba7 routing rt-mv8vd421jfgu80
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): review-round: sl-t3-review round 2 token dt-mv8v7whc84e2eba7 group dg-mv8v7whc6cb32a89 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"correctness":1},"minor":{}},"titles":[{"severity":"major","kind":"correctness","title":"Double-backtick inline code hides real sections and other checks"}]}
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): review-loop-end: sl-t3-review reason pass
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-fix2): artifact-command: npm test
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): review-same-lab-rule: in-mv5xafhywe3w8w slice sl-t3-review token dt-mv8vewus5e5cde1d labs openai,anthropic kimi moonshot/kimi-k2.7-code (its provider refused on dt-mv8u52ao5e3eb5ac (status 429))
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): hand-spawn: dt-mv8vewus5e5cde1d session /Users/jowolff/.agent-system-2/lanes/wl-mv8t3hv9iowf0g/sessions/2026-10-15T00-34-26-910Z_01a13cfb-55dd-7000-a7f7-ec25ed29f0a2 spawn sl-t3-review-3 review yes group dg-mv8vewus39c138ef row openai-codex/gpt-6-sol,anthropic/claude-opus-5-5
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): hand-settled: dt-mv8vewus5e5cde1d routing rt-mv8viintlb5r7k
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): review-round: sl-t3-review round 1 token dt-mv8vewus5e5cde1d group dg-mv8vewus39c138ef verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mv8t3hv9iowf0g-3, sl-t3-review): review-loop-end: sl-t3-review reason pass

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- message msg-mv8vitotn1jabk [held] not acted on: PR #19 (i-have-audhd 1.1.0: conclusion-first and bad-news-first judged per labeled section, on each section's first 20 words) is ready for Jo to merge: https://github.com/thewolff/jo-wolff-plugins/pull/19, head 9966855. A gpt-6-sol review passed it on round 3 (REVIEW-pr19-r3.md), `npm test` is 232/232 green at that head, and 1.0.1 (#17) is already in its base. Beyond the plan, review fixes also changed: the HTML comment handling in checks/lines.mjs (comments opened mid-line; fences inside comments; inline code spans matched by backtick count), and the SKILL.md bad-news line, which now says "first 20 words" instead of "first sentence".
