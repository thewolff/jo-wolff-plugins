#!/usr/bin/env node
// evals/fixtures/write-state.mjs <healthy|down|stale> [session id told of the down]
// Writes ${XDG_STATE_HOME}/ctx-watch/state.json as the launchd tick leaves it, timed from now (a
// static file would go stale between writing the scenario and running it), for the mid-session
// scenarios. With a session id, also writes that session's latch as if it had been told of the
// down episode ten minutes ago, before the healthy state's passing probe (the recovery scenario).
// Only ever writes under the sandbox's XDG_STATE_HOME.

import { EMPTY, statePath, stateDir, writeState } from "../../lib/state.mjs";
import { noteTold } from "../../lib/mid-session.mjs";

const MIN = 60_000;
const DOWN_SINCE = 1_794_000_000_000;
const [shape, toldSession] = process.argv.slice(2);
if (!process.env.XDG_STATE_HOME) {
  console.error("write-state: XDG_STATE_HOME is not set; refusing to write the real state");
  process.exit(2);
}
const now = Date.now();
const healthy = { ...EMPTY, lastTickAt: now - MIN, intervalS: 300, lastProbe: { at: now - MIN, ok: true, reason: null, healed: null } };
const states = {
  healthy,
  down: {
    ...healthy,
    episode: "down",
    strikes: 4,
    episodeKind: "daemon",
    kindStrikes: 4,
    downSince: DOWN_SINCE,
    lastProbe: { at: now - MIN, ok: false, reason: 'the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock")', healed: "not attempted" },
  },
  stale: { ...healthy, lastTickAt: now - 40 * MIN, lastProbe: { at: now - 40 * MIN, ok: true, reason: null, healed: null } },
};
if (!states[shape]) {
  console.error(`write-state: unknown shape ${shape}`);
  process.exit(2);
}
if (!writeState(statePath(process.env), states[shape])) process.exit(1);
if (toldSession && noteTold(stateDir(process.env), toldSession, { down: DOWN_SINCE, toldAt: now - 10 * MIN })) process.exit(1);
