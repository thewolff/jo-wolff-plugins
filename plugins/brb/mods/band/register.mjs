// register.mjs — the away band, a Claude Code mod (hooks/hooks.json `modules` points here).
//
// What it does:
//   - while this session is away, the band above the prompt (the `AbovePrompt` render site, drawn
//     in the terminal and in Claude Desktop) carries the digest: `AWAY 40m · 3 held · lunch` in
//     bold gold, `2 on fire came through · the rest wait for you` under it, the held items as a
//     numbered list (at most 10 rows, then `+N more`), and a Back button; the prompt box suggests
//     `away 40m — type back` (`$.prompt.suggest`, Tab takes it);
//   - the Back button sends `back` as the person's own prompt. A press is bound to the hold the
//     band drew (its `since`) the moment it is accepted. It runs `node mods/band/act.mjs
//     --session <id> back` (read-only: is this session away, since when?), and when that is the
//     same hold, a toast says `brb: Back pressed, ending the hold` and the press is pending until
//     the session is idle (now, or the running turn's `turn.complete`; before any turn event,
//     the band's `isWorking`). Then act.mjs is asked again and, when the same hold is still on,
//     the mod calls `$.prompt.submit({ text: "back", asUser: true })`, the same call the engine
//     makes for a typed prompt, so hooks/user-prompt-submit.mjs ends the hold exactly as for
//     `back` typed. A hold that ended (`back` typed meanwhile) or was replaced (a new `brb`),
//     at either check, drops the press silently. The call
//     is never awaited (it resolves only once its turn starts). While the press is pending the
//     band says `Back pressed · ending the hold` and further presses do nothing; a failed query
//     does not release it, a query that sees the hold gone does. A refused or dropped submit
//     (`{ drop }`, or a rejection) shows `brb: Back failed: <reason>; type back` and the button
//     works again; one from an earlier conversation says nothing. Its `b` hotkey fires only
//     while the band has focus (ctrl+x tab), not from the prompt box;
//   - after `back` the hold's digest stays on screen as the returned digest (checklist.json,
//     written by lib/back.mjs endHold): `BACK · 3 to act on` in blue, a Show and a Done button
//     per row (a done row is struck and dim and keeps only Show) and a Clear button. Each press
//     sends a prompt as the person's own (`$.prompt.submit`): Show `brb item N`, Done
//     `brb done N`, Clear `brb clear`; hooks/user-prompt-submit.mjs does the work and tells the
//     agent (Show: the item in full; Done: the tick; Clear: every item not done, in full, before
//     the file goes). A press is bound to the checklist the band drew (its `at`) and sent only
//     while act.mjs `open` still names it; idle it goes at once, while a turn runs at that turn's
//     end (a toast says so); one at a time, and never while a Back press is pending;
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
//     `$.ui.invalidate("ui.render")` and every row draws as before. config.json `hideRows: "off"`
//     (read by query.mjs each query; lib/state.mjs hideRowsEnabled) turns the row hiding off: every
//     row draws as Claude Code draws it, and the mod invalidates the rows when the switch flips;
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

import { BACK_WORD, actArgv, awayPath, emptySnapshot, pickPrompt, queryArgv, readResult, readSnapshot, sectionPath, statusText, suggestionText } from "./data.mjs";
import { AWAY_TEXT, HELD_LINE, HIDDEN_SITES, ORDER_SITE, SECTION_NAMES, createLedger, lastCarried, parseSectionState, sectionAnswer } from "./hide.mjs";
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
/** Which transcript rows belong to the hold (hide.mjs). */
let ledger = createLedger();
/** A query answered this conversation and its last answer read: until then, and after a failed query, no row is hidden. */
let known = false;
/** The session is away, as the last answered query said. */
let awayNow = false;
/** Row hiding is on, as config.json said at the last answered query (`hideRows`). */
let hideRows = true;
/**
 * One conversation's section state: `answered`, section name → the away state its last
 * `prompt.section` answer in this conversation carried; `store`, the promise of its section.json
 * (`{ path, saved, writing }`: `saved` `{}` when the file is missing, unreadable or unparsable;
 * `path` null when the state directory or the session id is unknown, and then nothing is written).
 * stop() replaces the whole object, so a section hook that began in an earlier conversation finds
 * a different object after any await and touches nothing of the new one.
 */
const newConversation = () => ({ answered: new Map(), store: null });
let conversation = newConversation();
/** The running turn has had the away text (or began away, when the prompt hook and the section carry it). */
let reminded = false;
/** The last row-hook fault logged, so a fault on every row logs once. */
let lastRowError = null;
/**
 * The pending Back press, or null: `{ since, phase }`. `since` is the hold the band drew when the
 * press was accepted, fixed then and never changed; every act.mjs check, the first included, must
 * report that same hold or the press is dropped. `phase` pressed → waiting (for idle) → checking →
 * sent. While it is set the band says so and a second press sends nothing; it ends when a query
 * sees that hold gone, or the press fails.
 */
