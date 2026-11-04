#!/usr/bin/env node
// handed-command.mjs — handed-command: a command handed to the reader is one script line.
//
// WHAT IT DECIDES
//   Skill rule 10 (Commands handed to the user): what the reader is handed to run is one line
//   that stays byte-identical for the task's life — `zsh /path/to/script.sh`, or their shell —
//   where the script lives in a scratch directory outside every git repository, and every fix
//   edits the script, never the line. This check asks one question of a message: does it hand
//   the reader a shell command that is NOT of that shape? A bare `gh pr list`, a two-line
//   paste, a script inside a checkout: each is a finding naming its line.
//
// WHAT COUNTS AS HANDED
//   - a fenced block tagged bash, sh, zsh or shell;
//   - an untagged fenced block whose first command starts with a known binary, when the
//     paragraph right above it tells the reader to run, paste, type, execute or enter it;
//   - a `console`/`text` fenced block, or unfenced `$ cmd` prompt lines, holding prompt lines
//     whose command starts with a known binary, under that same kind of instruction;
//   - an inline code span starting with a known binary, after a clause on the same line that
//     tells the reader to run, paste, type, execute or enter ("Run `x`", "then paste `x`",
//     "you can run `x`"). Every such span after the first imperative counts, not only the
//     first. Spans separated only by whitespace are one command (`zsh /x.sh` `--flag` is
//     `zsh /x.sh --flag`), and a span group that ends its line continues into a span group
//     opening the next line, and on through every following line that is one span group
//     (`zsh` / `~/x.sh` / `--force` on three lines is one command); prose on a line ends it.
//     "I ran `x`" and "I'll run `x`" are not handed. In a table row,
//     each cell is read on its own.
//   Known binaries: name-the-artifact's command list plus a few that only a reader is handed.
//
// WHAT NEVER COUNTS (evidence, not a hand-over)
//   - a receipt: the block under a **CLAIM** or **CITE** label line (checks/sections.mjs
//     labelOf). It holds the first paragraph, then explanatory paragraphs (no imperative),
//     fenced blocks and result lines; it ends at a heading, another label, a later paragraph
//     that tells the reader to run something, or — once a fenced block is taken — the next
//     paragraph that is not a fence or a result line;
//   - any line, or any fenced block, carrying `→`, and any line or fenced block whose very
//     next line is a result line (`→ …`, `Exit code: 0`, `exit 0`);
//   - a numbered list item under a retrospective heading (`What I ran`, `Ran`,
//     `Verification`) when the item carries a result (`→`, `exit 0`, `Exit code: 0`);
//   - a table row with an entry in a result column (`Result`, `Exit`, `Output`, `Status`,
//     `Outcome`) or a result-line cell;
//   - blockquotes, HTML comments, and fenced blocks tagged anything else (a language).
//
// WHAT PASSES
//   A handed block or span holding exactly one command line of the shape
//   `zsh|bash|sh <absolute or ~/ path>.sh` with no arguments, whose script (resolved as the
//   kernel does: each existing component through realpath before a `..` is applied) sits under
//   one of the caller's `scriptRoots` (default `~/agent-scratch`) and not inside a git checkout
//   (a `.git` file or directory in any parent, so worktrees count); a path that will not
//   resolve (a symlink loop) is a finding too. Or one
//   matching a glob in the caller's `allow` list (the profile's handedCommand.allow). Comment
//   lines (`# …`) and a leading `$ ` / `% ` prompt are ignored. Two commands in one block are a
//   finding even when both are script lines: the reader is still handed a sequence.
//
// NO LENGTH FLOOR
//   The rule holds at any length, and a command-only handoff is short by nature, so the Stop
//   hook runs this check even under its 200-char master floor.
//
// Usage:
//   import { checkHandedCommand } from "./handed-command.mjs";
//   node handed-command.mjs message.md    # prints one JSON object, exit 0

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { classifyLines } from "./lines.mjs";
import { labelOf } from "./sections.mjs";
import { COMMON_COMMANDS } from "./name-the-artifact.mjs";

