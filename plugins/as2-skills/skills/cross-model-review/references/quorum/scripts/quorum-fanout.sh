#!/usr/bin/env bash
#
# quorum — fan a plan brief out to three independently-trained models.
#
#   ./quorum-fanout.sh <brief-file-or-dir> [more sources...] [options]
#     --draft <path>        withhold this draft from the legs; staged for synthesis only
#     --context <path>      grounding pack (approved by the user before this call);
#                           copied into the run dir as context.md and given to all legs
#     --repo-context all    legs run against the live repo instead of a shared pack
#     --refute              after fan-out, each leg attacks the other two plans
#     --objectives          layer per-leg objective framings on top (waives attribution)
#     --only a,b / --skip c run a subset of legs
#     --slug <name>         override the run-directory slug
#
# All three legs receive the SAME prompt and the SAME brief (+ optional grounding
# pack). The independence axis is the provider — three labs, three corpora — and
# nothing else, so a divergence between plans is attributable to the model rather
# than to a difference in framing or information environment.
#
# Isolation is enforced by the execution environment, not by prompting: each leg
# runs in its own scratch dir (created outside the run dir — see the note at the
# scratch-dir setup) containing brief.md, optionally context.md, and nothing else.
#
# Legs run in parallel. Partial failure is survivable; the manifest records what died.
#
# The leg-runner machinery (timeout preflight, resolve_cli, run_leg with its
# ARG_MAX guard and codex banner assertion) lives in the shared library
# sourced below, extracted 2026-08-14 once this skill had a validated run —
# the precondition the old KNOWN DEBT header here named.

set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPTS="$SKILL_DIR/prompts"
. "$SKILL_DIR/../../lib/leg-runner.sh"

