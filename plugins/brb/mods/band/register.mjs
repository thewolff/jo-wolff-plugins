// register.mjs — the away band, a Claude Code mod (hooks/hooks.json `modules` points here).
//
// What it does:
//   - while this session is away, the band above the prompt (the `AbovePrompt` render site, drawn
//     in the terminal and in Claude Desktop) carries the digest: `AWAY 40m · 3 held · lunch` in
//     bold gold, `2 on fire came through · the rest wait for you` under it, the held items as a
//     numbered list (at most 10 rows, then `+N more`), and a Back button; the prompt box suggests
//     `away 40m — type back` (`$.prompt.suggest`, Tab takes it);
//   - the Back button sends `back` as the person's own prompt: it runs `node mods/band/act.mjs
//     --session <id> back` (read-only: is this session away, since when?), and when it is, a
//     toast says `brb: Back pressed, ending the hold` and the press is pending until the session
//     is idle (now, or the running turn's `turn.complete`). Then act.mjs is asked again and, when
//     the same hold (same `since`) is still on, the mod calls `$.prompt.submit({ text: "back",
//     asUser: true })`, the same call the engine makes for a typed prompt, so
//     hooks/user-prompt-submit.mjs ends the hold exactly as for `back` typed. A hold that ended
//     (`back` typed meanwhile) or was replaced (a new `brb`) drops the press silently. The call
//     is never awaited (it resolves only once its turn starts). While the press is pending the
//     band says `Back pressed · ending the hold` and further presses do nothing; a failed query
//     does not release it, a query that sees the hold gone does. A refused or dropped submit
//     (`{ drop }`, or a rejection) shows `brb: Back failed: <reason>; type back` and the button
//     works again; one from an earlier conversation says nothing. Its `b` hotkey fires only
//     while the band has focus (ctrl+x tab), not from the prompt box;
//   - after `back` the hold's digest stays on screen as a checklist (checklist.json, written by
//     lib/back.mjs endHold): `BACK · 3 to act on` in blue, a Done button per row (struck and
//     dim once done; Undo puts it back) and a Clear button; the band clears when every row is
//     done or on Clear. Done is cosmetic: the agent is told nothing;
//   - the data is this session's state, read out of process by `node mods/band/query.mjs
//     --session <id>` (read-only); the band refreshes at session start, after each prompt is
//     submitted (so `brb` and `back` show at once), at each main turn's start and end, after a
//     button press, and every 5 s while away or while a checklist is up. Between those, while
//     home with no checklist, the only poll is `$.fs.exists` on away.json once a second, which
//     starts a query when the file appears. `session.end` cancels both timers and clears the band;
//   - lifecycle: `session.start` fires once (and after a hot reload), never after /clear, /resume
//     or /branch; those fire `session.end` and then `classic.SessionStart` with `source` `clear`,
//     `resume` or `fork`. Both start hooks call begin(), which cancels the timers, resets every
//     piece of session state (snapshot, band drawn, status line, suggestion), starts the timers
//     exactly once, and bumps a generation counter, so a query answer that belongs to the last
//     conversation is dropped. `startup` and `compact` are left alone: session.start covers
//     startup, and compaction keeps the conversation;
//   - `$.ui.status` is the fallback only: where the band's render site is never asked to draw
//     (a host with no band), the one-line badge of 0.3.x is set under the prompt; the moment the
//     band renders once in a conversation, the line is cleared and stays clear.
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

import { BACK_WORD, actArgv, awayPath, emptySnapshot, queryArgv, readResult, readSnapshot, statusText, suggestionText } from "./data.mjs";
import { bandModel, bandTree } from "./view.mjs";

const PROBE_MS = 1000;
const POLL_MS = 5000;
const SCRIPT_TIMEOUT_MS = 5000;
/** The most characters of a failure reason a toast carries. */
const REASON_MAX = 120;

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
let generation = 0;
/**
 * The pending Back press, or null: `{ since, phase }`, `since` the hold it was made for (from
 * act.mjs), `phase` pressed → waiting (for idle) → checking → sent. While it is set the band says
 * so and a second press sends nothing; it ends when a query sees that hold gone, or the press fails.
 */
let pendingBack = null;
/** A top-level turn is running (turn.start until turn.complete); a pending press waits for it. */
let turnRunning = false;

