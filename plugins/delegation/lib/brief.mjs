// brief.mjs — the pure half of the spawn gates and the stop warning, shared by the Claude Code
// hooks (hooks/spawn-gate.mjs, hooks/subagent-stop.mjs) and the OMP adapter
// (omp/delegation-omp.ts). No I/O, never throws on a string input.
//
// WHAT IS MATCHED, AND ONLY THIS: a literal Markdown heading line, any level 1 to 6, whose
// text is `How it fails` or `Spiral bound` (case-insensitive; a trailing parenthetical such as
// `(builder)`, a trailing colon and closing hashes are allowed; up to three leading spaces, like
// CommonMark). A heading inside a fenced code block (``` or ~~~) does not count. Nothing else in
// the prompt is inspected: not whether the section has content, not prose that mentions the
// words. A gate that reads prose is a gate that argues; this one reads a heading. The session-brief
// gate reads the same way for all five SESSION_HEADINGS, so `# Target: the repo` (text on the
// heading line) is not a Target heading.
//
// BUILDER-CLASS: an agent name is compared bare: trimmed, lower-cased, any `plugin:` or
// `dir/` prefix dropped, so `newdle:builder`, `agents/builder` and `Builder` all match
// `builder`. A name in the read-only list (config `readOnlyAgents`) is never builder-class,
// whatever `builderClass` says. The spawn gate maps a missing subagent_type to Claude Code's
// default agent, `general-purpose`; the stop warning does not (an empty agent_type there is one
// of Claude Code's internal agents).
//
// STOPPED BECAUSE: a builder-class report's last non-empty line is `Stopped because: <value>`,
// where value starts with one of STOPPED_VALUES and may carry a detail after it
// (`bound hit (two retries on the lint step)`). Backticks, bold or italics around the line are
// ignored. A `Stopped because:` line that is not the last non-empty line does not count.

export const TARGET = "Target";
export const CHANGE = "Change";
export const ACCEPTANCE = "Acceptance";
export const HOW_IT_FAILS = "How it fails";
export const SPIRAL_BOUND = "Spiral bound";
/** The five headings a prompt for a new desktop session (`mcp__ccd_session__start_session`) carries, in order. */
export const SESSION_HEADINGS = Object.freeze([TARGET, CHANGE, ACCEPTANCE, HOW_IT_FAILS, SPIRAL_BOUND]);
export const START_SESSION_TOOL = "mcp__ccd_session__start_session";
export const TEMPLATE = "templates/builder-brief.md";
export const DEFAULT_AGENT = "general-purpose";
export const STOPPED_VALUES = Object.freeze(["acceptance met", "bound hit", "told to stop"]);

// THE SECTIONS, verbatim. A deny carries the whole missing section as a fill-in template, so a
// parent in a plain session with no convention behind it can rewrite the brief from the
// refusal alone (Jo, 2026-11-04: nobody will be hand-writing these from memory). The template
// file templates/builder-brief.md carries the same text; test/manifest.test.mjs holds the two
// equal, so this file is the source and the template is its copy.
export const TARGET_SECTION = `## Target

Repository, branch or worktree, the files in play, and what is out of scope.`;

export const CHANGE_SECTION = `## Change

The steps, in order, with the interfaces each one has to keep.`;

export const ACCEPTANCE_SECTION = `## Acceptance

What the parent will check, exactly: the command, what green looks like, what is reported back.`;

export const HOW_IT_FAILS_SECTION = `## How it fails

- What breaks if this is wrong, and where it shows first (a test, a log line, a user-visible surface).
- What recovery looks like: the undo command, the file to restore, the migration to roll back.
- The retry bound per failing step: one retry, then the failure is reported as a named item rather than chased.`;

export const SPIRAL_BOUND_SECTION = `## Spiral bound

- Retry bound: one retry per failing step. The second failure of the same step stops the work on that step.
- Commit budget: at most N commits (name N). Past it, stop and report what remains.
- When acceptance cannot be met: report what was tried, the exact failure, and the last green state. Do not loosen the check, skip the step, or substitute an easier problem.
- Time or tool budget, when there is one: name it.`;