# ---------------------------------------------------------------------------
# Config — verify these CLI invocations against current provider docs.
# Model IDs and flags turn over. Override any of the three via env.
#
# None of the three legs pins a specific dated model ID:
#   - Leg A keeps `--model opus`, a rolling alias the Claude Code CLI itself
#     documents as an example (`claude --help`, verified 2026-08-03) — not a
#     fixed model string, so it doesn't rot the way a dated ID would. It's
#     also load-bearing: the design wants Opus-class reasoning specifically.
#   - Leg B and leg C omit --model entirely and rely on each CLI's own
#     configured default (`~/.codex/config.toml` / `~/.kimi-code/config.toml`)
#     rather than a hardcoded ID. Fewer hardcoded IDs, less rot.
#   - Exception since 2026-10-12: leg B passes `-m gpt-6-sol` (Jo's review
#     rule; see the comment above QUORUM_B_CMD below), so the bullet above
#     holds for leg C only while that rule stands.
# ---------------------------------------------------------------------------
#
# Both legs below pin an explicit high reasoning/thinking effort. This is
# load-bearing, not tuning: on a real triad run (1026 lines / 18 files), leg B
# returned `{"status":"no_findings","findings":[]}` in 30s at its config
# default of `model_reasoning_effort = "low"`, then surfaced 3 real
# high-severity findings on the identical input re-run with
# `-c model_reasoning_effort=high` (verified 2026-08-03, live `codex exec`
# call). Plan generation is strictly more reasoning-heavy than diff review,
# so the pin matters more here, not less. Leg A's effort default comes from
# a per-operator `~/.claude/settings.json`, which this script should not
# depend on either, so it's pinned explicitly too.
: "${QUORUM_A_CMD:=claude -p --model opus --permission-mode plan --effort high}"
# Leg A's schemas are passed inline by run_leg, not embedded in the cmd — claude
# takes `--json-schema` INLINE (verified 2026-08-03: passing a path errors
# "not valid JSON" while the same schema inline returns a conforming object).
# Set QUORUM_A_SCHEMA= (empty) to fall back to unstructured output.
: "${QUORUM_A_SCHEMA:=$PROMPTS/plan.schema.json}"
: "${QUORUM_A_REFUTE_SCHEMA:=$PROMPTS/refute-plan.schema.json}"
# --skip-git-repo-check is required, not optional: leg B's scratch dir holds
# brief.md (+ context.md) and nothing else, which is by definition not a git
# repo. Without it codex refuses to start ("Not inside a trusted directory")
# and the leg dies in under a second. Verified 2026-08-03 (triad).
#
# Unlike triad, leg B's `--output-schema <path>` is NOT baked into the cmd:
# this script has two phases (plan, refute) needing two different schemas,
# so the schema path is appended per phase at the call site. codex takes the
# schema as a PATH; claude takes it inline — they are not interchangeable.
#
# The `permissions.*` overrides replace `--sandbox read-only`, which denied DNS
# to every shell command codex spawned: a real run trying to fetch an API URL
# died with `curl: (6) Could not resolve host`. `extends=":read-only"` keeps the
# filesystem fence while `network.enabled=true` restores egress. Measured
# 2026-08-14 on codex-cli 0.147.0: `touch ./x` in cwd → "Operation not
# permitted" (rc 1), `curl https://api.newdle.com/v3/api/feeds/latest` → 200.
# Two traps, both silent:
#   1. Leaving `--sandbox read-only` on this line OVERRIDES the profile and
#      kills the network again with no error and no warning — same measurement,
#      banner drops to plain `sandbox: read-only` and curl exits 6. The flag
#      must be REMOVED, not supplemented.
#   2. The only cheap correctness signal is codex's own banner, which it prints
#      on stderr (so it lands in the leg's .log): it must read
#      `sandbox: read-only (network access enabled)`. Plain `sandbox: read-only`
#      means the profile is not in effect. run_leg asserts that line for any
#      codex leg and fails the leg loudly when it is missing.
# The quotes inside the -c values are literal and load-bearing: $cmd is expanded
# unquoted for word splitting, so codex receives `":read-only"` and `"netro"`
# quotes included and parses each as a TOML string. Bare, they are not valid
# TOML and codex refuses to start.
# What this trades away: with the network on, egress is unrestricted — a
# `network.domains` allowlist naming only example.com did not stop
# api.github.com from returning 200 (measured 2026-08-14), and a deny rule had
# no effect. Accepted deliberately; see triad/SKILL.md § "What leg B's sandbox
# still guarantees, and what it no longer does".
# Model pin (Jo, 2026-10-12, ledger inputs in-mv5qdfvskukmbk and
# in-mv5qfm8910ycjk; MIGRATION.md item 110): a review that routes to OpenAI
# runs on gpt-6-sol, never gpt-6-astra, until the review-cost framework
# workload lands or Jo says otherwise. Without `-m gpt-6-sol` this leg takes
# `~/.codex/config.toml`'s `model`, which is gpt-6-astra on Jo's machine.
# Ending the rule = deleting `-m gpt-6-sol` here.
: "${QUORUM_B_CMD:=codex exec -m gpt-6-sol --skip-git-repo-check -c permissions.netro.extends=\":read-only\" -c permissions.netro.network.enabled=true -c default_permissions=\"netro\" -c model_reasoning_effort=high}"
: "${QUORUM_B_SCHEMA:=$PROMPTS/plan.schema.json}"
: "${QUORUM_B_REFUTE_SCHEMA:=$PROMPTS/refute-plan.schema.json}"
# Leg C has no structured-output flag (`kimi --help`, checked 2026-08-03);
# it returns the same JSON object shape as prose, parsed leniently downstream.
: "${QUORUM_C_CMD:=kimi -p}"

# Higher than triad's 600: each leg is generating a whole plan, not reviewing
# a diff, and generation on a real brief runs long.
: "${QUORUM_TIMEOUT:=900}"       # per-leg seconds

# Default lives outside any repo: the brief, the grounding pack, and model
# output can all contain sensitive material, and an in-repo default risks an
# accidental `git add .` sweeping a run into a commit.
: "${QUORUM_OUT_ROOT:=${TMPDIR:-/tmp}/quorum}"

