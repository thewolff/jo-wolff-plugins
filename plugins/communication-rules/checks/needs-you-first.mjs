#!/usr/bin/env node
// needs-you-first.mjs — the one predicate this plugin ships.
//
// WHAT IT DECIDES
//   Given one message: if a needs-you section exists, does any substantive prose come before it?
//   That is the whole question. Not whether the message is good, not whether it should have had
//   such a section, not whether the section contains the right things.
//
// WHY IT FLAGS MISORDERING AND NEVER ABSENCE
//   The dominant false positive for "needs-you first" is a message with nothing needing the
//   reader. A check that demands the section flags every routine answer — and the cheapest way to
//   satisfy such a check is an empty "Needs you: nothing." header, which puts ceremony in the
//   position the reader reads first. That is worse than no check. So absence is never a finding
//   here: no marker means not applicable, and not applicable is not a pass either.
//
// WHY THERE IS A LENGTH FLOOR
//   Short messages are the false-positive population for every structural check: an
//   acknowledgement, a one-line answer, a question. The default floor is 200 characters of
//   substantive prose. That number is a starting point, not a measurement of your corpus —
//   calibrate it before trusting the rate (reference.md, "Calibrate before you trust it").
//
// WHY IT IS LOG-ONLY AND REGISTERED NOWHERE
//   It returns a result. It cannot block a turn, cannot rewrite one, and the CLI exits 0 whether
//   it flags or not. No hook event in this plugin invokes it. A structural check whose
//   false-positive rate is unmeasured on your corpus must not be able to stop anything: the
//   cheapest way to satisfy a guard that fires wrongly is to stop writing the thing it misreads.
//
// Usage:
//   import { checkNeedsYouFirst } from "./needs-you-first.mjs";
//   node needs-you-first.mjs message.md      # prints one JSON object, exit 0

const DEFAULTS = {
  markers: ["Needs you"],
  minProseChars: 200,
  graceChars: 0,
};

// A heading is navigation and carries no content, so it neither counts as prose nor blocks a
// marker. Bold and colons are stripped so "**Needs you**", "## Needs you" and "Needs you:" are
// one marker rather than three.
function normalizeLine(line) {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s*:\s*$/, "")
    .trim();
}

function isHeading(line) {
  return /^\s{0,3}#{1,6}\s+\S/.test(line);
}

// Lines that contribute no substantive prose: blanks, rules, bare bullets, HTML comments,
// blockquotes (quoted material is not the author's assertion), and anything inside a fence.
function isStructural(line) {
  const t = line.trim();
  if (t === "") return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true;
  if (/^[-*+]$/.test(t)) return true;
  if (t.startsWith(">")) return true;
  if (t.startsWith("<!--") || t.endsWith("-->")) return true;
  if (/^\|[\s|:-]*\|$/.test(t)) return true; // table separator row
  return false;
}

function isFence(line) {
  return /^\s*(```|~~~)/.test(line);
}

export function checkNeedsYouFirst(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const markers = (Array.isArray(opts.markers) && opts.markers.length ? opts.markers : DEFAULTS.markers)
    .map((m) => String(m).toLowerCase().replace(/\s*:\s*$/, "").trim())
    .filter(Boolean);

  const result = {
    applicable: false,
    flagged: false,
    reason: "no-marker",
    markerLine: null,
    prosePrecedingChars: 0,
    proseChars: 0,
  };

  const lines = String(text ?? "").split(/\r?\n/);
  let inFence = false;
  let inComment = false;
  let markerLine = null;
  let proseBefore = 0;
  let proseTotal = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (isFence(raw)) {
      inFence = !inFence;
      continue;
    }
    // A marker inside a code block is an example of a marker, not one.
    if (inFence) continue;

    // Multi-line HTML comments (the output-types envelope is one) count as neither.
    if (!inComment && raw.trim().startsWith("<!--") && !raw.includes("-->")) inComment = true;
    else if (inComment) {
      if (raw.includes("-->")) inComment = false;
      continue;
    }
    if (inComment) continue;

    if (isStructural(raw)) continue;

    const norm = normalizeLine(raw);
    if (norm === "") continue;

    if (markerLine === null && markers.some((m) => norm.toLowerCase() === m || norm.toLowerCase().startsWith(m + " "))) {
      markerLine = i + 1;
      continue;
    }

    // Headings are navigation: they do not count as prose and do not delay a marker.
    if (isHeading(raw)) continue;

    proseTotal += norm.length;
    if (markerLine === null) proseBefore += norm.length;
  }

  result.proseChars = proseTotal;
  result.markerLine = markerLine;
  result.prosePrecedingChars = proseBefore;

  if (proseTotal < opts.minProseChars) {
    result.reason = "below-floor";
    return result;
  }
  if (markerLine === null) {
    result.reason = "no-marker";
    return result;
  }

  result.applicable = true;
  if (proseBefore > Math.max(0, Number(opts.graceChars) || 0)) {
    result.flagged = true;
    result.reason = "prose-precedes-marker";
  } else {
    result.reason = "marker-first";
  }
  return result;
}

// Profile loading lives with the hook; the exported function takes plain options so it stays
// testable with no filesystem at all; the CLI block below reads one.
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
  process.stdout.write(JSON.stringify(checkNeedsYouFirst(text), null, 2) + "\n");
  process.exit(0);
}
