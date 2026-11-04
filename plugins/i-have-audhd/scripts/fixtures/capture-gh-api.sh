#!/bin/sh
# capture-gh-api.sh — re-capture the `gh api` outputs scripts/gh-cache-fill.mjs is tested against.
# Run by hand from this directory (never by node --test): it calls GitHub for real.
#   sh capture-gh-api.sh
# Writes gh-api-<case>.{stdout,stderr,exit}.txt for a PR, an issue, a 404, and a no-auth run,
# plus CAPTURED.txt naming the date and gh version.
set -u
cd "$(dirname "$0")"
JQ='{number: .number, title: .title, pull_request: (.pull_request != null)}'
cap() { gh api --cache 1h "repos/cli/cli/issues/$2" --jq "$JQ" > "gh-api-$1.stdout.txt" 2> "gh-api-$1.stderr.txt"; echo $? > "gh-api-$1.exit.txt"; }
cap pr 1
cap issue 14935
cap 404 999999999
env -i PATH=/usr/bin:/bin HOME="$(mktemp -d)" "$(command -v gh)" api repos/cli/cli/issues/1 --jq "$JQ" > gh-api-noauth.stdout.txt 2> gh-api-noauth.stderr.txt; echo $? > gh-api-noauth.exit.txt
printf 'captured %s on %s by capture-gh-api.sh: `gh api --cache 1h repos/cli/cli/issues/<n> --jq <JQ>` for a PR (1), an issue (14935), a 404 (999999999), and the no-auth run under env -i with an empty HOME; gh version: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(uname -sm)" "$(gh --version | head -1)" > CAPTURED.txt
cat CAPTURED.txt
