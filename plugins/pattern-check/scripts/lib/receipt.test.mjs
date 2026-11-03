import { test } from "node:test";
import assert from "node:assert/strict";
import { HEADER, parseTable, render, SEPARATOR } from "./receipt.mjs";

test("a four-column table with header and separator parses; the decision is lower-cased", () => {
  const r = parseTable(`${HEADER}\n${SEPARATOR}\n| retry helper | src/net/retry.ts:12 | Reuse | same backoff |\n| webhook parser | (none: grep webhook in src/) | new | nothing parses inbound webhooks |\n`);
  assert.equal(r.ok, true);
  assert.equal(r.noNewPieces, null);
  assert.deepEqual(r.rows, [
    { piece: "retry helper", pattern: "src/net/retry.ts:12", decision: "reuse", reason: "same backoff" },
    { piece: "webhook parser", pattern: "(none: grep webhook in src/)", decision: "new", reason: "nothing parses inbound webhooks" },
  ]);
});

test("rows without leading and trailing pipes and without a header parse too", () => {
  const r = parseTable("config loader | src/config.ts:1 | replace | the new one takes env too");
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].decision, "replace");
});

test("a bad decision word, a 'new' row without a reason, a reuse row without a pattern, a wrong cell count: rejected", () => {
  assert.match(parseTable("| a | b | maybe | c |").error, /decision must be one of reuse, replace, new/);
  assert.match(parseTable("| a | | new | |").error, /a "new" row needs a reason/);
  assert.match(parseTable("| a | | reuse | fine |").error, /needs the existing pattern/);
  assert.match(parseTable("| a | b | reuse |").error, /needs 4 cells/);
  assert.match(parseTable("| | b | reuse | c |").error, /empty "new piece"/);
});

test("zero rows is valid only with a 'No new pieces:' line; empty input is rejected", () => {
  assert.match(parseTable("").error, /the receipt is empty/);
  assert.match(parseTable("\n\n").error, /the receipt is empty/);
  const r = parseTable("No new pieces: the change is a copy edit in two existing files");
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows, []);
  assert.equal(r.noNewPieces, "the change is a copy edit in two existing files");
  assert.match(parseTable("no new pieces:   ").error ?? "", /neither a table row/);
});

test("'No new pieces' and rows together are rejected; a stray prose line is rejected", () => {
  assert.match(parseTable("No new pieces: x\n| a | b | reuse | c |").error, /cannot both be present/);
  assert.match(parseTable("here is my table\n| a | b | reuse | c |").error, /neither a table row/);
});

test("a receipt file re-parses: its front matter lines are skipped", () => {
  const text = render({ key: "k", what: "w", opened: "o", recorded: "r", rows: [{ piece: "a", pattern: "b:1", decision: "reuse", reason: "c" }], noNewPieces: null });
  assert.match(text, /^# pattern-check receipt\n\nsession: k\nwhat: w\nopened: o\nrecorded: r\n\n/);
  const r = parseTable(text);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  const none = render({ key: "k", what: null, opened: null, recorded: "r", rows: [], noNewPieces: "copy edit" });
  assert.match(none, /what: \(not opened\)\n/);
  assert.equal(parseTable(none).noNewPieces, "copy edit");
});
