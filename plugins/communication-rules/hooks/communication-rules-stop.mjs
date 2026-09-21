#!/usr/bin/env node
// communication-rules-stop.mjs — the enforcement half of communication-rules.
//
// WHAT THIS IS
//   A Stop hook. When the assistant finishes a turn, this hook reads the final message and
//   enforces the delivered rules against it. A model-graded check that runs automatically
//   inside a hook is still machinery: it fires on a trigger, it decides pass or fail, and it
//   fails open — it is a different instrument with a different error profile, not a
//   non-enforcement. Jo, 2026-09-21: "I want the rules either enforceable by machinery or an
//   explicit it-can't-be-done." This file is the machinery answer for most of them.
//
// CONTRACT
//   stdin:  one Stop-payload JSON object — session_id, transcript_path, stop_hook_active
//           (Claude Code shape); OMP seat payloads additionally carry last_assistant_message.
//   stdout: one JSON object {"decision":"block","reason":"…"} when a block-mode rule fired,
//           and NOTHING otherwise. Exit 0 on every path — a broken hook must not break a
//           session, but it must not be invisible either (errors.log).
//
// ORDER OF OPERATIONS (each early return is exit 0, zero stdout)
//   1. Kill switch — the flag file $HOME/.claude/.communication-rules-off, checked with
//      existsSync PER INVOCATION. Never a module-scope env read: env is frozen for the life
//      of the host process that spawns hooks, so an env switch cannot be thrown without
//      relaunching the host. The file works within one turn. Chosen silence: documented
//      here, not announced to the model. $COMMUNICATION_RULES_ENFORCE=off is a secondary
//      switch with exactly that frozen caveat — it costs a host relaunch to change.
//   2. Parse the payload. Unparseable stdin → errors.log, exit 0.
//   3. Extract the final assistant text: last_assistant_message when it is a non-empty
//      string, else the transcript JSONL scanned backwards for the last type:"assistant"
//      entry with text content (tool-call-only entries are skipped; the message is the text).
//   4. Loop guard — stop_hook_active means the host already showed one block for this stop.
//      If the sha256 of this text equals the hash recorded at that block, exit 0: never
//      block the same message twice, or a model that ignores the reason loops forever.
//   5. Master floor — under 200 substantive chars nothing runs. Short messages are the
//      false-positive population for every structural check this plugin ships.
//   6. Deterministic checks run per their configured modes; findings collect.
//   7. Judge-gated checks run only where their deterministic trigger fired and a judge
//      command is configured; a skipped one leaves a line in skipped.log naming the rule —
//      a skipped check must be inspectable, never silently dead.
//   8. One block-mode finding is enough: emit the block, record the text hash for (4).
//      Warn-mode findings go to warnings.log. Block reasons follow the house ruling of
//      2026-09-18 (identifier resolver): name the rule, say exactly what to move or add,
//      and NEVER demand a resend of the whole message — "paste the corrected opening lines
//      only" style, terse.
//
// FAIL-OPEN EVERYWHERE
//   Any thrown error → exit 0, nothing on stdout, one line in errors.log. Carried from the
//   session-start hook's contract: fail-open, but not fail-silent.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { checkClosingAskLast } from "../checks/closing-ask-last.mjs";
import { checkNeedsYouFirst } from "../checks/needs-you-first.mjs";
import { checkNamesArtifact } from "../checks/name-the-artifact.mjs";
import { loadEnforcement, effectiveMode } from "../lib/config.mjs";
import { stateDir, killSwitchPath, lastBlockedPath, sha256hex, appendLog } from "../lib/state.mjs";

const MASTER_FLOOR = 200;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// The final assistant text: OMP seats put it in the payload; Claude Code requires reading the
// transcript. Returns "" whenever anything is missing or unparseable — no text, no opinion.
export function extractText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;

  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!transcriptPath) return "";
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  } catch {
    return "";
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn line in a JSONL transcript is not this hook's failure
    }
    if (!entry || typeof entry !== "object" || entry.type !== "assistant") continue;
    const content = entry.message?.content ?? entry.content;
    if (typeof content === "string" && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text.trim()) return text;
    // An assistant entry with only tool calls is not the message; keep scanning backwards.
  }
  return "";
}

