// register.mjs — the away band, a Claude Code mod (hooks/hooks.json `modules` points here).
//
// What it does:
//   - while this session is away, the band above the prompt (the `AbovePrompt` render site, drawn
//     in the terminal and in Claude Desktop) carries the digest: `AWAY 40m · 3 held · lunch` in
//     bold gold, `2 on fire came through · the rest wait for you` under it, the held items as a
//     numbered list (at most 10 rows, then `+N more`), and a Back button; the prompt box suggests
//     `away 40m — type back` (`$.prompt.suggest`, Tab takes it);
//   - the Back button cannot run a hook, so it runs `node mods/band/act.mjs --session <id> back`,
//     which leaves a `back-requested` marker the hooks honour on the next event (the next prompt,
//     whatever it says, or the agent's next stop), and suggests `back` in the prompt box; until
//     then the band says `Back pressed · the next prompt ends the hold`;
//   - after `back` the hold's digest stays on screen as a checklist (checklist.json, written by
//     lib/back.mjs endHold): `BACK · 3 to act on` in blue, a Done button per row (struck and
//     dim once done; Undo puts it back) and a Clear button; the band clears when every row is
//     done or on Clear. Done is cosmetic: the agent is told nothing;
//   - the data is this session's state, read out of process by `node mods/band/query.mjs
//     --session <id>` (read-only); the band refreshes at session start, after each prompt is
//     submitted (so `brb` and `back` show at once), at each main turn's start and end, after a
//     button press, and every 5 s while away or while a checklist is up. Between those, while
//     home with no checklist, the only poll is `$.fs.exists` on away.json once a second, which
//     starts a query when the file appears. `session.end` cancels both timers;
//   - `$.ui.status` is the fallback only: where the band's render site is never asked to draw
//     (a host with no band), the one-line badge of 0.3.x is set under the prompt; the moment the
//     band renders once, the line is cleared and stays clear.
//
// How it fails: every hook catches its own error, logs one dim transcript line (`$.ui.log`) and
// passes the event on with `next(e)`; a query, an action or a home probe that fails clears the
// band and logs its error once per distinct message. The scripts run with a 5 s timeout and
// their faults come back as `{ ok: false, error }`; the timers' callbacks catch everything;
// nothing throws past here.
//
// Rules this file keeps for `claude plugin validate`: every mods API call is spelled `$.ns.method`,
// `$` is passed only to top-level functions of this file, imports are relative, no node builtins,
// `$.env.get` takes a string literal.

import { actArgv, awayPath, emptySnapshot, queryArgv, readResult, readSnapshot, statusText, suggestionText } from "./data.mjs";
import { bandModel, bandTree } from "./view.mjs";

const PROBE_MS = 1000;
const POLL_MS = 5000;
const SCRIPT_TIMEOUT_MS = 5000;

let snapshot = emptySnapshot();
let viewKey = null;
let status = undefined;
let suggested = null;
let lastError = null;
let inFlight = false;
let bandSeen = false;
let ticked = false;
let stateEnv = { xdgStateHome: undefined, home: undefined };
let timers = [];

function pathUnder(root, rel) {
  return `${String(root).replace(/[\\/]+$/, "")}/${rel}`;
}

function errorText(err) {
  return String(err?.message ?? err ?? "unknown error");
}

/** One dim transcript line for a fault; never throws. */
async function logFault($, where, err) {
  try {
    await $.ui.log(`brb band: ${where}: ${errorText(err)}`);
  } catch {
    // nowhere to log
  }
}

/** Set or clear the fallback status line when its text changed. */
function applyStatus($, text) {
  if (text === status) return;
  status = text;
  $.ui.status(text ?? undefined);
}

/** Propose `text` for the empty prompt box, once per distinct text; a host with no prompt box, or one that refuses, is ignored. */
function suggest($, text) {
  if (text === suggested) return;
  suggested = text;
  try {
    Promise.resolve($.prompt.suggest({ text })).catch(() => {});
  } catch {
    // no prompt box
  }
}

/**
 * Keep the snapshot; redraw the band when what it would draw changed; propose the prompt-box
 * text while away; set the fallback line only where the band has never rendered (and not before
 * the first timer tick, so a host that draws the band never flashes the line at start); a new
 * error is logged once, named by `where`.
 */
function applySnapshot($, next, where = "query") {
  snapshot = next;
  const key = JSON.stringify(bandModel(snapshot));
  if (key !== viewKey) {
    viewKey = key;
    $.ui.invalidate("ui.render");
  }
  if (bandSeen) applyStatus($, undefined);
  else if (ticked) applyStatus($, statusText(snapshot) ?? undefined);
  const text = suggestionText(snapshot);
  if (text === null) suggested = null;
  else suggest($, text);
  if (!next.ok && next.error !== lastError) {
    lastError = next.error;
    logFault($, where, next.error);
  }
  if (next.ok) lastError = null;
}

