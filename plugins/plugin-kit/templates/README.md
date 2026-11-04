# {{title}}

{{description}}

## Install

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install {{name}}@jo-wolff-plugins
```

## What it does

(One paragraph per hook and skill: the rule, the text it shows, the way out.)

## How it fails

Every hook runs under `lib/hook-runner.mjs` and exits 0 whatever happens; a fault is one line in
`${XDG_STATE_HOME:-~/.local/state}/{{name}}/errors.log` and a `systemMessage`. The full table is
[HOW-IT-FAILS.md](HOW-IT-FAILS.md). `test/hook-contract.test.mjs` proves the five fault inputs;
`evals/manifest.json` declares what each hook can answer and `{{scenario}}` is the first
scenario that proves it; `e2e/live-run.sh` runs every scenario for the nightly canary; the
`state` field of `.claude-plugin/plugin.json` names what the plugin keeps outside the worktree
and `scripts/prune.mjs` removes what is older than its retention.

## Changes in 0.1.0

First release.
