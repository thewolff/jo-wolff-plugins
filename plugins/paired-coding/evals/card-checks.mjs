#!/usr/bin/env node
// Scenario setup only: start pairing, then put one card through pair_propose and exit 0 only when
// the gate answered the way the case says, through the same verbs the MCP server exposes. The
// hook scenario that runs this then proves the usual deny with pairing on; the card's outcome is
// what this setup proves. Usage: node card-checks.mjs <session-id> <case>, where <case> is
//   pattern-unsourced   a why claiming a codebase pattern, one file:line in the repository: refused,
//                       naming the receipt path and the counts
//   pattern-receipt     the same why, one file:line inside <git root>/.pattern-check/: recorded
//   alternatives-missing ask-graham's findings file exists (the scenario wrote it under
//                       $XDG_STATE_HOME) and the card has no alternatives: refused, naming the file
//   alternatives-pass   the same file, and alternatives carrying its chosen design plus one not
//                       chosen: recorded, and the reply shows them with the chosen one marked
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { executeVerb, sessionDirFor } from "../lib/verbs.mjs";

const [sessionId, which] = process.argv.slice(2);
const sessionDir = sessionDirFor(sessionId);
if (!sessionDir) { console.error(`card-checks: unusable session id ${JSON.stringify(sessionId)}`); process.exit(1); }
const root = realpathSync(process.cwd());
const ctx = { sessionId, sessionDir, root, cwd: root, env: process.env };
const fail = (msg) => { console.error(`card-checks ${which}: ${msg}`); process.exit(1); };
const expectOk = (r) => { if (!r.ok) fail(`expected the card to be recorded, got: ${r.text}`); return r; };
const expectRefused = (r, ...needles) => {
  if (r.ok) fail(`expected a refusal, but the card was recorded: ${r.text}`);
  for (const n of needles) if (!r.text.includes(n)) fail(`the refusal does not say ${JSON.stringify(n)}: ${r.text}`);
  return r;
};

const started = await executeVerb("pair_start", {}, ctx);
if (!started.ok) fail(started.text);
const why = "it is the pattern used in the rest of the codebase";
const receiptDir = join(root, ".pattern-check");
const card = (over) => executeVerb("pair_propose", { boundary: ["card-eval.txt"], ...over }, ctx);

switch (which) {
  case "pattern-unsourced":
    expectRefused(await card({ why, sources: [`${root}/card-eval.txt:1`] }), 'why claims a codebase pattern ("the pattern used in")', `${receiptDir}/ (this session's receipt would be ${receiptDir}/${sessionId}.md; found 0)`, `under ${root}/ showing the pattern in the code (found 1)`);
    break;
  case "pattern-receipt":
    expectOk(await card({ why, sources: [`${receiptDir}/${sessionId}.md:1`] }));
    break;
  case "alternatives-missing":
    expectRefused(await card({}), "ask-graham's findings for this session are on disk (", `/ask-graham/findings/${sessionId}.json), so the card needs alternatives`, 'including the findings\' chosen design "a queue table with a worker" and at least one entry with chosen: false');
    break;
  case "alternatives-pass": {
    const r = expectOk(await card({ alternatives: [{ design: "a queue table with a worker (pattern-fit)", chosen: true }, { design: "a direct call", chosen: false }] }));
    for (const line of ["Alternatives, to show on the card with the chosen one marked:", "  [chosen] a queue table with a worker (pattern-fit)", "  [      ] a direct call"]) {
      if (!r.text.includes(line)) fail(`the reply does not show ${JSON.stringify(line)}: ${r.text}`);
    }
    break;
  }
  default:
    fail(`unknown case ${JSON.stringify(which)}`);
}
