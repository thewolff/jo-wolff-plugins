// proposal.mjs — does a reply propose a plan or design?
//
// The Stop hook refuses a turn that proposed a plan or design when the session has no receipt.
// ask-graham's nudge leaves "is this a new idea?" to the agent reading the message; a Stop hook
// has no agent to ask, so this is a fixed list of signals over the reply text, using the same
// idea of "a message proposing a new project, product, feature, or tool that does not exist yet":
//
//   - an ask-graham verdict of `start now` or `later` (the two that commit to building);
//   - a heading or bold label naming a plan, design, proposal, approach, architecture, or
//     implementation steps;
//   - a sentence that opens with "I propose", "Here's the plan", "The plan is", "Proposed
//     approach", "My recommendation is to build";
//   - a numbered list of three or more steps under any of those labels.
//
// It is a heuristic and says so in the README: a plan written without any of these shapes is not
// caught, and a reply that quotes someone else's plan is. False positives cost one refusal naming
// the command; false negatives are the PreToolUse counter's to catch.

const VERDICT = /\*\*verdict:\*\*\s*(start now|later)\b/i;
const LABEL_WORDS = String.raw`(?:implementation\s+plan|implementation\s+steps|next\s+steps|proposed\s+(?:design|approach|architecture|plan|solution)|design\s+proposal|plan\s+of\s+(?:record|attack)|plan|design|proposal|approach|architecture|roadmap)`;
const HEADING = new RegExp(String.raw`^\s{0,3}#{1,6}\s+(?:[\w\s:'-]*\b)?${LABEL_WORDS}\b`, "im");
const BOLD_LABEL = new RegExp(String.raw`^\s*\*\*(?:[\w\s'-]*\b)?${LABEL_WORDS}\b[^*]*\*\*`, "im");
const OPENERS = [
  /\bI propose\b/i,
  /\bhere(?:'s| is) (?:the|my|a) (?:plan|design|proposal|approach)\b/i,
  /\bthe plan is\b/i,
  /\bproposed approach\b/i,
  /\bmy recommendation is to build\b/i,
  /\bI(?:'d| would) (?:build|structure|design|implement) (?:it|this) (?:as|like|with)\b/i,
];

/**
 * @param {string} text the reply
 * @returns {{ proposes: boolean, signal: string|null }}
 */
export function proposesPlan(text) {
  if (typeof text !== "string" || text.trim() === "") return { proposes: false, signal: null };
  const verdict = text.match(VERDICT);
  if (verdict) return { proposes: true, signal: `verdict: ${verdict[1].toLowerCase()}` };
  const heading = text.match(HEADING);
  if (heading) return { proposes: true, signal: `heading: ${heading[0].trim()}` };
  const bold = text.match(BOLD_LABEL);
  if (bold) return { proposes: true, signal: `label: ${bold[0].trim()}` };
  for (const re of OPENERS) {
    const m = text.match(re);
    if (m) return { proposes: true, signal: `opener: ${m[0]}` };
  }
  return { proposes: false, signal: null };
}
