---
name: {{name}}
description: {{description}}
---

# {{title}}

(What the skill does, in one paragraph: the situation it is for, what the agent does, what the
person sees.)

## Steps

1. (The first step, with the exact command in backticks.)
2. (The next.)

## When this can't run

(One bullet per way this skill's commands fail, each saying what the agent does and what the
person can do. The repository test bar requires this section in every skill and agent text, and
requires every deny or block text in the hooks to name a command in backticks, for one reason: a
person stopped by a hook, or an agent whose skill failed, reads one line and knows the way out.)

- The command printed `{{name}} <event> failed open: <why>`: the hook let the call through without
  its check; the line is also in `${XDG_STATE_HOME:-~/.local/state}/{{name}}/errors.log`. Tell
  the person once; do not treat the allowed call as checked.
- The script is missing (`no such file`): the plugin is not installed where `CLAUDE_PLUGIN_ROOT`
  points. Tell the person; do the step by hand if it can be done by hand, and say that you did.