/** Run query.mjs once and apply what it printed. Concurrent calls collapse into the one in flight. */
async function refresh($) {
  if (inFlight) return snapshot;
  inFlight = true;
  try {
    const sessionId = await $.session.id();
    const script = pathUnder($.plugin.root, "mods/band/query.mjs");
    const run = await $.process.run(["node", ...queryArgv(script, sessionId)], { timeoutMs: SCRIPT_TIMEOUT_MS });
    applySnapshot($, readSnapshot(run.stdout));
  } catch (err) {
    applySnapshot($, { ok: false, error: errorText(err) });
  } finally {
    inFlight = false;
  }
  return snapshot;
}

/** Run act.mjs with one verb, then refresh. A failed action is logged, and the band redrawn from the query either way. */
async function act($, verb, index) {
  try {
    const sessionId = await $.session.id();
    const script = pathUnder($.plugin.root, "mods/band/act.mjs");
    const run = await $.process.run(["node", ...actArgv(script, sessionId, verb, index)], { timeoutMs: SCRIPT_TIMEOUT_MS });
    const result = readResult(run.stdout);
    if (!result.ok) throw new Error(result.error);
    if (verb === "back") suggest($, "back");
  } catch (err) {
    await logFault($, verb, err);
  }
  await refresh($);
}

/** The poll (every POLL_MS): a query while away or while a checklist is up, so the duration and the count move. */
async function pollTick($) {
  ticked = true;
  if (inFlight || !(snapshot.ok && (snapshot.away || snapshot.checklist))) return;
  await refresh($);
}

/**
 * The home probe (every PROBE_MS): one `$.fs.exists` on away.json, and a query only when it
 * appeared. A probe that throws (a session id or a path the host refuses) clears the band and is
 * logged once per distinct message, as a query fault is; it never rejects into the timer.
 */
async function probeTick($) {
  ticked = true;
  if (inFlight || (snapshot.ok && (snapshot.away || snapshot.checklist))) return;
  try {
    const path = awayPath({ ...stateEnv, sessionId: await $.session.id() });
    if (path && (await $.fs.exists(path))) await refresh($);
  } catch (err) {
    applySnapshot($, { ok: false, error: errorText(err) }, "probe");
  }
}

export function register(on, options) {
  on("session.start", async ($, e, next) => {
    try {
      stateEnv = { xdgStateHome: await $.env.get("XDG_STATE_HOME"), home: await $.env.get("HOME") };
      timers = [$.clock.every(PROBE_MS, () => probeTick($)), $.clock.every(POLL_MS, () => pollTick($))];
      await refresh($);
    } catch (err) {
      await logFault($, "session.start", err);
    }
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    try {
      if (!bandSeen) {
        bandSeen = true;
        applyStatus($, undefined);
      }
      if (e.props?.hasSurvey) return next(e);
      const model = bandModel(snapshot, { maxRows: e.props?.maxRows, bodyColumns: e.props?.bodyColumns });
      if (!model) return next(e);
      const ui = await $.ui.resolve(e);
      let theirs = null;
      try {
        theirs = (await next(e)) ?? null;
      } catch {
        theirs = null;
      }
      return bandTree(ui, model, {
        theirs,
        onBack: () => act($, "back"),
        onClear: () => act($, "clear"),
        onDone: (index) => act($, "done", index),
      });
    } catch (err) {
      await logFault($, "ui.render", err);
      return next(e);
    }
  });

  on("prompt.submit", async ($, e, next) => {
    // After `next` the engine has handled the prompt, settings hooks included (as PreToolUse runs
    // inside a tool.call's `next`), so `brb` has written away.json and `back` has removed it; were
    // a version to run them later, the home probe catches a `brb` within PROBE_MS and the poll a
    // `back` within POLL_MS.
    const result = await next(e);
    try {
      refresh($);
    } catch (err) {
      await logFault($, "prompt.submit", err);
    }
    return result;
  });

  on("turn.start", async ($, e, next) => {
    try {
      if (e.agentId === undefined) refresh($);
    } catch (err) {
      await logFault($, "turn.start", err);
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    try {
      if (e.agentId === undefined) await refresh($);
    } catch (err) {
      await logFault($, "turn.complete", err);
    }
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    try {
      for (const t of timers) t?.cancel?.();
      timers = [];
    } catch (err) {
      await logFault($, "session.end", err);
    }
    return next(e);
  });
}