# Cap on the grounding pack. brief.md + context.md ride leg C's argv (see the
# ARG_MAX guard in run_leg), so the pack must leave headroom under that limit.
# A pack that exceeds the cap is a signal the brief is too broad — the run
# says so and stops rather than silently truncating.
: "${QUORUM_CONTEXT_MAX_BYTES:=131072}"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
BRIEF_SRCS=()
DRAFT=""
CONTEXT=""
REPO_CONTEXT=""
REFUTE=""
OBJECTIVES=""
ONLY_CSV=""
SKIP_CSV=""
SLUG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --draft)   DRAFT="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    # The only supported value is `all`. There is deliberately NO per-leg
    # variant (e.g. `--repo-context a`): granting repo access to one leg
    # creates an information asymmetry between legs that are compared as
    # peers, so a unique finding from that leg could mean either "this model
    # caught it" or "this was the only leg shown the input" — it contaminates
    # every synthesis bucket, not just one. Symmetric-only, always.
    --repo-context)
      if [[ "${2:-}" != "all" ]]; then
        echo "--repo-context only accepts 'all' — per-leg repo access breaks cross-leg attribution (see SKILL.md)" >&2
        exit 1
      fi
      REPO_CONTEXT="all"; shift 2 ;;
    --refute)     REFUTE=1; shift ;;
    --objectives) OBJECTIVES=1; shift ;;
    --only) ONLY_CSV="$2"; shift 2 ;;
    --skip) SKIP_CSV="$2"; shift 2 ;;
    --slug) SLUG="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    --*) echo "unknown option: $1" >&2; exit 1 ;;
    *) BRIEF_SRCS+=("$1"); shift ;;
  esac
done

