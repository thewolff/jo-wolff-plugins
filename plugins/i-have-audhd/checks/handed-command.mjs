#!/usr/bin/env node
// handed-command.mjs — handed-command: a command handed to the reader is one script line.
//
// WHAT IT DECIDES
//   Skill rule 10 (Commands handed to the user): what the reader is handed to run is one line
//   that stays byte-identical for the task's life — `zsh /path/to/script.sh`, or their shell —
//   and every fix edits the script, never the line. This check asks one question of a message:
//   does it hand the reader a shell command that is NOT of that shape? A bare `gh pr list`, a
//   two-line paste, an interactive command: each is a finding naming its line.
//
// WHAT COUNTS AS HANDED
//   - a fenced block tagged bash, sh, zsh or shell;
//   - an untagged fenced block whose first command starts with a known binary, when the
//     paragraph right above it tells the reader to run, paste, type, execute or enter it;
//   - an inline code span starting with a known binary, when the same line tells the reader
//     to run, paste, type, execute or enter it at the start of a clause ("Run `x`",
//     "then paste `x`", "you can run `x`"). "I ran `x`" and "I'll run `x`" are not handed.
//   Known binaries: name-the-artifact's command list plus a few that only a reader is handed.
//
// WHAT NEVER COUNTS (evidence, not a hand-over)
//   - a receipt: the paragraph and the one fenced block directly under a **CLAIM** or **CITE**
//     label line (checks/sections.mjs labelOf);
//   - any line, or any fenced block, carrying `→` — the `command → result` receipt form;
//   - blockquotes, HTML comments, and fenced blocks tagged anything else (`console`, `text`,
//     a language), which are quoted output or code, not something to run.
//
// WHAT PASSES
//   A handed block or span holding exactly one command line of the shape
//   `zsh|bash|sh <absolute or ~/ path>.sh` with no arguments, or one matching a glob in the
//   caller's `allow` list (the profile's handedCommand.allow). Comment lines (`# …`) and a
//   leading `$ ` / `% ` prompt are ignored. Two commands in one block are a finding even when
//   both are script lines: the reader is still handed a sequence.
//
// WHY NO LENGTH FLOOR OF ITS OWN
//   The Stop hook's 200-char master floor gates it, as it gates plural-back-reference.
//
// Usage:
//   import { checkHandedCommand } from "./handed-command.mjs";
//   node handed-command.mjs message.md    # prints one JSON object, exit 0

import { classifyLines } from "./lines.mjs";
import { labelOf } from "./sections.mjs";
import { COMMON_COMMANDS } from "./name-the-artifact.mjs";

const KNOWN_BINARIES = new Set([
  ...COMMON_COMMANDS,
  "rm", "sudo", "open", "launchctl", "defaults", "kill", "pkill", "ln", "tar", "unzip",
  "export", "source", "omp", "claude", "codex", "just", "vercel", "fly", "op", "security",
]);

// Fence tags that say "this is shell to run".
const SHELL_TAGS = new Set(["bash", "sh", "zsh", "shell"]);