// Exported for checks/link-the-reference.mjs, which reads a code span starting with one as a
// command rather than a file reference.
export const KNOWN_BINARIES = new Set([
  ...COMMON_COMMANDS,
  "rm", "sudo", "open", "launchctl", "defaults", "kill", "pkill", "ln", "tar", "unzip",
  "export", "source", "omp", "claude", "codex", "just", "vercel", "fly", "op", "security",
]);

// Fence tags that say "this is shell to run".
const SHELL_TAGS = new Set(["bash", "sh", "zsh", "shell"]);
// Fence tags for a terminal session: handed only under an instruction, prompt lines only.
const SESSION_TAGS = new Set(["console", "text", "shell-session"]);

export const DEFAULT_SCRIPT_ROOTS = ["~/agent-scratch"];

// The built-in passing shape: one shell, one absolute or home path ending .sh, nothing else.
// Group 1 is the path, quotes included.
const SCRIPT_LINE =
  /^(?:zsh|bash|sh)\s+((?:\/|~\/)[^\s;&|<>`$"']+\.sh|"(?:\/|~\/)[^"`$]+\.sh"|'(?:\/|~\/)[^']+\.sh')$/;

// An imperative addressed to the reader, at the start of a clause.
const IMPERATIVE_AT_CLAUSE =
  /(?:^|[.!?:;,(]\s*|\s[—–-]\s*)(?:(?:please|then|now|just|next|first|and)\s+)*(run|paste|type|execute|enter)\b/gi;
const IMPERATIVE_TO_YOU =
  /\byou(?:'ll)?\s+(?:(?:can|could|should|will|may|might|need|want|to|just|then)\s+){0,3}(run|paste|type|execute|enter)\b/gi;

// A result attached to a command: the line opens with `→`, `exit N`, `Exit code: N`, `exited N`.
const RESULT_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?(?:→|exit(?:ed)?(?:\s+code)?\s*:?\s*\d+\b)/i;
// A result anywhere in a list item's own text.
const RESULT_ANYWHERE = /→|\bexit(?:ed)?(?:\s+code)?\s*:?\s*\d+\b/i;

// Headings that open a report of what was already run.
const RETRO_HEADING = /^(?:what i ran|ran|verification)\b/i;
const LIST_ITEM = /^(\s*)\d+[.)]\s+/;

// Table header words that name a result column.
const RESULT_HEADER = /\b(?:results?|exit(?:\s+code)?|output|outcome|status)\b/i;
const TABLE_SEPARATOR = /^\|[\s|:-]*\|$/;

const PROMPT = /^[$%❯]\s+/;
const INLINE_SPAN = /`([^`\n]+)`/g;

// `*` any run of characters, `?` one, everything else literal; the whole line must match.
// Iterative with one backtrack point (the last `*`), so O(pattern × line) at worst — never the
// exponential backtracking a translated RegExp gives `*a*a*a…` against a near miss.
export function globMatch(pattern, s) {
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === s[i])) {
      p++;
      i++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = i;
    } else if (star !== -1) {
      p = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

// A command line as the reader would type it: trimmed, prompt removed.
const commandOf = (line) => line.trim().replace(PROMPT, "");

const firstWord = (cmd) => cmd.split(/\s+/)[0].replace(/^["']/, "");

const isBlank = (e) => e.raw.trim() === "";

const isResultLine = (e) => e !== undefined && e.kind === "prose" && RESULT_LINE.test(e.raw);

// The line with list markers and emphasis stripped, backticks kept.
const plain = (raw) => raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__/g, "");

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

// ─── where a script lives ────────────────────────────────────────────────────

// `~` and `~/…` expanded by concatenation: `join` would collapse a `..` before the symlink
// in front of it is resolved.
function expandHome(p, home) {
  if (p === "~") return home;
  return p.startsWith("~/") ? `${home}/${p.slice(2)}` : p;
}

// The path as the kernel resolves it: { path, error }. Each component is resolved physically
// (realpath) before the next one is applied, so `jump/../x` with `jump` a symlink lands in the
// link target's parent, as the shell's `zsh jump/../x` does. Once a component does not exist
// (ENOENT, ENOTDIR) the rest is a missing suffix, appended lexically to its deepest existing
// ancestor. Any other error (ELOOP from a symlink loop, EACCES) stops resolution: `error` is
// its code and `path` the lexical spelling, which the caller must not trust.
function physical(p) {
  const full = isAbsolute(p) ? p : `${process.cwd()}/${p}`;
  const parts = full.split("/");
  let cur = realpathSync.native("/");
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (part === "" || part === ".") continue;
    if (part === "..") {
      cur = dirname(cur);
      continue;
    }
    try {
      cur = realpathSync.native(join(cur, part));
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { path: normalize(join(cur, ...parts.slice(k))), error: null };
      return { path: normalize(full), error: err?.code ?? "EUNKNOWN" };
    }
  }
  return { path: cur, error: null };
}

// The git checkout holding this file, or null: the nearest parent with a `.git` file or
// directory (a worktree's `.git` is a file).
function checkoutOf(file) {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const isUnder = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// ─── receipts and other evidence ─────────────────────────────────────────────

// The blocks after line index `from`: fenced blocks and blank-separated paragraphs, as index
// ranges [start, end).
function* blocksFrom(entries, from) {
  let j = from;
  while (j < entries.length) {
    while (j < entries.length && isBlank(entries[j])) j++;
    if (j >= entries.length) return;
    const start = j;
    if (entries[j].kind === "fence") {
      j++;
      while (j < entries.length && entries[j].kind !== "fence") j++;
      if (j < entries.length) j++;
      yield { start, end: j, fence: true };
      continue;
    }
    while (j < entries.length && !isBlank(entries[j]) && entries[j].kind !== "fence") j++;
    yield { start, end: j, fence: false };
  }
}

// The line numbers (1-indexed) of every receipt: the block under a label line (see the header).
// Takes classifyLines entries. Exported for checks/link-the-reference.mjs: one definition of a
// receipt for every check that exempts them.
export function receiptLines(entries) {
  const out = new Set();
  for (let i = 0; i < entries.length; i++) {
    if (!labelOf(entries[i])) continue;
    let first = true;
    let fenceTaken = false;
    for (const b of blocksFrom(entries, i + 1)) {
      const lines = entries.slice(b.start, b.end);
      // A heading or another label ends the receipt where it stands.
      const stop = lines.findIndex((e) => e.kind === "heading" || labelOf(e));
      const own = stop === -1 ? lines : lines.slice(0, stop);
      let take;
      if (b.fence) take = true;
      else if (own.every((e) => e.kind !== "prose" || isResultLine(e) || e.raw.includes("→"))) take = true;
      else if (first) take = true;
      else if (fenceTaken) take = false;
      else take = !own.some((e) => e.kind === "prose" && imperativeEnd(plain(e.raw)) !== -1);
      if (!take) break;
      for (const e of own) out.add(e.number);
      if (b.fence) fenceTaken = true;
      first = false;
      if (stop !== -1) break;
    }
  }
  return out;
}

const isRetroHeading = (e) =>
  (e.kind === "heading" ||
    (e.kind === "prose" && (/^\s*(?:\*\*|__).+(?:\*\*|__):?\s*$/.test(e.raw) || /:\s*$/.test(e.raw)))) &&
  RETRO_HEADING.test(e.norm);

const indentOf = (raw) => raw.length - raw.trimStart().length;

// The line numbers of numbered list items under a retrospective heading that carry a result.
function retroEvidenceLines(entries) {
  const out = new Set();
  let i = 0;
  while (i < entries.length) {
    if (!isRetroHeading(entries[i])) {
      i++;
      continue;
    }
    i++;
    while (i < entries.length) {
      const e = entries[i];
      if (e.kind === "heading" || labelOf(e) || isRetroHeading(e)) break;
      const m = e.kind === "prose" ? LIST_ITEM.exec(e.raw) : null;
      if (!m) {
        if (isBlank(e) || e.kind === "fence" || e.kind === "fenced" || indentOf(e.raw) > 0) {
          i++;
          continue;
        }
        break;
      }
      const indent = m[1].length;
      let j = i + 1;
      while (j < entries.length) {
        const f = entries[j];
        if (f.kind === "fence" || f.kind === "fenced" || isBlank(f)) {
          j++;
          continue;
        }
        if (f.kind === "heading" || labelOf(f) || indentOf(f.raw) <= indent) break;
        j++;
      }
      const item = entries.slice(i, j);
      if (item.some((f) => f.kind !== "fenced" && RESULT_ANYWHERE.test(f.raw))) {
        for (const f of item) out.add(f.number);
      }
      i = j;
    }
  }
  return out;
}

// The prose lines of the paragraph directly above entry index `at`, blanks skipped.
function paragraphAbove(entries, at) {
  let k = at - 1;
  while (k >= 0 && isBlank(entries[k])) k--;
  const out = [];
  while (k >= 0 && entries[k].kind === "prose") out.push(entries[k--]);
  return out;
}

const instructsAbove = (entries, at) =>
  paragraphAbove(entries, at).some((e) => imperativeEnd(plain(e.raw)) !== -1);

// ─── tables ──────────────────────────────────────────────────────────────────

const isTableRow = (e) => e.kind === "prose" && e.raw.trim().startsWith("|");

// The cells of a `| a | b |` row; a `|` inside a code span is cell text.
function cellsOf(raw) {
  const t = raw.trim().replace(/^\|/, "").replace(/\|\s*$/, "");
  const cells = [];
  let cur = "";
  let inSpan = false;
  for (const ch of t) {
    if (ch === "`") inSpan = !inSpan;
    if (ch === "|" && !inSpan) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// ─── the check ───────────────────────────────────────────────────────────────

