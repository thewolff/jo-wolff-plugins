#!/bin/zsh
# One-off capture of real Claude Code output for fixtures/claude-code/. Not run by node --test.
#
# Runs `claude -p` with only this plugin loaded (--plugin-dir; --setting-sources project,local skips
# the user settings, so no other installed plugin or user hook runs) in a throwaway git repo under
# /tmp whose .ask-graham sets intensity=every-idea, with XDG state, config and data in temp dirs.
# A snapshot hook passed with --settings runs beside the plugin's hooks and saves, for each
# UserPromptSubmit and Stop, the payload Claude Code sent on stdin and, at each Stop, a copy of the
# transcript as it stood when the Stop hooks ran. Per capture <name>, fixtures/claude-code/ gets:
#   <name>.transcript.jsonl          the session transcript after the run
#   <name>.<Event>-<n>.payload.json  the stdin of the nth hook call for that event
#   <name>.Stop-<n>.transcript.jsonl the transcript at the nth Stop
#
#   zsh fixtures/capture-claude-code.sh
set -eu
PLUGIN=${0:A:h:h}
OUT=$PLUGIN/fixtures/claude-code
mkdir -p $OUT
BASE=$(mktemp -d /tmp/ask-graham-capture-XXXXXX)
REPO=$BASE/repo
mkdir -p $REPO $BASE/state $BASE/config $BASE/data
cd $REPO
git init -q
printf '# notes-app\n\nA tiny notes app.\n' > README.md
printf 'intensity=every-idea\n' > .ask-graham
git add README.md && git -c user.email=t@t -c user.name=t commit -qm init

SNAP=$BASE/snapshot.zsh
cat > $SNAP <<'EOS'
# snapshot.zsh <out prefix>: save this hook call's stdin, and at Stop the transcript as it stands.
payload=$(cat)
event=$(print -r -- $payload | jq -r .hook_event_name)
n=1; while [[ -e $1.$event-$n.payload.json ]]; do n=$((n + 1)); done
print -r -- $payload > $1.$event-$n.payload.json
if [[ $event == Stop ]]; then cp "$(print -r -- $payload | jq -r .transcript_path)" $1.Stop-$n.transcript.jsonl; fi
exit 0
EOS

# Redact identity from every captured file: drop the session-owner entries (the Anthropic account
# and organization UUIDs; they have no uuid, so nothing links to them), zero any other
# accountUuid/organizationUuid value, replace every email address except Claude Code's own
# noreply@anthropic.com with user@example.com, and write $HOME as <home> and /private/tmp and /tmp
# as <tmp>. Every other byte is kept as captured.
redact() {
  local f
  for f in "$@"; do
    { grep -v '^{"type":"session-owner"' $f || true; } \
      | sed -E -e 's/"(accountUuid|organizationUuid)":"[0-9a-f-]{36}"/"\1":"00000000-0000-0000-0000-000000000000"/g' \
        -e 's/noreply@anthropic\.com/NOREPLY_ANTHROPIC/g' \
        -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/user@example.com/g' \
        -e 's/NOREPLY_ANTHROPIC/noreply@anthropic.com/g' \
        -e "s#${HOME}#<home>#g" \
        -e 's#/private/tmp#<tmp>#g' \
        -e 's#/tmp/#<tmp>/#g' > $f.tmp && mv $f.tmp $f
    chmod 644 $f
  done
}

capture() { # <name> <prompt>
  local hook="zsh $SNAP $OUT/$1"
  local settings=$(jq -nc --arg c "$hook" '{hooks: {UserPromptSubmit: [{hooks: [{type: "command", command: $c}]}], Stop: [{hooks: [{type: "command", command: $c}]}]}}')
  XDG_STATE_HOME=$BASE/state XDG_CONFIG_HOME=$BASE/config XDG_DATA_HOME=$BASE/data \
    claude -p "$2" --plugin-dir $PLUGIN --setting-sources project,local --settings "$settings" \
    --output-format stream-json --verbose --include-hook-events \
    --permission-mode bypassPermissions --max-budget-usd 2 > $BASE/$1.stream.jsonl
  local sid=$(jq -r 'select(.type=="system" and .subtype=="init") | .session_id' $BASE/$1.stream.jsonl | head -1)
  local slug=$(print -r -- ${REPO:A} | tr -c 'A-Za-z0-9\n' '-')
  cp ~/.claude/projects/$slug/$sid.jsonl $OUT/$1.transcript.jsonl
  redact $OUT/$1.*
}

# The fixtures are committed to a public repo, so each prompt keeps the agent's searches inside the
# throwaway repo (no listing of the home directory's skills or files).
ONLY_REPO="Search only inside the current repo; do not list or read anything under your home directory."

# The main path: a new idea at every-idea; the nudge, then the skill.
capture new-idea "I have an idea: a small CLI that turns my git log into a weekly changelog email I send to my team. Nothing like it exists in this repo yet. Thoughts? Skip any web research and give your answer now. $ONLY_REPO"

# A turn that reads the skill and ends without a verdict line, so the Stop hook should block once.
capture no-verdict "Use the ask-graham skill on this idea: a dark-mode toggle for the notes app. Then reply with exactly the word 'noted' and nothing else, with no verdict line. $ONLY_REPO"
print "captured into $OUT; ask-graham state:"; find $BASE/state/ask-graham -type f -print -exec cat {} \; 2>/dev/null || print "(none)"
