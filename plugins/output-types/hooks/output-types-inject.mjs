#!/usr/bin/env node
// output-types-inject.mjs — SessionStart injection of the output-types operative core.
//
// WHY THIS HOOK EXISTS
//   The contract governs every assertion, and a skill fires in response to one — which is one
//   beat too late. A skill's text does stay in context for the rest of a session once it loads,
//   so the gap is not leakage; it is the window before the load, and the first assertion of a
//   session is usually in the first turn. This hook closes that window. The skill points at
//   the full contract for when it fires; this carries the part that must be in force before
//   the first tool call.
//
// WHY IT READS THE CONTRACT INSTEAD OF CARRYING TEXT
//   Two copies of one contract drift, and nothing detects it. So the injected text lives inside
//   skills/output-types/reference.md (the whole contract, stated once) between
//   `<!-- inject:start -->` and `<!-- inject:end -->`, and this file emits exactly that span.
//   Editing the contract IS editing what sessions receive. The only text this hook owns is the
//   single pointer line appended at the end, which cannot live in the span because it reads
//   differently inside the contract than it does injected.
//
// NO SCOPE GATE, DELIBERATELY
//   A plugin somebody chose to install is the opt-in. A gate here would reproduce the defect
//   this plugin was extracted away from: machinery that is present, believed live, and silent.
//   The off-switch is OUTPUT_TYPES_INJECT=off, so a person can silence it without uninstalling.
//
// FAIL-OPEN, BUT NOT FAIL-SILENT
//   Every error path exits 0 — a broken hook must never break somebody's session. But a hook
//   that fails silently is indistinguishable from a hook that is working, which is the exact
//   confusion this contract exists to prevent. So a failure emits one short warning line (to the
//   model and to the person) and appends one line naming this file and the reason to
//   ${XDG_STATE_HOME:-~/.local/state}/output-types/errors.log. When that log cannot be written,
//   the warning carries the reason itself. It costs nothing when things work.
//
// NEVER WAITS ON STDIN
//   The payload is unused. Stdin is drained so the pipe closes, but only for STDIN_GRACE_MS: a
//   caller that never closes the pipe still gets the core, inside the 5-second budget.
//
// Contract: read JSON on stdin (SessionStart payload; unused, but consumed so the pipe closes).
// Emit hookSpecificOutput.additionalContext, exit 0.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_FILE = "hooks/output-types-inject.mjs";
const STDIN_GRACE_MS = 1000;

// Resolved from this file, never from a working directory or an assumed layout.
const CONTRACT_PATH = fileURLToPath(new URL("../skills/output-types/reference.md", import.meta.url));

// Used when lib/core.mjs cannot load, or loaded but broke (an export missing or throwing), so the
// lib's logger and replies cannot be trusted. Same log path and line format as lib/core.mjs
// logError; kept to these few lines on purpose.
const WARN_NO_LIB = "The output-types core could not load this session.";
function noLibReply(reason) {
  let logged = null;
  try {
    const xdg = process.env.XDG_STATE_HOME?.trim() ? process.env.XDG_STATE_HOME : join(process.env.HOME || homedir(), ".local", "state");
    const dir = join(xdg, "output-types");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "errors.log"), `${new Date().toISOString()} ${HOOK_FILE} ${reason}\n`);
    logged = join(dir, "errors.log");
  } catch {
    /* nowhere to log; the warning carries the reason */
  }
  const line = logged ? `${WARN_NO_LIB} Reason logged to ${logged}.` : `${WARN_NO_LIB} Reason: ${reason}`;
  return { systemMessage: line, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line } };
}

function drainStdin(ms) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const done = () => {
      clearTimeout(timer);
      stdin.removeAllListeners("data");
      stdin.destroy();
      resolve();
    };
    const timer = setTimeout(done, ms);
    stdin.on("data", () => {});
    stdin.once("end", done);
    stdin.once("error", done);
  });
}

function finish(reply) {
  if (!reply) process.exit(0);
  process.stdout.on("error", () => process.exit(0));
  process.stdout.write(JSON.stringify(reply), () => process.exit(0));
}

// The off-switch is read here, before the lib loads, so `off` means no output even on a broken install.
function isOff() {
  return String(process.env.OUTPUT_TYPES_INJECT || "").toLowerCase() === "off";
}

const oneLine = (err) => String(err?.message ?? err).replace(/\s+/g, " ").trim();

async function main() {
  await drainStdin(STDIN_GRACE_MS);
  if (isOff()) return finish(null);
  // Imported here, not at the top, so a broken or partial install still exits 0 and says so.
  let lib;
  try {
    lib = await import("../lib/core.mjs");
  } catch (err) {
    return finish(noLibReply(`cannot load lib/core.mjs: ${oneLine(err)}`));
  }
  try {
    const { WARN_LOAD, WARN_MARKERS, extractCore, failureReply, logError, successReply } = lib;
    const fail = (warning, reason) => finish(failureReply(warning, reason, logError(HOOK_FILE, reason)));
    let md;
    try {
      md = readFileSync(CONTRACT_PATH, "utf8");
    } catch (err) {
      return fail(WARN_LOAD, `cannot read ${CONTRACT_PATH}: ${err?.message ?? err}`);
    }
    const core = extractCore(md);
    if (core === null) return fail(WARN_MARKERS, `inject markers missing from ${CONTRACT_PATH}`);
    finish(successReply(core));
  } catch (err) {
    // Fail open, and say so — a silent failure reads exactly like success. The lib may be the
    // thing that broke (an export missing or throwing), so report through the independent path.
    finish(noLibReply(`unexpected: ${oneLine(err)}`));
  }
}

main().catch((err) => {
  try {
    finish(noLibReply(`unexpected: ${oneLine(err)}`));
  } catch {
    process.exit(0);
  }
});