if (( ${#BRIEF_SRCS[@]} == 0 )); then
  echo "no brief supplied — pass one or more files/directories (see --help)" >&2
  exit 1
fi

if [[ -n "$CONTEXT" && -n "$REPO_CONTEXT" ]]; then
  echo "--context and --repo-context all are mutually exclusive (one grounding mode per run)" >&2
  exit 1
fi

run_this_leg() {
  local leg="$1"
  if [[ -n "$ONLY_CSV" && ",$ONLY_CSV," != *",$leg,"* ]]; then return 1; fi
  if [[ -n "$SKIP_CSV" && ",$SKIP_CSV," == *",$leg,"* ]]; then return 1; fi
  return 0
}
RUN_A=""; RUN_B=""; RUN_C=""
run_this_leg a && RUN_A=1
run_this_leg b && RUN_B=1
run_this_leg c && RUN_C=1
if [[ -z "$RUN_A" && -z "$RUN_B" && -z "$RUN_C" ]]; then
  echo "--only/--skip left no legs to run" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Preflight — fail before staging anything rather than mid-fan-out.
# ---------------------------------------------------------------------------

# Both from lib/leg-runner.sh: `timeout` resolution (GNU coreutils; macOS
# ships neither `timeout` nor `gtimeout` by default) and the off-PATH CLI
# probe used for kimi below.
require_timeout

MISSING_CLI=()
[[ -n "$RUN_A" ]] && { command -v claude >/dev/null 2>&1 || MISSING_CLI+=("claude (leg A) — https://docs.claude.com/en/docs/claude-code"); }
[[ -n "$RUN_B" ]] && { command -v codex  >/dev/null 2>&1 || MISSING_CLI+=("codex (leg B) — https://github.com/openai/codex"); }
if [[ -n "$RUN_C" ]]; then
  resolve_cli kimi "$HOME/.kimi-code/bin/kimi" \
    || MISSING_CLI+=("kimi (leg C) — curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash")
fi
if (( ${#MISSING_CLI[@]} > 0 )); then
  echo "Missing required CLI(s), install/auth before running quorum:" >&2
  printf '  - %s\n' "${MISSING_CLI[@]}" >&2
  exit 1
fi

# Leg C's provider/model is the piece most likely to be unconfigured even
# with the binary present. Check it and skip the leg with a clear reason
# instead of letting it fail mid-fan-out with a cryptic log.
if [[ -n "$RUN_C" ]] && ! kimi provider list >/dev/null 2>&1; then
  echo "note: \`kimi provider list\` failed — leg C has no configured model/provider." >&2
  echo "      Run \`kimi login\`, then \`kimi doctor\` to confirm. Running without leg C." >&2
  RUN_C=""
  SKIP_C_REASON="leg C provider/model unavailable (kimi provider list failed)"
fi

# ---------------------------------------------------------------------------
# Stage
# ---------------------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
if [[ -z "$SLUG" ]]; then
  SLUG="$(basename "${BRIEF_SRCS[0]}")"
  SLUG="${SLUG%.*}"
  SLUG="$(printf '%s' "$SLUG" | tr -c 'A-Za-z0-9_-' '-' | tr -s '-')"
  [[ -z "$SLUG" || "$SLUG" == "-" ]] && SLUG="quorum"
fi
# QUORUM_OUT_ROOT is absolute by default (outside any repo); a relative
# override resolves against the invocation cwd.
if [[ "$QUORUM_OUT_ROOT" = /* ]]; then
  OUT_ROOT="$QUORUM_OUT_ROOT"
else
  OUT_ROOT="$PWD/$QUORUM_OUT_ROOT"
fi
OUT="$OUT_ROOT/$SLUG-$STAMP"
mkdir -p "$OUT"

# Resolve the brief: concatenate every source into one brief.md. A directory
# contributes its regular files in sorted order. Multi-source runs get a
# `### source:` header per piece so a leg can cite which input a claim came from.
: > "$OUT/brief.md"
MULTI_SRC=""
(( ${#BRIEF_SRCS[@]} > 1 )) && MULTI_SRC=1
append_source() {
  local f="$1"
  if [[ ! -r "$f" ]]; then
    echo "brief source unreadable: $f" >&2; exit 1
  fi
  if [[ -n "$MULTI_SRC" ]]; then
    printf '### source: %s\n\n' "$(basename "$f")" >> "$OUT/brief.md"
  fi
  cat "$f" >> "$OUT/brief.md"
  printf '\n' >> "$OUT/brief.md"
}
for src in "${BRIEF_SRCS[@]}"; do
  if [[ -d "$src" ]]; then
    found=""
    for f in "$src"/*; do
      [[ -f "$f" ]] || continue
      MULTI_SRC=1
      append_source "$f"
      found=1
    done
    [[ -z "$found" ]] && { echo "brief directory is empty: $src" >&2; exit 1; }
  else
    append_source "$src"
  fi
done

# The one hard stop the script owns: an empty brief means every leg would be
# planning against nothing. Everything else about whether to run is advisory
# and lives at the skill level.
if [[ ! -s "$OUT/brief.md" ]] || ! grep -q '[^[:space:]]' "$OUT/brief.md"; then
  echo "resolved brief is empty — nothing to plan against" >&2
  exit 1
fi

CONTEXT_BYTES=0
CONTEXT_SHA=""
if [[ -n "$CONTEXT" ]]; then
  if [[ ! -r "$CONTEXT" ]]; then
    echo "grounding pack unreadable: $CONTEXT" >&2; exit 1
  fi
  CONTEXT_BYTES=$(wc -c < "$CONTEXT" | tr -d ' ')
  if (( CONTEXT_BYTES > QUORUM_CONTEXT_MAX_BYTES )); then
    cat >&2 <<EOF
Grounding pack is ${CONTEXT_BYTES}B, over the ${QUORUM_CONTEXT_MAX_BYTES}B cap (QUORUM_CONTEXT_MAX_BYTES).
brief.md + context.md must fit leg C's argv budget, and a pack this large is a
signal the brief is too broad for one quorum run. Narrow the brief or the pack;
this script will not silently truncate it.
EOF
    exit 1
  fi
  cp "$CONTEXT" "$OUT/context.md"
  CONTEXT_SHA="$(shasum -a 256 "$OUT/context.md" | awk '{print $1}')"
fi
BRIEF_BYTES=$(wc -c < "$OUT/brief.md" | tr -d ' ')
BRIEF_SHA="$(shasum -a 256 "$OUT/brief.md" | awk '{print $1}')"

# The withheld draft is staged at the run root for the synthesis cross-check.
# It must never reach a leg: independence from the draft is the product, and
# leg scratch dirs are created OUTSIDE $OUT (below) precisely so no leg's
# curious tool call can walk up and find this file.
if [[ -n "$DRAFT" ]]; then
  [[ -r "$DRAFT" ]] || { echo "draft unreadable: $DRAFT" >&2; exit 1; }
  cp "$DRAFT" "$OUT/withheld-draft.md"
fi

# Every leg gets the same payload: brief, then the grounding pack if one ran.
# Byte-identical across legs — only the transport differs (stdin vs argv).
{
  printf -- '--- BRIEF ---\n\n'
  cat "$OUT/brief.md"
  if [[ -f "$OUT/context.md" ]]; then
    printf -- '\n--- CONTEXT (grounding pack — the only codebase facts available; do not invent paths beyond it) ---\n\n'
    cat "$OUT/context.md"
  fi
} > "$OUT/payload.md"

# Per-leg prompts. Identical by default — the independence axis is the
# provider, nothing else. --objectives deliberately breaks that: it layers
# council's three framings on, one per leg, trading clean attribution
# for wider coverage. The manifest records the waiver.
A_PROMPT="$PROMPTS/plan.md"; B_PROMPT="$PROMPTS/plan.md"; C_PROMPT="$PROMPTS/plan.md"
if [[ -n "$OBJECTIVES" ]]; then
  # The leg→objective pairing is arbitrary (any assignment breaks attribution
  # equally); fixed here so re-runs are comparable.
  objective_prompt() {
    local leg="$1" framing="$2"
    local f="$OUT/$leg-prompt.md"
    {
      printf '# Objective framing (this leg only)\n\n%s\n\n---\n\n' "$framing"
      cat "$PROMPTS/plan.md"
    } > "$f"
    printf '%s' "$f"
  }
  A_PROMPT="$(objective_prompt a "Optimize for speed to ship / fastest path to value. Note explicitly what you'd skip or defer to move faster, and why that's an acceptable tradeoff.")"
  B_PROMPT="$(objective_prompt b "Optimize for minimal risk / smallest blast radius / most reversible path. Note explicitly what you'd instrument or stage before committing, and what you'd refuse to touch.")"
  C_PROMPT="$(objective_prompt c "Optimize for long-term structural correctness, even if it's slower to deliver. Note explicitly what you'd reject as a band-aid.")"
fi

# Leg scratch dirs live OUTSIDE $OUT: $OUT holds withheld-draft.md and, once
# legs start finishing, the other legs' plans — a leg walking up from a
# scratch dir inside $OUT could find both, and either one breaks blindness.
# One mktemp parent holds them all so cleanup is a single rm; a leg walking
# up from its own dir finds only sibling dirs with byte-identical content.
# In live-repo mode (--repo-context all) every leg instead runs at the
# invocation cwd — symmetric, so attribution survives, at the cost of 3x
# exploration and a non-reproducible input.
SCRATCH_ROOT=""
if [[ "$REPO_CONTEXT" != "all" ]]; then
  SCRATCH_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/quorum-legs.XXXXXX")"
fi
# Called via $(...) so it must not mutate globals — the subshell would drop them.
leg_workdir() {
  local leg="$1"
  if [[ "$REPO_CONTEXT" == "all" ]]; then
    printf '%s' "$PWD"
    return
  fi
  local d="$SCRATCH_ROOT/$leg"
  mkdir -p "$d"
  cp "$OUT/brief.md" "$d/brief.md"
  [[ -f "$OUT/context.md" ]] && cp "$OUT/context.md" "$d/context.md"
  printf '%s' "$d"
}

# ---------------------------------------------------------------------------
# Legs — run_leg comes from lib/leg-runner.sh; these knobs are its contract.
# LEG_SECTION_LABEL is empty on purpose: the appended content file carries its
# own section labels (payload.md / refute payloads), so no `--- DIFF ---`-style
# label is inserted between prompt and payload.
# ---------------------------------------------------------------------------
LEG_TIMEOUT="$QUORUM_TIMEOUT"
LEG_SECTION_LABEL=""
LEG_ARGMODE_HINT="brief + context are too large"
LEG_CODEX_CMD_VAR="QUORUM_B_CMD"
require_leg_contract

GROUND_MODE="ungrounded"
[[ -n "$CONTEXT" ]] && GROUND_MODE="shared pack"
[[ "$REPO_CONTEXT" == "all" ]] && GROUND_MODE="live repo (all legs, non-reproducible)"
echo "quorum: brief ${BRIEF_BYTES}B, grounding: $GROUND_MODE → $OUT"

WAIT_PIDS=()
if [[ -n "$RUN_A" ]]; then
  A_DIR="$(leg_workdir a)"
  run_leg a-plan "$A_DIR" "$QUORUM_A_CMD" "$A_PROMPT" "$OUT/payload.md" stdin "$QUORUM_A_SCHEMA" &
  WAIT_PIDS+=("$!")
else
  echo "a-plan skipped (--only/--skip)" > "$OUT/a-plan.status"
fi

if [[ -n "$RUN_B" ]]; then
  B_DIR="$(leg_workdir b)"
  run_leg b-plan "$B_DIR" "$QUORUM_B_CMD --output-schema $QUORUM_B_SCHEMA" "$B_PROMPT" "$OUT/payload.md" &
  WAIT_PIDS+=("$!")
else
  echo "b-plan skipped (--only/--skip)" > "$OUT/b-plan.status"
fi

if [[ -n "$RUN_C" ]]; then
  C_DIR="$(leg_workdir c)"
  run_leg c-plan "$C_DIR" "$QUORUM_C_CMD" "$C_PROMPT" "$OUT/payload.md" arg &
  WAIT_PIDS+=("$!")
else
  echo "c-plan skipped (${SKIP_C_REASON:---only/--skip})" > "$OUT/c-plan.status"
fi

wait ${WAIT_PIDS[@]+"${WAIT_PIDS[@]}"}

# ---------------------------------------------------------------------------
# Cross-refutation (opt-in). Each leg is handed the OTHER legs' plans — never
# its own, never told which model produced which — and asked to attack them.
# Anonymized as PLAN 1 / PLAN 2 in payload order; provider labels reattach
# only at synthesis, where they are signal rather than contamination.
# ---------------------------------------------------------------------------
REFUTE_RAN=""
if [[ -n "$REFUTE" ]]; then
  OK_LEGS=()
  for leg in a b c; do
    [[ -f "$OUT/$leg-plan.status" ]] && grep -q ' ok ' "$OUT/$leg-plan.status" && OK_LEGS+=("$leg")
  done
  if (( ${#OK_LEGS[@]} < 2 )); then
    echo "note: --refute needs at least two surviving plans; only ${#OK_LEGS[@]} — skipping refutation" >&2
  else
    REFUTE_RAN=1
    REFUTE_PIDS=()
    for leg in "${OK_LEGS[@]}"; do
      payload="$OUT/$leg-refute-payload.md"
      {
        printf -- '--- BRIEF ---\n\n'
        cat "$OUT/brief.md"
        if [[ -f "$OUT/context.md" ]]; then
          printf -- '\n--- CONTEXT (grounding pack) ---\n\n'
          cat "$OUT/context.md"
        fi
        n=0
        for other in "${OK_LEGS[@]}"; do
          [[ "$other" == "$leg" ]] && continue
          n=$(( n + 1 ))
          printf -- '\n--- PLAN %d ---\n\n' "$n"
          cat "$OUT/$other-plan.md"
        done
      } > "$payload"
      case "$leg" in
        a)
          RA_DIR="$(leg_workdir a-refute)"
          run_leg a-refute "$RA_DIR" "$QUORUM_A_CMD" "$PROMPTS/refute-plan.md" "$payload" stdin "$QUORUM_A_REFUTE_SCHEMA" &
          REFUTE_PIDS+=("$!") ;;
        b)
          RB_DIR="$(leg_workdir b-refute)"
          run_leg b-refute "$RB_DIR" "$QUORUM_B_CMD --output-schema $QUORUM_B_REFUTE_SCHEMA" "$PROMPTS/refute-plan.md" "$payload" &
          REFUTE_PIDS+=("$!") ;;
        c)
          RC_DIR="$(leg_workdir c-refute)"
          run_leg c-refute "$RC_DIR" "$QUORUM_C_CMD" "$PROMPTS/refute-plan.md" "$payload" arg &
          REFUTE_PIDS+=("$!") ;;
      esac
    done
    wait ${REFUTE_PIDS[@]+"${REFUTE_PIDS[@]}"}
  fi
fi

[[ -n "$SCRATCH_ROOT" ]] && rm -rf "$SCRATCH_ROOT"

# ---------------------------------------------------------------------------
# Manifest — records the grounding mode and the pack's size and hash, so a
# reader can always tell why a run's plans were concrete or abstract without
# re-deriving it.
# ---------------------------------------------------------------------------
{
  echo "# quorum manifest"
  echo "brief:     ${BRIEF_BYTES}B sha256:$BRIEF_SHA"
  echo "sources:   ${BRIEF_SRCS[*]}"
  echo "grounding: $GROUND_MODE"
  if [[ -n "$CONTEXT" ]]; then
    echo "context:   ${CONTEXT_BYTES}B sha256:$CONTEXT_SHA (cap ${QUORUM_CONTEXT_MAX_BYTES}B)"
  fi
  echo "draft:     $([[ -n "$DRAFT" ]] && echo "withheld ($DRAFT → withheld-draft.md, never shown to legs)" || echo none)"
  echo "objectives: $([[ -n "$OBJECTIVES" ]] && echo 'ON — council framings layered per leg; cross-provider attribution WAIVED for this run' || echo off)"
  echo "refute:    $([[ -n "$REFUTE_RAN" ]] && echo ran || { [[ -n "$REFUTE" ]] && echo "requested but skipped (<2 surviving plans)" || echo "not requested"; })"
  echo "timeout:   ${QUORUM_TIMEOUT}s per leg"
  echo
  echo "legs:"
  for f in "$OUT"/*.status; do echo "  $(cat "$f")"; done
  echo
  echo "cmds:"
  echo "  A: $QUORUM_A_CMD${QUORUM_A_SCHEMA:+ --json-schema <$QUORUM_A_SCHEMA>}"
  echo "  B: $QUORUM_B_CMD --output-schema $QUORUM_B_SCHEMA"
  echo "  C: $QUORUM_C_CMD"
} | tee "$OUT/manifest.txt"

# Count status files whose one line records success (`grep -l` lists each
# matching file once). Refute statuses count too; a dead refute leg is a
# caveat, not a run failure, so the floor below only checks plan legs.
OK_PLANS=0
for leg in a b c; do
  [[ -f "$OUT/$leg-plan.status" ]] && grep -q ' ok ' "$OUT/$leg-plan.status" && OK_PLANS=$(( OK_PLANS + 1 ))
done
(( OK_PLANS == 0 )) && { echo "all legs failed" >&2; exit 1; }
(( OK_PLANS < 3 )) && echo "note: only $OK_PLANS/3 plans returned — report accordingly" >&2

echo "$OUT"
