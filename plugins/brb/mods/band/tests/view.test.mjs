// view.test.mjs — mods/band/view.mjs under `node --test`: the band's model (headline, sub-line,
// numbered rows, `+N more`, the row budget against `maxRows`, clipping to `bodyColumns`) and the
// element tree built from plain constructors shaped as `$.ui.resolve(e)` hands them out
// (`{ type, props, children }`). band.test.tsx mounts the same tree through Claude Code's kit.

import test from "node:test";
import assert from "node:assert/strict";

import { AWAY_COLORS, BACK_COLORS, HEADLINE_MAX, ROWS_MAX, awayHeadline, bandModel, bandTree, clip, rowBudget } from "../view.mjs";

const SINCE = "2026-11-04T18:42:00.000Z";
const NOW = Date.parse(SINCE) + 40 * 60_000;
const away = (over = {}) => ({ ok: true, away: true, since: SINCE, note: "", held: 3, onFire: 0, items: ["Create the token secret?", "Billing limit on the org", "Clear the review round"], ...over });
const back = (items) => ({ ok: true, away: false, checklist: { at: SINCE, since: SINCE, note: "", items } });

/** Plain-data constructors, as the element table builds them: `{ type, props, children }`, Button a leaf. */
const el = (type) => ({ children, ...props } = {}) => ({ type, props, children: [children ?? []].flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) });
const UI = { Box: el("Box"), Text: el("Text"), Button: (props) => ({ type: "Button", props }) };

/** Every node of a tree, depth first. */
function nodes(tree, out = []) {
  if (!tree || typeof tree !== "object") return out;
  out.push(tree);
  for (const c of tree.children ?? []) nodes(c, out);
  return out;
}
const texts = (tree) => nodes(tree).filter((n) => n.type === "Text").map((n) => n.children.join(""));
const buttons = (tree) => nodes(tree).filter((n) => n.type === "Button");

test("clip: short text unchanged, long text cut to the width with one ellipsis, whitespace collapsed", () => {
  assert.equal(clip("  a \n b ", 10), "a b");
  assert.equal(clip("abcdefghij", 5), "abcd…");
  assert.equal(clip("abc", 1), "…");
  assert.equal(clip("abc", Infinity), "abc");
});

test("awayHeadline: `AWAY <dur> · N held`, the note added only while the whole stays within 40 characters", () => {
  assert.equal(HEADLINE_MAX, 40);
  assert.equal(awayHeadline(away(), NOW), "AWAY 40m · 3 held");
  assert.equal(awayHeadline(away({ note: "lunch" }), NOW), "AWAY 40m · 3 held · lunch");
  assert.equal(awayHeadline(away({ note: "x".repeat(30) }), NOW), "AWAY 40m · 3 held");
  for (const note of ["", "lunch", "x".repeat(22), "x".repeat(23)]) assert.ok(awayHeadline(away({ note }), NOW).length <= HEADLINE_MAX);
});

test("bandModel away: headline, no sub-line with no fires, the sub-line with them, one row per held item", () => {
  const m = bandModel(away(), { now: NOW });
  assert.equal(m.kind, "away");
  assert.equal(m.headline, "AWAY 40m · 3 held");
  assert.equal(m.sub, null);
  assert.deepEqual(m.rows.map((r) => `${r.n}. ${r.text}`), ["1. Create the token secret?", "2. Billing limit on the org", "3. Clear the review round"]);
  assert.equal(m.more, 0);
  assert.equal(bandModel(away({ onFire: 2 }), { now: NOW }).sub, "2 on fire came through · the rest wait for you");
  const pressed = bandModel(away({ onFire: 2, backPressed: true }), { now: NOW });
  assert.equal(pressed.sub, "Back pressed · ending the hold", "the press outranks the fire line");
  assert.equal(pressed.backPressed, true);
  assert.equal(bandModel(away(), { now: NOW }).backPressed, false);
});

test("bandModel: at most 10 rows then `+N more`; fewer when maxRows has no room; at least one", () => {
  assert.equal(ROWS_MAX, 10);
  const many = away({ held: 14, items: Array.from({ length: 14 }, (_, i) => `item ${i + 1}`) });
  const m = bandModel(many, { now: NOW });
  assert.equal(m.rows.length, 10);
  assert.equal(m.more, 4);
  // 11 rows in the band: frame 2 + headline 1 = 3, leaving 8, less the `+N more` row = 7.
  const tight = bandModel(many, { now: NOW, maxRows: 11 });
  assert.equal(tight.rows.length, 7);
  assert.equal(tight.more, 7);
  assert.ok(2 + 1 + tight.rows.length + 1 <= 11);
  assert.equal(bandModel(many, { now: NOW, maxRows: 2 }).rows.length, 1);
  assert.equal(rowBudget({ total: 0, maxRows: 11, hasSub: false }), 0);
  assert.equal(rowBudget({ total: 3, maxRows: 11, hasSub: true }), 3);
});

