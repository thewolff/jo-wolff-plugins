import { test } from "node:test";
import assert from "node:assert/strict";
import { proposesPlan } from "./proposal.mjs";

const yes = (text) => assert.equal(proposesPlan(text).proposes, true, text);
const no = (text) => assert.equal(proposesPlan(text).proposes, false, text);

test("an ask-graham verdict of start now or later proposes; do it now and don't build do not", () => {
  yes("**Verdict:** start now. Waiting blocks the release.");
  yes("**Verdict:** later. Nothing gets worse.");
  no("**Verdict:** do it now. Two-minute fix.");
  no("**Verdict:** don't build. It exists already.");
});

test("plan and design headings and bold labels propose", () => {
  yes("## Plan\n1. Add a store\n2. Add a loader\n3. Wire the hook");
  yes("### Proposed design\nA new module…");
  yes("# Implementation plan for the exporter");
  yes("**Approach:** add a parser beside the router.");
  yes("**Design decisions**\n- keep the store in memory");
  yes("## Next steps\n1. x");
});

test("sentence openers propose", () => {
  yes("Here's the plan: build a small cache in front of the API.");
  yes("I propose a new config loader that reads TOML.");
  yes("The plan is to add a worker per queue.");
  yes("Proposed approach: one table per tenant.");
  yes("My recommendation is to build a tiny CLI.");
  yes("I'd build it as a separate package with its own tests.");
});

test("reports, answers and summaries do not propose", () => {
  no("Done. Tests pass: 12/12. The three files changed are listed below.");
  no("The bug was a missing await on line 41; fixed and verified.");
  no("## Summary\nThe branch adds nothing new; it fixes two typos.");
  no("## Steps taken\n1. read the file\n2. ran the tests");
  no("");
  no(undefined);
  no(42);
});

test("the signal names what matched", () => {
  assert.equal(proposesPlan("**Verdict:** later").signal, "verdict: later");
  assert.match(proposesPlan("## Plan").signal, /^heading: ## Plan/);
  assert.match(proposesPlan("I propose x").signal, /^opener: I propose/);
});
