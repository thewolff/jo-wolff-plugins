// Regression for finding B of the live Desktop session 782c0b72 of 2026-11-03 (0.3.0): the
// session's greeting, "What are we working on?", asks for no decision and offers no options, and
// the Stop ask rule bounced it (cc_bounces row 2). The ask rule now fires only on a question that
// asks for a decision. The corpus below carries the session's greeting, the live 0.3.1 run's
// loose-`or` closing line, and the sentences of the 0.3.1 Codex review's boundary probe.

import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, hook, openDb } from "./helpers.mjs";
import { checkStop, asksDecision, isDecisionAsk, questionSentences } from "../lib/stop-rules.mjs";
import { DEFAULTS } from "../lib/config.mjs";

const stop = (box, sid, prompt, last_assistant_message, extra = {}) =>
  hook(box, "stop", { session_id: sid, cwd: box.work, hook_event_name: "Stop", prompt_id: prompt, stop_hook_active: false, last_assistant_message, ...extra });
const start = (box, sid, cwd = box.work) => hook(box, "session-start", { session_id: sid, cwd, hook_event_name: "SessionStart", source: "startup" });

// A neutral preamble that lifts every sentence over the 40-character floor on its own.
const PREFIX = "The implementation has been inspected and the results are available. ";

// [sentence, decision?] — the review's classification is the expected value.
const CORPUS = [
  // Information requests: no row needed.
  ["What are we working on?", false],
  ["What are we working on today?", false],
  ["What do you want to work on?", false],
  ["What do you want to build or check first with the trial on the local database?", false], // live 0.3.1, session 69733bc7
  ["Which file contains the database configuration?", false],
  ["Do we know why the hook failed during startup?", false],
  ["Are the log files compressed or uncompressed?", false],
  ["Is the parser deciding which file to load?", false],
  ["Why should I store this value twice?", false],
  ["Why does the hook bounce?", false],
  ["Where did the config go?", false],
  // Codex round 2: information requests with an embedded decision word, and explanations.
  ["Does the log say whether the build failed?", false],
  ["Did the deployment proceed without errors?", false],
  ["I wonder, why do you prefer this naming scheme?", false],
  ["Do we have permission to deploy?", false],
  ["Anything else?", false],
  ["Why did the build fail?", false],
  ["What does the log say?", false],
  // Decisions, permissions, confirmations and choices: a row is needed.
  ["Ready to deploy the reviewed change?", true],
  ["Would you like me to deploy the reviewed change?", true],
  ["Shall we deploy the reviewed change?", true],
  ["How should we proceed with the database migration?", true],
  ["Where should I put the shared helper: plugins/a or plugins/b?", true],
  ["What should it be, alpha or beta?", true],
  ["Alpha or beta?", true],
  ["Should I use A or B?", true],
  ["Should I do that now?", true],
  ["Do you want me to run it against the dev database?", true],
  ["Is that right?", true],
  ["Which do you prefer?", true],
  ["Is this what you meant?", true],
  ["Okay to merge the branch now?", true],
  ["Do we keep the old name or drop it?", true],
  ["I looked at both layouts and either works. Should the runner be a separate package under plugins/, or live inside plugins/ledger?", true],
  // Codex round 2: first-person permission, subject-based choices, confirmations.
  ["Can I push the reviewed branch?", true],
  ["Can we deploy this change?", true],
  ["Should the helper use local or remote storage?", true],
  ["Use local or remote storage?", true],
  ["Is it safe to deploy?", true],
  ["Want me to push?", true],
  ["Shall I open the PR?", true],
  ["Does that look right?", true],
  ["Would you like me to open the PR?", true],
  ["Should I open the PR?", true],
  ["Is this a good time to proceed?", true],
  ["Which option should we use?", true],
  ["Which storage mode, local or remote?", true],
  ["Would you prefer local or remote?", true],
  ["Should the retry live in lib or bin?", true],
  ["May I rename the heading to match?", true],
];

test("B: decision corpus — information requests pass the ask rule; decisions, confirmations and choices fire it", () => {
  const wrong = [];
  for (const [sentence, decision] of CORPUS) {
    const got = checkStop(PREFIX + sentence, { forcing: DEFAULTS.forcing })?.rule ?? null;
    if ((got === "stopAskRule") !== decision) wrong.push(`${JSON.stringify(sentence)} → ${got}`);
  }
  assert.deepEqual(wrong, []);
  // The whole greeting of session 782c0b72, verbatim apart from the folder listing.
  const greeting = "Hey Jo. I'm here, and nothing's running yet.\n\nOne thing worth knowing, not urgent: the ledger shows 1 question still waiting on you, filed from a different folder. I haven't opened it, so I don't know what it's about yet.\n\nWhat are we working on?";
  assert.equal(checkStop(greeting, { forcing: DEFAULTS.forcing }), null);
  // The live 0.3.1 closing message, whole.
  const closing = "I've recorded your answer: the trial will use a local database, not a remote one. That question came from the other trial folder, and it was the only one waiting.\n\nWhat do you want to build or check first with the trial on the local database?";
  assert.equal(checkStop(closing, { forcing: DEFAULTS.forcing }), null);
});

test("B: the hook passes the greeting end to end and records no bounce", () => {
  const box = sandbox();
  start(box, "s-greet");
  const r = stop(box, "s-greet", "p-1", "I read the folder. There is nothing pending in the ledger for this folder. What are we working on?");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "", r.out);
  assert.equal(openDb(box).prepare("SELECT count(*) AS n FROM cc_bounces").get().n, 0);
  const r2 = stop(box, "s-greet", "p-2", "I read the folder and the two layouts both work. Should the runner be a separate package, or live inside plugins/ledger?");
  assert.equal(r2.json?.decision, "block", r2.out);
});

test("B: sentence splitting and the classifier's pure shape", () => {
  assert.deepEqual(questionSentences("Done. Should I do A or B? Yes.\nWhat now?"), ["Should I do A or B?", "What now?"]);
  assert.equal(asksDecision("What now?"), false);
  assert.equal(asksDecision("Is this what you meant?"), true);
  assert.equal(isDecisionAsk("**Closing ask:** Should I change the heading?"), true);
  assert.equal(isDecisionAsk("- Ready to ship?"), true);
  assert.equal(isDecisionAsk("Why not, should we?"), false, "why-questions never count");
});
