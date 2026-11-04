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
`e2e/live-run.sh` is the nightly canary's live run.

## Changes in 0.1.0

First release.
