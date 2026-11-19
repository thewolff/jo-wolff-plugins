// claudex.mjs — gate 5: does a builder-class brief say how claudex-loop applies to it?
//
// THE RULE: new features and behaviour changes go through claudex-loop (Claude plans, Codex
// reviews the plan, the provider that did not build inspects the result); trivial or mechanical
// work and prototypes are exempt. A builder-class brief therefore carries one of two lines:
//   claudex: log: <path>     the claudex-loop plan-review log for this work; it must be an
//                            existing, non-empty regular file
//   claudex: skip: <reason>  why claudex-loop does not apply; the reason must be non-empty
// claudex-loop writes no log of its own: the host conversation keeps the append-only LOG_FILE
// (default `PLAN-REVIEW-LOG.md`), so existence is the only thing this gate can check. It does not
// read the log's verdict, which would bind this plugin to a format claudex-loop leaves free.
//
// WHAT IS MATCHED: a line outside fenced code blocks (the spawn gates' fence rule), trimmed, with
// backticks around the whole line and one leading `- ` or `* ` list marker dropped, reading
// `claudex: skip: …` or `claudex: log: …` (keywords case-insensitive). A value wrapped in `<…>`
// is the deny template's placeholder and never counts. Any one valid line passes.
//
// PATHS: `~/` expands to HOME; a relative path resolves against the payload's cwd. A relative
// path with no cwd, or a stat that fails for any reason but "not found"/"not a directory", is
// `skipped` (the caller logs one skipped.log line and allows). A stat that hangs is the hook
// runner's 4 s deadline, which also allows.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { linesOutsideFences } from "./brief.mjs";
import { configPath } from "./config.mjs";

const LINE_RE = /^claudex:[ \t]*(skip|log)[ \t]*:(.*)$/i;
const NOT_FOUND = new Set(["ENOENT", "ENOTDIR"]);

const isPlaceholder = (v) => v.startsWith("<") && v.endsWith(">");

/** The claudex lines of `prompt`, in order: `{ kind: "skip"|"log", value }` with `value` trimmed. */
export function claudexLines(prompt) {
  if (typeof prompt !== "string") return [];
  const out = [];
  for (const raw of linesOutsideFences(prompt)) {
    let line = raw.trim().replace(/^`+/, "").replace(/`+$/, "").trim();
    line = line.replace(/^[-*][ \t]+/, "");
    const m = LINE_RE.exec(line);
    if (m) out.push({ kind: m[1].toLowerCase(), value: m[2].trim() });
  }
  return out;
}

function unquote(v) {
  const m = /^(["'`])(.*)\1$/.exec(v);
  return m ? m[2].trim() : v;
}

/**
 * @param {{ prompt: string, cwd?: string }} payload
 * @param {object} [deps]  `stat` replaces fs.statSync (tests inject a faulting one)
 * @returns {{ status: "present"|"missing"|"skipped", why?: string, problem?: string, path?: string, config?: string }}
 */
export function checkClaudexLine({ prompt, cwd }, env = process.env, home = homedir(), { stat = statSync } = {}) {
  const lines = claudexLines(prompt);
  let problem = null;
  let skipped = null;
  const note = (p) => {
    if (!problem) problem = p;
  };
  for (const { kind, value } of lines) {
    if (kind === "skip") {
      if (value === "") note({ problem: "empty-reason" });
      else if (isPlaceholder(value)) note({ problem: "placeholder" });
      else return { status: "present" };
      continue;
    }
    const v = unquote(value);
    if (v === "") {
      note({ problem: "empty-path" });
      continue;
    }
    if (isPlaceholder(v)) {
      note({ problem: "placeholder" });
      continue;
    }
    let path;
    if (v === "~" || v.startsWith("~/")) path = join(env.HOME || home, v.slice(1));
    else if (isAbsolute(v)) path = v;
    else if (typeof cwd === "string" && cwd !== "") path = resolve(cwd, v);
    else {
      skipped ??= `the log path "${v}" is relative and the payload has no cwd`;
      continue;
    }
    let st;
    try {
      st = stat(path);
    } catch (err) {
      if (NOT_FOUND.has(err?.code)) note({ problem: "log-not-found", path });
      else skipped ??= `the log path ${path} could not be read (${err?.code ?? err?.message ?? "unknown error"})`;
      continue;
    }
    if (!st.isFile()) note({ problem: "log-not-file", path });
    else if (st.size === 0) note({ problem: "log-empty", path });
    else return { status: "present", path };
  }
  if (skipped) return { status: "skipped", why: skipped };
  return { status: "missing", ...(problem ?? { problem: "no-line" }), config: configPath(env, home) };
}

const WHAT = Object.freeze({
  "no-line": () => "the prompt has none",
  "empty-reason": () => `its "claudex: skip:" line gives no reason`,
  "empty-path": () => `its "claudex: log:" line names no file`,
  placeholder: () => "its claudex line is still the template placeholder",
  "log-not-found": (r) => `the plan-review log it names does not exist at ${r.path}`,
  "log-not-file": (r) => `the plan-review log it names at ${r.path} is not a file`,
  "log-empty": (r) => `the plan-review log it names at ${r.path} is empty`,
});

/** The two lines a brief adds, as a fill-in template. Their placeholders never pass the gate. */
export const CLAUDEX_LINES = `claudex: log: <absolute path to this work's claudex-loop plan-review log>
claudex: skip: <why claudex-loop does not apply: prototype, one-file fix, copy change, regex tweak, rebase, measurement run, docs>`;

/** The template's Claudex section, verbatim; test/manifest.test.mjs holds templates/builder-brief.md to it. */
export const CLAUDEX_SECTION = `## Claudex

A builder-class brief carries one of these lines, alone on its line, or the spawn is refused. New features and behaviour changes go through claudex-loop first and name its plan-review log; trivial or mechanical work (one-file fixes, copy changes, regex tweaks, rebases, measurement runs, docs) and prototypes say why they skip it. The placeholders below never pass as written.

\`\`\`
${CLAUDEX_LINES}
\`\`\``;

/** The deny reason for gate 5: what is wrong, both ways through, and the config switch that turns it off. */
export function claudexReason(subagentType, result) {
  const type = String(subagentType ?? "general-purpose").trim() || "general-purpose";
  const what = (WHAT[result.problem] ?? WHAT["no-line"])(result);
  return `Spawn refused: builder-class "${type}" needs a claudex-loop line, and ${what}. New features and behaviour changes go through claudex-loop first. Add one of these lines to the prompt, alone on its line, filled in, then re-issue this spawn:\n\n${CLAUDEX_LINES}\n\nTo turn this gate off instead, set \`"requireClaudexLoop": false\` in ${result.config ?? "the delegation config file"}.`;
}
