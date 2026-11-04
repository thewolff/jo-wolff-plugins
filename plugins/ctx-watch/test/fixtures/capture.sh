#!/usr/bin/env bash
# test/fixtures/capture.sh — re-capture the ctx fixtures from real runs. Run by hand; not part of
# `node --test`. Touches the real managed install READ-ONLY (two `CI=true` status reads) and does
# everything else on a throwaway data root it creates under $TMPDIR, stops, and leaves for you to
# delete (the path is printed). Needs ctx on PATH.
#
#   bash test/fixtures/capture.sh
#
# Stops on the first failure. Scrubs /Users/<you> → /Users/example and the throwaway root →
# /Users/example/.ctx before writing.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(mktemp -d "${HOME}/ctx-watch-capture.XXXXXX")"   # not under /tmp: ctx refuses a symlinked parent ("Not a directory")
scrub() { sed -e "s#${ROOT}#/Users/example/.ctx#g" -e "s#${HOME}#/Users/example#g"; }
echo "throwaway data root: $ROOT"

# Read-only against the real install.
CI=true ctx daemon status --format json | scrub >"$HERE/ctx-daemon-status.txt"
CI=true ctx index mode --format json | scrub >"$HERE/ctx-index-mode.txt"

# ctx missing: the shell's line.
(env -i PATH=/usr/bin:/bin ctx daemon status --format json 2>&1 || true) | scrub >"$HERE/ctx-daemon-status.unavailable.txt"
cp "$HERE/ctx-daemon-status.unavailable.txt" "$HERE/ctx-index-mode.unavailable.txt"
cp "$HERE/ctx-daemon-status.unavailable.txt" "$HERE/ctx-daemon-status-not-running.unavailable.txt"
cp "$HERE/ctx-daemon-status.unavailable.txt" "$HERE/ctx-daemon-status-semantic-budget-exhausted.unavailable.txt"
cp "$HERE/ctx-daemon-status.unavailable.txt" "$HERE/ctx-daemon-status-semantic-budget-exhausted-0300.unavailable.txt"
# ctx-daemon-status-semantic-budget-exhausted{,-0300}.txt are one-offs (2026-11-04 13:39 and 03:00,
# semantic_index budget_exhausted, which the daemon only shows between its budgeted runs); not recaptured here.

# Throwaway root: set up without a daemon, start one with the repair, kill it, read the status.
env -u CI ctx setup --data-root "$ROOT" --no-daemon --format json --progress none >/dev/null
env -u CI ctx index mode auto --data-root "$ROOT" --format json | scrub >"$HERE/ctx-index-mode-auto.txt"
PID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["daemon"]["pid"])' <"$HERE/ctx-index-mode-auto.txt")"
sleep 2
kill "$PID"
sleep 2
env -u CI ctx daemon status --data-root "$ROOT" --format json | scrub >"$HERE/ctx-daemon-status-not-running.txt"

# The repair refused under CI, with the daemon absent.
(CI=true ctx index mode auto --data-root "$ROOT" --format json 2>&1 || true) | scrub >"$HERE/ctx-index-mode-auto.unavailable.txt"

# Stop and leave the root in manual mode so nothing lingers.
env -u CI ctx index mode manual --data-root "$ROOT" --format json >/dev/null
echo "captured into $HERE; the throwaway root $ROOT is stopped (mode manual): delete it when you are done"
grep -l "$HOME" "$HERE"/*.txt && { echo "UNSCRUBBED PATHS ABOVE"; exit 1; } || echo "scrub: clean"