test("bandModel clips rows to bodyColumns with `…`", () => {
  const long = away({ items: ["x".repeat(300)] });
  const m = bandModel(long, { now: NOW, bodyColumns: 60 });
  assert.ok(m.rows[0].text.endsWith("…"));
  assert.ok(`1. ${m.rows[0].text}`.length <= 60 - 4, `${m.rows[0].text.length}`);
});

test("bandModel back: `BACK · N to act on` counts open rows; done rows stay, struck; all done or no checklist → nothing", () => {
  const m = bandModel(back([{ text: "a", done: false }, { text: "b", done: true }, { text: "c", done: false }]));
  assert.equal(m.kind, "back");
  assert.equal(m.headline, "BACK · 2 to act on");
  assert.deepEqual(m.rows.map((r) => [r.n, r.text, r.done]), [[1, "a", false], [3, "c", false], [2, "b", true]], "open rows first, numbers kept");
  assert.equal(bandModel(back([{ text: "a", done: true }])), null);
  assert.equal(bandModel(back([])), null);
  assert.equal(bandModel({ ok: true, away: false, checklist: null }), null);
  assert.equal(bandModel({ ok: false, error: "x" }), null);
});

test("bandTree away: gold border and background, the headline bold, the numbered rows, a Back button that calls onBack", () => {
  const pressed = [];
  const tree = bandTree(UI, bandModel(away({ onFire: 2, note: "lunch" }), { now: NOW }), { onBack: () => pressed.push("back") });
  assert.equal(tree.type, "Box");
  assert.equal(tree.props.borderColor, AWAY_COLORS.border);
  assert.equal(tree.props.backgroundColor, AWAY_COLORS.background);
  assert.equal(tree.props.borderStyle, "round");
  const t = texts(tree);
  assert.equal(t[0], "AWAY 40m · 3 held · lunch");
  assert.equal(t[1], "2 on fire came through · the rest wait for you");
  assert.deepEqual(t.slice(2), ["1. Create the token secret?", "2. Billing limit on the org", "3. Clear the review round"]);
  const headline = nodes(tree).find((n) => n.type === "Text" && n.children.join("") === t[0]);
  assert.equal(headline.props.bold, true);
  const b = buttons(tree);
  assert.deepEqual(b.map((x) => x.props.key), ["back"]);
  assert.equal(b[0].props.label, "Back");
  b[0].props.onPress();
  assert.deepEqual(pressed, ["back"]);
});

test("bandTree back: blue border, Clear in the header, a Done per row (Undo once done, struck and dim), handlers get the 0-based row", () => {
  const calls = [];
  const model = bandModel(back([{ text: "a", done: false }, { text: "b", done: true }]));
  const tree = bandTree(UI, model, { onClear: () => calls.push("clear"), onDone: (i) => calls.push(`done ${i}`) });
  assert.equal(tree.props.borderColor, BACK_COLORS.border);
  assert.equal(texts(tree)[0], "BACK · 1 to act on");
  const b = buttons(tree);
  assert.deepEqual(b.map((x) => [x.props.key, x.props.label]), [["clear", "Clear"], ["done-1", "Done"], ["done-2", "Undo"]]);
  const struck = nodes(tree).find((n) => n.type === "Text" && n.children.join("") === "2. b");
  assert.equal(struck.props.strikethrough, true);
  assert.equal(struck.props.dimColor, true);
  for (const x of b) x.props.onPress();
  assert.deepEqual(calls, ["clear", "done 0", "done 1"]);
});

test("bandTree keeps what later mods drew under the band", () => {
  const theirs = { type: "Text", props: {}, children: ["another mod"] };
  const tree = bandTree(UI, bandModel(away(), { now: NOW }), { theirs });
  assert.equal(tree.children.length, 2);
  assert.equal(tree.children[1], theirs);
});

test("no emoji anywhere in a drawn band: every character is single-width", () => {
  const trees = [bandTree(UI, bandModel(away({ onFire: 1, note: "lunch", backPressed: true }), { now: NOW })), bandTree(UI, bandModel(back([{ text: "a", done: false }, { text: "b", done: true }])))];
  for (const tree of trees) {
    const all = [...texts(tree), ...buttons(tree).map((b) => b.props.label)].join("");
    assert.doesNotMatch(all, /\p{Extended_Pictographic}/u, all);
  }
});