// Groups of code spans in `s` separated only by whitespace: [{ start, end, text }].
function spanGroups(s) {
  const groups = [];
  INLINE_SPAN.lastIndex = 0;
  let m;
  while ((m = INLINE_SPAN.exec(s))) {
    const start = m.index;
    const end = start + m[0].length;
    const last = groups[groups.length - 1];
    if (last && s.slice(last.end, start).trim() === "") {
      last.end = end;
      last.text += ` ${m[1]}`;
    } else {
      groups.push({ start, end, text: m[1] });
    }
  }
  return groups;
}

export function checkHandedCommand(text, options = {}) {
  const allow = (Array.isArray(options.allow) ? options.allow : [])
    .filter((p) => typeof p === "string" && p.trim())
    .map((p) => p.trim());
  const home = typeof options.home === "string" && options.home ? options.home : homedir();
  const rootsShown =
    Array.isArray(options.scriptRoots) && options.scriptRoots.length
      ? options.scriptRoots.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim())
      : DEFAULT_SCRIPT_ROOTS;
  let roots = null; // resolved lazily: only a script line needs the filesystem

  // null when the command passes, else { problem, checkout? | roots? | error? }.
  const problemOf = (cmd) => {
    if (allow.some((g) => globMatch(g, cmd))) return null;
    const m = SCRIPT_LINE.exec(cmd);
    if (!m) return { problem: "bare-command" };
    const { path: file, error } = physical(expandHome(m[1].replace(/^["']|["']$/g, ""), home));
    // A path the kernel will not resolve (a symlink loop, a denied directory) cannot be
    // shown to sit outside a checkout.
    if (error) return { problem: "unresolvable-path", error };
    const checkout = checkoutOf(file);
    if (checkout) return { problem: "in-checkout", checkout };
    roots ??= rootsShown.map((r) => physical(expandHome(r, home)).path);
    if (!roots.some((r) => isUnder(file, r))) return { problem: "outside-script-roots", roots: rootsShown };
    return null;
  };

  const result = {
    applicable: false,
    flagged: false,
    reason: "no-handed-command",
    findings: [], // { line, command, where: "fence" | "inline" | "prompt", problem, checkout? | roots? | error? }
  };

  // One handed block or span: [{ line, cmd }].
  const judge = (commands, where) => {
    result.applicable = true;
    if (commands.length === 1) {
      const p = problemOf(commands[0].cmd);
      if (p) result.findings.push({ line: commands[0].line, command: commands[0].cmd, where, ...p });
      return;
    }
    const bad = commands.find((c) => problemOf(c.cmd)) ?? commands[1];
    result.findings.push({ line: bad.line, command: bad.cmd, where, problem: "bare-command" });
  };

  // The handed span groups of one line or cell: every group after the first imperative whose
  // command starts with a known binary. `from` is the entry index of the line (null for a
  // table cell): a group that ends its line continues into the group opening the next line,
  // and on through every following line that is one span group continuing the same way, so
  // `zsh` / `~/x.sh` / `--force` on three lines is one command.
  const inline = (s, line, from) => {
    const after = imperativeEnd(s);
    if (after === -1) return;
    const groups = spanGroups(s).filter((g) => g.start >= after);
    for (let g = 0; g < groups.length; g++) {
      let cmd = groups[g].text;
      if (g === groups.length - 1 && from !== null) {
        let rest = s.slice(groups[g].end);
        for (let k = from + 1; rest.trim() === "" && entries[k]?.kind === "prose"; k++) {
          const cont = plain(entries[k].raw).trimStart();
          const lead = cont.startsWith("`") ? spanGroups(cont)[0] : null;
          if (!lead || lead.start !== 0) break;
          cmd += ` ${lead.text}`;
          rest = cont.slice(lead.end);
        }
      }
      cmd = commandOf(cmd);
      if (!KNOWN_BINARIES.has(firstWord(cmd))) continue;
      judge([{ line, cmd }], "inline");
    }
  };

  const entries = classifyLines(text);
  const receipts = receiptLines(entries);
  const retro = retroEvidenceLines(entries);
  const evidence = (e) => receipts.has(e.number) || retro.has(e.number);
  let resultCols = null; // the current table's result-column indexes

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
      if (evidence(e)) continue;
      if (body.some((b) => b.raw.includes("→"))) continue;
      if (isResultLine(entries[j + 1])) continue;

      let commands;
      let handed;
      if (SESSION_TAGS.has(tag)) {
        commands = body
          .filter((b) => PROMPT.test(b.raw.trim()))
          .map((b) => ({ line: b.number, cmd: commandOf(b.raw) }))
          .filter((c) => c.cmd && !c.cmd.startsWith("#"));
        handed =
          commands.length > 0 && KNOWN_BINARIES.has(firstWord(commands[0].cmd)) && instructsAbove(entries, openIndex);
      } else {
        commands = body
          .map((b) => ({ line: b.number, cmd: commandOf(b.raw) }))
          .filter((c) => c.cmd && !c.cmd.startsWith("#"));
        handed =
          commands.length > 0 &&
          (SHELL_TAGS.has(tag) ||
            (tag === "" && KNOWN_BINARIES.has(firstWord(commands[0].cmd)) && instructsAbove(entries, openIndex)));
      }
      if (handed) judge(commands, "fence");
      continue;
    }

    if (e.kind === "structural" && TABLE_SEPARATOR.test(e.raw.trim())) {
      // The row above is the header; its result columns mark evidence rows below.
      const header = i > 0 && isTableRow(entries[i - 1]) ? cellsOf(entries[i - 1].raw) : [];
      resultCols = header.flatMap((h, k) => (RESULT_HEADER.test(h) ? [k] : []));
      continue;
    }
    if (!isTableRow(e)) resultCols = null;

    if (e.kind !== "prose" || evidence(e) || e.raw.includes("→") || isResultLine(entries[i + 1])) continue;

    if (isTableRow(e)) {
      if (entries[i + 1]?.kind === "structural" && TABLE_SEPARATOR.test(entries[i + 1].raw.trim())) continue;
      const cells = cellsOf(e.raw);
      if ((resultCols ?? []).some((k) => cells[k])) continue;
      if (cells.some((c) => RESULT_LINE.test(c))) continue;
      for (const c of cells) inline(plain(c), e.number, null);
      continue;
    }

    if (PROMPT.test(e.raw.trim()) && KNOWN_BINARIES.has(firstWord(commandOf(e.raw)))) {
      // Unfenced prompt lines: one block, handed only under an instruction.
      const start = i;
      const commands = [];
      while (i < entries.length && entries[i].kind === "prose" && PROMPT.test(entries[i].raw.trim())) {
        commands.push({ line: entries[i].number, cmd: commandOf(entries[i].raw) });
        i++;
      }
      i--;
      if (instructsAbove(entries, start) && !isResultLine(entries[i + 1])) judge(commands, "prompt");
      continue;
    }

    inline(plain(e.raw), e.number, i);
  }

  if (result.findings.length) {
    result.flagged = true;
    result.reason = result.findings.some((f) => f.problem === "bare-command") ? "bare-command" : "script-location";
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
