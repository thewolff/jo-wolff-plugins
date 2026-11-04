// register.mjs — {{name}}'s mod (hooks/hooks.json `modules` points here).
// What it does: polls a file every POLL_MS and draws a band above the prompt while there is
// something to say (terminal and Desktop both draw it). The same text is pinned as the status
// line only as a fallback, until the `AbovePrompt` render hook has been called once this
// session; from then on the band is the signal and the status line stays clear (Desktop draws
// it as a 32-character grey footnote). A terminal user who collapses the band later is not
// detectable, so the line does not come back for them. `session.end` clears both.
// How it fails: every hook catches its own error, logs one dim line per distinct message, and
// returns next(e); a poll that fails clears the band and the line. Nothing throws past here.
// Validation rules kept: every call spelled `$.ns.method`; `$` passed only to top-level
// functions of this file; no node builtins; `$.env.get` with a string literal.

const POLL_MS = 5000;
const LINE_MAX = 40;

let state = null; // what the band shows, or null for nothing
let shown; // the status text last pinned, or undefined
let bandDrawn = false; // true once AbovePrompt has asked this session: the status line goes
let lastFault = null;
let timer = null;

/** Single-width ellipsis cut; the band and the line both read it. */
function clip(text, max = LINE_MAX) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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

export function register(on, options) {
  on('session.start', async ($, e, next) => {
    try {
      bandDrawn = false; // a new session pins the fallback line again until its band is asked for
      timer = $.clock.every(POLL_MS, () => refresh($));
      await refresh($);
    } catch (err) { fault($, 'session.start', err); }
    return next(e); // the timer is not awaited: the session starts at once
  });

  on('session.end', async ($, e, next) => {
    try { if (timer) timer.cancel(); $.ui.status(undefined); } catch (err) { fault($, 'session.end', err); }
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
    const head = Text({ bold: true, color: 'yellow', children: [clip(lineOf(state), e.props.bodyColumns - 16)] });
    const ack = Button({ key: 'ack', label: 'Dismiss', hotkey: 'd', onPress: () => apply($, null) });
    const band = Box({ borderStyle: 'round', borderColor: 'yellow', paddingX: 1, flexDirection: 'row', columnGap: 2, children: [head, ack] });
    return Box({ flexDirection: 'column', children: [band, theirs] });
  });
}
