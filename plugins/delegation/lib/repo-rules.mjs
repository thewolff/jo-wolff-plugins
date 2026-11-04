// repo-rules.mjs — the rules chain for a directory, with `@import` expansion, and the fit of
// its sections into one additionalContext. Ported from newdle's hooks/lib/repo-rules-walk.mjs
// and hooks/lib/budget-fit.mjs (0.2.175) for hooks/repo-rules-inject.mjs. Reads files; never
// throws on a missing or unreadable one.
//
// THE CHAIN: walking up from `startDir`, each directory holding `CLAUDE.md` (plus
// `CLAUDE.local.md` beside it) or, failing that, `AGENTS.md`, is one level; nearest first.
// `~/.claude/CLAUDE.md` is never included: the host loads user memory everywhere.
//
// IMPORTS: a `@path` token (outside backticks and fences) naming an existing file is replaced
// by that file's content, recursively to MAX_IMPORT_DEPTH; a file seen before in this session
// is replaced by a one-line note rather than repeated.
//
// THE BUDGET: Claude Code caps hook output at 10 000 characters. Sections are inlined until
// the message exceeds the budget, then the largest are turned into pointers (path + heading
// outline) one at a time; a message still over budget is cut with a trailing note.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const MAX_IMPORT_DEPTH = 4;
export const MAX_WALK = 64;

export function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `[{ dir, files }]`, nearest first. */
export function collectChain(startDir) {
  const levels = [];
  let dir = resolve(startDir);
  for (let i = 0; i < MAX_WALK; i++) {
    const claude = join(dir, "CLAUDE.md");
    const local = join(dir, "CLAUDE.local.md");
    const agents = join(dir, "AGENTS.md");
    if (isFile(claude)) levels.push({ dir, files: isFile(local) ? [claude, local] : [claude] });
    else if (isFile(agents)) levels.push({ dir, files: [agents] });
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return levels;
}

export function expandImports(content, fromDir, visited, depth, filesOut, home) {
  const out = [];
  let fenced = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (fenced || !line.includes("@")) {
      out.push(line);
      continue;
    }
    const parts = line.split("`");
    for (let i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(/(^|\s)@([A-Za-z0-9~][A-Za-z0-9._/~-]*)/g, (whole, lead, ref) => {
        try {
          const target = ref.startsWith("~/") ? join(home, ref.slice(2)) : resolve(fromDir, ref);
          if (!isFile(target)) return whole;
          const body = includeFile(target, visited, depth + 1, filesOut, home);
          return body === null ? `${lead}(content of ${canonical(target)} already included above; not repeated)` : `${lead}${body}`;
        } catch {
          return whole;
        }
      });
    }
    out.push(parts.join("`"));
  }
  return out.join("\n");
}

/** The file's content with imports expanded; "" when empty or unreadable; null when already included or user memory. */
export function includeFile(absPath, visited, depth, filesOut, home = homedir()) {
  const key = canonical(absPath);
  if (key === canonical(join(home, ".claude", "CLAUDE.md"))) return null;
  if (visited.has(key)) return null;
  visited.add(key);
  let raw;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return "";
  }
  if (!raw.trim()) return "";
  if (filesOut) filesOut.push(key);
  if (depth >= MAX_IMPORT_DEPTH) return raw;
  return expandImports(raw, dirname(absPath), visited, depth, filesOut, home);
}

export function isAncestorOf(ancestor, dir) {
  const a = resolve(ancestor);
  const c = resolve(dir);
  return c === a || c.startsWith(`${a}/`);
}

/** `#`..`###` headings outside fences as an indented list, at most `maxLines`. */
export function outlineOf(rules, maxLines = 40) {
  const out = [];
  let fenced = false;
  for (const line of rules.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    out.push(`${"  ".repeat(m[1].length - 1)}- ${m[2]}`);
    if (out.length >= maxLines) {
      out.push("  - (outline truncated)");
      break;
    }
  }
  return out.join("\n");
}

/** `render(section, asPointer)` renders one section; the largest become pointers until the whole fits `budget`. */
export function fitToBudget(header, sections, render, budget) {
  const asPointer = new Set();
  const compose = () => `${header}---\n\n${sections.map((s) => render(s, asPointer.has(s))).join("\n---\n\n")}`;
  let message = compose();
  while (message.length > budget) {
    const inline = sections.filter((s) => !asPointer.has(s));
    if (!inline.length) break;
    inline.sort((a, b) => b.content.length - a.content.length);
    asPointer.add(inline[0]);
    message = compose();
  }
  if (message.length > budget) message = `${message.slice(0, Math.max(0, budget - 60))}\n\n(trimmed to fit the hook output cap)`;
  return message;
}
