// rules.mjs — the skill's eleven rules and the Stop checks bound to them, defined once.
//
// RULES are the `## N. Heading` sections of skills/i-have-audhd/SKILL.md, each with a stable
// id. The id is what the profile's `inject.rules` switches key on; the number and heading are
// what every finding cites. rules.test.mjs fails when SKILL.md's headings drift from this list.
//
// CHECKS maps every Stop check id (the key `enforcement.rules` uses) to the rule it enforces.
// This is each check's declaration of its rule: a check bound to a rule the profile switched
// off defaults to off (lib/config.mjs effectiveMode), and its findings cite the rule's heading.
//
// compileCore turns the injected span of SKILL.md into the text a session receives with some
// rules switched off: each disabled rule's core block (the paragraphs opened by
// `**Name (rule N).**`) and its line in the closing rule list are removed.

export const RULES = [
  { number: 1, id: "skeleton", heading: "Skeleton" },
  { number: 2, id: "layer", heading: "Layer" },
  { number: 3, id: "blunt-facts", heading: "Blunt facts, declarative requests" },
  { number: 4, id: "recommend", heading: "Recommend; at most two open decisions" },
  { number: 5, id: "grade-signals", heading: "Grade every signal" },
  { number: 6, id: "references", heading: "References survive without scrolling" },
  { number: 7, id: "assumptions", heading: "Assumptions and intent" },
  { number: 8, id: "resume", heading: "Resume by restating content" },
  { number: 9, id: "durable", heading: "Durable means written" },
  { number: 10, id: "commands", heading: "Commands handed to the user" },
  { number: 11, id: "machinery-anchors", heading: "Machinery anchors" },
];

export const RULE_IDS = RULES.map((r) => r.id);

const byId = new Map(RULES.map((r) => [r.id, r]));
const byNumber = new Map(RULES.map((r) => [r.number, r]));

export const CHECKS = {
  "needs-you-first": "skeleton",
  "closing-ask-last": "skeleton",
  "do-not-batch-by-label": "skeleton",
  "conclusion-first": "skeleton",
  "plural-back-reference": "references",
  "restate-resumed-thread": "resume",
  "handed-command": "commands",
  "name-the-artifact": "machinery-anchors",
  "link-the-reference": "machinery-anchors",
  "report-what-you-did-not-do": "machinery-anchors",
  "bad-news-first": "machinery-anchors",
};

export const CHECK_IDS = Object.keys(CHECKS);

// "i-have-audhd rule 11, Machinery anchors" for a check id; "" for an unknown one.
export function ruleRef(checkId) {
  const rule = byId.get(CHECKS[checkId]);
  return rule ? `i-have-audhd rule ${rule.number}, ${rule.heading}` : "";
}

// The rule a check is bound to, or undefined.
export const ruleOf = (checkId) => CHECKS[checkId];

const CORE_BLOCK = /^\*\*[^*]+\(rule (\d+)\)\.\*\*/;
const LIST_ITEM = /^- (\d+)\. /;
const LIST_INTRO = /^Every rule, by heading/;

// The injected span with every rule in `disabled` (a Set of rule ids) removed. With nothing
// disabled it returns `span` unchanged.
export function compileCore(span, disabled) {
  if (!disabled || !disabled.size) return span;
  const off = (n) => disabled.has(byNumber.get(Number(n))?.id);
  const out = [];
  let skipping = false;
  for (const line of span.split("\n")) {
    const block = CORE_BLOCK.exec(line);
    if (block) skipping = off(block[1]);
    else if (LIST_INTRO.test(line)) skipping = false;
    if (skipping) continue;
    const item = LIST_ITEM.exec(line);
    if (item && off(item[1])) continue;
    out.push(line);
  }
  // No rule left in the list: drop the list's intro line too.
  if (!out.some((l) => LIST_ITEM.test(l))) {
    const at = out.findIndex((l) => LIST_INTRO.test(l));
    if (at !== -1) out.splice(at, 1);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
