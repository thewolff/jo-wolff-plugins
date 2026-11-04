# Vendored from newdle-claude-plugins plugins/newdle/lib/leg-runner.sh at commit 28e7356 (2026-11-04); owned patch: line 210 banner check consumes head output (pipefail/SIGPIPE); otherwise byte-identical below this line.
# leg-runner.sh — shared leg-runner machinery for the cross-provider fan-out
# skills (triad, quorum). Sourced, not executed; no shebang on purpose.
#
# Extracted 2026-08-14 from triad/scripts/triad-fanout.sh, whose copy had been
# authoritative while quorum/scripts/quorum-fanout.sh carried a duplicate under
# a KNOWN DEBT header. The precondition both headers named — one validated
# quorum run — was met 2026-08-13 (see quorum/SKILL.md). What lives here is
# exactly the surface that was byte-identical or trivially parametrizable
# between the two scripts: require_timeout, resolve_cli, and run_leg. The
# manifest writers, ok-counting, and per-skill preflight variants diverge
# structurally and deliberately stay in their callers.
#
# Contract — the sourcing script provides, before the first run_leg call:
#   OUT                 run directory; run_leg writes $OUT/<name>.{md,log,status}
#   LEG_TIMEOUT         per-leg seconds handed to `timeout`
#   LEG_SECTION_LABEL   label inserted between prompt and appended content
#                       ("--- DIFF ---" for triad; empty for quorum, whose
#                       payload files carry their own section labels)
#   LEG_ARGMODE_HINT    noun phrase for the ARG_MAX-refusal log line, e.g.
#                       "diff is too large" / "brief + context are too large"
#   LEG_CODEX_CMD_VAR   name of the caller's codex cmd variable, cited in the
#                       banner-assertion failure message (TRIAD_B_CMD / …)
# and a `timeout` function, which require_timeout defines. The library assumes
# the caller's `set -uo pipefail` and macOS bash 3.2 (no associative arrays,
# `${arr[@]+...}` guards on possibly-empty arrays are load-bearing under -u).

# ---------------------------------------------------------------------------
# `timeout` is GNU coreutils; macOS ships neither it nor `gtimeout` by default.
# Fails the run before staging anything rather than mid-fan-out.
# ---------------------------------------------------------------------------
require_timeout() {
  TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
  if [[ -z "$TIMEOUT_BIN" ]]; then
    cat >&2 <<'EOF'
`timeout` (GNU coreutils) not found. macOS ships no `timeout` by default.
Install it, then re-run:
  brew install coreutils   # provides `gtimeout`; this script also accepts `timeout`
EOF
    exit 1
  fi
  # Use whichever name resolved, in case only `gtimeout` is installed.
  timeout() { "$TIMEOUT_BIN" "$@"; }
}

