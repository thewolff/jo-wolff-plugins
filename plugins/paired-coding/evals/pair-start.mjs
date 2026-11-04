#!/usr/bin/env node
// Scenario setup only: activate pairing for one session the way the MCP server's pair_start
// does, so a hook scenario can start from "pairing is on". Usage: node pair-start.mjs <session-id>
// State lands under $PAIRED_CODING_STATE_DIR or ~/.local/state/paired-coding (the sandbox HOME).
import { executeVerb, sessionDirFor } from "../lib/verbs.mjs";

const sessionId = process.argv[2];
const sessionDir = sessionDirFor(sessionId);
if (!sessionDir) { console.error(`pair-start: unusable session id ${JSON.stringify(sessionId)}`); process.exit(1); }
const r = await executeVerb("pair_start", {}, { sessionId, sessionDir, root: process.cwd(), cwd: process.cwd() });
if (!r.ok) { console.error(r.text); process.exit(1); }
