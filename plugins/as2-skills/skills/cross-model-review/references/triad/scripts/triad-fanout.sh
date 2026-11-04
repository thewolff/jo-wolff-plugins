#!/usr/bin/env bash
#
# triad — fan a diff out to three independently-trained models.
#
#   ./triad-fanout.sh [base-ref] [--ticket path/to/ticket.md]
#   ./triad-fanout.sh --multi [base-ref] [--only r1,r2] [--skip r1,r2] [--ticket ...]
#
#   --multi reviews every git repo one level under the shipyard root's repos/
#   directory whose merge-base diff against its own origin/main (or base-ref,
#   if one is given) is non-empty. Legs B/C receive one concatenated patch
#   with a/<repo>/-prefixed paths; leg A runs at the shipyard root.
#
# Isolation is enforced by the execution environment, not by prompting:
#   leg A  runs in the repo root      → full context (AGENTS.md, .ai/, decision log)
#   leg B  runs in a scratch dir      → diff + ticket only, no repo access
#   leg C  own empty scratch dir      → diff via prompt arg, tools with nothing to find
#
# Legs run in parallel. Partial failure is survivable; the manifest records what died.
#
# The leg-runner machinery (timeout preflight, resolve_cli, run_leg with its
# ARG_MAX guard and codex banner assertion) lives in the shared library
# sourced below, extracted 2026-08-14 once quorum had a validated run — the
# precondition the old KNOWN DEBT header here named.

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
#     rather than a hardcoded ID. The original draft's leg B default,
#     `gpt-5.6-codex`, did not match any configured model on this machine
#     (verified 2026-08-03: `~/.codex/config.toml` has `gpt-5.6-terra`) —
#     it looks like an invented string. Fewer hardcoded IDs, less rot.
#   - Exception since 2026-10-12: leg B passes `-m gpt-6-sol` (Jo's review
#     rule; see the comment above TRIAD_B_CMD below), so the bullet above
#     holds for leg C only while that rule stands.
#   - Leg C's CLI changed from a generic `llm` invocation (unusable out of
#     the box — no kimi/moonshot model was registered) to the native Kimi
#     Code CLI, verified working on this machine 2026-08-03. See SKILL.md
#     "Leg C setup" for the prerequisite and why it's a real prerequisite,
#     not a default every teammate already has.
# ---------------------------------------------------------------------------
#
# Both legs below pin an explicit high reasoning/thinking effort. This is
# load-bearing, not tuning: on a real 1026-line/18-file run, leg B returned
# `{"status":"no_findings","findings":[]}` in 30s while legs A and C (318s,
# 435s) found 6 and 11 issues on the same diff. It was NOT a diff-reading
# failure — leg B's own log showed it read the entire diff.patch via several
# `rg`/`sed` tool calls first. The `codex exec` log line `reasoning effort:
# low` matched `~/.codex/config.toml`'s `model_reasoning_effort = "low"`
# default. Re-running the exact same sandbox dir and prompt with
# `-c model_reasoning_effort=high` (verified 2026-08-03, live `codex exec`
# call) surfaced 3 real high-severity findings instead. Leg A's default is
# a personal `~/.claude/settings.json` `"effortLevel": "medium"`, not "low"
# — that's the likely reason leg A wasn't visibly broken the same way — but
# a per-operator global setting isn't something this script should depend
# on either, so it's pinned explicitly here too.
: "${TRIAD_A_CMD:=claude -p --model opus --permission-mode plan --effort high}"
# Leg A's schema is passed inline by run_leg, not embedded here — see the note
# there. Set TRIAD_A_SCHEMA= (empty) to fall back to leg A's old markdown output.
# `=` not `:=`: the `:` form treats an exported-but-empty value as unset and
# re-applies the default, which silently broke that documented escape hatch.
: "${TRIAD_A_SCHEMA=$PROMPTS/architecture.schema.json}"
# --skip-git-repo-check is required, not optional: leg B's whole design is a
# sandbox dir holding diff.patch and ticket.md and nothing else, which is by
# definition not a git repo. Without it codex refuses to start ("Not inside a
# trusted directory") and the leg dies in under a second. Verified 2026-08-03.
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
# no effect. Accepted deliberately; see SKILL.md § "What leg B's sandbox still
# guarantees, and what it no longer does".
# Model pin (Jo, 2026-10-12, ledger inputs in-mv5qdfvskukmbk and
# in-mv5qfm8910ycjk; MIGRATION.md item 110): a review that routes to OpenAI
# runs on gpt-6-sol, never gpt-6-astra, until the review-cost framework
# workload lands or Jo says otherwise. Without `-m gpt-6-sol` this leg takes
# `~/.codex/config.toml`'s `model`, which is gpt-6-astra on Jo's machine.
# Ending the rule = deleting `-m gpt-6-sol` here.
: "${TRIAD_B_CMD:=codex exec -m gpt-6-sol --skip-git-repo-check -c permissions.netro.extends=\":read-only\" -c permissions.netro.network.enabled=true -c default_permissions=\"netro\" -c model_reasoning_effort=high --output-schema $PROMPTS/correctness.schema.json}"
# Leg C times out at the full TRIAD_TIMEOUT with an empty result on real diffs
# as small as 5-20KB, confirmed 2026-08-04 by reproducing outside the skill:
# `kimi -p` with no `-m` resolves `~/.kimi-code/config.toml`'s
# `default_model = "moonshot-ai/kimi-k3"`, which has `default_effort = "max"`
# and `[thinking] enabled = true` (`always_thinking` capability) — the model
# reasons exhaustively line-by-line (visible verbatim in c-cold-read.log,
# which is stderr) and never reaches a final answer on stdout within 600s.
# `-m moonshot-ai/kimi-k2.7-code-highspeed` (no forced max-effort thinking, same
# provider) completed the same 300KB diff that timed out with the default model
# in 100s with a valid cold-read review. This is a machine-local model alias —
# not every teammate's config.toml is guaranteed to have it — but `kimi` fails
# fast (~1s, non-zero rc) on an unconfigured `-m` alias with a clear error
# ("Model ... is not configured"), which run_leg already surfaces as a loud
# "failed rc=N" leg rather than a silent or slow one, so this degrades safely.
# Override TRIAD_C_CMD if your config.toml uses a different fast-model alias.
: "${TRIAD_C_CMD:=kimi -m moonshot-ai/kimi-k2.7-code-highspeed -p}"