/** The sources of classic.SessionStart that begin a new conversation (the d.ts spelling: /branch reports `fork`). */
const NEW_CONVERSATION = ["clear", "resume", "fork"];

function pathUnder(root, rel) {
  return `${String(root).replace(/[\\/]+$/, "")}/${rel}`;
}

function errorText(err) {
  return String(err?.message ?? err ?? "unknown error");
}

/** A failure reason fit for one toast line: control characters and runs of space collapsed, at most REASON_MAX characters. */
function reasonText(err) {
  const text = errorText(err).replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
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

/** Show one toast; a host with no toast, or one that refuses, is ignored. */
function toast($, text) {
  try {
    Promise.resolve($.ui.toast(text)).catch(() => {});
  } catch {
    // no toast
  }
}

/**
 * A Back press that did not end the hold: logged, a toast with the reason, and the button live
 * again. Only for the press still pending; one from an earlier conversation, or one whose hold
 * already ended, says nothing.
 */
function backFailed($, intent, err) {
  if (pendingBack !== intent) return;
  pendingBack = null;
  logFault($, "back", err);
  toast($, `brb: Back failed: ${reasonText(err)}; type back`);
  applySnapshot($, snapshot);
}

/** Ask act.mjs whether this session is away: `{ away, since }`; throws when the action failed. */
async function checkAway($) {
  const sessionId = await $.session.id();
  const script = pathUnder($.plugin.root, "mods/band/act.mjs");
  const run = await $.process.run(["node", ...actArgv(script, sessionId, "back")], { timeoutMs: SCRIPT_TIMEOUT_MS });
  const result = readResult(run.stdout);
  if (!result.ok) throw new Error(result.error);
  return { away: result.away === true, since: result.since ?? null };
}

/**
 * Send `back` for the pending press when the session is idle; while a turn runs, wait for its
 * `turn.complete`. Before sending after a wait, act.mjs is asked again (`checked`, the answer the
 * press itself just got, spares that when nothing ran between): a hold that ended (`back` typed)
 * or was replaced (a new `brb`, another `since`) since the press drops the press without a word,
 * so a press never ends a hold it was not made for and never sends a `back` that finds no hold.
 * `$.prompt.submit` is not awaited (it resolves only once its turn starts); a `{ drop }` answer or a
 * rejection is a failed press.
 */
async function drainBack($, checked = null) {
  const intent = pendingBack;
  if (!intent || intent.phase !== "waiting" || turnRunning) return;
  intent.phase = "checking";
  let now = checked;
  try {
    now ??= await checkAway($);
  } catch (err) {
    backFailed($, intent, err);
    return;
  }
  if (pendingBack !== intent) return;
  if (!now.away || now.since !== intent.since) {
    pendingBack = null;
    applySnapshot($, snapshot);
    return;
  }
  if (turnRunning) {
    intent.phase = "waiting";
    return;
  }
  intent.phase = "sent";
  try {
    Promise.resolve($.prompt.submit({ text: BACK_WORD, asUser: true })).then(
      (r) => {
        if (r?.drop) backFailed($, intent, r.drop);
      },
      (err) => backFailed($, intent, err),
    );
  } catch (err) {
    backFailed($, intent, err);
  }
}

/**
 * Keep the snapshot; redraw the band when what it would draw changed; propose the prompt-box
 * text while away; set the fallback line only where the band has never rendered (and not before
 * the first timer tick, so a host that draws the band never flashes the line at start); a new
 * error is logged once, named by `where`.
 */
function applySnapshot($, next, where = "query") {
  // The press is done once a query sees its hold gone (home, or another hold). A failed query
  // proves nothing, so the press stays pending and a second press still sends nothing.
  if (pendingBack?.since && next.ok && (!next.away || next.since !== pendingBack.since)) pendingBack = null;
  const { backPressed: _shown, ...query } = next;
  snapshot = pendingBack ? { ...query, backPressed: true } : query;
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
  const gen = generation;
  inFlight = true;
  try {
    const sessionId = await $.session.id();
    const script = pathUnder($.plugin.root, "mods/band/query.mjs");
    const run = await $.process.run(["node", ...queryArgv(script, sessionId)], { timeoutMs: SCRIPT_TIMEOUT_MS });
    if (gen === generation) applySnapshot($, readSnapshot(run.stdout));
  } catch (err) {
    if (gen === generation) applySnapshot($, { ok: false, error: errorText(err) });
  } finally {
    if (gen === generation) inFlight = false;
  }
  return snapshot;
}

/**
 * Run act.mjs with one verb, then refresh. Back: one pending press at a time (a second press, or
 * one while the first waits, sends nothing); when act.mjs says the session is away, a toast and
 * `back` sent now or at the end of the running turn (drainBack); home, the press is dropped. A
 * failed action is logged (Back's also toasted), and the band redrawn from the query either way.
 */
async function act($, verb, index) {
  const gen = generation;
  if (verb === "back") {
    if (pendingBack) return;
    const intent = { since: null, phase: "pressed" };
    pendingBack = intent;
    applySnapshot($, snapshot);
    try {
      const checked = await checkAway($);
      if (pendingBack === intent) {
        if (checked.away) {
          intent.since = checked.since;
          intent.phase = "waiting";
          toast($, "brb: Back pressed, ending the hold");
          await drainBack($, checked);
        } else pendingBack = null;
      }
    } catch (err) {
      backFailed($, intent, err);
    }
  } else {
    try {
      const sessionId = await $.session.id();
      const script = pathUnder($.plugin.root, "mods/band/act.mjs");
      const run = await $.process.run(["node", ...actArgv(script, sessionId, verb, index)], { timeoutMs: SCRIPT_TIMEOUT_MS });
      const result = readResult(run.stdout);
      if (!result.ok) throw new Error(result.error);
    } catch (err) {
      await logFault($, verb, err);
    }
  }
  if (gen === generation) await refresh($);
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
  const gen = generation;
  try {
    const path = awayPath({ ...stateEnv, sessionId: await $.session.id() });
    if (path && (await $.fs.exists(path)) && gen === generation) await refresh($);
  } catch (err) {
    if (gen === generation) applySnapshot($, { ok: false, error: errorText(err) }, "probe");
  }
}

/** Cancel the timers and clear what this conversation drew: the band, the status line, the suggestion. Answers in flight are dropped. */
function stop($) {
  for (const t of timers) {
    try {
      t?.cancel?.();
    } catch {
      // already gone
    }
  }
  timers = [];
  generation++;
  pendingBack = null;
  turnRunning = false;
  inFlight = false;
  snapshot = emptySnapshot();
  suggested = null;
  lastError = null;
  applyStatus($, undefined);
  const key = JSON.stringify(bandModel(snapshot));
  if (key !== viewKey) {
    viewKey = key;
    $.ui.invalidate("ui.render");
  }
}

/** Start (or restart) one conversation: drop the last one's timers and state, then poll again, once. */
async function begin($) {
  stop($);
  bandSeen = false;
  ticked = false;
  stateEnv = { xdgStateHome: await $.env.get("XDG_STATE_HOME"), home: await $.env.get("HOME") };
  timers = [$.clock.every(PROBE_MS, () => probeTick($)), $.clock.every(POLL_MS, () => pollTick($))];
  await refresh($);
}

export function register(on, options) {
  on("session.start", async ($, e, next) => {
    try {
      await begin($);
    } catch (err) {
      await logFault($, "session.start", err);
    }
    return next(e);
  });

  // /clear, /resume and /branch. The filter is the engine's; the check inside keeps a host that
  // ignores filters from re-initialising at startup or compaction.
  on("classic.SessionStart", { source: NEW_CONVERSATION }, async ($, e, next) => {
    try {
      if (NEW_CONVERSATION.includes(e?.source)) await begin($);
    } catch (err) {
      await logFault($, "classic.SessionStart", err);
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
      if (e.agentId === undefined) {
        turnRunning = true;
        refresh($);
      }
    } catch (err) {
      await logFault($, "turn.start", err);
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        turnRunning = false;
        await refresh($);
        // Not awaited past its own check: a pending press sends `back` now the session is idle.
        drainBack($).catch((err) => logFault($, "turn.complete", err));
      }
    } catch (err) {
      await logFault($, "turn.complete", err);
    }
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    try {
      stop($);
    } catch (err) {
      await logFault($, "session.end", err);
    }
    return next(e);
  });
}
