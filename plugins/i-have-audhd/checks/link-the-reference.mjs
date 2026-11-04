#!/usr/bin/env node
// link-the-reference.mjs — link-the-reference: a named reference carries its link.
//
// WHAT IT DECIDES
//   Skill rule 11 (Machinery anchors): name the file, the command, or the line, so the reader
//   can open what a sentence points at without asking. This check asks one question of each
//   substantive line: does it point at an artifact by a name the reader cannot open? Four kinds:
//
//   issue-ref    `PR #N`, `pull request N`, `issue N`, or a bare `#N` (N of two digits or more,
//                not inside a URL, path or code span), with no
//                `https://github.com/…/(pull|issues)/N` URL for that N on the same line.
//   file-name    a file name ending in .md .sh .zsh .mjs .ts .js .json .yaml .yml .txt .log
//                .sql .py (alone or at the end of a relative path), with no absolute, `~/`,
//                `file://` or http(s) path ending in that name on the same line. A name that is
//                itself the end of such a path is the link.
//   artifact     `the report|guide|handoff|inventory|review|spec|plan|script|log|transcript`
//                with no link (URL, absolute or `~/` path, markdown link) after it in the same
//                sentence.
//   branch       a code span holding a branch-looking token (`[a-z0-9]+(-[a-z0-9]+)+`) on a
//                line that also says `branch` or `PR`, with no PR URL and no absolute path on
//                that line.
//
// WHAT NEVER COUNTS
//   Lines that are not the author's prose: fenced blocks, HTML comments, blockquotes, headings
//   (checks/lines.mjs), receipts under a **CLAIM** or **CITE** label (handed-command's
//   receiptLines, the one shared definition) or opening with their own inline label, any line
//   carrying `→` (evidence), and a line or code span whose first word is a known command (the
//   file names in it are arguments).
//
// ONE FINDING PER LINE
//   A line with several offending references is one finding, naming its first reference and
//   its kind. Each finding: { line, where: "line N", kind, excerpt }.
//
// KINDS ARE SWITCHABLE
//   options.kinds: { "issue-ref": bool, "file-name": bool, artifact: bool, branch: bool }.
//   DEFAULT_KINDS is the shipped default, set from the corpus measurement in reference.md.
//
// Usage:
//   import { checkLinkTheReference } from "./link-the-reference.mjs";
//   node link-the-reference.mjs message.md    # prints one JSON object, exit 0

import { classifyLines } from "./lines.mjs";
import { receiptLines, KNOWN_BINARIES } from "./handed-command.mjs";

export const KINDS = ["issue-ref", "file-name", "artifact", "branch"];

// The shipped default per kind, from the corpus measurement in reference.md (469 final
// messages, hand-classified): issue-ref 7 of 93 flags false positives (8%), file-name 3 of 90
// (3%), artifact 33 of 44 (75%), branch 1 of 2 (50%, too few flags to trust either way).
// A kind over 30% ships off; the profile's linkTheReference.kinds turns it on.
export const DEFAULT_KINDS = { "issue-ref": true, "file-name": true, artifact: false, branch: false };

const EXTENSIONS = "md|sh|zsh|mjs|ts|js|json|yaml|yml|txt|log|sql|py";

// A link: a URL (http, https, file) or an absolute / home path of at least two segments.
const URL_RE = /\b(?:https?|file):\/\/[^\s`'"<>)\]]+/g;
const ABS_PATH_RE = /(?<![\w.:/-])(?:~\/[^\s`'"<>()[\],;]+|\/[\w.@+~-]+(?:\/[^\s`'"<>()[\],;]*)+)/g;
const MD_LINK_RE = /\[[^\]\n]*\]\([^)\s]+\)/;

const GITHUB_REF_RE = /github\.com\/[^\s)]*?\/(?:pull|issues)\/(\d+)/g;
const PR_URL_RE = /github\.com\/[^\s)]*?\/pull\/\d+/;