// The built-in passing shape: one shell, one absolute or home path ending .sh, nothing else.
const SCRIPT_LINE =
  /^(?:zsh|bash|sh)\s+(?:(?:\/|~\/)[^\s;&|<>`$"']+\.sh|"(?:\/|~\/)[^"`$]+\.sh"|'(?:\/|~\/)[^']+\.sh')$/;

// An imperative addressed to the reader, at the start of a clause.
const IMPERATIVE_AT_CLAUSE =
  /(?:^|[.!?:;,(]\s*|\s[—–-]\s*)(?:(?:please|then|now|just|next|first|and)\s+)*(run|paste|type|execute|enter)\b/gi;
const IMPERATIVE_TO_YOU =
  /\byou(?:'ll)?\s+(?:(?:can|could|should|will|may|might|need|want|to|just|then)\s+){0,3}(run|paste|type|execute|enter)\b/gi;

const INLINE_SPAN = /`([^`\n]+)`/g;

function globToRegExp(glob) {
  const body = glob
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

// A command line as the reader would type it: trimmed, prompt removed.
const commandOf = (line) => line.trim().replace(/^[$%❯]\s+/, "");

const firstWord = (cmd) => cmd.split(/\s+/)[0].replace(/^["']/, "");

// The line numbers (1-indexed) of every receipt: the paragraph and the one fenced block directly
// under a label line, stopping at a heading, another label, or a second paragraph.
function receiptLines(entries) {
  const out = new Set();
  for (let i = 0; i < entries.length; i++) {
    if (!labelOf(entries[i])) continue;
    let j = i + 1;
    let fenceTaken = false;
    let paragraphTaken = false;
    while (j < entries.length) {
      const e = entries[j];
      if (e.kind === "heading" || labelOf(e)) break;
      if (e.kind === "fence") {
        if (fenceTaken) break;
        fenceTaken = true;
        out.add(e.number);
        j++;
        while (j < entries.length && entries[j].kind !== "fence") out.add(entries[j++].number);
        if (j < entries.length) out.add(entries[j++].number);
        continue;
      }
      if (e.raw.trim() === "") {
        // A blank ends the receipt unless the next non-blank is its one fenced block.
        let k = j;
        while (k < entries.length && entries[k].raw.trim() === "") k++;
        if (k < entries.length && entries[k].kind === "fence" && !fenceTaken) {
          j = k;
          continue;
        }
        if (paragraphTaken || fenceTaken) break;
        j++;
        continue;
      }
      paragraphTaken = true;
      out.add(e.number);
      j++;
    }
  }
  return out;
}

// Does this line tell the reader to run something? Returns the index just past the first
// imperative, or -1.
function imperativeEnd(line) {
  let best = -1;
  for (const re of [IMPERATIVE_AT_CLAUSE, IMPERATIVE_TO_YOU]) {
    re.lastIndex = 0;
    const m = re.exec(line);
    if (m && (best === -1 || m.index + m[0].length < best)) best = m.index + m[0].length;
  }
  return best;
}

// The line with list markers and emphasis stripped, backticks kept.
const plain = (raw) => raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__/g, "");

export function checkHandedCommand(text, options = {}) {
  const allow = (Array.isArray(options.allow) ? options.allow : [])
    .filter((p) => typeof p === "string" && p.trim())
    .map((p) => globToRegExp(p.trim()));
  const passes = (cmd) => SCRIPT_LINE.test(cmd) || allow.some((re) => re.test(cmd));

  const result = {
    applicable: false,
    flagged: false,
    reason: "no-handed-command",
    findings: [], // { line, command, where: "fence" | "inline" }
  };

  const entries = classifyLines(text);
  const receipts = receiptLines(entries);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    if (e.kind === "fence") {
      // An opening fence: collect its body up to the closing fence.
      const tag = e.raw.trim().replace(/^(```+|~~~+)/, "").trim().split(/\s+/)[0].toLowerCase();
      const body = [];
      let j = i + 1;
      while (j < entries.length && entries[j].kind !== "fence") body.push(entries[j++]);
      const openIndex = i;
      i = j; // skip past the closing fence
      if (receipts.has(e.number)) continue;
      if (body.some((b) => b.raw.includes("→"))) continue;
      const commands = body
        .map((b) => ({ line: b.number, cmd: commandOf(b.raw) }))
        .filter((c) => c.cmd && !c.cmd.startsWith("#"));
      if (!commands.length) continue;

      let handed = SHELL_TAGS.has(tag);
      if (!handed && tag === "" && KNOWN_BINARIES.has(firstWord(commands[0].cmd))) {
        // Untagged: handed only when the paragraph right above tells the reader to run it.
        let k = openIndex - 1;
        while (k >= 0 && entries[k].raw.trim() === "") k--;
        while (k >= 0 && entries[k].kind === "prose") {
          if (imperativeEnd(plain(entries[k].raw)) !== -1) {
            handed = true;
            break;
          }
          k--;
        }
      }
      if (!handed) continue;
      result.applicable = true;
      if (commands.length === 1 && passes(commands[0].cmd)) continue;
      const bad = commands.find((c) => !passes(c.cmd)) ?? commands[1];
      result.findings.push({ line: bad.line, command: bad.cmd, where: "fence" });
      continue;
    }

    if (e.kind !== "prose" || receipts.has(e.number) || e.raw.includes("→")) continue;
    const line = plain(e.raw);
    const after = imperativeEnd(line);
    if (after === -1) continue;
    INLINE_SPAN.lastIndex = after;
    const m = INLINE_SPAN.exec(line);
    if (!m) continue;
    const cmd = commandOf(m[1]);
    if (!KNOWN_BINARIES.has(firstWord(cmd))) continue;
    result.applicable = true;
    if (passes(cmd)) continue;
    result.findings.push({ line: e.number, command: cmd, where: "inline" });
  }

  if (result.findings.length) {
    result.flagged = true;
    result.reason = "bare-command";
  } else if (result.applicable) {
    result.reason = "script-line-only";
  }
  return result;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const { readFileSync } = await import("node:fs");
  const path = process.argv[2];
  let text = "";
  try {
    text = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: `could not read ${path || "stdin"}: ${err.message}` }) + "\n");
    process.exit(0); // log-only, including its own failures
  }
  process.stdout.write(JSON.stringify(checkHandedCommand(text), null, 2) + "\n");
  process.exit(0);
}
