// Regression for finding B of the live Desktop session 782c0b72 of 2026-11-03 (0.3.0): the
// session's greeting, "What are we working on?", asks for no decision and offers no options, and
// the Stop ask rule bounced it (cc_bounces row 2). The ask rule now fires only on a question that
// asks for a decision. The greeting is the session's own text.

import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, hook, cli, apply, askQuestion, openDb, row } from "./helpers.mjs";
import { checkStop, asksDecision, questionSentences } from "../lib/stop-rules.mjs";
import { DEFAULTS } from "../lib/config.mjs";

const stop = (box, sid, prompt, last_assistant_message, extra = {}) =>
  hook(box, "stop", { session_id: sid, cwd: box.work, hook_event_name: "Stop", prompt_id: prompt, stop_hook_active: false, last_assistant_message, ...extra });
const start = (box, sid, cwd = box.work) => hook(box, "session-start", { session_id: sid, cwd, hook_event_name: "SessionStart", source: "startup" });

const BODY = "Should the plugin-kit runner bundle be a new package under plugins/, or live inside plugins/ledger?";
const ASKS_A_OR_B = "I looked at both layouts and either works. Should the runner be a separate package under plugins/, or live inside plugins/ledger? I'd go separate.";

test("B: a question that offers no options and asks for no decision does not fire the ask rule", () => {
  // The session's first message, verbatim apart from the folder listing.
  const greeting = "Hey Jo. I'm here, and nothing's running yet.\n\nOne thing worth knowing, not urgent: the ledger shows 1 question still waiting on you, filed from a different folder. I haven't opened it, so I don't know what it's about yet.\n\nWhat are we working on?";
  assert.equal(checkStop(greeting, { forcing: DEFAULTS.forcing }), null);
  const box = sandbox();
  start(box, "s-greet");
  const r = stop(box, "s-greet", "p-1", "I read the folder. There is nothing pending in the ledger for this folder. What are we working on?");
  assert.equal(r.out, "", r.out);
  assert.equal(openDb(box).prepare("SELECT count(*) AS n FROM cc_bounces").get().n, 0);

  // Decision asks still fire: a choice, a should-I, a do-you-want, a confirmation.
  for (const text of [
    ASKS_A_OR_B,
    "I can rename the README heading to match the name you picked. Should I do that now?",
    "The migration is written and the tests pass on the new column. Do you want me to run it against the dev database?",
    "I read the spec as asking for one package per plugin, not one shared package. Is that right?",
    "Two layouts are possible for the runner bundle. Which do you prefer?",
  ]) {
    assert.equal(checkStop(text, { forcing: DEFAULTS.forcing })?.rule, "stopAskRule", text);
  }
  // Rhetorical and greeting shapes do not.
  for (const text of [
    "What are we working on today? I have the ledger open and nothing is pending here or in the other folders.",
    "Still here, and nothing's running. Whenever you're ready, tell me what you want to work on. What do you want to work on?",
    "Why does the hook bounce? Because the earlier session left a row; I adopted it and the Stop passes now.",
    "Where did the config go? The loader reads ~/.config/ledger/config.json first and the repo file second.",
  ]) {
    assert.equal(checkStop(text, { forcing: DEFAULTS.forcing }), null, text);
  }
  assert.deepEqual(questionSentences("Done. Should I do A or B? Yes.\nWhat now?"), ["Should I do A or B?", "What now?"]);
  assert.equal(asksDecision("What now?"), false);
  assert.equal(asksDecision("Is this what you meant?"), true);
});