let pendingBack = null;
/**
 * The pending press on the returned digest, or null: `{ text, at, gen }`, the prompt it sends,
 * the checklist the band drew at the press, and the conversation it belongs to. Sent at once when
 * idle, else at the running turn's end, and only while act.mjs `open` still reports `at`.
 */
let pendingPick = null;
/** A top-level turn is running (turn.start until turn.complete), as the turn events said. */
let turnRunning = false;
/** A top-level turn.start or turn.complete has been seen in this conversation, so turnRunning is known. */
let turnSeen = false;
/** The band's own `isWorking` as last drawn (true while a model turn runs), or null where the host gives none. */
let drawnWorking = null;

/**
 * Whether a turn is running now: the turn events once one has been seen; before that (the mod
 * loaded mid-turn) the band's `isWorking`; with neither, idle (the conversation just started).
 */
function busy() {
  if (turnSeen) return turnRunning;
  return drawnWorking === true;
}

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

/** A press on the returned digest that was not sent: logged and toasted; one from an earlier conversation says nothing. */
function pickFailed($, intent, err) {
  if (intent.gen !== generation) return;
  if (pendingPick === intent) pendingPick = null;
  logFault($, "band", err);
  toast($, `brb: ${intent.text} failed: ${reasonText(err)}; type it instead`);
}

/** Ask act.mjs which returned digest is open: `{ open, at }`; throws when the action failed. */
async function checkOpen($) {
  const sessionId = await $.session.id();
  const script = pathUnder($.plugin.root, "mods/band/act.mjs");
  const run = await $.process.run(["node", ...actArgv(script, sessionId, "open")], { timeoutMs: SCRIPT_TIMEOUT_MS });
  const result = readResult(run.stdout);
  if (!result.ok) throw new Error(result.error);
  return { open: result.open === true, at: result.at ?? null };
}

/**
 * Send the pending press when the session is idle; while a turn runs, wait for its
 * `turn.complete`. act.mjs `open` is asked first: a list closed or replaced since the press drops
 * it without a word, so a press never ticks or shows a row of a list it was not made for.
 */