: "${TRIAD_TIMEOUT:=600}"        # per-leg seconds
: "${TRIAD_MIN_LINES:=50}"       # gate: skip below this many changed lines
# Default lives outside the repo under review: diff.patch and model output
# can contain sensitive code, and an in-repo default risks an accidental
# commit of a working-tree scan or a stray `git add .`. Override to an
# in-repo path (e.g. `.triad`) if you'd rather keep runs local — see
# SKILL.md for the gitignore step that override requires.
: "${TRIAD_OUT_ROOT:=${TMPDIR:-/tmp}/triad}"

# Default excludes: generated ORM schema dumps (drizzle introspection output
# committed by newdle-web, newdle-api, kitchen). Verified 2026-08-03 on real
# repos: `git ls-files -- '*database/schema.ts' '*database/relations.ts'`
# matches exactly src/database/{schema,relations}.ts (newdle-api),
# src/shared/database/schema.ts (newdle-web), and
# src/server/database/{schema,relations}.ts (kitchen) — the five paths both
# triad runs so far needed manually excluded (70% and 85% of those diffs) —
# with no false-positive match on `.cursor/rules/database.mdc` or the
# `database/meta/*.json` snapshot files sitting next to them. Two globs cover
# five literal paths and any repo that follows the same convention later.
# Space-separated, not an array: TRIAD_DEFAULT_EXCLUDES is meant to be
# overridden from a plain env-var string (`export TRIAD_DEFAULT_EXCLUDES=...`),
# and none of these globs contain spaces, so word-splitting it is safe and
# keeps the override a one-liner instead of requiring an exported bash array.
# `=` not `:=`, same reason as TRIAD_A_SCHEMA above: exporting this empty is a
# supported way to disable the defaults, and the manifest already reports it.
#
# Test files are excluded for the same reason as the schema dumps: they are the
# largest and least architecturally informative part of a real diff, and they
# are what pushes leg A over TRIAD_TIMEOUT. Measured 2026-08-04 on newdle-api
# c3b5810 ("Staged writing edits: atomic promote, API v3, newsletter send
# fixes"): 19 files / 2693 lines / 154KB whole, 10 files / 1286 lines / 78KB
# with tests excluded — tests were 49% of the payload. At 154KB leg A hit the
# 600s cap and returned nothing; the two prior runs, at 54KB and 78KB,
# completed in 500s and 557s. Halving the payload puts leg A back inside the
# cap. Legs B and C read the same patch, so they benefit too.
#
# Suffix globs cover the four naming conventions in use (verified 2026-08-04 via
# `git ls-files` across newdle-web, newdle-api, kitchen: 534 .test.tsx/.test.ts
# in newdle-web plus 3 .spec.ts, 178 .test.ts plus 3 .test.js in newdle-api, 117
# in kitchen). `*__tests__/*` additionally catches fixtures and helpers inside
# test directories that carry no test suffix. Deliberately no leading-directory
# glob like `tests/*`: unquoted word-splitting happens in a shell that would
# filesystem-expand it against the cwd, turning one pathspec into a hundred
# literal paths. Every glob here starts with `*` so it reaches git intact.
# If the tests are what you actually want reviewed, pass --no-default-excludes.
: "${TRIAD_DEFAULT_EXCLUDES=*database/schema.ts *database/relations.ts *.test.ts *.test.tsx *.test.js *.spec.ts *__tests__/*}"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
BASE="main"
BASE_SET=""
TICKET=""
MULTI=""
ONLY_CSV=""
SKIP_CSV=""
EXCLUDES=()
EXPLICIT_EXCLUDE_PATTERNS=()
NO_DEFAULT_EXCLUDES=""
COMMITTED_ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ticket) TICKET="$2"; shift 2 ;;
    --force)  TRIAD_MIN_LINES=0; shift ;;
    # Repeatable. Keeps machine-generated files out of the diff: an ORM
    # introspection dump can be 85% of the changed lines and none of the
    # reviewable surface, and leg C reads the raw patch with no repo to
    # tell noise from signal.
    --exclude) EXCLUDES+=(":(exclude)$2"); EXPLICIT_EXCLUDE_PATTERNS+=("$2"); shift 2 ;;
    # Opt out of TRIAD_DEFAULT_EXCLUDES entirely — e.g. if the ORM schema
    # file itself is what changed and you actually want it reviewed.
    --no-default-excludes) NO_DEFAULT_EXCLUDES=1; shift ;;
    # Restore the old commit-only semantics ($BASE...HEAD), ignoring
    # the working tree — e.g. reviewing a pushed branch exactly as a
    # teammate would see it on a PR.
    --committed-only) COMMITTED_ONLY=1; shift ;;
    # Review every repo one level under <shipyard>/repos/ whose merge-base
    # diff vs its own origin/main is non-empty. No branch-name matching:
    # cross-repo work legitimately rides differently-named branches per repo
    # (observed in practice), so "differs from its own origin/main" is the
    # only invariant that holds.
    --multi) MULTI=1; shift ;;
    # Comma-separated repo directory names; only meaningful with --multi.
    --only) ONLY_CSV="$2"; shift 2 ;;
    --skip) SKIP_CSV="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) BASE="$1"; BASE_SET=1; shift ;;
  esac