// Issue references, matched against the line with URLs, paths and code spans blanked.
const ISSUE_RES = [
  /\bPRs?\s*#?(\d+)\b/g,
  /\bpull\s+requests?\s*#?(\d+)\b/gi,
  /\bissues?\s+#?(\d+)\b/gi,
  /(?<![\w&#/])#(\d{2,})\b/g,
];

// A file name: a token ending in a known extension, optionally after a relative path.
const FILE_TOKEN_RE = new RegExp(
  `(?<![\\w.@+~/:-])((?:[\\w.@+-]+\\/)*[\\w@+-][\\w.@+-]*\\.(?:${EXTENSIONS}))(?![\\w/-])`,
  "g",
);

const ARTIFACT_RE = /\bthe\s+(report|guide|handoff|inventory|review|spec|plan|script|log|transcript)(?![\w-])/gi;

const SPAN_RE = /`([^`\n]+)`/g;
const BRANCH_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const BRANCH_WORD_RE = /\bbranch(?:es)?\b|\bPRs?\b/;

// Replace every match of `re` in `s` with spaces of the same length, so indexes hold.
function blank(s, re) {
  return s.replace(re, (m) => " ".repeat(m.length));
}

const lastSegment = (p) => p.replace(/[:#].*$/, "").replace(/\/+$/, "").split("/").pop();

// Every link-shaped token on the line (URLs and absolute / home paths).
function linksOf(line) {
  return [...(line.match(URL_RE) ?? []), ...(line.match(ABS_PATH_RE) ?? [])];
}

// The end of the sentence holding index `from`: the first `.`, `!` or `?` followed by
// whitespace or the line end, or the line end.
function sentenceEnd(line, from) {
  const m = /[.!?](?=\s|$)/g;
  m.lastIndex = from;
  const hit = m.exec(line);
  return hit ? hit.index : line.length;
}

// Each detector first asks one cheap, anchor-free question of the raw line — can it hold this
// kind at all? — so the ordinary line costs one scan per kind, not the masking passes.
const MAY_ISSUE = /\d/;
const MAY_FILE = new RegExp(`\\.(?:${EXTENSIONS})(?![\\w/-])`);
const MAY_ARTIFACT = /\bthe\s/i;

function issueRef(line) {
  if (!MAY_ISSUE.test(line)) return null;
  const linked = new Set();
  for (const m of line.matchAll(GITHUB_REF_RE)) linked.add(m[1]);
  const masked = blank(blank(blank(line, URL_RE), ABS_PATH_RE), SPAN_RE).replace(/\S*\/\S*/g, (m) => " ".repeat(m.length));
  let first = null;
  for (const re of ISSUE_RES) {
    re.lastIndex = 0;
    for (const m of masked.matchAll(re)) {
      if (linked.has(m[1])) continue;
      if (!first || m.index < first.index) first = { index: m.index, excerpt: m[0].trim() };
      break;
    }
  }
  return first;
}

// A code span or a line whose first word is a known command is a command, not a reference:
// the file names inside it are its arguments (`bun file.js`, `zsh script.sh`).
const COMMANDS = new Set([...KNOWN_BINARIES, "head", "tail", "wc", "diff", "less", "sort", "xargs", "env", "tee"]);
const isCommand = (s) => COMMANDS.has(s.trim().replace(/^[$%❯]\s+/, "").split(/\s+/)[0].replace(/^["']/, ""));

// A line that opens with its own bold CLAIM or CITE label (`- **CLAIM:** grep … returned
// nothing`) is a receipt written inline; receiptLines covers the label-alone form.
const INLINE_LABEL = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\*\*(?:CLAIM|CITE)\b/;

function fileName(line) {
  if (!MAY_FILE.test(line)) return null;
  const masked = blank(line, URL_RE).replace(SPAN_RE, (m, inner) => (isCommand(inner) ? " ".repeat(m.length) : m));
  const links = linksOf(line);
  FILE_TOKEN_RE.lastIndex = 0;
  for (const m of masked.matchAll(FILE_TOKEN_RE)) {
    const name = lastSegment(m[1]);
    if (links.some((l) => l.includes(name))) continue;
    return { index: m.index, excerpt: m[1] };
  }
  return null;
}

function artifact(line) {
  if (!MAY_ARTIFACT.test(line)) return null;
  const masked = blank(line, SPAN_RE);
  ARTIFACT_RE.lastIndex = 0;
  for (const m of masked.matchAll(ARTIFACT_RE)) {
    const after = line.slice(m.index + m[0].length, sentenceEnd(masked, m.index + m[0].length));
    if (linksOf(after).length || MD_LINK_RE.test(after)) continue;
    return { index: m.index, excerpt: m[0] };
  }
  return null;
}

function branch(line) {
  if (!line.includes("`") || !BRANCH_WORD_RE.test(blank(line, SPAN_RE))) return null;
  if (PR_URL_RE.test(line)) return null;
  if ((line.match(ABS_PATH_RE) ?? []).length) return null;
  SPAN_RE.lastIndex = 0;
  for (const m of line.matchAll(SPAN_RE)) {
    if (BRANCH_TOKEN_RE.test(m[1].trim())) return { index: m.index, excerpt: m[0] };
  }
  return null;
}

const DETECTORS = { "issue-ref": issueRef, "file-name": fileName, artifact, branch };

export function checkLinkTheReference(text, options = {}) {
  const kinds = { ...DEFAULT_KINDS };
  if (options.kinds && typeof options.kinds === "object") {
    for (const k of KINDS) if (typeof options.kinds[k] === "boolean") kinds[k] = options.kinds[k];
  }
  const active = KINDS.filter((k) => kinds[k]);

  const result = { applicable: false, flagged: false, reason: "no-prose", findings: [] };
  if (!active.length) {
    result.reason = "no-kind-enabled";
    return result;
  }

  const entries = classifyLines(String(text ?? ""));
  let receipts = null; // computed only when a candidate line exists
  for (const e of entries) {
    if (e.kind !== "prose" || e.raw.includes("→")) continue;
    result.applicable = true;
    let hit = null;
    for (const k of active) {
      const h = DETECTORS[k](e.raw);
      if (h && (!hit || h.index < hit.index)) hit = { ...h, kind: k };
    }
    if (!hit || INLINE_LABEL.test(e.raw) || isCommand(e.raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))) continue;
    receipts ??= receiptLines(entries);
    if (receipts.has(e.number)) continue;
    result.findings.push({ line: e.number, where: `line ${e.number}`, kind: hit.kind, excerpt: hit.excerpt });
  }
  result.flagged = result.findings.length > 0;
  result.reason = result.flagged ? "unlinked-reference" : result.applicable ? "all-linked" : "no-prose";
  return result;
}

// Real paths on both sides: node resolves the main module through symlinks; a raw argv compare is a silent no-op there.
const invokedDirectly = await (async () => {
  try {
    const [{ realpathSync }, { fileURLToPath }] = await Promise.all([import("node:fs"), import("node:url")]);
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (invokedDirectly) {
  const { readFileSync } = await import("node:fs");
  const path = process.argv[2];
  let text = "";
  try {
    text = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: `could not read ${path || "stdin"}: ${err.message}` }) + "\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(checkLinkTheReference(text), null, 2) + "\n");
  process.exit(0);
}
