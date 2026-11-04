#!/usr/bin/env node
// links-resolve.mjs — links-resolve: a link the message hands the reader opens.
//
// WHAT IT DECIDES
//   Skill rule 11 (Machinery anchors): a reference the reader can open. link-the-reference
//   asks whether a named thing carries a link; this check asks whether the link itself leads
//   anywhere, with nothing but the local disk and a local cache:
//
//   missing-path  a local path in a code span or a markdown link — `/absolute`, `~/home`, or
//                 `file://` — that does not exist. A `file://` URL is decoded first, then line
//                 and column suffixes are stripped (`:41`, `:41-50`, `:307–321`, `:18,22`,
//                 `:13-14,56-59`, `#L12`). Never for a sentence that says the file is still
//                 to come ("will be written", "I'll save it to", "Step 3: … save them to",
//                 "Plan:", "once it lands", "didn't save") or gone ("removed", "deleted", "no
//                 longer exists"), nor for a span that is a command (`rm /x`), nor for a
//                 placeholder (`/path/to/<name>`, a glob, a `$VAR`), nor for a missing path
//                 that is a slash command or an HTTP route (ROUTE_RE: one segment with no dot,
//                 `/mcp`, `/wrap-up`, `/health`; or a `:param` segment, `/messages/:id/x`).
//   gh-shape      a github.com URL whose number segment is not `/issues/N` or `/pull/N`
//                 (`/issue/N`, `/pulls/N`): GitHub has no such page.
//   gh-word       the word nearest before the URL (at most WORD_WINDOW tokens back, not past
//                 an earlier URL) calls it a PR and the URL says `/issues/N`, or the reverse.
//                 GitHub redirects either way, so the page opens; the word is what misleads.
//   gh-missing    the local cache (lib/gh-cache.mjs) says GitHub answered 404 for it, inside
//                 the miss TTL.
//   gh-kind       the cache says the target is a PR and the URL says `/issues/N`, or the
//                 reverse (the page opens through a redirect; the path is the wrong kind).
//
//   A GitHub URL with no fresh cache entry is UNKNOWN: never a finding. Its key goes to
//   `lookups`, which the Stop hook hands to the detached helper (scripts/gh-cache-fill.mjs)
//   for a later stop. The hook never calls GitHub.
//
//   `agent://<id>` references are not checked: neither Claude Code nor OMP writes a registry
//   of agent ids to disk (looked for 2026-11-04 under ~/.omp and ~/.claude), so there is
//   nothing to resolve them against.
//
// WHAT NEVER COUNTS
//   Lines that are not the author's prose (checks/lines.mjs: fenced blocks, HTML comments,
//   blockquotes, headings, structural lines), and any line carrying `→` (evidence).
//
// ONE FINDING PER LINK, every link resolved is in `links` for the optional judge stage
//   (the Stop hook's links-judge): { line, sentence, href, kind: "path"|"gh", title? }.
//
// Usage:
//   import { checkLinksResolve } from "./links-resolve.mjs";
//   node links-resolve.mjs message.md    # prints one JSON object, exit 0

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { classifyLines } from "./lines.mjs";
import { isCommand } from "./link-the-reference.mjs";
import { lookupGh, ghKey } from "../lib/gh-cache.mjs";

export const KINDS = ["missing-path", "gh-shape", "gh-word", "gh-missing", "gh-kind"];

const SPAN_RE = /`([^`\n]+)`/g;
const MD_LINK_RE = /\[[^\]\n]*\]\(([^)\s]+)\)/g;
const GH_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([^/\s`'"<>)\]]+)\/([^/\s`'"<>)\]]+)\/(issues?|pulls?)\/(\d+)(?![\w/-])/g;