done

# Applied after arg parsing so --no-default-excludes can suppress it and
# explicit --exclude values are always included regardless. A silent
# exclusion is worse than no exclusion — DEFAULT_EXCLUDE_PATTERNS (unprefixed,
# human-readable) feeds both the stderr note below and the manifest, so a
# reader can always see what was filtered without re-deriving it from EXCLUDES.
DEFAULT_EXCLUDE_PATTERNS=()
if [[ -z "$NO_DEFAULT_EXCLUDES" && -n "$TRIAD_DEFAULT_EXCLUDES" ]]; then
  # Intentionally unquoted: word-split the space-separated glob list (see the
  # TRIAD_DEFAULT_EXCLUDES comment above for why this is safe here).
  DEFAULT_EXCLUDE_PATTERNS=($TRIAD_DEFAULT_EXCLUDES)
  for pattern in "${DEFAULT_EXCLUDE_PATTERNS[@]}"; do
    EXCLUDES+=(":(exclude)$pattern")
  done
fi

if [[ -z "$MULTI" && ( -n "$ONLY_CSV" || -n "$SKIP_CSV" ) ]]; then
  echo "--only/--skip require --multi" >&2; exit 1
fi

if [[ -n "$MULTI" ]]; then

# -------------------------------------------------------------------------
# Multi-repo discovery. The script may be invoked from inside any child
# repo, so walk up from cwd to the nearest directory whose repos/ holds at
# least one git repo — no hardcoded workspace path. Override with
# TRIAD_SHIPYARD_ROOT for unusual layouts.
# -------------------------------------------------------------------------
SHIPYARD_ROOT="${TRIAD_SHIPYARD_ROOT:-}"
if [[ -z "$SHIPYARD_ROOT" ]]; then
  d="$PWD"
  while [[ "$d" != "/" ]]; do
    for r in "$d"/repos/*/; do
      if [[ -e "$r.git" ]]; then SHIPYARD_ROOT="$d"; break 2; fi
    done
    d="$(dirname "$d")"
  done
fi
if [[ -z "$SHIPYARD_ROOT" || ! -d "$SHIPYARD_ROOT/repos" ]]; then
  echo "--multi: no shipyard root (a directory whose repos/ contains git repos) found above $PWD" >&2
  exit 1
fi

# Each repo diffs against its own origin/main (or the explicit base-ref, if
# one was passed — looked up per repo). A shared branch-name convention is
# deliberately NOT assumed: real cross-repo work has been observed riding
# differently-named branches in different repos.
MULTI_BASE="origin/main"
[[ -n "$BASE_SET" ]] && MULTI_BASE="$BASE"

# Bash 3.2 has no associative arrays; per-repo facts ride parallel indexed
# arrays sharing one index.
REPO_NAMES=(); REPO_DIRS=(); REPO_RANGES=(); REPO_MBS=(); REPO_HEADS=()
REPO_LINES=(); REPO_FILESN=(); REPO_EXCL=()
SKIPPED_CLEAN=(); SKIPPED_NOREF=()
CHANGED_LINES=0; CHANGED_FILES=0; UNTRACKED_COUNT=0
for dir in "$SHIPYARD_ROOT"/repos/*/; do
  [[ -e "$dir.git" ]] || continue
  name="$(basename "$dir")"
  if [[ -n "$ONLY_CSV" && ",$ONLY_CSV," != *",$name,"* ]]; then continue; fi
  if [[ -n "$SKIP_CSV" && ",$SKIP_CSV," == *",$name,"* ]]; then continue; fi
  if ! git -C "$dir" rev-parse --verify --quiet "$MULTI_BASE" >/dev/null; then
    SKIPPED_NOREF+=("$name"); continue
  fi
  mb="$(git -C "$dir" merge-base "$MULTI_BASE" HEAD 2>/dev/null)" || {
    SKIPPED_NOREF+=("$name"); continue; }
  if [[ -n "$COMMITTED_ONLY" ]]; then range="$MULTI_BASE...HEAD"; else range="$mb"; fi
  lines=$(git -C "$dir" diff --numstat "$range" -- . ${EXCLUDES[@]+"${EXCLUDES[@]}"} | awk '{a+=$1; d+=$2} END {print a+d+0}')
  filesn=$(git -C "$dir" diff --name-only "$range" -- . ${EXCLUDES[@]+"${EXCLUDES[@]}"} | wc -l | tr -d ' ')
  if (( filesn == 0 )); then SKIPPED_CLEAN+=("$name"); continue; fi
  raw=$(git -C "$dir" diff --numstat "$range" -- . | awk '{a+=$1; d+=$2} END {print a+d+0}')
  untr=$(git -C "$dir" ls-files --others --exclude-standard -- . ${EXCLUDES[@]+"${EXCLUDES[@]}"} | wc -l | tr -d ' ')
  UNTRACKED_COUNT=$(( UNTRACKED_COUNT + untr ))
  REPO_NAMES+=("$name"); REPO_DIRS+=("$dir"); REPO_RANGES+=("$range")
  REPO_MBS+=("$(git -C "$dir" rev-parse --short "$mb")")
  REPO_HEADS+=("$(git -C "$dir" rev-parse --short HEAD)")
  REPO_LINES+=("$lines"); REPO_FILESN+=("$filesn"); REPO_EXCL+=("$(( raw - lines ))")
  CHANGED_LINES=$(( CHANGED_LINES + lines ))
  CHANGED_FILES=$(( CHANGED_FILES + filesn ))
