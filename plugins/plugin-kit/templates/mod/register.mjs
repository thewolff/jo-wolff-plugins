// register.mjs — {{name}}'s mod (hooks/hooks.json `modules` points here).
// What it does: polls a file every POLL_MS and draws a band above the prompt while there is
// something to say (terminal and Desktop both draw it). The same text is pinned as the status
// line only as a fallback, until the `AbovePrompt` render hook has been called once this
// session; from then on the band is the signal and the status line stays clear (Desktop draws
// it as a 32-character grey footnote). A terminal user who collapses the band later is not
// detectable, so the line does not come back for them. `session.end` clears both.
// Lifecycle: `session.start` fires once (and after a hot reload), never after /clear, /resume
// or /branch; those fire `session.end` and then `classic.SessionStart` with `source` `clear`,
// `resume` or `fork`. Both start hooks call begin(), which resets everything and restarts the
// poll, so a new conversation never keeps the last one's band or loses its poll.
// How it fails: every hook catches its own error, logs one dim line per distinct message, and
// returns next(e); a poll that fails clears the band and the line. Nothing throws past here.
// Validation rules kept: every call spelled `$.ns.method`; `$` passed only to top-level
// functions of this file; no node builtins; `$.env.get` with a string literal.

const POLL_MS = 5000;
const LINE_MAX = 40;
const ROW_CHROME = 21; // border 2, paddingX 2, columnGap 2, the button's `[ Dismiss (d) ]` 15
const STACK_CHROME = 4; // border 2, paddingX 2: the button goes under the text
const MIN_ROOM = 12; // below this the text and the button do not share a row

let state = null; // what the band shows, or null for nothing
let shown; // the status text last pinned, or undefined
let bandDrawn = false; // true once AbovePrompt has asked this session: the status line goes
let lastFault = null;
let timer = null;

/** Cut to at most `max` columns with a single `…`, at the last space that fits; a first word
 *  longer than the room is cut inside the word. A room of 0 (or less) or no text gives ''. */
function clip(text, max = LINE_MAX) {
  const room = Math.max(0, Math.floor(Number(max) || 0));
  if (!text || room === 0) return '';
  if (text.length <= room) return text;
  if (room === 1) return '…';
  const cut = text.slice(0, room - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The one line a person reads: headline first, count second; trim the note before the count. */
function lineOf(s) {
  return `${s.headline} · ${s.count} held`;
}

/** One dim transcript line per distinct fault; never throws. */
function fault($, where, err) {
  const text = `{{name}}: ${where}: ${String(err?.message ?? err ?? 'unknown error')}`;
  if (text === lastFault) return;
  lastFault = text;
  try { $.ui.log(text); } catch { /* nowhere to log */ }
}

/** Keep the state, pin or clear the status line when its text changed, and ask for a redraw.
 *  The line is pinned only until the band has been asked for once this session. */
function apply($, next) {
  state = next;
  const line = state && !bandDrawn ? clip(lineOf(state)) : undefined;
  if (line !== shown) { shown = line; $.ui.status(line); }
  $.ui.invalidate('ui.render');
}

/** Read the file once and apply it. Replace the path and the parse with the real source. */
async function refresh($) {
  try {
    const path = `${await $.env.get('HOME')}/.local/state/{{name}}/state.json`;
    const next = (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : null;
    lastFault = null;
    apply($, next);
  } catch (err) {
    fault($, 'refresh', err);
    apply($, null);
  }
}

/** Start (or restart) one conversation: drop the last one's poll and state, then poll again. */
async function begin($) {
  if (timer) { try { timer.cancel(); } catch { /* already gone */ } }
  timer = null;
  state = null;
  shown = undefined; // session.end cleared the line; the next pin must not be skipped as unchanged
  bandDrawn = false; // the fallback line is pinned again until this conversation's band is asked for
  lastFault = null;
  timer = $.clock.every(POLL_MS, () => refresh($));
  await refresh($);
}

export function register(on, options) {
  on('session.start', async ($, e, next) => {
    try { await begin($); } catch (err) { fault($, 'session.start', err); }
    return next(e); // the timer is not awaited: the session starts at once
  });

  // /clear, /resume and /branch (which reports `fork`). Startup and compaction also fire
  // classic.SessionStart; the filter leaves those alone, since session.start covers startup and
  // compaction keeps the conversation.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try { await begin($); } catch (err) { fault($, 'classic.SessionStart', err); }
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    try {
      if (timer) timer.cancel();
      timer = null;
      state = null;
      shown = undefined;
      $.ui.status(undefined);
    } catch (err) { fault($, 'session.end', err); }
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!bandDrawn) {
      // The band draws on this host: from now on it is the signal, so the fallback line goes.
      bandDrawn = true;
      try { if (shown !== undefined) { shown = undefined; $.ui.status(undefined); } } catch (err) { fault($, 'ui.render', err); }
    }
    if (!state) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const theirs = await next(e); // the bands of the mods after this one stay
    const cols = Math.max(0, Number(e.props?.bodyColumns) || 0);
    const stacked = cols - ROW_CHROME < MIN_ROOM;
    const room = Math.min(cols, cols - (stacked ? STACK_CHROME : ROW_CHROME));
    const head = Text({ bold: true, color: 'yellow', children: [clip(lineOf(state), room)] });
    const ack = Button({ key: 'ack', label: 'Dismiss (d)', hotkey: 'd', onPress: () => apply($, null) });
    const band = Box({ borderStyle: 'round', borderColor: 'yellow', paddingX: 1, flexDirection: stacked ? 'column' : 'row', columnGap: 2, children: [head, ack] });
    return Box({ flexDirection: 'column', children: [band, theirs] });
  });
}
