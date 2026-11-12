import test from "node:test";
import assert from "node:assert/strict";
import { offerSentences, offerPattern, unrecordedOffers, offerReason, offerAwayReason, OFFER_PATTERNS } from "../lib/stop-rules.mjs";

const POSITIVE = [
  ["I can wire the retry wrapper next.", "P1"],
  ["I can run the scrub over the rest next.", "P1"],
  ["Say the word and I'll start the migration.", "P2"],
  ["If you want, I'll draft the PR description.", "P3"],
  ["Let me know if you want me to rerun the canary.", "P4"],
  ["I'd be happy to build the exporter.", "P5"],
  ["I'll open the PR if you say so.", "P6"],
  ["Next, I could add the missing index.", "P7"],
  ["I can pick that up after this.", "P11"],
  ["Want me to add the backfill script?", "P8"],
  ["Would you like me to write the tests first?", "P9"],
  ["Shall I go ahead and open the issue?", "P10"],
  ["Should I dispatch a builder for the scrub?", "P10"],
  ["I’d be happy to build the exporter.", "P5"],
];

const NEGATIVE = [
  "Happy to help.",
  "I can see the next file in the list.",
  "What do you want to work on next?",
  "Should I know about any other folders?",
  "The script can run next week.",
  "If you want details, the log is in errors.log.",
  "I'll keep that in mind.",
  "Let me know what you think.",
  "I'm happy to answer questions about it.",
  "Did the build pass?",
  "Can I ask what the deadline is?",
  "```\nI can run it next.\n```",
  "```\nWant me to run it?\n```",
  'You said "I can run the scrub next." earlier.',
  'You said "want me to build it?" earlier.',
  "I can see the file is fine.",
  "If you want, I can explain why it failed.",
  "Next, we can see that the value is 3.",
  "I can confirm that the tests pass next.",
  "We could revisit this next quarter.",
  "You can run it next.",
  "I can't run it next.",
  "I can tell which one runs next.",
  "> I can run the scrub next.",
  "Approved, not started: Run the scrub over the rest.",
  "Should I go ahead with that?",
];

for (const [sentence, id] of POSITIVE) {
  test(`offer: ${JSON.stringify(sentence)} → ${id}`, () => {
    const found = offerSentences(sentence);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].pattern, id);
  });
}

for (const text of NEGATIVE) {
  test(`not an offer: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(offerSentences(text), []);
  });
}

test("every pattern has a positive row and the list is closed at eleven", () => {
  const ids = OFFER_PATTERNS.map(([id]) => id);
  assert.deepEqual([...ids].sort(), ["P1", "P10", "P11", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]);
  for (const id of ids) assert.ok(POSITIVE.some(([, p]) => p === id), `${id} has a positive`);
});

test("P10 pointing back at the open question: nothing or only `with that|it|this` follows", () => {
  assert.equal(offerPattern("Shall I start?"), null);
  assert.equal(offerPattern("Should we go ahead with it?"), null);
  assert.equal(offerPattern("Should we go ahead with the rename?"), "P10");
});

test("offerSentences: a reply with prose around two offers returns both, in order", () => {
  const reply = "The parser is fixed and the tests pass.\nI can wire the retry wrapper next. Want me to add the backfill script?";
  assert.deepEqual(offerSentences(reply).map((o) => o.pattern), ["P1", "P8"]);
});

const offer = (sentence) => offerSentences(sentence);

test("match: an offer equal to a candidate's about is recorded; case and spacing do not matter", () => {
  const s = "I can run the scrub over the rest next.";
  assert.deepEqual(unrecordedOffers(offer(s), [{ about: s, body: "Run the scrub?" }]), []);
  assert.deepEqual(unrecordedOffers(offer(s), [{ about: "  i CAN run the   scrub over the rest next ", body: "x" }]), []);
});

test("match: a paraphrase is not recorded", () => {
  const s = "I can run the scrub over the rest next.";
  assert.equal(unrecordedOffers(offer(s), [{ about: "Run the scrub over the remaining reports", body: "Scrub the rest?" }]).length, 1);
});

test("match: a recorded body under 20 characters inside a long offer does not count", () => {
  const s = "I can run it now and then report back on what changed next.";
  assert.equal(unrecordedOffers(offer(s), [{ about: null, body: "Run it now?" }]).length, 1);
  assert.deepEqual(unrecordedOffers(offer(s), [{ about: null, body: "run it now and then report back" }]), [], "a body of 20 or more inside the offer counts");
});

test("match: a second, different offer in the same reply as a recorded one is unrecorded", () => {
  const reply = "I can wire the retry wrapper next. Want me to add the backfill script?";
  const left = unrecordedOffers(offer(reply), [{ about: "I can wire the retry wrapper next.", body: "Wire the retry wrapper?" }]);
  assert.deepEqual(left.map((o) => o.sentence), ["Want me to add the backfill script?"]);
});

test("offerReason and offerAwayReason: each sentence cut to 120, the ask line, and the way out", () => {
  const long = `I can ${"wire the retry wrapper and ".repeat(6)}next.`;
  const r = offerReason([{ sentence: long, pattern: "P1" }, { sentence: "Want me to add the backfill script?", pattern: "P8" }], "ledger");
  assert.match(r, /- .{119}…\n/);
  assert.match(r, /- Want me to add the backfill script\?\n/);
  assert.match(r, /`ledger ask "<the question, in plain words>" --kind approval --name <short> --about "<the offer sentence, verbatim>"`/);
  assert.match(r, /If a sentence is not an offer, or repeats one already recorded, finish: the bounce is counted\.$/);
  const away = offerAwayReason([{ sentence: "Want me to add the backfill script?", pattern: "P8" }], "ledger");
  assert.match(away, /away \(brb\)/);
  assert.match(away, /then `ledger hold <q-id>`, then finish/);
});
