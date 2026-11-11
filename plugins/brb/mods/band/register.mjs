// register.mjs — the away band, a Claude Code mod (hooks/hooks.json `modules` points here).
//
// What it does:
//   - while this session is away, the band above the prompt (the `AbovePrompt` render site, drawn
//     in the terminal and in Claude Desktop) carries the digest: `AWAY 40m · 3 held · lunch` in
//     bold gold, `2 on fire came through · the rest wait for you` under it, the held items as a
//     numbered list (at most 10 rows, then `+N more`), and a Back button; the prompt box suggests
//     `away 40m — type back` (`$.prompt.suggest`, Tab takes it);
//   - the Back button sends `back` as the person's own prompt: it runs `node mods/band/act.mjs
//     --session <id> back` (read-only: is this session away?), and when it is, calls
//     `$.prompt.submit({ text: "back", asUser: true })`, the same call the engine makes for a
//     typed prompt, so hooks/user-prompt-submit.mjs ends the hold exactly as for `back` typed.
//     The call is never awaited (it resolves only once the session is idle and the turn began),
//     a toast says `brb: Back pressed, ending the hold`, and until the hold ends the band says
//     `Back pressed · ending the hold` and further presses do nothing. A refused or dropped
//     submit (`{ drop }`, or a rejection) shows `brb: Back failed: <reason>; type back` and the
//     button works again. Its `b` hotkey fires only while the band has focus (ctrl+x tab), not
//     from the prompt box;
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
//     band renders once in a conversation, the line is cleared and stays clear;
//   - while away, the transcript rows of the hold (`AssistantMessage`, `ToolUse`, `ToolResult`,
//     `ToolGroup`) draw as one dim line `held while away · say back` per run of hidden rows, the
//     rest of the run an empty Box; rows from before the hold, rows with an `on fire:` line and
//     Jo's own prompts (`UserMessage`, watched only to end a run) draw as Claude Code draws them.
//     Which rows belong to the hold is hide.mjs's ledger (by row id; the sites carry no time).
//     The stored messages are never touched: a hook returns a tree in the row's place and does
//     not call `next`. When the hold ends (`back`, the Back button, the hold gone), the mod calls
//     `$.ui.invalidate("ui.render")` and every row draws as before;
//   - while away, the agent reads hide.mjs AWAY_TEXT (work without narration, hold every ask,
//     reply with the still-away line, the body and `idle: <why>`): appended to the environment
//     section of the system prompt (`prompt.section`, `breakPromptCache: true` at `brb` and at
//     `back` only, after `$.ui.invalidate("prompt.section")`), and, in a turn that began while
//     home (`brb` typed mid-turn), once as `context` after the next tool result (`tool.call`).
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
import { AWAY_TEXT, HELD_LINE, HIDDEN_SITES, ORDER_SITE, SECTION_NAMES, createLedger, sectionAnswer } from "./hide.mjs";
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
/** A Back press is on its way: the band says so, and a second press sends nothing. */
let backPressed = false;
/** Which transcript rows belong to the hold (hide.mjs). */
let ledger = createLedger();
/** A query answered this conversation and its last answer read: until then, and after a failed query, no row is hidden. */
let known = false;
/** The session is away, as the last answered query said. */
let awayNow = false;
/** The away state the last `prompt.section` answer carried. */
let sectionAway = false;
/** The running turn has had the away text (or began away, when the prompt hook and the section carry it). */
let reminded = false;
/** The last row-hook fault logged, so a fault on every row logs once. */
let lastRowError = null;

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

/** A Back press that did not end the hold: logged, a toast with the reason, and the button live again. */
function backFailed($, gen, err) {
  logFault($, "back", err);
  toast($, `brb: Back failed: ${reasonText(err)}; type back`);
  if (gen !== generation) return;
  backPressed = false;
  applySnapshot($, snapshot);
}

/**
 * Send `back` as the person's own prompt. Not awaited: `$.prompt.submit` waits until the session
 * is idle and resolves when the turn starts, so awaiting it would hold the press while the agent
 * works. A `{ drop }` answer or a rejection is a failed press.
 */
function sendBack($, gen) {
  try {
    Promise.resolve($.prompt.submit({ text: BACK_WORD, asUser: true })).then(
      (r) => {
        if (r?.drop) backFailed($, gen, r.drop);
      },
      (err) => backFailed($, gen, err),
    );
  } catch (err) {
    backFailed($, gen, err);
  }
}

/**
 * Follow the hold for the row hooks, the section and the tool reminder. An answered query sets
 * `known` and the away state; a failed one clears `known` (every row draws as is, nothing is
 * recorded) and keeps the away state, so one failed query neither ends the hold's ledger nor
 * flips the system prompt. When the hold ends, its rows join the ledger's past and every site is
 * drawn again; when the away state changes, the section is asked again.
 */
