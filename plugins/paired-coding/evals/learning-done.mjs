#!/usr/bin/env node
// Scenario setup only: start pairing with learning mode on and close one change set with a recall
// question, through the same verbs the MCP server exposes, so a Stop scenario starts from "a
// pair_done this turn". The partner's agreement is recorded the way the hooks record a typed turn
// (recordTrustedInput, source "interactive"). Usage: node learning-done.mjs <session-id>
import { executeVerb, recordTrustedInput, sessionDirFor } from "../lib/verbs.mjs";

const sessionId = process.argv[2];
const sessionDir = sessionDirFor(sessionId);
if (!sessionDir) { console.error(`learning-done: unusable session id ${JSON.stringify(sessionId)}`); process.exit(1); }
const ctx = { sessionId, sessionDir, root: process.cwd(), cwd: process.cwd(), env: process.env };
const step = async (name, args) => {
  const r = await executeVerb(name, args, ctx);
  if (!r.ok) { console.error(r.text); process.exit(1); }
  return r;
};
await step("pair_start", {});
await step("pair_learn", { on: true });
const p = await step("pair_propose", { boundary: ["learning-eval.txt"], why: "one file keeps the scenario small", sources: ["from memory: the scenario needs only one change set"] });
recordTrustedInput({ sessionDir, text: "yes, go ahead", source: "interactive" });
await step("pair_begin", { cardId: p.result.card.id, quote: "go ahead" });
await step("pair_done", { cardId: p.result.card.id, recall: "Which file did this change set cover?" });
