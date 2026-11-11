# coordinator

Habits for a session that coordinates other sessions and subagents: briefing, checking what comes
back, relaying the owner's decisions, and keeping a record. The plugin is one skill, `coordinator`,
and it adds no hooks.

## What it covers

The skill is written from a long run in which one session coordinated several peer sessions and
subagents for one owner. It covers how to brief a worker, how to read what comes back, how to relay
the owner's decisions without changing them, what a peer session cannot do, which actions the agent
may not take on its own, how to keep the record, and how to treat work that is approved but not
started.

## When it applies

It loads on demand, matched against its description, when a session starts or messages other
sessions or subagents and relays their results to the human. A session that does its own work and
delegates nothing does not need it.

## Install

On Claude Code:

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install coordinator@jo-wolff-plugins
```

The skill runs as `/coordinator:coordinator`.

## No hooks

Nothing runs on its own. No hook, script, or OMP extension ships with it, so there is nothing to
fail open and no state directory.

## Developing

```
cd plugins/coordinator && node --test
```

## Changes in 0.1.0

First release: the `coordinator` skill. See [CHANGELOG.md](CHANGELOG.md).
