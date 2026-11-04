// register.mjs — the away badge, a Claude Code mod (hooks/hooks.json `modules` points here).
//
// What it does:
//   - while this session is away, the plugin's status line under the prompt (`$.ui.status`, drawn
//     by the app as `⚠ brb: …`) reads `away since 10:42 AM (40m) · 12 held · say back`, so a person
//     typing into a session they left sees the hold before they send; home, the line is removed;
//   - the data is this session's away.json, read out of process by `node mods/badge/query.mjs
//     --session <id>` (read-only); the badge refreshes at session start, after each prompt is
//     submitted (so `brb` and `back` show at once), at each main turn's start and end, and once a
//     second while away. Between those, while home, the only poll is `$.fs.exists` on away.json
//     in this process, which starts a query when the file appears;
//   - where nothing draws (`claude -p`, no surface) nothing is shown: the hooks' own lines cover it.
//
// How it fails: every hook catches its own error, logs one dim transcript line (`$.ui.log`) and
// passes the event on with `next(e)`; a query that fails clears the badge and logs its error once
// per distinct message. The query runs with a 5 s timeout and its faults come back as
// `{ ok: false, error }`, never a throw past here.
//
// Rules this file keeps for `claude plugin validate`: every mods API call is spelled `$.ns.method`,
// `$` is passed only to top-level functions of this file, imports are relative, no node builtins,
// `$.env.get` takes a string literal.

import { awayPath, badgeText, emptySnapshot, queryArgv, readSnapshot } from "./data.mjs";

const POLL_MS = 1000;
const QUERY_TIMEOUT_MS = 5000;

let snapshot = emptySnapshot();
let shown = null;
let lastError = null;
let inFlight = false;
let draws = false;
let stateEnv = { xdgStateHome: undefined, home: undefined };

function pathUnder(root, rel) {
  return `${String(root).replace(/[\\/]+$/, "")}/${rel}`;
}

function errorText(err) {
  return String(err?.message ?? err ?? "unknown error");
}

/** One dim transcript line for a fault; never throws. */
async function logFault($, where, err) {
  try {
    await $.ui.log(`brb badge: ${where}: ${errorText(err)}`);
  } catch {
    // nowhere to log
  }
}

/** Keep the snapshot, and set or clear the status line when its text changed; a new error is logged once. */
function applySnapshot($, next) {
  snapshot = next;
  const text = badgeText(snapshot);
  if (text !== shown) {
    shown = text;
    $.ui.status(text ?? undefined);
  }
  if (!next.ok && next.error !== lastError) {
    lastError = next.error;
    logFault($, "query", next.error);
  }
  if (next.ok) lastError = null;
}

/** Run query.mjs once and apply what it printed. Concurrent calls collapse into the one in flight. */
async function refresh($) {
  if (inFlight) return snapshot;
  inFlight = true;
  try {
    const sessionId = await $.session.id();
    const script = pathUnder($.plugin.root, "mods/badge/query.mjs");
    const run = await $.process.run(["node", ...queryArgv(script, sessionId)], { timeoutMs: QUERY_TIMEOUT_MS });
    applySnapshot($, readSnapshot(run.stdout));
  } catch (err) {
    applySnapshot($, { ok: false, error: errorText(err) });
  } finally {
    inFlight = false;
  }
  return snapshot;
}

/** The poll: a query while away (the duration and the count move); while home, one `$.fs.exists` and a query only when away.json appeared. */
async function tick($) {
  if (inFlight) return;
  if (snapshot.ok && snapshot.away) {
    await refresh($);
    return;
  }
  const path = awayPath({ ...stateEnv, sessionId: await $.session.id() });
  if (path && (await $.fs.exists(path))) await refresh($);
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    try {
      draws = (e.surface ?? null) !== null;
      if (draws) {
        stateEnv = { xdgStateHome: await $.env.get("XDG_STATE_HOME"), home: await $.env.get("HOME") };
        $.clock.every(POLL_MS, () => tick($));
        await refresh($);
      }
    } catch (err) {
      await logFault($, "session.start", err);
    }
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    // After `next` the engine has handled the prompt, settings hooks included (as PreToolUse runs
    // inside a tool.call's `next`), so `brb` has written away.json and `back` has removed it; were
    // a version to run them later, the poll's probe catches up within POLL_MS.
    const result = await next(e);
    try {
      if (draws) refresh($);
    } catch (err) {
      await logFault($, "prompt.submit", err);
    }
    return result;
  });

  on("turn.start", async ($, e, next) => {
    try {
      if (draws && e.agentId === undefined) refresh($);
    } catch (err) {
      await logFault($, "turn.start", err);
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    try {
      if (draws && e.agentId === undefined) await refresh($);
    } catch (err) {
      await logFault($, "turn.complete", err);
    }
    return next(e);
  });
}
