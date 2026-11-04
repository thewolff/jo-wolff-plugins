// view.test.mjs — mods/band/view.mjs under `node --test`: the band's model (headline, sub-line,
// numbered rows, `+N more`, the row budget against `maxRows`, clipping to `bodyColumns`) and the
// element tree built from plain constructors shaped as `$.ui.resolve(e)` hands them out
// (`{ type, props, children }`). band.test.tsx mounts the same tree through Claude Code's kit.

import test from "node:test";
import assert from "node:assert/strict";

import { AWAY_COLORS, BACK_COLORS, HEADLINE_MAX, ROWS_MAX, awayHeadline, bandModel, bandTree, clip, rowBudget } from "../view.mjs";

const SINCE = "2026-11-04T18:42:00.000Z";
const NOW = Date.parse(SINCE) + 40 * 60_000;
const away = (over = {}) => ({ ok: true, away: true, since: SINCE, note: "", held: 3, onFire: 0, items: ["Create the token secret?", "Billing limit on the org", "Clear the review round"], backRequested: false, ...over });
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
  assert.match(bandModel(away({ backRequested: true }), { now: NOW }).sub, /^Back pressed · the next prompt ends the hold/);
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
  assert.deepEqual(m.rows.map((r) => [r.n, r.text, r.done]), [[1, "a", false], [2, "b", true], [3, "c", false]]);
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
  const trees = [bandTree(UI, bandModel(away({ onFire: 1, note: "lunch", backRequested: true }), { now: NOW })), bandTree(UI, bandModel(back([{ text: "a", done: false }, { text: "b", done: true }])))];
  for (const tree of trees) {
    const all = [...texts(tree), ...buttons(tree).map((b) => b.props.label)].join("");
    assert.doesNotMatch(all, /\p{Extended_Pictographic}/u, all);
  }
});