/** The line a builder-class report ends with; the stop warning quotes it. */
export const STOPPED_LINE = `Stopped because: ${STOPPED_VALUES.join(" | ")}`;
export const STOPPED_SECTION = `## Report

Lead the report with the outcome in its first sentence: what happened or what was found. Then: what changed, what was verified, what could not be confirmed, and anything needing the owner's decision.

End the report with exactly one of these lines, as the last line:

\`\`\`
Stopped because: acceptance met
Stopped because: bound hit
Stopped because: told to stop
\`\`\`

\`acceptance met\` means every acceptance check above passed once. \`bound hit\` means a retry, commit, time or tool bound stopped the work before acceptance; name which after it, as in \`Stopped because: bound hit (commit budget)\`. \`told to stop\` means the parent sent a stop. Nothing else is a valid value, and a builder-class report without the line draws a warning: shown to the user on Claude Code, added to the parent's context on OMP.`;

/**
 * The block a fresh session is given before its first spawn (SessionStart on Claude Code,
 * before_agent_start once per session on OMP): the whole brief skeleton inline, under 25
 * lines, so the gate is a backstop and not the first time the rule is seen.
 * @param {string[]} builderClass  the configured builder-class names, for the one line that names them
 */
export function sessionBlock(builderClass) {
  return `# Delegation: how to brief a subagent (delegation plugin)

Before any Agent/Task call, the prompt you hand the subagent carries these sections, in this order. A spawn without \`## How it fails\` is refused; a builder-class spawn (${builderClass.join(", ")}) without \`## Spiral bound\` or without this session's pattern-check receipt is refused. A \`mcp__ccd_session__start_session\` prompt carries all five headings below, each alone on its line, or the start is refused. The refusal carries the missing section as a fill-in template. Teaching: the \`delegation\` skill; template: templates/builder-brief.md in the plugin.

# Target
the repository, branch, files in play, and the non-goals
# Change
the steps in order, with the interfaces each keeps
# Acceptance
the exact command, what green looks like, what is reported back
## How it fails
- what breaks if this is wrong and where it shows first; the undo; one retry per failing step, then report the failure as a named item
## Spiral bound
- one retry per failing step; a commit budget (name N); when acceptance cannot be met, report what was tried and the last green state instead of loosening the check or skipping the step

The report from a builder-class agent leads with the outcome in its first sentence (what happened or what was found), then what changed, what was verified, what could not be confirmed, and anything needing the owner's decision; it ends with one line: \`${STOPPED_LINE}\`. Facts in any report are labeled only with a receipt: **CLAIM** (file:line, or command and output) or **CITE** (a fetched URL or live probe); everything else is unlabeled prose.

Which agent: \`scout\` finds paths and lines; \`reader\` maps code you will not read yourself; \`research\` answers from fetched sources; \`planner\` orders the steps before code; \`builder\` changes code (a handful of files, one repository); \`auditor\`, \`checker\`, \`debugger\` for review, verification, root cause. A message to a subagent that could not be delivered is marked NOT delivered next to the tool result; spawn a new agent or fix the name.`;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lower = (s) => s.toLowerCase();
const isWs = (c) => c === " " || c === "\t";
const skipWs = (line, i) => {
  while (i < line.length && isWs(line[i])) i++;
  return i;
};

/**
 * A single left-to-right scan of one line, so a line of any length costs time linear in it (no
 * backtracking). Grammar: up to three leading spaces or tabs, one to six `#`, whitespace, the
 * title, then optionally whitespace and a parenthetical without nested parentheses, whitespace,
 * a colon, whitespace, closing `#`s and whitespace, then the end of the line.
 */
function headingMatches(line, title) {
  let i = 0;
  while (i < 3 && i < line.length && isWs(line[i])) i++;
  const hashes = i;
  while (i < line.length && line[i] === "#") i++;
  const level = i - hashes;
  if (level < 1 || level > 6) return false;
  const afterHashes = i;
  i = skipWs(line, i);
  if (i === afterHashes) return false;
  if (lower(line.slice(i, i + title.length)) !== lower(title)) return false;
  i = skipWs(line, i + title.length);
  if (line[i] === "(") {
    const close = line.indexOf(")", i + 1);
    if (close === -1 || line.slice(i + 1, close).includes("(")) return false;
    i = skipWs(line, close + 1);
  }
  if (line[i] === ":") i = skipWs(line, i + 1);
  while (i < line.length && line[i] === "#") i++;
  return skipWs(line, i) === line.length;
}
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const STOPPED_RE = /^Stopped because:[*_]{0,2}[ \t]*(.*)$/i;
const VALID_STOPPED_RE = new RegExp(`^(?:${STOPPED_VALUES.map(escape).join("|")})(?:$|[ \\t]*[(:;,\\u2014\\u2013-][\\s\\S]*$|[ \\t]+[\\s\\S]*$)`);

/**
 * The lines of `text` outside fenced code blocks (``` or ~~~, closed by the same character, at
 * least as long). With `closeOpenFence`, a fence that never closes ends at the end of the text
 * and its opening line is the only line dropped, so sections appended after an unclosed fence
 * still count; without it (the spawn gates) an unclosed fence runs to the end, as in CommonMark.
 */
function unfencedLines(text, { closeOpenFence = false } = {}) {
  const out = [];
  let fence = null;
  let inside = [];
  for (const line of text.split(/\r?\n/)) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
        fence = null;
        inside = [];
      } else if (closeOpenFence) inside.push(line);
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  if (fence && closeOpenFence) out.push(...inside);
  return out;
}

