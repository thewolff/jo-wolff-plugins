// view.mjs — what the band above the prompt shows, in two pure steps: `bandModel` turns a
// snapshot into the lines to draw (the headline, the sub-line, the numbered rows, the `+N more`
// row) and `bandTree` turns that into the element tree Claude Code draws (Box, Text, Button from
// `$.ui.resolve(e)`). register.mjs calls both; the tests call them with plain constructors.
//
//   AWAY 40m · 3 held · lunch                                        [ Back ]      ← bold, gold
//   2 on fire came through · the rest wait for you                                 ← muted
//   1. GH_PACKAGES_READ_TOKEN secret on ContextPress/kitchen — create it? (recomm…
//   2. v1.2.0 publish failed: GitHub Packages 403 — billing limit on ContextPress…
//   +4 more
//
//   BACK · 2 to act on                                               [ Clear ]     ← bold, blue
//   1. GH_PACKAGES_READ_TOKEN secret on ContextPress/kitchen — create it?  [ Done ]
//   2. v1.2.0 publish failed: GitHub Packages 403                         [ Undo ] ← struck, dim
//
// Rules: no emoji, single-width symbols only; the headline is at most HEADLINE_MAX characters
// before the note is dropped; the word AWAY or BACK carries the state, never the colour alone;
// at most ROWS_MAX rows, fewer when the site's `maxRows` has no room, then one `+N more` row;
// a row longer than the band is cut with `…`. Colours are the mockup's (gold while away, blue
// after back), set on every Text so the band reads the same on a light and a dark theme.
//
// Imports only ./data.mjs: loaded inside Claude Code by the hooks module, where only relative
// imports are allowed, and by `node --test`.

import { elapsed } from "./data.mjs";

/** The most characters a whole headline may run; the note is dropped first, then the rest is cut. */
export const HEADLINE_MAX = 40;
/** The most item rows the band shows before `+N more`. */
export const ROWS_MAX = 10;
/** Below this many inner columns a button no longer shares a row with its text: it goes under it. */
export const COMPACT_BELOW = 26;
/** The rows the band's frame takes whatever it shows: the top and bottom border. */
const FRAME_ROWS = 2;
/** Cells a row loses to the frame and padding (border + paddingX on both sides). */
const FRAME_COLUMNS = 4;
/** Cells a `[ Done ]` / `[ Undo ]` button and its gap take beside a checklist row. */
const DONE_BUTTON_COLUMNS = 9;
/** Cells the Back or Clear button and its gap take beside the headline. */
const HEAD_BUTTON_COLUMNS = 10;

export const AWAY_COLORS = Object.freeze({ border: "#E0B23C", background: "#3A2D12", headline: "#E0B23C", body: "#F3E7C9", muted: "#CDBF9A" });
export const BACK_COLORS = Object.freeze({ border: "#48798F", background: "#14222B", headline: "#9CC9DF", body: "#DCE6EA", muted: "#9FB4BE" });

/**
 * `text` cut to `width` cells with a trailing `…`; whitespace collapsed first. Infinity (no width
 * known) keeps the whole text; a finite width is floored and clamped at 0, so a width of 0 or
 * less is `""` and a width of 1 is `…`.
 */
export function clip(text, width) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (width === Infinity) return t;
  const room = Math.max(0, Math.floor(Number(width) || 0));
  if (t.length <= room) return t;
  if (room === 0) return "";
  return room === 1 ? "…" : `${t.slice(0, room - 1)}…`;
}

/** `AWAY 40m · 3 held`, with ` · <note>` when the whole stays within HEADLINE_MAX; never over HEADLINE_MAX. */
export function awayHeadline(snapshot, now) {
  const base = `AWAY ${elapsed(snapshot.since, now)} · ${snapshot.held} held`;
  const note = String(snapshot.note ?? "").replace(/\s+/g, " ").trim();
  const withNote = note ? `${base} · ${note}` : base;
  return clip(withNote.length <= HEADLINE_MAX ? withNote : base, HEADLINE_MAX);
}