// The deterministic checks, wired one by one. Each returns findings for the emit stage.
function runDeterministicChecks(text, config) {
  const findings = [];

  // R1 — needs you first. Calls the EXISTING check; not a fork, not a copy.
  if (effectiveMode(config, "needs-you-first") !== "off") {
    const r = checkNeedsYouFirst(text);
    if (r.flagged) {
      findings.push({
        rule: "needs-you-first",
        mode: effectiveMode(config, "needs-you-first"),
        text:
          `Needs you first — ${r.prosePrecedingChars} chars of substantive prose precede the Needs-you marker ` +
          `(line ${r.markerLine}). Move what needs the reader above the body. ` +
          `Paste the corrected opening lines only; never resend the whole message.`,
      });
    }
  }

  // R2 — one closing ask, and it goes last.
  if (effectiveMode(config, "closing-ask-last") !== "off") {
    const r = checkClosingAskLast(text);
    if (r.flagged) {
      const detail =
        r.reason === "multiple-markers"
          ? `${r.markerCount} closing-ask markers (first at line ${r.markerLine}). Keep exactly one and fold the others into it.`
          : `${r.proseAfterChars} chars of substantive prose follow the closing-ask marker (line ${r.markerLine}). ` +
            `Move that prose above the ask so the ask is the last substantive thing.`;
      findings.push({
        rule: "closing-ask-last",
        mode: effectiveMode(config, "closing-ask-last"),
        text: `One closing ask — ${detail} Paste the corrected ending lines only; never resend the whole message.`,
      });
    }
  }

  // R5 — name the artifact. WARN by default (a vocabulary check, labeled as one); the
  // built-in default lives in lib/config.mjs, overridable per-rule or globally.
  if (effectiveMode(config, "name-the-artifact") !== "off") {
    const r = checkNamesArtifact(text);
    if (r.flagged) {
      findings.push({
        rule: "name-the-artifact",
        mode: effectiveMode(config, "name-the-artifact"),
        text:
          `Name the artifact — this report-shaped message (${r.proseChars} chars, "${r.matchedVerb}" language) ` +
          `names no file, path, command, or URL. Add the artifact for the work described so the claim can be ` +
          `checked and resumed. (Vocabulary check; warn mode by default.)`,
      });
    }
  }

  return findings;
}

function recordBlock(sessionId, textHash, rules) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(lastBlockedPath(sessionId), JSON.stringify({ sha256: textHash, rules, at: new Date().toISOString() }));
  } catch (err) {
    appendLog("errors.log", `could not record loop-guard hash for ${sessionId}: ${err.message}`);
  }
}

async function main() {
  const raw = readStdin();

  // 1. Kill switch — per invocation, from the file. Zero output is the documented behavior.
  if (existsSync(killSwitchPath())) return;
  // Secondary env switch. Caveat, documented: env is frozen per host process, so changing
  // this one means relaunching the host — the flag file above is the fast control.
  if (String(process.env.COMMUNICATION_RULES_ENFORCE || "").toLowerCase() === "off") return;

  // 2. Payload.
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch (err) {
    appendLog("errors.log", `stop payload did not parse: ${err.message}`);
    return;
  }
  const sessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : "no-session";

  // 3. Text.
  const text = extractText(payload);
  if (!text.trim()) return;

  // 4. Loop guard.
  const textHash = sha256hex(text);
  if (payload.stop_hook_active === true) {
    try {
      const prev = JSON.parse(readFileSync(lastBlockedPath(sessionId), "utf8"));
      if (prev && prev.sha256 === textHash) return; // same message, second pass: let it through
    } catch {
      /* no recorded hash = nothing to compare */
    }
  }

  // 5. Master floor. proseChars comes from the R1 check's own accounting — one shared
  // definition of "substantive", not a second one that can drift.
  const r1 = checkNeedsYouFirst(text);
  if (r1.proseChars < MASTER_FLOOR) return;

  // 6–7. Checks per configured modes.
  const config = loadEnforcement();
  const findings = [...runDeterministicChecks(text, config)];
  // Judge-gated rules are dispatched here as their triggers land (commits 5–9).

  // 8. Emit.
  for (const f of findings) {
    if (f.mode === "warn") appendLog("warnings.log", `rule=${f.rule} ${f.text}`);
  }
  const blocks = findings.filter((f) => f.mode === "block");
  if (blocks.length) {
    recordBlock(sessionId, textHash, blocks.map((b) => b.rule).join(","));
    process.stdout.write(
      JSON.stringify({ decision: "block", reason: blocks.map((b) => b.text).join("\n\n") }),
    );
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err) => {
    // Fail open, and say so in the one place failures go.
    appendLog("errors.log", `stop hook failed open: ${err?.stack || String(err)}`);
    process.exit(0);
  });
}
