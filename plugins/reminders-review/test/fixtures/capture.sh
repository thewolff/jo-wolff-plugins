#!/bin/sh
# capture.sh — run by hand (never under node --test) to re-capture remindctl's output for the
# fixtures beside it. Read-only: `show` only. Titles are personal: replace them before committing.
#   sh test/fixtures/capture.sh <list>
set -u
list=${1:?usage: capture.sh <list>}
dir=$(dirname "$0")
remindctl show today --list "$list" --json > "$dir/remindctl-show-today.json"
remindctl show overdue --list "$list" --json > "$dir/remindctl-show-overdue.json"
remindctl show today --list "no-such-list-$$" --json > /dev/null 2> "$dir/remindctl-list-not-found.unavailable.txt"
echo "exit $? from the unknown-list capture (expected 1)"