/** `BACK · 2 to act on`, never over HEADLINE_MAX. */
export function backHeadline(open) {
  return clip(`BACK · ${open} to act on`, HEADLINE_MAX);
}

/** Item rows the site's `maxRows` leaves after the frame, the headline and the sub-line; Infinity when no `maxRows`. */
function itemRoom(maxRows, hasSub) {
  return Number.isFinite(maxRows) && maxRows > 0 ? maxRows - FRAME_ROWS - 1 - (hasSub ? 1 : 0) : Infinity;
}

/**
 * How many item rows fit: at most ROWS_MAX, and no more than the site's `maxRows` leaves after
 * the frame, the headline, the sub-line and, when rows are left over, the `+N more` row. At
 * least one row is shown whenever there is one, whatever `maxRows` says.
 */
export function rowBudget({ total, maxRows, hasSub }) {
  if (total <= 0) return 0;
  let budget = Math.min(ROWS_MAX, total);
  let room = itemRoom(maxRows, hasSub);
  if (room < total) room -= 1; // the `+N more` row
  budget = Math.min(budget, room);
  return Math.max(1, budget);
}

/**
 * Which checklist rows to show, rows still to act on first: as many open rows as fit (at most
 * ROWS_MAX, a `+N more` line for the open rows that do not), then, only once every open row is
 * shown, the done rows in the room left: all of them or, when they do not all fit, none and one
 * `N done` line instead. Every row keeps its index in the whole list.
 * Returns { open: [index], done: [index], more, doneHidden }.
 */
export function checklistWindow(items, { maxRows } = {}) {
  const open = [];
  const done = [];
  items.forEach((item, i) => (item.done ? done : open).push(i));
  const room = itemRoom(maxRows, false);
  let shownOpen = Math.min(open.length, ROWS_MAX);
  const lines = (n) => n + (open.length > n ? 1 : 0) + (done.length > 0 ? 1 : 0);
  while (shownOpen > 1 && lines(shownOpen) > room) shownOpen--;
  const left = Math.min(ROWS_MAX - shownOpen, room - shownOpen);
  const doneFits = shownOpen === open.length && done.length > 0 && done.length <= left;
  return { open: open.slice(0, shownOpen), done: doneFits ? done : [], more: open.length - shownOpen, doneHidden: doneFits ? 0 : done.length };
}

/**
 * The lines the band draws from a snapshot, or null when there is nothing to draw (home with no
 * checklist, every checklist row done, or a query that failed):
 *   { kind: "away", headline, sub, rows: [{ n, text, done: false }], more, moreText, doneHidden: 0, doneText: null, compact, backPressed }
 *   { kind: "back", headline, sub: null, rows: [{ n, text, done }], more, moreText, doneHidden, doneText, compact }
 * `n` is the row's 1-based number in the whole list; `text` is already clipped to the width the
 * row has (beside its button, or the whole width when `compact` puts the buttons under the text).
 * `more` counts the hidden rows still to act on (`moreText` its `+N more` line, or null),
 * `doneHidden` the done rows summed in one line (`doneText`, `N done`, or null); both clipped.
 * `maxRows` and `bodyColumns` are the site's props: absent, ROWS_MAX rows and no clipping to width.
 */
