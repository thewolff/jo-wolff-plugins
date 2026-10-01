# OMP adapter built warn-only on a side branch; gaslight staged; installer v3 awaiting Jo

---
date: 2026-09-22 00:24 -0700
engineer: tinker
session: seat-tinker, 2026-09-21 → 09-22 (communication-rules enforcement program)
status: landed — branch `omp-adapter` @ `1f4e7f1`, deliberately unpushed (see Decisions)
durable: false (pending Jo's call — only the gaslight-before-arming sequence is a candidate)
---

## What changed

- **This branch** (`omp-adapter`, commit `1f4e7f1`, parent `7921ad3` = remote main) adds
  `plugins/communication-rules/omp/`:
  - `communication-rules-omp.ts` — the OMP-harness binding for the existing Stop-hook CLI.
  - `communication-rules-omp.test.mjs` — 18/18.
  - `REGISTRATION.md` — the not-taken registration steps + the 5-minute canary seat.
- Adapter test suite 18/18; full plugin suite **152/152**. Canonical invocation: run
  `node --test` from **inside** `plugins/communication-rules/` — passing the directory as an
  argument errors "Cannot find module" and masquerades as a failure. node v24.13 imports the
  `.ts` type-stripped; no Bun involved.
- Unregistered: nothing in `~/.omp` loads it. Nothing pushed; remote main stays `7921ad3`.
- Context-only artifacts landed outside the repo (nothing here references them as shipped
  docs):
  - `/Users/jowolff/agent-scratch/orchestrator/reports/rule-graduation-loop-2026-09-22.md`
  - `/Users/jowolff/agent-scratch/orchestrator/reports/onboarding-new-user-review-2026-09-22.md`
  - Installer v3 (name-the-artifact armed at install, Jo-only by construction):
    `/Users/jowolff/agent-scratch/orchestrator/install-communication-rules-enforcement.sh`,
    sha256 `398180ee3baec1cd20a39886627f1b83f9e4af1b53605b78b865a7477a2b6437`. The log beside
    it is a fake-HOME battery run (tmp.kM4Dt3sxwi paths) — **not a real install**; Jo's
    `~/.claude/communication-rules.json` and `.communication-rules-state` are still absent.

## Decisions

- **Warn-only by construction.** The shared profile arms name-the-artifact at BLOCK for
  Claude Code; the adapter downgrades any CLI block to one warnings.log line until Jo sets
  `COMMUNICATION_RULES_OMP_MODE=block` at registration time (read per invocation). The two
  harnesses can disagree without the adapter silently picking a side.
- **Spawn the CLI; never import it.** Keeps exit-0 fail-open isolation and keeps `.ts` and
  `.mjs` from ever meeting in one module graph (OMP-port research finding). Lazy spawn,
  25 s timeout, fail-open counter persisted to
  `~/.claude/.communication-rules-state/omp-adapter-failures.json`.
- **No seat-side kill switch.** The CLI's `~/.claude/.communication-rules-off` flag file is
  per-invocation and shared across both bindings — one switch, one place, documented once.
- **Side branch, not main, and unpushed — on purpose.** Remote main is pinned at `7921ad3`
  by the installer's `git ls-remote` drift gate; pushing this branch's merge would move the
  tip and break the gate. Merge + push + pin bump happen as ONE deliberate act when Jo arms
  OMP. Until then this commit is unreplicated by design, not forgotten.
- **Known defect recorded, not yet fixed:** `README.md:44-53` scoreboard is stale — it
  promises block×7/warn×1, the inverse of the measured warn-everywhere default
  (`lib/config.mjs:19-26`). Fix belongs to the next docs pass (onboarding report, finding 1).

## Dead ends

- Importing the Stop hook in-process (rejected — couples fail-open semantics and module
  formats; spawn is the seam the research picked).
- Treating the fresh installer log as evidence of a real install (it isn't — fake-HOME
  battery; verified by the tmp.* paths inside it and the absent real profile).

## Heads-up

- **Gaslight over this adapter is staged, not returned.** Lintel's brief:
  `/Users/jowolff/agent-scratch/orchestrator/briefs/gaslight-omp-adapter.md`; leg prompts and
  the gpt-5.6-sol probe (PROBE-OK) at
  `/Users/jowolff/agent-scratch/orchestrator/gaslight-omp-adapter/`. Findings will come back
  verbatim to its runner. **If findings demand changes:** fix on this branch, re-run both
  suites (18/18 + 152/152), amend or add a commit — do not start a second adapter.
- Sequence Jo has gated: gaslight findings land → Jo accepts (or asks for changes) → Jo runs
  installer v3 → canary seat per `omp/REGISTRATION.md` (~5 min) → optional 30-45 min new-user
  walkthrough per the onboarding report. Nothing proceeds without the gate.
- The graduation bar for warn→block (≤1 FP over ≥25 adjudicated fires, ≥3 TPs, two stable
  windows; deterministic provisional at 0 FP ≥10 fires — name-the-artifact's exact standing)
  is recorded in the graduation-loop report above, not yet anywhere shipped.