// A local-path candidate: absolute, home, or file URL, with nothing else in the span.
const LOCAL_RE = /^(?:file:\/\/\S+|~(?:\/\S*)?|\/[^\s/]\S*)$/;
// Trailing line/column anchors and punctuation a sentence leaves on a path: one range or a
// comma list of them (`:41`, `:41-50`, `:307–321`, `:18,22`, `:13-14,56-59`, `#L12-L20`, `:7:3`).
const SUFFIX_RE = /(?:[:#]L?\d+(?:[-–]L?\d+)?(?:,L?\d+(?:[-–]L?\d+)?)*(?::\d+)?)?[.,;:)!?]*$/;
// A missing path that is a slash command or an HTTP route, not a file: one segment with no
// dot (`/mcp`, `/wrap-up`, `/health`; a real one-segment path such as `/tmp` exists), or any
// `:param` segment (`/:id`, `/messages/:id/delivered`).
const ROUTE_RE = /^\/[^/.\s]+\/?$|\/:[A-Za-z_]/;
// Placeholders: nothing on disk can be meant.
const PLACEHOLDER_RE = /[<>…*?$|{}[\]]|\.\.\.|(?:^|\/)(?:path\/to|abs|absolute|some|your)\//;

// The sentence says the file is still to come, or gone.
const NOT_NOW_RE =
  /\b(?:will|would|shall|should|going to|about to|planned|proposed|intend(?:s|ed)? to|expect(?:s|ed)? to|(?:I|we|you|it|they|he|she)['’]ll)\b[^.;]{0,60}\b(?:be|write|writes|written|create|creates|created|produce|produces|produced|generate|generates|generated|save|saves|saved|land|lands|landed|exist|exists|appear|appears|live|go|put|placed|end up)\b|\bto be (?:written|produced|created|generated|saved|placed|added)\b|\bonce (?:it|that|this|they|the \w+) (?:lands?|exists?|merges?|is (?:written|created|produced|in)|are (?:written|created|produced|in))\b|\bwhen (?:it|that|this|they|the \w+) (?:lands?|exists?|merges?|is (?:written|created|produced)|are (?:written|created|produced))\b|\b(?:not|never|no longer|isn't|isn’t|doesn't|doesn’t|don't|don’t|wasn't|wasn’t) (?:yet )?(?:exist|exists|there|present|written|created|produced|saved|generated|found)\b|\b(?:didn't|didn’t|did not|haven't|haven’t|have not|hasn't|hasn’t|has not) (?:yet )?(?:write|wrote|written|save|saved|create|created|produce|produced|generate|generated)\b|\bplan:|\bstep \d+\b|\bnot (?:yet|there|found)\b|\byet to (?:be|exist|land)\b|\b(?:removed|deleted|dropped|moved|renamed|unlinked|pruned|cleaned up|gone|absent|missing)\b|\brm(?: -\w+)? \b|\bwould(?: have)? (?:been|gone)\b/i;

const PR_WORD_RE = /^(?:PRs?|pull requests?)$/i;
const ISSUE_WORD_RE = /^issues?$/i;
// How far back from a GitHub URL its PR/issue word may sit, in whitespace tokens.
export const WORD_WINDOW = 6;

// The sentence's own words: code spans, link targets and URLs blanked, so a path or URL
// cannot supply the word the sentence is judged by.
export const proseOf = (sentence) =>
  sentence.replace(SPAN_RE, " ").replace(MD_LINK_RE, " ").replace(/https?:\/\/\S+/g, " ");

// A `.`/`!`/`?`/`;` at `i` ends a sentence when whitespace (or the end) follows, except the
// dot of `e.g.`, `i.e.`, `vs.` or of a dotted version number (`1.6.`, `v2.0.1.`).
function endsSentence(line, i) {
  if (!/[.!?;]/.test(line[i]) || !/\s/.test(line[i + 1] ?? " ")) return false;
  if (line[i] !== ".") return true;
  const before = line.slice(Math.max(0, i - 24), i);
  return !/(?:^|[\s(])(?:e\.g|i\.e|vs)$/i.test(before) && !/(?:^|[\s(])v?\d+(?:\.\d+)+$/.test(before);
}

// The sentence of `line` around index `at`: from the previous sentence end (or line start) to
// the next one (or the end).
export function sentenceAround(line, at) {
  let start = 0;
  for (let i = at - 1; i > 0; i--) {
    if (endsSentence(line, i)) {
      start = i + 1;
      break;
    }
  }
  let end = line.length;
  for (let i = at; i < line.length; i++) {
    if (endsSentence(line, i)) {
      end = i + 1;
      break;
    }
  }
  return line.slice(start, end).trim();
}

// The PR/issue word a GitHub URL at `at` is bound to: the nearest such word among the
// WORD_WINDOW tokens before it, in the same clause — never reaching back past the sentence
// start, a `,`/`;`/dash clause break, or an earlier URL. "pr", "issue", or null.
export function wordBefore(line, at) {
  let from = 0;
  for (let i = at - 1; i > 0; i--) {
    if (endsSentence(line, i)) {
      from = i + 1;
      break;
    }
  }
  for (const m of line.slice(0, at).matchAll(/https?:\/\/\S+|[,;—–]/g)) from = Math.max(from, m.index + m[0].length);
  const tokens = line.slice(from, at).replace(SPAN_RE, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(-WORD_WINDOW);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (PR_WORD_RE.test(tokens[i])) return "pr";
    if (ISSUE_WORD_RE.test(tokens[i])) return "issue";
    if (/^requests?$/i.test(tokens[i]) && /^pull$/i.test(tokens[i - 1] ?? "")) return "pr";
  }
  return null;
}

// `~/x` → <home>/x; `file:///x` → /x (decoded first, so `%E2%80%93` is an en dash before the
// suffix is stripped); a bare `/x` as is. null when it cannot be a path.
export function toLocalPath(candidate, home) {
  let c = candidate;
  if (PLACEHOLDER_RE.test(c.replace(SUFFIX_RE, ""))) return null;
  if (c.startsWith("file://")) {
    try {
      c = fileURLToPath(c);
    } catch {
      return null;
    }
  }
  c = c.replace(SUFFIX_RE, "");
  if (!c || PLACEHOLDER_RE.test(c)) return null;
  if (c === "~") c = home;
  else if (c.startsWith("~/")) c = home + c.slice(1);
  if (!c.startsWith("/")) return null;
  return c;
}

// Every local-path candidate on the line with its index: code spans holding only a path, and
// markdown link targets. A span that is a command is skipped (its paths are arguments).
function localCandidates(line) {
  const out = [];
  for (const m of line.matchAll(SPAN_RE)) {
    const s = m[1].trim();
    if (!LOCAL_RE.test(s) || isCommand(s)) continue;
    out.push({ raw: s, index: m.index });
  }
  for (const m of line.matchAll(MD_LINK_RE)) {
    const t = m[1].trim();
    if (LOCAL_RE.test(t)) out.push({ raw: t, index: m.index });
  }
  return out;
}

export function checkLinksResolve(text, options = {}) {
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;
  const cache = options.ghCache ?? null;
  const now = options.now ?? Date.now();

  const result = { applicable: false, flagged: false, reason: "no-prose", findings: [], lookups: [], links: [] };
  const entries = classifyLines(String(text ?? ""));
  const seenLookups = new Set();
  for (const e of entries) {
    if (e.kind !== "prose" || e.raw.includes("→")) continue;
    result.applicable = true;
    const line = e.raw;

    // Local paths.
    if (line.includes("/") || line.includes("~")) {
      for (const c of localCandidates(line)) {
        const path = toLocalPath(c.raw, home);
        if (!path) continue;
        const sentence = sentenceAround(line, c.index);
        if (NOT_NOW_RE.test(proseOf(sentence))) continue; // the path's own words (`gone.md`) do not exempt it
        if (exists(path)) result.links.push({ line: e.number, sentence, href: c.raw, path, kind: "path" });
        else if (!ROUTE_RE.test(path)) {
          result.findings.push({ line: e.number, where: `line ${e.number}`, kind: "missing-path", excerpt: c.raw, path });
        }
      }
    }

    // GitHub issue and PR URLs.
    if (line.includes("github.com/")) {
      for (const m of line.matchAll(GH_URL_RE)) {
        const [url, owner, repo, seg, number] = m;
        const sentence = sentenceAround(line, m.index);
        if (seg !== "issues" && seg !== "pull") {
          result.findings.push({ line: e.number, where: `line ${e.number}`, kind: "gh-shape", excerpt: url, segment: seg });
          continue;
        }
        const urlKind = seg === "pull" ? "pr" : "issue";
        const word = wordBefore(line, m.index);
        if (word && word !== urlKind) {
          result.findings.push({ line: e.number, where: `line ${e.number}`, kind: "gh-word", excerpt: url, word: word === "pr" ? "PR" : "issue", urlKind });
        }
        const key = ghKey(owner, repo, number);
        const known = cache ? lookupGh(cache, key, now) : null;
        if (!known) {
          if (!seenLookups.has(key)) {
            seenLookups.add(key);
            result.lookups.push(key);
          }
          continue; // unknown is never a finding
        }
        if (known.kind === "missing") {
          result.findings.push({ line: e.number, where: `line ${e.number}`, kind: "gh-missing", excerpt: url, key });
        } else if (known.kind !== urlKind) {
          result.findings.push({ line: e.number, where: `line ${e.number}`, kind: "gh-kind", excerpt: url, key, urlKind, actualKind: known.kind });
        } else {
          result.links.push({ line: e.number, sentence, href: url, key, kind: "gh", ghKind: known.kind, title: known.title });
        }
      }
    }
  }
  result.flagged = result.findings.length > 0;
  result.reason = result.flagged ? "unresolved-link" : result.applicable ? "all-resolve" : "no-prose";
  return result;
}

// Real paths on both sides: node resolves the main module through symlinks; a raw argv compare is a silent no-op there.
const invokedDirectly = await (async () => {
  try {
    const { realpathSync } = await import("node:fs");
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const { readFileSync } = await import("node:fs");
  const { readGhCache } = await import("../lib/gh-cache.mjs");
  const path = process.argv[2];
  let text = "";
  try {
    text = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: `could not read ${path || "stdin"}: ${err.message}` }) + "\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(checkLinksResolve(text, { ghCache: text.includes("github.com") ? readGhCache() : null }), null, 2) + "\n");
  process.exit(0);
}
