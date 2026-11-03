#!/usr/bin/env bash
#
# herdr-legs.sh — optional live-pane instrumentation for fan-out leg runners.
#
# Sourced, never executed. Every function here is a no-op when herdr is not
# running, so the caller needs no `if` around the call sites — only around the
# one decision that actually differs (whether to open a tab at all).
#
#   . "$(dirname "$0")/herdr-legs.sh"
#   if herdr_live; then HERDR_TAB="$(herdr_tab_open "triad·$STAMP" "$REPO_ROOT")"; fi
#
# ---------------------------------------------------------------------------
# WHAT THIS DOES AND DELIBERATELY DOES NOT DO
# ---------------------------------------------------------------------------
# Does: gives each leg its own live terminal pane tailing that leg's log, and
# reports semantic agent state (working / idle / blocked) into herdr's agent
# sidebar so a 10-minute fan-out stops being a blank screen.
#
# Does NOT: move leg execution into the panes. The legs stay exactly where they
# were — background jobs of the calling shell — and the panes only watch their
# logs. This is a deliberate scope limit, not an unfinished one:
#
#   1. Persistence is already free. herdr's whole premise is that a pane's
#      process survives lid-close, network drop, and detach. A fan-out started
#      from inside a herdr pane ALREADY has that for its legs, because they are
#      children of a shell that herdr is keeping alive. Moving execution into
#      sibling panes would buy nothing and would put the run's structured
#      output (`codex --output-schema`, `claude --json-schema`) behind a TUI
#      scrape instead of a plain stdout redirect.
#   2. `herdr pane run` types its command into the pane's interactive shell
#      rather than exec'ing it (verified 2026-08-06: it returns in ~6ms while
#      the command is still running, and the pane's shell prompt reappears
#      afterwards). Anything with quoting in it is a hazard there. Every call
#      below passes a single already-quoted token for that reason.
#
# So the legs keep their timeouts, their exit codes, their .status files and
# their manifest. This file is pure observability bolted alongside.
#
# ---------------------------------------------------------------------------
# THE ONE NON-OBVIOUS SEMANTIC — READ BEFORE CHANGING A --until
# ---------------------------------------------------------------------------
# `herdr pane report-agent --state` accepts idle|working|blocked|unknown. There
# is no `done` on the WAY IN. But herdr surfaces a reported `idle` that followed
# a `working` as `done` on the way OUT — `herdr pane get` returns
# `"agent_status":"done"`, and `herdr agent wait --until done` matches it.
#
# Verified live 2026-08-06 on a scratch workspace:
#   report --state working  → pane get: agent_status "working"
#   report --state idle     → pane get: agent_status "done"
#   agent wait --until idle → {"error":{"code":"timeout"}}, rc=1   (never matches)
#   agent wait --until done → rc=0, returns agent_info               (matches)
#
# Report `idle`. Wait on `done`. They are the same event under two names, and
# waiting on the name you reported is the failure mode.
# ---------------------------------------------------------------------------

# True only when this shell is genuinely inside a live herdr pane. All three
# checks matter: HERDR_ENV/HERDR_PANE_ID are injected by herdr into panes it
# launches (verified 2026-08-06 — a pane created via `herdr pane split` sees
# HERDR_ENV=1, HERDR_PANE_ID, and HERDR_SOCKET_PATH without any --env), and the
# binary can be absent even when a stale env var survived a shell export.
herdr_live() {
  [ "${HERDR_ENV:-}" = "1" ] || return 1
  [ -n "${HERDR_PANE_ID:-}" ] || return 1
  [ -n "${HERDR_SOCKET_PATH:-}" ] || return 1
  command -v herdr >/dev/null 2>&1 || return 1
  [ "${TRIAD_HERDR:-1}" != "0" ] || return 1   # explicit opt-out
}

# Every call is best-effort. A herdr socket that went away mid-run must never
# take the fan-out down with it — the review is the deliverable, the panes are
# scenery. Callers therefore never check these return codes.
#
# NEVER write `command herdr` here. Not a style preference — it silently breaks
# the whole integration, and the failure looks like something else entirely.
#
# Under macOS's stock bash 3.2.57 (which is what `#!/usr/bin/env bash` resolves
# to on this machine), the `command` builtin in front of an EXTERNAL binary lets
# bash skip the fork and exec that binary in place of the current shell. Inside
# a backgrounded shell function that means the function is REPLACED mid-body:
# every statement after the call is silently skipped and the job exits 0, so it
# reads as success. A trailing `|| true` does not prevent it.
#
# Verified 2026-08-06, backgrounded-function shape, one job per line:
#   command echo hi                 → next line ran     (builtin, not exec'd)
#   command herdr pane list         → next line SKIPPED
#   command herdr pane report-agent → next line SKIPPED
#   command git --version           → next line SKIPPED (not herdr-specific)
#   herdr pane report-agent         → next line ran
#
# Cost of getting this wrong, measured on the real script: all three legs
# reported `working`, then vanished before `run_leg` was ever called. No status
# files, no logs, no error — just "all legs failed" after one second.
#
# `command` was there to bypass a shell function or alias named `herdr`. That
# is a real hazard in an interactive shell and a non-hazard here: this file is
# only ever sourced by a bash script, which inherits no interactive functions
# (verified 2026-08-06: `type -a herdr` inside a script resolves straight to
# /opt/homebrew/bin/herdr, and `declare -F herdr` is empty).
_herdr() {
  herdr "$@" >/dev/null 2>&1
  return 0
}

