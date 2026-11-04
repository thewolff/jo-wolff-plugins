#!/bin/sh
# evals/fixtures/fake-ctx.sh — the `ctx` the SessionStart scenarios spawn (through CTX_WATCH_CTX),
# so no scenario touches a real daemon. Prints the fixture named by FAKE_CTX_STATUS for
# `ctx daemon status --format json` (with every `last_run_at_ms` set to now, so the capture's date
# never makes core_refresh look stale) and the index-mode fixture for `ctx index mode …`.
# FAKE_CTX_FIXTURES is the plugin's test/fixtures directory.
set -eu
now_ms=$(( $(date +%s) * 1000 ))
case "${1:-} ${2:-}" in
  "daemon status") sed "s/\"last_run_at_ms\": [0-9]*/\"last_run_at_ms\": ${now_ms}/g" "${FAKE_CTX_FIXTURES}/${FAKE_CTX_STATUS}" ;;
  "index mode") cat "${FAKE_CTX_FIXTURES}/ctx-index-mode.txt" ;;
  *) echo "fake ctx: unexpected argv: $*" >&2; exit 2 ;;
esac