function applyAway($, next) {
  const wasKnown = known;
  known = next.ok === true;
  const away = known ? next.away === true : awayNow;
  if (away === awayNow && known === wasKnown) return;
  if (away !== awayNow) {
    if (awayNow) ledger.endHold();
    awayNow = away;
    reminded = !away;
    $.ui.invalidate("prompt.section");
  }
  $.ui.invalidate("ui.render");
}

/**
 * Keep the snapshot; redraw the band when what it would draw changed; propose the prompt-box
 * text while away; set the fallback line only where the band has never rendered (and not before
 * the first timer tick, so a host that draws the band never flashes the line at start); a new
 * error is logged once, named by `where`.
 */
function applySnapshot($, next, where = "query") {
  if (!(next.ok && next.away)) backPressed = false;
  applyAway($, next);
  const { backPressed: _shown, ...query } = next;
  snapshot = backPressed ? { ...query, backPressed: true } : query;
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
 * Run act.mjs with one verb, then refresh. Back: mark the press at once (so a second press sends
 * nothing), and when act.mjs says the session is away, toast and send `back`; home, the mark goes.
 * A failed action is logged (Back's also toasted), and the band redrawn from the query either way.
 */
async function act($, verb, index) {
  const gen = generation;
  if (verb === "back") {
    if (backPressed) return;
    backPressed = true;
    applySnapshot($, snapshot);
  }
  try {
    const sessionId = await $.session.id();
    const script = pathUnder($.plugin.root, "mods/band/act.mjs");
    const run = await $.process.run(["node", ...actArgv(script, sessionId, verb, index)], { timeoutMs: SCRIPT_TIMEOUT_MS });
    const result = readResult(run.stdout);
    if (!result.ok) throw new Error(result.error);
    if (verb === "back" && gen === generation) {
      if (result.away) {
        toast($, "brb: Back pressed, ending the hold");
        sendBack($, gen);
      } else backPressed = false;
    }
  } catch (err) {
    if (verb === "back") backFailed($, gen, err);
    else await logFault($, verb, err);
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
  backPressed = false;
  inFlight = false;
  snapshot = emptySnapshot();
  suggested = null;
  lastError = null;
  applyStatus($, undefined);
  // The next conversation starts with no ledger and not known: no row hidden until its first
  // query answers. A hold this one had is dropped from the section (asked again, cache broken).
  const wasHiding = known && awayNow;
  ledger = createLedger();
  known = false;
  lastRowError = null;
  if (awayNow) {
    awayNow = false;
    $.ui.invalidate("prompt.section");
  }
  reminded = true;
  const key = JSON.stringify(bandModel(snapshot));
  if (key !== viewKey || wasHiding) {
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

  // The transcript rows of the hold. `UserMessage` is watched only so a prompt Jo typed ends a
  // run of hidden rows; it is always drawn as is. A fault draws the row as Claude Code would.
  for (const component of [...HIDDEN_SITES, ORDER_SITE]) {
    on("ui.render", { component }, async ($, e, next) => {
      try {
        const verdict = ledger.decide({ known, away: awayNow, component: e.component, requestId: e.requestId, props: e.props });
        if (verdict === "show") return next(e);
        const { Box, Text } = await $.ui.resolve(e);
        return verdict === "line" ? Text({ dimColor: true, wrap: "truncate-end", children: [HELD_LINE] }) : Box({});
      } catch (err) {
        const message = errorText(err);
        if (message !== lastRowError) {
          lastRowError = message;
          await logFault($, `ui.render ${component}`, err);
        }
        return next(e);
      }
    });
  }

  // The away text in the system prompt. Only the engine's own section names are asked for, so it
  // is appended to the environment section; home, core's text passes as it is.
  for (const name of SECTION_NAMES) {
    on("prompt.section", { name }, async ($, e, next) => {
      const core = await next(e);
      try {
        const answer = sectionAnswer(core?.text ?? null, awayNow, sectionAway);
        sectionAway = awayNow;
        return answer;
      } catch (err) {
        await logFault($, "prompt.section", err);
        return core;
      }
    });
  }

  // A turn that began home and is still running when the hold starts (`brb` typed mid-turn) has
  // neither the prompt hook's instruction nor the section: its next tool result carries the away
  // text once. Home, the call's id joins the ledger's past (its row may first draw after `brb`).
  on("tool.call", async ($, e, next) => {
    try {
      ledger.noteCall(e?.tool_use_id, { known, away: awayNow });
    } catch {
      // the ledger never throws on an id; nothing to undo
    }
    const result = await next(e);
    try {
      if (reminded || !known || !awayNow || e?.agentId !== undefined || !result || result.deny !== undefined) return result;
      reminded = true;
      return { ...result, context: [...(result.context ?? []), AWAY_TEXT] };
    } catch (err) {
      await logFault($, "tool.call", err);
      return result;
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
        // A turn that begins away has the prompt hook's instruction and the section already.
        reminded = awayNow && known;
        refresh($);
      }
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
      stop($);
    } catch (err) {
      await logFault($, "session.end", err);
    }
    return next(e);
  });
}