/** True when `text` has a heading line titled `title`. A non-string is false. */
export function hasHeading(text, title, opts) {
  if (typeof text !== "string") return false;
  return unfencedLines(text, opts).some((line) => headingMatches(line, title));
}

/** The bare agent name: trimmed, lower-cased, `plugin:`/`dir/` prefix dropped. */
export function agentKey(name) {
  return String(name ?? "").trim().toLowerCase().split(/[:/]/).at(-1) ?? "";
}

/** Is bare `name` in `list` (bare names)? */
export function inList(name, list) {
  const key = agentKey(name);
  return key !== "" && list.some((b) => agentKey(b) === key);
}

/**
 * Is `name` builder-class: in `builderClass` and not in `readOnly`? An empty or missing name is
 * DEFAULT_AGENT (the spawn gate's reading; the stop warning screens out an empty name first).
 */
export function isBuilderClass(name, builderClass, readOnly = []) {
  const key = agentKey(name) || DEFAULT_AGENT;
  return inList(key, builderClass) && !inList(key, readOnly);
}

/**
 * Which required headings `prompt` lacks, in order. `builder` turns the Spiral-bound
 * requirement on; the two `require*` flags come from the config.
 * @returns {string[]} a subset of [HOW_IT_FAILS, SPIRAL_BOUND]
 */
export function missingHeadings(prompt, { builder, requireHowItFails = true, requireSpiralBound = true }) {
  const missing = [];
  if (requireHowItFails && !hasHeading(prompt, HOW_IT_FAILS)) missing.push(HOW_IT_FAILS);
  if (builder && requireSpiralBound && !hasHeading(prompt, SPIRAL_BOUND)) missing.push(SPIRAL_BOUND);
  return missing;
}

const shortType = (t) => {
  const s = String(t ?? DEFAULT_AGENT).trim() || DEFAULT_AGENT;
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};

/**
 * The deny reason for gate 1 / gate 4: names the missing heading(s) and carries each missing
 * section in full, as a fill-in template, so the brief can be rewritten from the refusal alone.
 * A builder-class refusal also carries the closing line the report has to end with.
 */
export function headingReason(missing, subagentType, { builder = missing.includes(SPIRAL_BOUND) } = {}) {
  const type = shortType(subagentType);
  const both = missing.includes(HOW_IT_FAILS) && missing.includes(SPIRAL_BOUND);
  const head = both
    ? `Spawn refused: the prompt has no "## ${HOW_IT_FAILS}" or "## ${SPIRAL_BOUND}" heading; builder-class "${type}" needs both.`
    : missing.includes(SPIRAL_BOUND)
      ? `Spawn refused: builder-class "${type}" needs a "## ${SPIRAL_BOUND}" heading too.`
      : `Spawn refused: the prompt has no "## ${HOW_IT_FAILS}" heading.`;
  const sections = missing.map((m) => (m === HOW_IT_FAILS ? HOW_IT_FAILS_SECTION : SPIRAL_BOUND_SECTION));
  const closing = builder ? ` The report ends with one line: \`${STOPPED_LINE}\`.` : "";
  return `${head} Re-issue the spawn with the same prompt plus the section${sections.length > 1 ? "s" : ""} below, filled in (keep the heading line as written; the gate reads it literally).${closing} Full template: ${TEMPLATE} in the delegation plugin.\n\n${sections.join("\n\n")}`;
}

const SECTION_OF = Object.freeze({ [TARGET]: TARGET_SECTION, [CHANGE]: CHANGE_SECTION, [ACCEPTANCE]: ACCEPTANCE_SECTION, [HOW_IT_FAILS]: HOW_IT_FAILS_SECTION, [SPIRAL_BOUND]: SPIRAL_BOUND_SECTION });