export function bandModel(snapshot, { now = Date.now(), maxRows, bodyColumns } = {}) {
  if (!snapshot?.ok) return null;
  const width = Number.isFinite(bodyColumns) ? Math.max(0, bodyColumns - FRAME_COLUMNS) : Infinity;
  const compact = width < COMPACT_BELOW;
  const beside = (cells) => (compact ? width : width - cells);
  const rowText = (n, text, button) => clip(text, beside(button) - `${n}. `.length);
  if (snapshot.away) {
    const sub = snapshot.backPressed
      ? "Back pressed · ending the hold"
      : snapshot.onFire > 0
        ? `${snapshot.onFire} on fire came through · the rest wait for you`
        : null;
    const items = snapshot.items ?? [];
    const shown = rowBudget({ total: items.length, maxRows, hasSub: sub !== null });
    const rows = items.slice(0, shown).map((text, i) => ({ n: i + 1, text: rowText(i + 1, text, 0), done: false }));
    const more = items.length - shown;
    return { kind: "away", headline: clip(awayHeadline(snapshot, now), beside(HEAD_BUTTON_COLUMNS)), sub: sub && clip(sub, width), rows, more, moreText: more > 0 ? clip(`+${more} more`, width) : null, doneHidden: 0, doneText: null, compact, backPressed: snapshot.backPressed === true };
  }
  const items = snapshot.checklist?.items ?? [];
  const open = items.filter((i) => !i.done).length;
  if (!items.length || open === 0) return null;
  const win = checklistWindow(items, { maxRows });
  const rows = [...win.open, ...win.done].map((i) => ({ n: i + 1, text: rowText(i + 1, items[i].text, DONE_BUTTON_COLUMNS), done: items[i].done === true }));
  return {
    kind: "back",
    headline: clip(backHeadline(open), beside(HEAD_BUTTON_COLUMNS)),
    sub: null,
    rows,
    more: win.more,
    moreText: win.more > 0 ? clip(`+${win.more} more`, width) : null,
    doneHidden: win.doneHidden,
    doneText: win.doneHidden > 0 ? clip(`${win.doneHidden} done`, width) : null,
    compact,
  };
}

/**
 * The element tree for a model, from the site's constructors `{ Box, Text, Button }`:
 * `onBack()`, `onClear()` and `onDone(index)` are the buttons' handlers (index is 0-based);
 * `theirs` is what the mods after this one drew in the band (`await next(e)`), kept under the band.
 */
export function bandTree({ Box, Text, Button }, model, { onBack, onClear, onDone, theirs = null } = {}) {
  const colors = model.kind === "away" ? AWAY_COLORS : BACK_COLORS;
  const direction = model.compact ? "column" : "row";
  const headButton =
    model.kind === "away"
      ? Button({ key: "back", label: "Back", hotkey: "b", dimColor: model.backPressed, onPress: () => onBack?.() })
      : Button({ key: "clear", label: "Clear", hotkey: "c", onPress: () => onClear?.() });
  const head = Box({
    flexDirection: direction,
    columnGap: 2,
    children: [Box({ flexGrow: 1, children: [Text({ bold: true, color: colors.headline, wrap: "truncate-end", children: [model.headline] })] }), headButton],
  });
  const sub = model.sub ? [Text({ color: colors.muted, wrap: "truncate-end", children: [model.sub] })] : [];
  const row = (r) => {
    const line = Text({ color: colors.body, dimColor: r.done, strikethrough: r.done, wrap: "truncate-end", children: [`${r.n}. ${r.text}`] });
    if (model.kind !== "back") return line;
    const hotkey = r.n <= 9 ? String(r.n) : undefined;
    return Box({
      flexDirection: direction,
      columnGap: 1,
      children: [Box({ flexGrow: 1, children: [line] }), Button({ key: `done-${r.n}`, label: r.done ? "Undo" : "Done", ...(hotkey ? { hotkey } : {}), dimColor: r.done, onPress: () => onDone?.(r.n - 1) })],
    });
  };
  const muted = (text, dim = false) => Text({ color: colors.muted, dimColor: dim, wrap: "truncate-end", children: [text] });
  const more = model.moreText ? [muted(model.moreText)] : [];
  const doneLine = model.doneText ? [muted(model.doneText, true)] : [];
  const band = Box({
    key: "brb-band",
    flexDirection: "column",
    borderStyle: "round",
    borderColor: colors.border,
    backgroundColor: colors.background,
    paddingX: 1,
    children: [head, ...sub, ...model.rows.filter((r) => !r.done).map(row), ...more, ...model.rows.filter((r) => r.done).map(row), ...doneLine],
  });
  return theirs ? Box({ flexDirection: "column", children: [band, theirs] }) : band;
}