async function drainPick($) {
  const intent = pendingPick;
  if (!intent || intent.checking || busy()) return;
  intent.checking = true;
  let now;
  try {
    now = await checkOpen($);
  } catch (err) {
    pickFailed($, intent, err);
    return;
  }
  intent.checking = false;
  if (pendingPick !== intent) return;
  if (!now.open || now.at !== intent.at) {
    pendingPick = null;
    return;
  }
  if (busy()) return;
  pendingPick = null;
  try {
    Promise.resolve($.prompt.submit({ text: intent.text, asUser: true })).then(
      (r) => {
        if (r?.drop) pickFailed($, intent, r.drop);
      },
      (err) => pickFailed($, intent, err),
    );
  } catch (err) {
    pickFailed($, intent, err);
  }
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
  if (!intent || intent.phase !== "waiting" || busy()) return;
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
  if (busy()) {
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
 * Follow the hold for the row hooks, the section and the tool reminder. An answered query sets
 * `known` and the away state; a failed one clears `known` (every row draws as is, nothing is
 * recorded) and keeps the away state, so one failed query neither ends the hold's ledger nor
 * flips the system prompt. When the hold ends, its rows join the ledger's past and every site is
 * drawn again; when the away state changes, the section is asked again.
 */
function applyAway($, next) {
  const wasKnown = known;
  const wasHiding = hideRows;
  known = next.ok === true;
  if (known) hideRows = next.hideRows !== false;
  const away = known ? next.away === true : awayNow;
  if (away === awayNow && known === wasKnown && hideRows === wasHiding) return;
  // Switched off: every row hidden so far joins the past now, drawn again or not, so switching
  // back on hides only rows first drawn after that (never one this hold hid before).
  if (wasHiding && !hideRows) ledger.endHold();
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
  // The press is done once a query sees its hold gone (home, or another hold). A failed query
  // proves nothing, so the press stays pending and a second press still sends nothing.
  if (pendingBack?.since && next.ok && (!next.away || next.since !== pendingBack.since)) pendingBack = null;
  applyAway($, next);
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
 * Run act.mjs with one verb, then refresh. Back: only while the band shows a hold, and bound to
 * that hold (its `since`) at the press; one pending press at a time (a second press, or one while
 * the first waits, sends nothing); when act.mjs reports that same hold, a toast and `back` sent
 * now or at the end of the running turn (drainBack); home or another hold, the press is dropped
 * without a word. Show, Done and Clear (`item`, `done`, `clear`): only while the band shows a
 * returned digest and nothing is pending; the prompt data.mjs pickPrompt names is sent now or at
 * the running turn's end (drainPick), and a press that cannot be sent is logged and toasted. The
 * band is redrawn from the query after a Back press.
 */
async function act($, verb, index) {
  const gen = generation;
  if (verb === "back") {
    if (pendingBack || !(snapshot.ok && snapshot.away && typeof snapshot.since === "string")) return;
    const intent = { since: snapshot.since, phase: "pressed" };
    pendingBack = intent;
    applySnapshot($, snapshot);
    try {
      const checked = await checkAway($);
      if (pendingBack === intent) {
        if (checked.away && checked.since === intent.since) {
          intent.phase = "waiting";
          toast($, "brb: Back pressed, ending the hold");
          await drainBack($, checked);
        } else {
          pendingBack = null;
          applySnapshot($, snapshot);
        }
      }
    } catch (err) {
      backFailed($, intent, err);
    }
  } else {
    const text = pickPrompt(verb, index);
    if (!text || pendingPick || pendingBack || !(snapshot.ok && !snapshot.away && typeof snapshot.checklist?.at === "string")) return;
    const intent = { text, at: snapshot.checklist.at, gen, checking: false };
    pendingPick = intent;
    if (busy()) toast($, `brb: ${text} goes when this turn ends`);
    await drainPick($);
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
 * `conv`'s section.json, read once (`$.fs.read`, in Claude Code). A missing file, a read the host
 * refuses, or text that does not parse is `saved: {}`: nothing known, so no cache break. An
 * unknown state directory or session id is `path: null` (nothing read or written) and is not
 * kept, so a later answer in the same conversation tries again. Never rejects.
 */
function loadSavedSections($, conv) {
  if (!conv.store) {
    const pending = (async () => {
      let path = null;
      try {
        path = sectionPath({ ...stateEnv, sessionId: await $.session.id() });
      } catch {
        path = null;
      }
      if (!path) return { path: null, saved: {}, writing: Promise.resolve() };
      let text = null;
      try {
        text = await $.fs.read(path);
      } catch {
        // missing (a session never away) or unreadable: nothing known
      }
      return { path, saved: parseSectionState(text), writing: Promise.resolve() };
    })();
    conv.store = pending;
    pending.then((store) => {
      if (!store.path && conv.store === pending) conv.store = null;
    });
  }
  return conv.store;
}

/**
 * Record that `name` now carries `away` and write the whole record (`$.fs.write`), one write
 * after another so the last one holds every name. A write that fails is logged once per call and
 * leaves the answer as it is.
 */
function saveSections($, store, name, away) {
  store.saved[name] = away;
  store.writing = store.writing.then(async () => {
    try {
      await $.fs.write(store.path, `${JSON.stringify(store.saved)}\n`);
    } catch (err) {
      await logFault($, "prompt.section save", err);
    }
  });
  return store.writing;
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
  pendingPick = null;
  turnRunning = false;
  turnSeen = false;
  drawnWorking = null;
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
  // The next conversation (a /clear, a /resume) starts with no answers and reads its own
  // section.json at its first answer; a hook still running for this one drops its result.
  conversation = newConversation();
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
      drawnWorking = typeof e.props?.isWorking === "boolean" ? e.props.isWorking : null;
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
        onShow: (index) => act($, "item", index),
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
        // Row hiding off (config.json): the ledger is told home, so every row draws as is.
        const verdict = ledger.decide({ known, away: awayNow && hideRows, component: e.component, requestId: e.requestId, props: e.props });
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
  // is appended to the environment section; home, core's answer passes as it is. Every field of
  // the answer `next` gave is kept, its own `breakPromptCache` included; each name tracks the
  // away state it last carried, so each breaks the cache once at `brb` and once at `back`.
  // section.json keeps that state per session across a resume or a restart: a conversation that
  // comes back home while its saved prompt carried the away text breaks the cache once, at its
  // first answer; one never saved away (or with no readable file) does not.
  for (const name of SECTION_NAMES) {
    on("prompt.section", { name }, async ($, e, next) => {
      // The conversation is checked after the section.json load, the one await before any state
      // is read or written (core's `next` comes before it): an answer that crosses a /clear or
      // /resume is returned as core gave it and records nothing.
      const conv = conversation;
      const core = await next(e);
      try {
        const store = await loadSavedSections($, conv);
        if (conv !== conversation) return core;
        const answer = sectionAnswer(core, awayNow, lastCarried(conv.answered, store.saved, name));
        conv.answered.set(name, awayNow);
        if (store.path && (store.saved[name] === true) !== awayNow) await saveSections($, store, name, awayNow);
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
        turnRunning = true;
        turnSeen = true;
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
      if (e.agentId === undefined) {
        turnRunning = false;
        turnSeen = true;
        await refresh($);
        // Not awaited past its own check: a pending press sends `back` now the session is idle.
        drainBack($).catch((err) => logFault($, "turn.complete", err));
        drainPick($).catch((err) => logFault($, "turn.complete", err));
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
