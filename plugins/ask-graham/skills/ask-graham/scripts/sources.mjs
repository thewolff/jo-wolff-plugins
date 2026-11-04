// sources.mjs — the user's own sources file: where it lives, the bullets it lists, and the nudge
// lines built from them. The plugin names no source of its own: everything here comes from the file
// on the running machine, `${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/sources.md`.
//
// FORMAT (SKILL.md "The sources file"): one Markdown list item per source, opening with a bold
// label (`**Label:**` or `**Label**:`). An indented line under an item continues it. Each source is
// one of three kinds, decided from the item's text:
//   command  the first backticked span that is not a path. Proof of a run is a tool call whose
//            command (Bash, bash, pair_run) or code (eval) contains the command's prefix: its first
//            two tokens, three when the second is a generic runner (RUNNERS). A token holding a
//            placeholder (`<the ask>`) or a quote ends the prefix early.
//   path     no such span, but a path: a backticked span or bare word starting `/`, `~/`, `$HOME/`,
//            `${HOME}/`, `./` or `../`. `*` in it matches any run of path characters. Proof is a tool
//            call naming the path. A command and a path in one item: the command wins.
//   none     neither. Proof is a `**Local search:**` line in the reply whose whole label is this one.
// An item without a bold label cannot be required, so it is skipped and counted in `skipped`. Items
// inside a fenced code block do not count.
//
// readSources is the only I/O here and never throws: a missing, unreadable or unparseable file (no
// labelled item) is null, which means "no sources file" to the nudge and to the Stop check.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { userConfigPath } from "./intensity.mjs";
import { stripFences } from "./verdict.mjs";

/** Runners whose name alone says nothing about the source: a third prefix token is required after them. */
export const RUNNERS = Object.freeze(["node", "bun", "python3", "sh", "zsh", "npx"]);

/** The sources file's path, beside the user config file (XDG_CONFIG_HOME counts only when absolute). */
export function sourcesPath(env = process.env, home = homedir()) {
  return join(dirname(userConfigPath(env, home)), "sources.md");
}

const ITEM = /^[ \t]*[-*+][ \t]+(.*)$/;
const LABEL = /^(\*\*|__)(.+?)\1[ \t]*:?[ \t]*(.*)$/;
const IS_PATH = /^(?:~|\$HOME|\$\{HOME\}|\.\.?)?\/\S*$/;
const BARE_PATH = /(?:^|[\s(])((?:~|\$HOME|\$\{HOME\}|\.\.?)?\/[^\s`'"(),;]+)/;

// The prefix a run must contain: the first two tokens, or three when the second is a runner, cut
// before the first token that holds a placeholder or a quote (at least one token).
function commandPrefix(command) {
  const tokens = command.trim().split(/\s+/);
  const want = RUNNERS.includes(tokens[1]) ? 3 : 2;
  const prefix = [];
  for (const t of tokens.slice(0, want)) {
    if (prefix.length && /[<>"']/.test(t)) break;
    prefix.push(t);
  }
  return prefix.join(" ");
}

// One item's text (its continuation lines joined) as a source, or null without a bold label.
function source(text) {
  const m = LABEL.exec(text.trim());
  if (!m) return null;
  const label = m[2].replace(/:\s*$/, "").trim();
  if (!label) return null;
  const rest = m[3];
  const spans = [...rest.matchAll(/`([^`\n]+)`/g)].map((s) => s[1].trim());
  const command = spans.find((s) => !IS_PATH.test(s));
  if (command) return { label, kind: "command", value: command, prefix: commandPrefix(command), shown: `\`${command}\`` };
  const span = spans.find((s) => IS_PATH.test(s));
  if (span) return { label, kind: "path", value: span, shown: `\`${span}\`` };
  const bare = BARE_PATH.exec(rest.replace(/`[^`\n]*`/g, " "));
  if (bare) {
    const path = bare[1].replace(/[.:]+$/, "");
    return { label, kind: "path", value: path, shown: path };
  }
  return { label, kind: "none", value: null, shown: "" };
}

/** The sources a file's text lists, in order, and how many list items had no bold label. */
export function parseSources(text) {
  const items = [];
  let current = null;
  for (const line of stripFences(String(text).replace(/\r\n/g, "\n")).split("\n")) {
    const m = ITEM.exec(line);
    if (m && !/^[ \t]{2,}/.test(line)) {
      current = [m[1]];
      items.push(current);
    } else if (current && /^[ \t]/.test(line) && line.trim()) {
      current.push(line.trim());
    } else if (line.trim()) {
      current = null;
    }
  }
  const bullets = [];
  let skipped = 0;
  for (const item of items) {
    const s = source(item.join(" "));
    if (s) bullets.push(s);
    else skipped++;
  }
  return { bullets, skipped };
}

/**
 * The sources file on this machine, parsed: `{ path, bullets, skipped }`, or null when it is
 * missing, unreadable, or lists no labelled source. Never throws.
 */
export function readSources({ env = process.env, home = homedir() } = {}) {
  try {
    const path = sourcesPath(env, home);
    const parsed = parseSources(readFileSync(path, "utf8"));
    return parsed.bullets.length ? { path, ...parsed } : null;
  } catch {
    return null;
  }
}

/** The nudge with one line per source appended (its label and its command or path), or the nudge alone. */
export function withSources(nudge, sources) {
  if (!sources?.bullets?.length) return nudge;
  const lines = sources.bullets.map((b) => `ask-graham source: **${b.label}:**${b.shown ? ` ${b.shown}` : ""}`);
  return `${nudge}\n${lines.join("\n")}`;
}