# Pull one field out of a herdr JSON response. python3 is already a hard
# dependency of herdr's own Claude integration hook, so requiring it here adds
# no new prerequisite. Prints nothing on any failure, which every caller treats
# as "herdr bookkeeping unavailable, carry on".
_herdr_field() {
  local path="$1"
  python3 -c '
import json, sys
try:
    node = json.load(sys.stdin)["result"]
except Exception:
    sys.exit(0)
for key in sys.argv[1].split("."):
    if not isinstance(node, dict) or key not in node:
        sys.exit(0)
    node = node[key]
print(node if isinstance(node, str) else "")
' "$path" 2>/dev/null
}

# Open a dedicated tab in the CURRENT workspace and echo "<tab_id> <pane_id>".
#
# A tab, not a new workspace: the operator's workspaces are their projects
# (one per repo), and a fan-out is an episode inside a project rather than a
# new one. --no-focus is not politeness, it is the point — the run is watchable
# but it must not steal the cursor out from under whatever the operator is
# doing while it runs.
herdr_tab_open() {
  local label="$1" cwd="$2" out tab pane
  out="$(herdr tab create --label "$label" --cwd "$cwd" --no-focus 2>/dev/null)" || return 1
  tab="$(printf '%s' "$out"  | _herdr_field 'tab.tab_id')"
  pane="$(printf '%s' "$out" | _herdr_field 'root_pane.pane_id')"
  [ -n "$tab" ] && [ -n "$pane" ] || return 1
  printf '%s %s\n' "$tab" "$pane"
}

# Split $1 downward and echo the new pane id. Used to turn the tab's single
# root pane into one pane per leg. --ratio is left at the default: with three
# legs the second split lands inside the lower half and the thirds come out
# close enough that hand-tuning ratios would just be a number to maintain.
herdr_pane_add() {
  local from="$1" cwd="$2" out pane
  out="$(herdr pane split "$from" --direction down --cwd "$cwd" --no-focus 2>/dev/null)" || return 1
  pane="$(printf '%s' "$out" | _herdr_field 'pane.pane_id')"
  [ -n "$pane" ] || return 1
  printf '%s\n' "$pane"
}

# Point a pane at a leg's log. The log file is created by the caller before
# this runs; `tail -F` (capital, follow-by-name) is used anyway so a pane
# started microseconds early waits for the file instead of dying on it.
#
# The command reaches the pane's shell as typed text, so it is deliberately
# short and free of quoting: a bare `tail -F <path>`. Paths under $TMPDIR/triad
# are timestamped and contain no spaces.
herdr_watch() {
  local pane="$1" logfile="$2"
  _herdr pane run "$pane" tail -F "$logfile"
}

# Name the pane so the border label reads `a-architecture` rather than the
# shell's cwd. Only visible with `show_agent_labels_on_pane_borders = true`,
# but harmless without it.
herdr_label() {
  _herdr pane rename "$1" "$2"
}

# Report leg lifecycle state into the agent sidebar.
#   herdr_state <pane> <leg-name> working|idle|blocked ["message"]
#
# --source namespaces this reporter so it cannot fight herdr's built-in agent
# detection or its Claude integration hook over the same pane. --seq is
# deliberately omitted: it exists to order reports racing in from independent
# reporters, and every report here is issued sequentially from one process.
herdr_state() {
  local pane="$1" leg="$2" state="$3" message="${4:-}"
  [ -n "$pane" ] || return 0
  if [ -n "$message" ]; then
    _herdr pane report-agent "$pane" --source triad --agent "$leg" --state "$state" --message "$message"
  else
    _herdr pane report-agent "$pane" --source triad --agent "$leg" --state "$state"
  fi
}

# Hand the pane's lifecycle authority back to herdr's own detection. Without
# this a finished leg's pane keeps `triad` as its state owner for as long as
# the pane exists, and anything the operator later runs there shows up under a
# stale agent label.
herdr_release() {
  local pane="$1" leg="$2"
  [ -n "$pane" ] || return 0
  _herdr pane release-agent "$pane" --source triad --agent "$leg"
}

# Fan-out runs take minutes; the operator will have moved on. This is the whole
# reason the integration is worth having. `--sound done` vs `request` maps onto
# herdr's own idle-vs-blocked vocabulary, and with `ui.toast.delivery = "system"`
# in config.toml it surfaces as a real OS notification rather than an in-app
# toast the operator has to already be looking at herdr to see.
herdr_notify() {
  local title="$1" body="$2" sound="${3:-done}"
  _herdr notification show "$title" --body "$body" --sound "$sound"
}

herdr_tab_close() {
  [ -n "${1:-}" ] || return 0
  _herdr tab close "$1"
}
