#!/usr/bin/env node
// communication-rules-inject.mjs — SessionStart injection of the message-shape core, plus any
// reader traits the operator declared locally.
//
// WHY THIS HOOK EXISTS
//   The rules govern the shape of a message, and the first message of a session is often the
//   first turn. A skill fires in response to something; that is one beat too late for a contract
//   about the very first thing said. This closes that window. The skill carries the fuller
//   contract and the reference for when it loads.
//
// WHY IT READS THE SKILL INSTEAD OF CARRYING TEXT
//   Two copies of one contract drift and nothing detects it. The injected text lives inside
//   skills/communication-rules/SKILL.md between `<!-- inject:start -->` and `<!-- inject:end -->`,
//   and this file emits exactly that span. Editing the skill IS editing what sessions receive.
//
// WHY THE READER TRAITS ARE NOT IN THIS REPOSITORY
//   A trait sentence is information about a real person. It is attributable to whoever owns the
//   repository it sits in, and a pushed commit survives in forks and caches after any later
//   deletion — so genericising the wording does not anonymise the author. This plugin therefore
//   ships the MECHANISM and no traits: it reads a profile the operator writes on their own
//   machine and emits it verbatim. example.communication-rules.json is a generic illustration and
//   describes nobody.
//
// FAIL-OPEN, BUT NOT FAIL-SILENT
//   Every path exits 0 — a broken hook must never break a session. But a hook that fails silently
//   is indistinguishable from one that is working, so a missing span or an unparseable profile
//   emits one short line saying so. A profile that simply does not exist is normal, not a
//   failure, and says so in one clause rather than a warning.
//
// Contract: read JSON on stdin (SessionStart payload; unused, but consumed so the pipe closes).
// Emit hookSpecificOutput.additionalContext, exit 0.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_PATH = fileURLToPath(
  new URL("../skills/communication-rules/SKILL.md", import.meta.url),
);

// Line-anchored: the skill's own prose names the markers, and must not match.
const START = "\n<!-- inject:start -->\n";
const END = "\n<!-- inject:end -->";

const POINTER =
  "\nThe enforceability verdict for each rule, the operator-profile schema, and the one shipped " +
  "check are in the `communication-rules` skill. Nothing here inspects what you send.";

function emit(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    }),
  );
  process.exit(0);
}

function profilePath() {
  const explicit = process.env.COMMUNICATION_RULES_PROFILE;
  if (explicit && explicit.trim()) return explicit.trim();
  return join(homedir(), ".claude", "communication-rules.json");
}

// Returns { text, note } — text is emitted verbatim, note reports a failure worth one line.
function readProfile() {
  const path = profilePath();
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { text: "", note: "No reader profile is configured, so these rules name no addressee." };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { text: "", note: `The reader profile at ${path} did not parse (${err.message}), so no traits were applied.` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { text: "", note: `The reader profile at ${path} is not a JSON object, so no traits were applied.` };
  }

  const reader = typeof parsed.reader === "string" ? parsed.reader.trim() : "";
  const traits = Array.isArray(parsed.traits)
    ? parsed.traits.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim())
    : [];

  if (!reader && !traits.length) {
    return { text: "", note: `The reader profile at ${path} declares no reader and no traits.` };
  }

  const lines = [];
  lines.push(
    reader
      ? `\n**These messages are being written for ${reader}.**`
      : "\n**The operator has declared how this reader reads.**",
  );
  if (traits.length) {
    lines.push("");
    for (const t of traits) lines.push(`- ${t.replace(/\s+$/, "")}`);
    lines.push("");
    lines.push(
      "Those are traits of the reader, not of the subject matter. Where one of them conflicts " +
        "with a rule above, the trait wins and you say which rule you set aside.",
    );
  }
  return { text: lines.join("\n"), note: "" };
}

try {
  try {
    readFileSync(0, "utf8"); // drain stdin; the payload is not needed
  } catch {
    /* no stdin is fine */
  }

  if (String(process.env.COMMUNICATION_RULES_INJECT || "").toLowerCase() === "off") process.exit(0);

  const md = readFileSync(SKILL_PATH, "utf8");
  const start = md.indexOf(START);
  const end = start === -1 ? -1 : md.indexOf(END, start + START.length);
  if (start === -1 || end === -1) {
    emit("The communication-rules core could not load: its markers are missing from the skill file.");
  }

  const core = md.slice(start + START.length, end).trim();
  const { text, note } = readProfile();
  emit(core + text + POINTER + (note ? `\n${note}` : ""));
} catch {
  // Fail open, and say so — a silent failure reads exactly like success.
  try {
    emit("The communication-rules core could not load this session.");
  } catch {
    process.exit(0);
  }
}