done

if [[ -n "$ONLY_CSV" ]]; then
  IFS=',' read -r -a only_arr <<< "$ONLY_CSV"
  for o in ${only_arr[@]+"${only_arr[@]}"}; do
    [[ -d "$SHIPYARD_ROOT/repos/$o" ]] || \
      echo "warning: --only repo '$o' does not exist under repos/" >&2
  done
fi

# Scope is printed before the gate and before any leg spawns, so the
# operator sees exactly what a run would review before money is spent.
echo "triad multi: repos vs $MULTI_BASE (shipyard root: $SHIPYARD_ROOT)"
if (( ${#REPO_NAMES[@]} > 0 )); then
  for i in "${!REPO_NAMES[@]}"; do
    scope_line="  ${REPO_NAMES[$i]}: ${REPO_LINES[$i]} lines / ${REPO_FILESN[$i]} files"
    (( ${REPO_EXCL[$i]} > 0 )) && scope_line="$scope_line (${REPO_EXCL[$i]} lines excluded)"
    echo "$scope_line"
  done
fi
(( ${#SKIPPED_CLEAN[@]} > 0 )) && echo "  skipped (no diff vs $MULTI_BASE): ${SKIPPED_CLEAN[*]}"
(( ${#SKIPPED_NOREF[@]} > 0 )) && echo "  skipped ('$MULTI_BASE' unresolvable): ${SKIPPED_NOREF[*]}"
if (( ${#REPO_NAMES[@]} == 0 )); then
  echo "--multi: no repo under repos/ differs from $MULTI_BASE — nothing to review" >&2
  exit 2
fi

if (( UNTRACKED_COUNT > 0 )); then
  echo "note: $UNTRACKED_COUNT untracked file(s) across included repos are NOT in the diff — \`git add\` them to include." >&2
fi

# Downstream, REPO_ROOT doubles as leg A's workdir and the anchor for a
# relative TRIAD_OUT_ROOT; in multi mode both are the shipyard root.
REPO_ROOT="$SHIPYARD_ROOT"
cd "$REPO_ROOT"

else # single-repo (original) path

REPO_ROOT="$(git rev-parse --show-toplevel)" || { echo "not a git repo" >&2; exit 1; }
cd "$REPO_ROOT"

git rev-parse --verify "$BASE" >/dev/null 2>&1 || {
  echo "base ref '$BASE' not found" >&2; exit 1; }

# Diff against the merge base rather than `$BASE...HEAD`, so the review covers
# uncommitted work as well as commits. The three-dot form compares two commits
# and is blind to the working tree, which meant the skill could only review
# code already committed — the opposite of when a review is most useful. Naming
# the merge base explicitly keeps the "changes on this branch, not changes that
# landed on main meanwhile" semantics that three-dot gave.
#
# Still invisible: untracked files. `git diff` never reports them, so a brand
# new file shows up only once it is `git add`ed. Reported below so the operator
# isn't misled about coverage.
MERGE_BASE="$(git merge-base "$BASE" HEAD)" || {
  echo "no merge base between '$BASE' and HEAD" >&2; exit 1; }
if [[ -n "$COMMITTED_ONLY" ]]; then
  DIFF_RANGE="$BASE...HEAD"
else
  DIFF_RANGE="$MERGE_BASE"
fi

UNTRACKED_COUNT=$(git ls-files --others --exclude-standard -- . ${EXCLUDES[@]+"${EXCLUDES[@]}"} | wc -l | tr -d ' ')
if (( UNTRACKED_COUNT > 0 )); then
  echo "note: $UNTRACKED_COUNT untracked file(s) are NOT in the diff — \`git add\` them to include." >&2
fi

fi # end single-repo vs --multi discovery

# ---------------------------------------------------------------------------
# Preflight — fail before staging anything rather than mid-fan-out.
# ---------------------------------------------------------------------------

# Both from lib/leg-runner.sh: `timeout` resolution (GNU coreutils; macOS
# ships neither `timeout` nor `gtimeout` by default) and the off-PATH CLI
# probe used for kimi below.
require_timeout

MISSING_CLI=()
command -v claude >/dev/null 2>&1 || MISSING_CLI+=("claude (leg A) — https://docs.claude.com/en/docs/claude-code")
command -v codex  >/dev/null 2>&1 || MISSING_CLI+=("codex (leg B) — https://github.com/openai/codex")
resolve_cli kimi "$HOME/.kimi-code/bin/kimi" \
  || MISSING_CLI+=("kimi (leg C) — curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash")
if (( ${#MISSING_CLI[@]} > 0 )); then
  echo "Missing required CLI(s), install/auth before running triad:" >&2
  printf '  - %s\n' "${MISSING_CLI[@]}" >&2
  exit 1
fi

# Leg C's provider/model is the piece most likely to be unconfigured even
# with the binary present. Check it and skip the leg with a clear reason
# instead of letting it fail mid-fan-out with a cryptic log.
SKIP_C=""
if ! kimi provider list >/dev/null 2>&1; then
  echo "note: \`kimi provider list\` failed — leg C has no configured model/provider." >&2
  echo "      Run \`kimi login\`, then \`kimi doctor\` to confirm. Running with legs A+B only." >&2
  SKIP_C=1
fi

# ---------------------------------------------------------------------------
# Gate
# ---------------------------------------------------------------------------
# `${EXCLUDES[@]+"${EXCLUDES[@]}"}` (not the plainer `"${EXCLUDES[@]}"`) is
# required on macOS's stock bash: it ships 3.2.57 (verified 2026-08-03 via
# `bash --version`), which errors expanding an empty array under `set -u`.
# Do not simplify this back to the plain form.
#
# In multi mode the totals were already summed per repo during discovery;
# only the single-repo path computes them here.
if [[ -z "$MULTI" ]]; then

CHANGED_LINES=$(git diff --numstat "$DIFF_RANGE" -- . ${EXCLUDES[@]+"${EXCLUDES[@]}"} | awk '{a+=$1; d+=$2} END {print a+d+0}')
CHANGED_FILES=$(git diff --name-only "$DIFF_RANGE" -- . ${EXCLUDES[@]+"${EXCLUDES[@]}"} | wc -l | tr -d ' ')

# Report the reduction so a silent exclusion never passes as "no findings" —
# the operator sees exactly how many lines were kept out and why.
if (( ${#EXCLUDES[@]} > 0 )); then
  RAW_LINES=$(git diff --numstat "$DIFF_RANGE" -- . | awk '{a+=$1; d+=$2} END {print a+d+0}')
  EXCLUDED_LINES=$(( RAW_LINES - CHANGED_LINES ))
  if (( EXCLUDED_LINES > 0 )); then
    echo "triad: excluded $EXCLUDED_LINES lines ($RAW_LINES → $CHANGED_LINES) via:" >&2
    (( ${#DEFAULT_EXCLUDE_PATTERNS[@]} > 0 )) && \
      printf '  default: %s\n' "${DEFAULT_EXCLUDE_PATTERNS[*]}" >&2
    (( ${#EXPLICIT_EXCLUDE_PATTERNS[@]} > 0 )) && \
      printf '  --exclude: %s\n' "${EXPLICIT_EXCLUDE_PATTERNS[*]}" >&2
  fi
fi

fi # end single-repo gate arithmetic

if (( CHANGED_LINES < TRIAD_MIN_LINES )); then
  cat >&2 <<EOF
Diff is $CHANGED_LINES lines across $CHANGED_FILES files — below the $TRIAD_MIN_LINES-line gate.
A triad review costs three model calls and a synthesis pass. Not worth it here.
Use --force if you disagree.
EOF
  exit 2
fi

# ---------------------------------------------------------------------------
# Stage
# ---------------------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
# TRIAD_OUT_ROOT is absolute by default (outside the repo); a relative
# override resolves against REPO_ROOT for the old in-repo behavior.
if [[ "$TRIAD_OUT_ROOT" = /* ]]; then
  OUT_ROOT="$TRIAD_OUT_ROOT"
else
  OUT_ROOT="$REPO_ROOT/$TRIAD_OUT_ROOT"
fi
if [[ -n "$MULTI" ]]; then
  OUT="$OUT_ROOT/multi-$STAMP"
else
  OUT="$OUT_ROOT/$(basename "$REPO_ROOT")-$STAMP"
fi
SANDBOX="$OUT/sandbox"
mkdir -p "$OUT" "$SANDBOX"

A_PROMPT="$PROMPTS/architecture.md"
if [[ -z "$MULTI" ]]; then
git diff "$DIFF_RANGE" -- . ${EXCLUDES[@]+"${EXCLUDES[@]}"} > "$OUT/diff.patch"
git diff --name-only "$DIFF_RANGE" -- . ${EXCLUDES[@]+"${EXCLUDES[@]}"} > "$OUT/files.txt"
else
# One concatenated patch. `--src-prefix`/`--dst-prefix` bake the repo name
# into every path inside the patch itself (verified live 2026-08-03:
# `diff --git a/newdle-api/src/... b/newdle-api/src/...`), so a leg citing
# a finding cannot produce a path that's ambiguous across repos. The
# `### repo:` header is a human/model courtesy on top, not the mechanism.
: > "$OUT/diff.patch"
: > "$OUT/files.txt"
for i in "${!REPO_NAMES[@]}"; do
  name="${REPO_NAMES[$i]}"; dir="${REPO_DIRS[$i]}"; range="${REPO_RANGES[$i]}"
  {
    printf '### repo: %s (vs %s, merge-base %s, head %s — %s lines / %s files)\n' \
      "$name" "$MULTI_BASE" "${REPO_MBS[$i]}" "${REPO_HEADS[$i]}" \
      "${REPO_LINES[$i]}" "${REPO_FILESN[$i]}"
    git -C "$dir" diff --src-prefix="a/$name/" --dst-prefix="b/$name/" \
      "$range" -- . ${EXCLUDES[@]+"${EXCLUDES[@]}"}
  } >> "$OUT/diff.patch"
  git -C "$dir" diff --name-only "$range" -- . ${EXCLUDES[@]+"${EXCLUDES[@]}"} \
    | sed "s|^|$name/|" >> "$OUT/files.txt"
done

# Leg A's stock prompt says "review `git diff main...HEAD`, work it out from
# the repo" — wrong at the shipyard root, where the root repo's own diff is
# orchestration files, not the change. Prepend a run-specific preamble naming
# each included repo and its own base rather than editing the shared prompt.
A_PROMPT="$OUT/architecture-multi.md"
A_EXCL=""
for p in ${DEFAULT_EXCLUDE_PATTERNS[@]+"${DEFAULT_EXCLUDE_PATTERNS[@]}"} \
         ${EXPLICIT_EXCLUDE_PATTERNS[@]+"${EXPLICIT_EXCLUDE_PATTERNS[@]}"}; do
  A_EXCL="$A_EXCL ':(exclude)$p'"
done
{
  echo "# Multi-repo run — overrides the diff instruction in the base prompt below"
  echo
  echo "This change spans multiple git repos under \`repos/\` in this workspace. Ignore the"
  echo "base prompt's single-repo \"git diff main...HEAD\" instruction; instead review, for"
  echo "each repo listed, its diff against that repo's own base (run from this directory):"
  echo
  for i in "${!REPO_NAMES[@]}"; do
    echo "- repos/${REPO_NAMES[$i]}: \`git -C repos/${REPO_NAMES[$i]} diff ${REPO_RANGES[$i]} -- .$A_EXCL\` (${REPO_LINES[$i]} lines / ${REPO_FILESN[$i]} files vs $MULTI_BASE)"
  done
  echo
  echo "Cite every finding as <repo>/<path>:<line> — e.g. newdle-api/src/routes/x.ts:42 —"
  echo "so a path is never ambiguous across repos. The seams BETWEEN these repos (contract"
  echo "mismatches, deploy-order hazards, one repo assuming another's unmerged change) are"
  echo "the highest-value findings in this mode and squarely in your lane."
  echo
  echo "---"
  echo
  cat "$PROMPTS/architecture.md"
} > "$A_PROMPT"
fi

if [[ -n "$TICKET" && -f "$TICKET" ]]; then
  cp "$TICKET" "$SANDBOX/ticket.md"
else
  # No ticket → leg B has no spec to score against. Record it; SKILL.md says
  # drop leg B rather than let it invent the intent.
  echo "NO_TICKET_PROVIDED" > "$SANDBOX/ticket.md"
fi
cp "$OUT/diff.patch" "$SANDBOX/diff.patch"

# ---------------------------------------------------------------------------
# Legs — run_leg comes from lib/leg-runner.sh; these knobs are its contract.
# The `--- DIFF ---` label is triad-specific: the appended file is a raw
# patch, so run_leg inserts the section marker between prompt and diff.
# ---------------------------------------------------------------------------
LEG_TIMEOUT="$TRIAD_TIMEOUT"
LEG_SECTION_LABEL="--- DIFF ---"
LEG_ARGMODE_HINT="diff is too large"
LEG_CODEX_CMD_VAR="TRIAD_B_CMD"
require_leg_contract

if [[ -n "$MULTI" ]]; then
  echo "triad multi: $CHANGED_LINES lines / $CHANGED_FILES files across ${#REPO_NAMES[@]} repo(s) vs $MULTI_BASE → $OUT"
else
  echo "triad: $CHANGED_LINES lines / $CHANGED_FILES files vs $BASE → $OUT"
fi

# A — full repo context. Prompt only; the agent reads the repo itself.
# In multi mode REPO_ROOT is the shipyard root and A_PROMPT the generated
# preamble. Running there is consistency, not new capability: even in
# single-repo runs `claude -p` has no sandbox fence and has been observed
# walking to sibling repos unaided — the root cwd just makes its cited
# paths line up with the repos/<name>/ form the other legs' patch uses.
run_leg a-architecture "$REPO_ROOT" "$TRIAD_A_CMD" "$A_PROMPT" /dev/null stdin "$TRIAD_A_SCHEMA" &
PID_A=$!

# B — sandbox dir containing diff.patch + ticket.md and nothing else.
run_leg b-correctness  "$SANDBOX"   "$TRIAD_B_CMD" "$PROMPTS/correctness.md" &
PID_B=$!

WAIT_PIDS=("$PID_A" "$PID_B")

if [[ -n "$SKIP_C" ]]; then
  echo "c-cold-read skipped (leg C provider/model unavailable — see note above)" > "$OUT/c-cold-read.status"
else
  # C — no repo, nothing worth finding even though the CLI itself is a
  # tool-using agent. Its own empty scratch dir, outside the $OUT tree, so
  # a curious tool call has nothing nearby to discover — walking up from
  # $OUT would land on diff.patch and the other legs' output, so leg C does
  # not run there. The diff arrives as the -p argument, not on disk.
  C_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/triad-c.XXXXXX")"
  run_leg c-cold-read "$C_SCRATCH" "$TRIAD_C_CMD" "$PROMPTS/cold-read.md" "$OUT/diff.patch" arg &
  PID_C=$!
  WAIT_PIDS+=("$PID_C")
fi

wait "${WAIT_PIDS[@]}"
[[ -n "${C_SCRATCH:-}" ]] && rm -rf "$C_SCRATCH"

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------
{
  echo "# triad manifest"
  if [[ -n "$MULTI" ]]; then
    echo "mode:    multi$([[ -z "$COMMITTED_ONLY" ]] && echo '  (includes uncommitted tracked changes)' || echo '  (committed only)')"
    echo "base:    $MULTI_BASE, resolved per repo"
    echo "untracked (excluded from diff): $UNTRACKED_COUNT"
    echo "scope:   $CHANGED_LINES lines / $CHANGED_FILES files across ${#REPO_NAMES[@]} repo(s)"
    echo "ticket:  ${TICKET:-none}"
    echo
    # Per-repo record: a reader must be able to tell exactly what was and
    # was not reviewed, per repo, without re-deriving it.
    echo "repos:"
    for i in "${!REPO_NAMES[@]}"; do
      echo "  ${REPO_NAMES[$i]}: base $MULTI_BASE@${REPO_MBS[$i]} head ${REPO_HEADS[$i]} — ${REPO_LINES[$i]} lines / ${REPO_FILESN[$i]} files, ${REPO_EXCL[$i]} lines excluded"
    done
    (( ${#SKIPPED_CLEAN[@]} > 0 )) && echo "  not reviewed (no diff vs $MULTI_BASE): ${SKIPPED_CLEAN[*]}"
    (( ${#SKIPPED_NOREF[@]} > 0 )) && echo "  not reviewed ('$MULTI_BASE' unresolvable): ${SKIPPED_NOREF[*]}"
  else
    echo "base:    $BASE"
    echo "range:   $DIFF_RANGE$([[ -z "$COMMITTED_ONLY" ]] && echo '  (includes uncommitted tracked changes)' || echo '  (committed only)')"
    echo "untracked (excluded from diff): $UNTRACKED_COUNT"
    echo "head:    $(git rev-parse --short HEAD)"
    echo "scope:   $CHANGED_LINES lines / $CHANGED_FILES files"
    echo "ticket:  ${TICKET:-none}"
  fi
  echo
  echo "excludes:"
  if (( ${#DEFAULT_EXCLUDE_PATTERNS[@]} > 0 )); then
    echo "  default: ${DEFAULT_EXCLUDE_PATTERNS[*]}"
  elif [[ -n "$NO_DEFAULT_EXCLUDES" ]]; then
    echo "  default: disabled (--no-default-excludes)"
  else
    echo "  default: none configured (TRIAD_DEFAULT_EXCLUDES empty)"
  fi
  if (( ${#EXPLICIT_EXCLUDE_PATTERNS[@]} > 0 )); then
    echo "  --exclude: ${EXPLICIT_EXCLUDE_PATTERNS[*]}"
  else
    echo "  --exclude: none"
  fi
  echo
  echo "legs:"
  for f in "$OUT"/*.status; do echo "  $(cat "$f")"; done
  echo
  echo "cmds:"
  echo "  A: $TRIAD_A_CMD${TRIAD_A_SCHEMA:+ --json-schema <$TRIAD_A_SCHEMA>}"
  echo "  B: $TRIAD_B_CMD"
  echo "  C: $TRIAD_C_CMD"
} | tee "$OUT/manifest.txt"

# Count status files whose one line records success. `grep -l` lists each
# matching file once; `-c` (match count per file) was piled on top of it in
# an earlier draft, which is redundant with `-l` and reads as if it were
# counting occurrences rather than files.
OK_COUNT=$(grep -l ' ok ' "$OUT"/*.status 2>/dev/null | wc -l | tr -d ' ')
(( OK_COUNT == 0 )) && { echo "all legs failed" >&2; exit 1; }
(( OK_COUNT < 3 )) && echo "note: only $OK_COUNT/3 legs returned — report accordingly" >&2

echo "$OUT"