/**
 * Which of the five SESSION_HEADINGS `prompt` lacks, in order. A non-string lacks all five.
 * @returns {string[]}
 */
export function missingSessionHeadings(prompt) {
  return SESSION_HEADINGS.filter((h) => !hasHeading(prompt, h, { closeOpenFence: true }));
}

const headingList = (missing) => missing.map((m) => `"## ${m}"`).join(", ");
const plural = (missing) => (missing.length > 1 ? "s" : "");

/**
 * The deny reason for a thin `start_session` prompt: names the missing headings, says each heading
 * line holds the heading alone, and carries each missing section in full, so the prompt can be
 * rebuilt from the refusal alone.
 */
export function sessionHeadingReason(missing) {
  const s = plural(missing);
  return `Session start refused: the prompt lacks the heading line${s} ${headingList(missing)}. A prompt for \`${START_SESSION_TOOL}\` carries five heading lines: ${SESSION_HEADINGS.join(", ")}. Re-issue the same call with the same fields and the same prompt plus the section${s} below, filled in. Each heading line holds the heading alone, as \`## Target\` with the repository on the line under it. If the call was an offer (\`initiation: own_initiative\`), re-issue it as an offer; the owner saw nothing yet. Full template: ${TEMPLATE} in the delegation plugin.\n\n${missing.map((m) => SECTION_OF[m]).join("\n\n")}`;
}

/** The warn-only line (config `checks["session-brief-gate"]: "warn"`): the call goes ahead. */
export function sessionHeadingWarning(missing) {
  const s = plural(missing);
  return `delegation: this \`${START_SESSION_TOOL}\` prompt lacks the heading line${s} ${headingList(missing)}. The session start goes ahead; the repair is a follow-up message to that session carrying the missing section${s} from ${TEMPLATE} in the delegation plugin, each heading alone on its line.`;
}

/**
 * The `Stopped because:` verdict of a report: judged on its last non-empty line only.
 * `found` is true when any line of the report is a `Stopped because:` line; `misplaced` when
 * one is, but not the last non-empty line.
 * @returns {{ found: boolean, value: string|null, valid: boolean, misplaced: boolean }}
 */
export function stoppedBecause(text) {
  const none = { found: false, value: null, valid: false, misplaced: false };
  if (typeof text !== "string") return none;
  const lines = text.split(/\r?\n/).map(stripWrap).filter((l) => l !== "");
  if (!lines.length) return none;
  const m = STOPPED_RE.exec(lines.at(-1));
  if (m) {
    const value = stoppedValue(m[1]);
    return { found: true, value, valid: VALID_STOPPED_RE.test(value), misplaced: false };
  }
  const earlier = lines.findLast((l) => STOPPED_RE.test(l));
  if (!earlier) return none;
  return { found: true, value: stoppedValue(STOPPED_RE.exec(earlier)[1]), valid: false, misplaced: true };
}

/** A line with surrounding whitespace, and backticks and bold/italic markers at its start or a trailing backtick, removed. */
function stripWrap(line) {
  return line.trim().replace(/^[`*_]+/, "").replace(/`+$/, "").trim();
}

const stoppedValue = (raw) => raw.replace(/[*_`.]+$/g, "").replace(/^[*_`]+/g, "").trim().toLowerCase();

/**
 * The warning for a builder-class report with no valid `Stopped because:` line. It says the
 * exact line to add, so the next brief (or a resumed subagent) can be fixed from the warning alone.
 */
export function stopWarning(agentType, agentId, verdict) {
  const who = `builder-class agent "${shortType(agentType)}"${agentId ? ` (${agentId})` : ""}`;
  const what = verdict.misplaced
    ? `has "Stopped because: ${verdict.value}" but not as its last line`
    : verdict.found
      ? `ended with "Stopped because: ${verdict.value}", which is not one of the three values`
      : `ended without a "Stopped because:" line`;
  return `delegation: ${who} ${what}. Its report is unfinished until it says which applies. The report's last line is exactly one of: \`Stopped because: acceptance met\` (every acceptance check passed once), \`Stopped because: bound hit\` (a retry, commit, time or tool bound stopped it; name which after it), \`Stopped because: told to stop\` (the parent sent a stop). The next builder-class brief needs: "End your report with one line: ${STOPPED_LINE}." Full template: ${TEMPLATE} in the delegation plugin.`;
}

/** The sentence gate 3 appends to the host's own message. */
export const NOT_DELIVERED = "this message was NOT delivered; spawn a new agent or fix the name";