# ---------------------------------------------------------------------------
# The five caller-scope variables in the header contract are read under the
# caller's `set -u`, and run_leg runs in a backgrounded subshell — an unbound
# variable there aborts that subshell with no visible error, and the caller's
# manifest reads "no status recorded" with nothing pointing at the cause.
# Callers invoke this once, after assigning the contract and before the first
# run_leg. SET is the bar, not non-empty: LEG_SECTION_LABEL is legitimately
# empty (quorum's payload files carry their own section labels).
# ---------------------------------------------------------------------------
require_leg_contract() {
  local v missing=""
  for v in OUT LEG_TIMEOUT LEG_SECTION_LABEL LEG_ARGMODE_HINT LEG_CODEX_CMD_VAR; do
    [[ -z "${!v+x}" ]] && missing="$missing $v"
  done
  if [[ -n "$missing" ]]; then
    echo "leg-runner contract unmet — unset:$missing (all five must be SET before run_leg; empty is fine for LEG_SECTION_LABEL)" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Some leg CLIs are single-binary installs that land off PATH in a non-login
# shell — `kimi` lands in ~/.kimi-code/bin (verified 2026-08-03: resolves in
# an interactive shell, `command -v kimi` from a plain Bash session does not).
# Probe the known install path(s) before giving up.
# ---------------------------------------------------------------------------
resolve_cli() {
  local bin="$1"; shift
  command -v "$bin" >/dev/null 2>&1 && return 0
  local p
  for p in "$@"; do
    if [[ -x "$p" ]]; then
      export PATH="$(dirname "$p"):$PATH"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# leg_has_body <file> — does this leg output actually carry a report?
#
# The only artifact check run_leg used to make was `[[ -s "$out" ]]`, so a leg
# that exited 0 having written a spinner remnant, a bare newline, or a one-line
# refusal counted as `ok` and the run reported success. Non-empty is not a
# report.
#
# The predicate has to hold for every shape the legs genuinely emit, and there
# are exactly two. Schema legs (triad a/b, quorum a/b/refute) return a JSON
# object against prompts/*.schema.json. Unstructured legs (triad c-cold-read,
# all three gaslight legs) are handed an output template made of ATX headings —
# see gaslight/prompts/challenge.md "## Output template" and
# triad/prompts/cold-read.md "## Output". So: an ATX heading line, or a brace
# pair, plus a floor on non-whitespace content.
#
# Rejected alternatives:
#   - Heading-only. Would fail every JSON leg, which is most of them.
#   - A marker string the prompt asks for. Per-caller, and a magic string the
#     model can silently stop emitting — the failure would look identical to
#     the one being fixed.
#   - Length alone. The floor cannot be raised past the smallest legitimate
#     report, and `{"status":"no_findings","findings":[]}` is 38 non-whitespace
#     bytes, so a length-only check has to sit under 38 and would pass a
#     100-byte refusal. It works only as the second half of a structural test.
#
# The floor is set below that 38 and above whitespace/ANSI residue and a bare
# `{}`. Overridable by a caller that knows its legs emit something terser.
# ---------------------------------------------------------------------------
: "${LEG_BODY_MIN_NONWS:=24}"

leg_has_body() {
  local f="$1"
  [[ -s "$f" ]] || return 1
  local nonws
  nonws=$(tr -d '[:space:]' < "$f" | wc -c | tr -d ' ')
  (( nonws >= LEG_BODY_MIN_NONWS )) || return 1
  # ATX markdown heading with actual text after it.
  grep -qE '^[[:space:]]*#{1,6}[[:space:]]+[^[:space:]]' "$f" && return 0
  # JSON object/array payload, possibly preceded by CLI preamble.
  grep -q '[{[]' "$f" && grep -q '[]}]' "$f" && return 0
  return 1
}

# ---------------------------------------------------------------------------
# run_leg <name> <workdir> <cmd> <prompt_file> [stdin_file] [delivery] [schema_file]
# Runs one leg under `timeout`, capturing stdout to $OUT/<name>.md, stderr to
# $OUT/<name>.log, and a one-line verdict to $OUT/<name>.status. Partial
# failure is survivable; the caller's manifest records what died.
# ---------------------------------------------------------------------------
run_leg() {
  local name="$1" workdir="$2" cmd="$3" prompt_file="$4" stdin_file="${5:-/dev/null}" delivery="${6:-stdin}" schema_file="${7:-}"
  local out="$OUT/$name.md" log="$OUT/$name.log"
  local start; start=$(date +%s)
  local rc

  # A schema can't ride in $cmd: the call sites expand it unquoted for word
  # splitting, and inline JSON has spaces inside its string values. Codex takes
  # a path (baked into the cmd or appended at the call site); claude takes the
  # schema *inline* — verified 2026-08-03, `claude --json-schema schema.json`
  # errors "not valid JSON" while the same schema passed inline returns a
  # conforming object.
  local -a schema_args=()
  if [[ -n "$schema_file" ]]; then
    if [[ -r "$schema_file" ]]; then
      schema_args=(--json-schema "$(cat "$schema_file")")
    else
      echo "$name: schema $schema_file unreadable; falling back to unstructured output" >&2
    fi
  fi

  if [[ "$delivery" == "arg" ]]; then
    # kimi's `-p` takes the prompt as an argv value, not stdin — verified
    # 2026-08-03: `kimi -p` with no value errors "argument missing" instead
    # of waiting on stdin. Compose the prompt in memory and pass it as the
    # final argument instead of piping. The `; printf x` / strip-x dance
    # preserves trailing newlines that a bare `$(cat ...)` would eat — the
    # arg-mode payload must be byte-identical to what the stdin legs get,
    # and it used to differ by exactly those stripped newlines.
    local prompt_text stdin_text
    prompt_text="$(cat "$prompt_file"; printf x)"; prompt_text="${prompt_text%x}"
    if [[ "$stdin_file" != /dev/null ]]; then
      stdin_text="$(cat "$stdin_file"; printf x)"; stdin_text="${stdin_text%x}"
      if [[ -n "$LEG_SECTION_LABEL" ]]; then
        prompt_text="${prompt_text}"$'\n\n'"${LEG_SECTION_LABEL}"$'\n\n'"${stdin_text}"
      else
        prompt_text="${prompt_text}"$'\n\n'"${stdin_text}"
      fi
    fi
    # Guard the OS argv limit (getconf ARG_MAX, verified 1048576 on this
    # machine) rather than let a large payload fail as a cryptic exec error.
    local max_arg=$(( $(getconf ARG_MAX 2>/dev/null || echo 262144) / 2 ))
    if (( ${#prompt_text} > max_arg )); then
      echo "$name skipped: prompt ${#prompt_text}B exceeds arg-mode limit (${max_arg}B)" > "$OUT/$name.status"
      echo "prompt length ${#prompt_text} exceeds half of ARG_MAX ($max_arg); not attempting the call — $LEG_ARGMODE_HINT for this leg's CLI to take as an argument" > "$log"
      return
    fi
    ( cd "$workdir" && timeout "$LEG_TIMEOUT" $cmd ${schema_args[@]+"${schema_args[@]}"} "$prompt_text" ) > "$out" 2> "$log"
    rc=$?
  else
    {
      cat "$prompt_file"
      if [[ "$stdin_file" != /dev/null ]]; then
        if [[ -n "$LEG_SECTION_LABEL" ]]; then
          printf '\n\n%s\n\n' "$LEG_SECTION_LABEL"
        else
          printf '\n\n'
        fi
        cat "$stdin_file"
      fi
    } | ( cd "$workdir" && timeout "$LEG_TIMEOUT" $cmd ${schema_args[@]+"${schema_args[@]}"} ) > "$out" 2> "$log"
    rc=$?
  fi

  local elapsed=$(( $(date +%s) - start ))

  # Trap 2 beside the caller's codex cmd definition: a codex leg that starts
  # without network runs fine and returns output written blind to anything it
  # needed to fetch. The banner is the only cheap signal, so assert it rather
  # than let a silent regression pass as a green leg. Anchor the assertion to
  # the startup banner block (top of stderr, line-exact) — codex echoes the
  # entire prompt-and-evidence into the same log, so an unanchored grep is
  # satisfied by a target that merely MENTIONS the banner string, and the
  # assertion would pass with the network off.
  local netfail=""
  if [[ "$cmd" == *codex* ]] && ! head -n 40 "$log" 2>/dev/null | grep '^[[:space:]]*sandbox: read-only (network access enabled)[[:space:]]*$' >/dev/null; then
    netfail=1
  fi

  if   (( rc == 124 )); then echo "$name timeout ${elapsed}s"
  elif (( rc != 0 ));   then echo "$name failed rc=$rc (${elapsed}s) — see $name.log"
  elif [[ -n "$netfail" ]]; then
    echo "$name failed (${elapsed}s) — codex banner does not read 'sandbox: read-only (network access enabled)'; the leg had no network. See $name.log and the $LEG_CODEX_CMD_VAR comment." >&2
    echo "$name failed: codex sandbox banner shows no network access (${elapsed}s) — see $name.log"
  elif [[ ! -s "$out" ]]; then echo "$name empty (${elapsed}s) — the leg exited 0 and wrote nothing at all; see $name.log"
  elif ! leg_has_body "$out"; then
    # Distinct from `empty` on purpose: the leg DID write, so the log will not
    # look like a crash, and the caller's ok-count must still exclude it. Same
    # path as any other failed leg — detection and reporting only.
    echo "$name no-report (${elapsed}s) — wrote $(wc -c < "$out" | tr -d ' ')B but no report body (no markdown heading, no JSON payload). See $name.md and $name.log." >&2
    echo "$name no-report (${elapsed}s) — wrote $(wc -c < "$out" | tr -d ' ')B of non-report output; see $name.md and $name.log"
  else echo "$name ok ${elapsed}s"
  fi > "$OUT/$name.status"
}