test("R1 S1: rows still to act on come first; 11 items with the first 10 done shows row 11 with a Done button and one `10 done` line; `+N more` counts only hidden open rows", () => {
  const items = Array.from({ length: 11 }, (_, i) => ({ text: `item ${i + 1}`, done: i < 10 }));
  const m = bandModel(back(items));
  assert.equal(m.headline, "BACK · 1 to act on");
  assert.deepEqual(m.rows.map((r) => [r.n, r.done]), [[11, false]]);
  assert.equal(m.more, 0);
  assert.equal(m.doneHidden, 10);
  const calls = [];
  const tree = bandTree(UI, m, { onDone: (i) => calls.push(i) });
  const b = buttons(tree).find((x) => x.props.key === "done-11");
  assert.equal(b.props.label, "Done");
  b.props.onPress();
  assert.deepEqual(calls, [10], "the original index");
  assert.ok(texts(tree).includes("10 done"));
  // 14 open after 2 done: 10 open rows, `+4 more` for the hidden open rows, `2 done` for the rest.
  const many = Array.from({ length: 16 }, (_, i) => ({ text: `item ${i + 1}`, done: i < 2 }));
  const mm = bandModel(back(many));
  assert.deepEqual(mm.rows.map((r) => r.n), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(mm.more, 4);
  assert.equal(mm.doneHidden, 2);
});

test("R1 S1: done rows fill the room left after the open rows, in their original numbering, with Undo", () => {
  const m = bandModel(back([{ text: "a", done: true }, { text: "b", done: false }, { text: "c", done: true }, { text: "d", done: false }]));
  assert.deepEqual(m.rows.map((r) => [r.n, r.done]), [[2, false], [4, false], [1, true], [3, true]]);
  assert.equal(m.doneHidden, 0);
  assert.equal(m.more, 0);
  const labels = buttons(bandTree(UI, m)).map((b) => [b.props.key, b.props.label]);
  assert.deepEqual(labels, [["clear", "Clear"], ["done-2", "Done"], ["done-4", "Done"], ["done-1", "Undo"], ["done-3", "Undo"]]);
});

test("R1 S1: a tight maxRows keeps every open row reachable before any done row; the lines never pass maxRows", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ text: `item ${i + 1}`, done: i % 2 === 0 }));
  for (const maxRows of [4, 5, 6, 7, 8, 9, 12]) {
    const m = bandModel(back(items), { maxRows });
    const lines = 2 + 1 + m.rows.length + (m.more > 0 ? 1 : 0) + (m.doneHidden > 0 ? 1 : 0);
    // The floor is frame 2 + headline 1 + one open row + `+N more` + `N done` = 6; a taller band scrolls.
    assert.ok(lines <= Math.max(maxRows, 6), `maxRows ${maxRows}: ${lines} lines`);
    const shownOpen = m.rows.filter((r) => !r.done).length;
    assert.equal(shownOpen + m.more, 4, `maxRows ${maxRows}: every open row is shown or counted`);
    assert.equal(m.rows.filter((r) => r.done).length + m.doneHidden, 4, `maxRows ${maxRows}: every done row is shown or counted`);
    if (m.rows.some((r) => r.done)) assert.equal(m.more, 0, "a done row is never shown while an open one is hidden");
  }
});

test("R1 S2: clip clamps a finite budget at 0 (empty text) and keeps the whole text only for Infinity", () => {
  assert.equal(clip("abcdefghijklmnop", -1), "");
  assert.equal(clip("abcdefghijklmnop", 0), "");
  assert.equal(clip("abcdefghijklmnop", 1), "…");
  assert.equal(clip("abcdefghijklmnop", 2.9), "a…");
  assert.equal(clip("abcdefghijklmnop", Infinity), "abcdefghijklmnop");
});

test("R1 S2: no drawn line is wider than the band at any width; a narrow band stacks each button under its text", () => {
  const long = "x".repeat(100);
  const snaps = [away({ items: [long, long], note: "lunch", onFire: 3 }), back([{ text: long, done: false }, { text: long, done: true }])];
  for (const snap of snaps) {
    for (const bodyColumns of [1, 4, 5, 8, 12, 13, 14, 15, 20, 25, 26, 30, 40, 80]) {
      const m = bandModel(snap, { now: NOW, bodyColumns });
      const inner = Math.max(0, bodyColumns - 4);
      for (const t of texts(bandTree(UI, m))) assert.ok(t.length <= Math.max(inner, 0) || (t.length <= 4 && /^\d+\. ?$/.test(t)), `${snap.away ? "away" : "back"} ${bodyColumns}: ${JSON.stringify(t)} (${t.length})`);
      if (inner < 26) assert.equal(m.compact, true, `${bodyColumns}: compact`);
    }
  }
  const narrow = bandTree(UI, bandModel(back([{ text: long, done: false }]), { bodyColumns: 15 }));
  const rowBox = nodes(narrow).find((n) => n.type === "Box" && (n.children ?? []).some((c) => c.type === "Button" && c.props.key === "done-1"));
  assert.equal(rowBox.props.flexDirection, "column", "the Done button goes under the text");
  const wide = bandTree(UI, bandModel(back([{ text: long, done: false }]), { bodyColumns: 80 }));
  const wideBox = nodes(wide).find((n) => n.type === "Box" && (n.children ?? []).some((c) => c.type === "Button" && c.props.key === "done-1"));
  assert.equal(wideBox.props.flexDirection, "row");
});

test("R1 N1: the whole headline is at most 40 characters, whatever the count or the duration", () => {
  const h = awayHeadline(away({ since: "-271821-04-20T00:00:00.000Z", held: 1e20 }), NOW);
  assert.ok(h.length <= HEADLINE_MAX, `${h.length}: ${h}`);
  assert.ok(h.startsWith("AWAY "));
  assert.ok(bandModel(back(Array.from({ length: 3 }, () => ({ text: "a", done: false }))), {}).headline.length <= HEADLINE_MAX);
});
