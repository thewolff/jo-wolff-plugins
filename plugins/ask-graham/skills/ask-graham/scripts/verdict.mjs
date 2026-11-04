// verdict.mjs — the four verdicts an ask-graham answer ends in, in the order SKILL.md step 5 lists
// them, and the Stop check built on them. vocabulary.test.mjs checks SKILL.md's table and Output
// template against VERDICTS. The Claude Code Stop hook (hooks/ask-graham-stop.mjs) and the OMP
// session_stop handler (omp/ask-graham-omp.ts) both call checkStop; every function here is pure
// (no I/O), so the two harnesses differ only in how they read the transcript and keep the
// once-per-turn record.
//
// THE CHECK. A main-session turn that read the ask-graham skill must end in a line
// `**Verdict:** <one of VERDICTS>`, unless it ends by asking the comparables question and waiting
// with step 1 and step 3 above the question (a `**Ask:**` line and a `**Gate questions**` block
// with its five bullets: waitingMissing), or it is a structure check: a turn whose first use of the
// skill declared one (skillUse) and whose reply opens with `**Structure check:**` and then a
// `**Found:**` or `**No similar:**` line (SKILL.md "When it runs").
// When the user has a sources file (scripts/sources.mjs), a full check's verdict or waiting reply
// also needs its proof, in the turn since the skill load: a Read of the file, a run or read of each
// source it lists, and a `**Local search:**` block marking every source (sourcesMissing). A source
// marked unreachable for a policy reason (its command writes, or research was declined) needs no
// run. Without a sources file nothing more is required.
// A turn that did not read the skill, or whose only uses of it were settings invocations (`/ask-graham intensity`, `/ask-graham stop-check`), is not checked.
// The adapters skip the check entirely when the stop-check setting is off. The check blocks at most once per
// turn: the caller keeps the opener id of the turn it last blocked and passes it back as
// `blockedOpener`.
//
// TRANSCRIPTS. Both harnesses write an append-only JSONL file whose entries form a tree
// (uuid/parentUuid on Claude Code, id/parentId on OMP). The leaf is the last main-session entry
// that carries a parent field; Claude Code 2.1.317 also appends telemetry with an `id` and no
// parent field (`api-request`), which is skipped. The active turn is the chain from that leaf
// back to the last turn opener (a prompt the person sent), so a branch rewound away from is never
// read, with or without a new prompt. Claude Code 2.1.317 writes the final reply only after the
// Stop hooks run, so its Stop hook passes the reply in as `text` (fixtures/claude-code/).

export const VERDICTS = Object.freeze(["do it now", "start now", "later", "don't build"]);

// "don't" matches a straight or a curly apostrophe.
const VERDICT_ALT = VERDICTS.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("'", "['’]")).join("|");

// A line whose label is Verdict: optional list marker or heading, optional bold with the colon
// inside or outside it, optional emphasis around the verdict, then end, space or punctuation.
const VERDICT_LINE = new RegExp(
  String.raw`^[ \t]*(?:[-*+>][ \t]+|#{1,6}[ \t]+)?(?:\*\*|__)?Verdict(?::(?:\*\*|__)?|(?:\*\*|__)?:)[ \t]*(?:\*\*|__|\*|_)?(` +
    VERDICT_ALT +
    String.raw`)(?=$|\s|\p{P})`,
  "imu",
);

/** The verdict a text gives on a `Verdict:` line, as written in VERDICTS, or null. */
export function findVerdict(text) {
  if (typeof text !== "string") return null;
  const m = VERDICT_LINE.exec(text);
  if (!m) return null;
  const said = m[1].toLowerCase().replace("’", "'");
  return VERDICTS.find((v) => v === said) ?? null;
}

const isObject = (v) => v !== null && typeof v === "object";

/** Parse JSONL text into entries; a line that is not a JSON object is skipped. */
export function parseJsonl(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") entries.push(e);
    } catch {
      // a torn line in a transcript being written is not a reason to fail
    }
  }
  return entries;
}

// Claude Code entries carry uuid/parentUuid; OMP entries carry id/parentId.
const idOf = (e) => (typeof e.uuid === "string" ? e.uuid : typeof e.id === "string" ? e.id : null);
const parentOf = (e) => {
  const p = "parentUuid" in e ? e.parentUuid : e.parentId;
  return typeof p === "string" ? p : null;
};
// Whether an entry is on a conversation chain at all: it carries the parent field, null at a root.
// Claude Code 2.1.317 also appends telemetry with an `id` and no parent field (`api-request`), which
// is never a leaf.
const onChain = (e) => "parentUuid" in e || "parentId" in e;

// The text of a content value: a string, or the text blocks of an array joined by newlines.
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => isObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

// OMP: a `/skill:<name>` the user typed, leading or mid-prompt, which OMP stores as a
// user-attributed custom message (customType "skill-prompt"). Agent or autoload injections of the
// same type carry another attribution and are neither openers nor invocations.
const isUserSkillPrompt = (e) => e.type === "custom_message" && e.customType === "skill-prompt" && e.attribution === "user";

// Whether an entry opens a turn: a prompt the person sent.
//  - Claude Code: a `user` entry with string or text content. Not isMeta (a slash command's
//    expanded skill body), not a compact summary, not a tool_result. Hook output is written as
//    `attachment` or `system` entries, so it never opens a turn.
//  - OMP: a `message` with role user, or a user-invoked skill prompt. A session_stop
//    continuation is a custom message attributed to the agent, so it does not open a turn.
function isOpener(e) {
  if (e.type === "user") {
    if (e.isMeta || e.isCompactSummary || e.isSidechain) return false;
    const content = e.message?.content;
    if (typeof content === "string") return true;
    if (!Array.isArray(content)) return false;
    if (content.some((b) => isObject(b) && b.type === "tool_result")) return false;
    return content.some((b) => isObject(b) && (b.type === "text" || b.type === "image"));
  }
  if (e.type === "message") return e.message?.role === "user";
  return isUserSkillPrompt(e);
}

// Claude Code writes each block of one model response as its own entry, all with the same
// message.id. Parallel tool calls are such blocks, and their results are chained so that only
// one of them sits on the parent chain from the leaf (seen in real transcripts). The id of the
// response an assistant entry belongs to, for collecting those siblings back into the turn.
const responseId = (e) => (e.type === "assistant" && typeof e.message?.id === "string" ? e.message.id : null);

/**
 * The active turn of one parsed JSONL transcript, either harness: the turn opener's id and, in
 * file order, the opener plus every entry after it on the parent chain from the leaf (plus, on
 * Claude Code, the parallel blocks of a response on that chain). The leaf is the last main-session
 * entry on a chain, so telemetry without a parent field is skipped. When the chain ends without an
 * opener, the turn is the whole chain and its id is the chain's root. Null when no entry is on a
 * chain.
 */
export function currentTurn(entries) {
  if (!Array.isArray(entries)) return null;
  const byId = new Map();
  let leaf = null;
  for (const e of entries) {
    if (!isObject(e)) continue;
    const id = idOf(e);
    if (id === null || !onChain(e)) continue;
    byId.set(id, e);
    if (!e.isSidechain) leaf = e;
  }
  if (!leaf) return null;
  const chain = new Set();
  let opener = null;
  let root = leaf;
  for (let e = leaf; e && !chain.has(e); e = byId.get(parentOf(e))) {
    chain.add(e);
    root = e;
    if (isOpener(e)) {
      opener = e;
      break;
    }
  }
  const responses = new Set([...chain].map(responseId).filter(Boolean));
  const inTurn = (e) => chain.has(e) || (responses.has(responseId(e)) && !e.isSidechain);
  return { id: idOf(opener ?? root), entries: entries.filter((e) => isObject(e) && inTurn(e)) };
}

// `ask-graham` or `<plugin>:ask-graham` (Claude Code), `ask-graham` or `<ns>/ask-graham` (OMP).
const isSkillName = (name) => typeof name === "string" && /^(?:[^\s:/]+[:/])?ask-graham$/.test(name);

// A read of the skill file: OMP `skill://ask-graham`, `skill://<ns>/ask-graham` (optionally
// `/SKILL.md`), or any path ending `/ask-graham/SKILL.md`. An OMP `:<lines>` selector is ignored.
function isSkillPath(path) {
  if (typeof path !== "string") return false;
  const p = path.replace(/:[^/]*$/, "");
  return /^skill:\/\/(?:[^/]+\/)?ask-graham(?:\/SKILL\.md)?$/.test(p) || /(?:^|\/)ask-graham\/SKILL\.md$/.test(p);
}

// A read of the structure-check marker beside SKILL.md: `skill://[<ns>/]ask-graham/structure-check.md`
// or any path ending `/ask-graham/structure-check.md`. Reading it declares a structure check.
function isStructurePath(path) {
  if (typeof path !== "string") return false;
  const p = path.replace(/:[^/]*$/, "");
  return /^skill:\/\/(?:[^/]+\/)?ask-graham\/structure-check\.md$/.test(p) || /(?:^|\/)ask-graham\/structure-check\.md$/.test(p);
}

// The `User: <args>` line OMP's user-invocation template ends a skill prompt with.
function userLine(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith("User: "));
  return lines.length ? lines[lines.length - 1].slice("User: ".length) : null;
}

// Invocation args that ask for a settings subcommand: `intensity` or `stop-check`, optionally
// followed by more.
const isSettings = (args) => typeof args === "string" && /^(?:intensity|stop-check)(?:\s|$)/i.test(args.trim());
// Invocation args that declare a structure check: `structure-check`, optionally followed by more.
const isStructure = (args) => typeof args === "string" && /^structure-check(?:\s|$)/i.test(args.trim());

/**
 * Whether a turn read the ask-graham skill, whether every such use was a settings invocation, and
 * whether it is a structure check. Reading counts as: a Claude Code Skill tool call or
 * `/ask-graham` slash command, an OMP user-invoked `/skill:ask-graham`, or a file read (Claude Code
 * Read, OMP read) of the skill or its structure-check marker. A skill body pasted into an ordinary
 * prompt does not count. Returns `{ read, settingsOnly, structureCheck }`; settingsOnly is true iff
 * read is, and every use was an invocation whose args start with `intensity` or `stop-check`. A
 * file read, or an invocation with no args or other args, makes it false. structureCheck is true
 * iff the turn's first use that is not a settings invocation declared one (invocation args
 * starting `structure-check`, or a read of structure-check.md) and no use was an ordinary
 * invocation (no args, or args other than settings or `structure-check`). A first use that reads
 * SKILL.md or invokes the skill otherwise makes it a full check, and a later marker read cannot
 * change that.
 */
export function skillUse(turn) {
  const { read, settingsOnly, structureCheck } = scanSkillUse(turn);
  return { read, settingsOnly, structureCheck };
}

// skillUse plus `loadedAt`: the index in turn.entries of the first use that is not a settings
// invocation (-1 when none), where the sources proof starts counting tool calls.
function scanSkillUse(turn) {
  let read = false;
  let settingsOnly = true;
  let first = null; // "structure" or "full": the first use that is not a settings invocation
  let ordinary = false;
  let loadedAt = -1;
  let at = -1;
  const use = (kind) => {
    read = true;
    settingsOnly = false;
    if (first === null) loadedAt = at;
    first ??= kind;
  };
  const invoked = (a) => {
    read = true;
    if (isSettings(a)) return;
    if (isStructure(a)) return use("structure");
    ordinary = true;
    use("full");
  };
  const pathRead = (path) => {
    if (isSkillPath(path)) use("full");
    else if (isStructurePath(path)) use("structure");
  };
  for (const e of turn?.entries ?? []) {
    at++;
    if (e.type === "user" && isOpener(e)) {
      const text = contentText(e.message?.content);
      const name = /<command-name>\/?([^<]*)<\/command-name>/.exec(text);
      if (name && isSkillName(name[1].trim())) {
        const a = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
        invoked(a ? a[1] : null);
      }
    } else if (isUserSkillPrompt(e)) {
      const d = isObject(e.details) ? e.details : {};
      if (isSkillName(d.name)) invoked(typeof d.args === "string" ? d.args : userLine(contentText(e.content)));
    } else if (e.type === "assistant" || (e.type === "message" && e.message?.role === "assistant")) {
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!isObject(b)) continue;
        if (b.type === "tool_use" && b.name === "Skill" && isSkillName(b.input?.skill)) invoked(b.input?.args);
        else if (b.type === "tool_use" && b.name === "Read") pathRead(b.input?.file_path);
        else if (b.type === "toolCall" && b.name === "read") pathRead(b.arguments?.path);
      }
    }
  }
  return { read, settingsOnly: read && settingsOnly, structureCheck: first === "structure" && !ordinary, loadedAt };
}

/**
 * Every tool call on a turn from entry index `from` on, either harness, as `{ name, input }`: a
 * Claude Code `tool_use` block's input, an OMP `toolCall` block's arguments.
 */
export function toolCalls(turn, from = 0) {
  const calls = [];
  for (const e of (turn?.entries ?? []).slice(Math.max(0, from))) {
    if (!(e.type === "assistant" || (e.type === "message" && e.message?.role === "assistant"))) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!isObject(b)) continue;
      if (b.type === "tool_use" && isObject(b.input)) calls.push({ name: b.name, input: b.input });
      else if (b.type === "toolCall" && isObject(b.arguments)) calls.push({ name: b.name, input: b.arguments });
    }
  }
  return calls;
}

/**
 * The last assistant text on a turn. On Claude Code one response can span several entries with
 * the same message.id; their text is joined. Null when the turn has no assistant text.
 */
export function lastAssistantText(turn) {
  const list = turn?.entries ?? [];
  const textOf = (e) =>
    e.type === "assistant" || (e.type === "message" && e.message?.role === "assistant") ? contentText(e.message?.content) : "";
  for (let i = list.length - 1; i >= 0; i--) {
    if (!textOf(list[i]).trim()) continue;
    const rid = responseId(list[i]);
    if (!rid) return textOf(list[i]);
    return list
      .filter((e) => responseId(e) === rid)
      .map(textOf)
      .filter((t) => t.trim())
      .join("\n");
  }
  return null;
}

/** The reason a block gives the agent: what is missing, and the line to add. */
export const BLOCK_REASON =
  "ask-graham: this turn read the ask-graham skill, but the reply has no verdict line. Add one line " +
  `\`**Verdict:** <verdict>\` naming exactly one of: ${VERDICTS.join(", ")} (SKILL.md step 5). ` +
  "Reply with the verdict line and anything it changes only; do not resend the whole answer.";

/** The reason a structure check's block gives: its two opening lines (SKILL.md "When it runs"). */
export const STRUCTURE_BLOCK_REASON =
  "ask-graham: this turn is a structure check, but the reply does not open with its two lines. Start it with " +
  "`**Structure check:** <the new structure>`, then on the next line either `**Found:** <each match, with a file:line " +
  "receipt and how it overlaps>` or `**No similar:** <the parent, and what was searched>`. " +
  "Reply with those lines and anything they change only; do not resend the whole answer.";

// A structure check's reply: `**Structure check:** <text>` as its first line, then, as the next
// non-blank line, `**Found:** <text>` or `**No similar:** <text>`.
const STRUCTURE_REPLY = /^\*\*Structure check:\*\*[ \t]*\S[^\n]*\n(?:[ \t]*\n)*\*\*(?:Found|No similar):\*\*[ \t]*\S/;

/**
 * The Stop check for one stop. `entries` is the parsed transcript, `text` the final assistant
 * text (when absent, the last assistant text on the turn), `blockedOpener` the turn opener id
 * this caller last blocked in this session (or null), `sources` the user's parsed sources file
 * (scripts/sources.mjs readSources; null when there is none) and `home` the home directory `~`
 * and `$HOME` in its paths and in tool calls expand to.
 *
 * Returns `{ block: <reason>, opener }` when the stop must be blocked, which the caller records
 * as its new blockedOpener, or `{ pass: <why>, opener }` otherwise, `why` being one of
 * "no-turn", "no-skill-read", "settings" (every skill use was a settings invocation),
 * "verdict", "structure-check", "comparables-question", "already-blocked". `opener` is the turn
 * opener's id, or null with "no-turn". A structure check's block gives STRUCTURE_BLOCK_REASON; a
 * reply ending on the comparables question without step 1 and step 3 above it gets
 * waitingBlockReason, naming what it lacks. With a sources file, a full check whose reply has its
 * verdict or its waiting shape also needs the sources proof (sourcesMissing); without it the
 * block gives sourcesBlockReason. Without a sources file nothing more is required.
 */
export function checkStop({ entries, text, blockedOpener = null, sources = null, home = null } = {}) {
  const turn = currentTurn(entries);
  if (!turn) return { pass: "no-turn", opener: null };
  const opener = turn.id;
  const use = scanSkillUse(turn);
  if (!use.read) return { pass: "no-skill-read", opener };
  if (use.settingsOnly) return { pass: "settings", opener };
  const finalText = typeof text === "string" && text.trim() ? text : lastAssistantText(turn);
  const done = use.structureCheck ? structureDone(finalText) : fullDone(finalText);
  const missing = typeof done === "string" && !use.structureCheck && sources?.bullets?.length
    ? sourcesMissing({ calls: toolCalls(turn, use.loadedAt), reply: finalText ?? "", sources, home })
    : [];
  if (typeof done === "string" && !missing.length) return { pass: done, opener };
  if (blockedOpener !== null && blockedOpener === opener) return { pass: "already-blocked", opener };
  if (missing.length) return { block: sourcesBlockReason(missing), opener };
  if (use.structureCheck) return { block: STRUCTURE_BLOCK_REASON, opener };
  return { block: done ? waitingBlockReason(done.missing) : BLOCK_REASON, opener };
}

// A structure check is done only by its own shape: the reply opens with the label and its outcome
// line. A verdict or the comparables question does not stand in for it (SKILL.md "When it runs").
function structureDone(finalText) {
  return typeof finalText === "string" && STRUCTURE_REPLY.test(finalText.trimStart().replace(/\r\n/g, "\n"))
    ? "structure-check"
    : null;
}

// A full check is done by a verdict line, or by waiting on the comparables question: only the exact
// question on the final line signals a wait, not a quotation or a report mentioning it. A wait counts
// only with steps 1 and 3 above it (waitingMissing); without them the result is `{ missing }`.
function fullDone(finalText) {
  if (findVerdict(finalText)) return "verdict";
  if (typeof finalText === "string" &&
      /(?:^|\n)[ \t]*Do you want me to research and see if something comparable exists\?[ \t]*$/.test(finalText.trimEnd())) {
    const missing = waitingMissing(finalText);
    return missing.length ? { missing } : "comparables-question";
  }
  return null;
}

/** The five gate-question bullets a waiting reply must carry, as SKILL.md's Output template labels them. */
export const GATE_BULLETS = Object.freeze(["- Why:", "- How long lived:", "- Already exists:", "- In scope:", "- Owner"]);

// Each bullet's label, after the list marker and any bold, matched case-insensitively and followed by
// an answer. Owner takes any suffix before its colon (`Owner / maintenance:`, `Owner:`).
const GATE_LABELS = [/^why\s*:/i, /^how long lived\s*:/i, /^already exists\s*:/i, /^in scope\s*:/i, /^owner\b[^:]*:/i];

// Fenced code blocks (``` or ~~~, to a matching closer or the end) removed, so a label shown as an
// example inside one never counts. Quoted lines need no stripping: every label below must start
// its line, and a quoted line starts with `>`. scripts/sources.mjs uses it on the sources file too.
export const stripFences = (text) => text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, "");

/**
 * What a waiting reply lacks of SKILL.md's waiting shape (Jo): a `**Ask:**` line with text (step 1),
 * and a `**Gate questions**` line followed by the five answered bullets of GATE_BULLETS (step 3),
 * outside fenced code. Returns the missing items in order: "**Ask:**", "**Gate questions**" (the
 * heading is absent, so every bullet is), or one GATE_BULLETS entry per absent or empty bullet.
 */
export function waitingMissing(text) {
  const lines = stripFences(text.replace(/\r\n/g, "\n")).split("\n");
  const missing = [];
  if (!lines.some((l) => /^[ \t]*\*\*Ask:\*\*[ \t]*\S/.test(l))) missing.push("**Ask:**");
  const at = lines.findIndex((l) => /^[ \t]*\*\*Gate questions\*\*/.test(l));
  if (at < 0) return [...missing, "**Gate questions**"];
  // The bullets: list items after the heading, through blank and indented continuation lines, up to
  // the first other line.
  const answered = [];
  for (const l of lines.slice(at + 1)) {
    const item = /^[ \t]*[-*+][ \t]+(.*)$/.exec(l);
    if (item) answered.push(item[1].replace(/\*\*|__/g, "").trim());
    else if (l.trim() && !/^[ \t]/.test(l)) break;
  }
  GATE_LABELS.forEach((label, i) => {
    const hit = answered.find((a) => label.test(a));
    if (!hit || !/\S/.test(hit.replace(label, ""))) missing.push(GATE_BULLETS[i]);
  });
  return missing;
}

/** The reason a waiting reply's block gives: exactly what it lacks (waitingMissing), under 300 chars. */
export function waitingBlockReason(missing) {
  const named = missing.map((m) => (m === "**Gate questions**" ? "`**Gate questions**` line and its five bullets" : `\`${m}\``));
  return `ask-graham: a reply waiting on the comparables question needs step 1 and step 3 above it. Missing: ${named.join(", ")}. ` +
    "Add only those (SKILL.md Output); keep the question alone on the final line.";
}

// --- The sources proof: the user's sources file was read and each source it lists was checked ---
//
// Counted from the turn's skill load on (scanSkillUse loadedAt), main session only: a subagent's
// tool calls are not in this transcript, so a search a subagent ran does not count until the parent
// runs it or relays it. Only the call is read, never its result, so a command that exited non-zero
// counts as run.

// `~` and `$HOME` / `${HOME}` expanded to `home` when one is given, so `~/x` and `<home>/x` compare equal.
function expandHome(s, home) {
  if (typeof home !== "string" || !home) return s;
  return s
    .replace(/(^|[\s"'=:(])~(?=\/|\s|$)/g, (_, pre) => pre + home)
    .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, () => home);
}
const squash = (s, home) => expandHome(s, home).replace(/\s+/g, " ");

// Every string in a value, nested arrays and objects included.
function stringsOf(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (isObject(v)) for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

// What a tool call runs: a shell command (Claude Code Bash, OMP bash and pair_run) or eval code.
const runTexts = (call) => [call.input.command, call.input.code].filter((s) => typeof s === "string");

// The file a Read (Claude Code) or read (OMP, its `:<lines>` selector dropped) opens, or null.
function readPath(call) {
  if (call.name === "Read" && typeof call.input.file_path === "string") return call.input.file_path;
  if (call.name === "read" && typeof call.input.path === "string") return call.input.path.replace(/:[^/]*$/, "");
  return null;
}

// A sources-file path as a pattern: home expanded, `*` matching any run of path characters.
function pathPattern(path, home) {
  return new RegExp(expandHome(path, home).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^\\s\"'`]*"));
}

const LOCAL_SEARCH = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?local search(?::(?:\*\*|__)?|(?:\*\*|__)?:)/i;

/**
 * The reply's `**Local search:**` block outside fenced code and quotes: the heading line's text after
 * the label, then the list items and indented lines under it (blank lines skipped) up to the first
 * other line. Null when the reply has no such heading. The label matches in any case, bold optional.
 */
export function localSearchBlock(text) {
  if (typeof text !== "string") return null;
  const lines = stripFences(text.replace(/\r\n/g, "\n")).split("\n");
  const at = lines.findIndex((l) => LOCAL_SEARCH.test(l));
  if (at < 0) return null;
  const block = [lines[at].replace(LOCAL_SEARCH, "")];
  for (const l of lines.slice(at + 1)) {
    if (!l.trim() || /^[ \t]*>/.test(l)) continue;
    if (/^[ \t]*[-*+][ \t]/.test(l) || /^[ \t]/.test(l)) block.push(l);
    else break;
  }
  return block;
}

// A label as compared: emphasis dropped, a trailing colon dropped, spaces collapsed, lowercased.
const normLabel = (s) => s.replace(/\*\*|__/g, "").trim().replace(/:$/, "").replace(/\s+/g, " ").trim().toLowerCase();

// The status words a result may carry, longest first so `nothing found` is not read as `found`.
const STATUS = /\b(nothing found|found|unreachable)\b/;

// A stated reason that makes not running a source the rule rather than a miss: the listed command
// writes or deletes (SKILL.md "The sources file"), or the user declined research (step 2's "No").
// An error such as "cannot write" is not a reason: the word must say the command itself writes.
const POLICY_SKIP = /\b(?:writes|writing|would write|deletes|deleting|would delete|destructive|not read-only|declined|said no)\b/;

/**
 * The block's line for a source: each line is read as `<label>: <result>` (list marker and emphasis
 * dropped), and the first line whose whole label equals the source's (normLabel on both) is
 * returned as `{ status, reason }`: the first status word in the result and the result text after
 * it. Null when no line carries that label with a status. A status word inside a label never counts.
 */
export function blockLine(block, label) {
  const want = normLabel(label);
  for (const raw of block) {
    const line = raw.replace(/^[ \t]*[-*+][ \t]+/, "").replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!line.startsWith(`${want}:`)) continue;
    const m = STATUS.exec(line.slice(want.length + 1));
    if (m) return { status: m[1], reason: line.slice(want.length + 1 + m.index + m[0].length) };
  }
  return null;
}

// Whether a source's line marks it unreachable for a stated policy reason (POLICY_SKIP after the word).
const policySkipped = (line) => line?.status === "unreachable" && POLICY_SKIP.test(line.reason);

/**
 * What the turn lacks of the sources proof, in order, as `{ label, expected }`: a Read of the
 * sources file; the reply's `**Local search:**` block; then per source, its run (a command source:
 * a tool call whose command or code contains its prefix), its read (a path source: a tool call
 * naming the path), or, once both of those hold or for a source with neither, its line in the
 * block. A source whose line marks it unreachable because its command writes or deletes, or because
 * research was declined, needs no run or read: not running it is the rule. Empty when nothing is missing.
 */
export function sourcesMissing({ calls = [], reply = "", sources, home = null } = {}) {
  const missing = [];
  if (!sources?.bullets?.length) return missing;
  const sourcesFile = expandHome(sources.path, home);
  if (!calls.some((c) => { const p = readPath(c); return p !== null && expandHome(p, home) === sourcesFile; })) {
    missing.push({ label: "sources file", expected: `a Read of ${sources.path}` });
  }
  const block = localSearchBlock(reply);
  if (!block) missing.push({ label: "**Local search:**", expected: "a block in the reply" });
  for (const b of sources.bullets) {
    const line = block ? blockLine(block, b.label) : null;
    if (policySkipped(line)) continue;
    if (b.kind === "command") {
      const prefix = squash(b.prefix, home);
      if (!calls.some((c) => runTexts(c).some((t) => squash(t, home).includes(prefix)))) {
        missing.push({ label: b.label, expected: `a Bash or eval call running \`${b.prefix}\`` });
        continue;
      }
    } else if (b.kind === "path") {
      const pattern = pathPattern(b.value, home);
      if (!calls.some((c) => stringsOf(c.input).some((s) => pattern.test(expandHome(s, home))))) {
        missing.push({ label: b.label, expected: `a tool call naming ${b.value}` });
        continue;
      }
    }
    if (block && !line) missing.push({ label: b.label, expected: "a **Local search:** line marking it" });
  }
  return missing;
}

/** The reason a sources-proof block gives: the first missing source and what was expected, then a count of the rest; at most 300 chars. */
export function sourcesBlockReason(missing) {
  const rest = missing.length - 1;
  const head = "ask-graham: sources file not fully checked. First missing: ";
  const tail = (rest > 0 ? ` (+${rest} more).` : ".") +
    " Run each read-only, then mark it under **Local search:** (found, nothing found, unreachable).";
  let first = `${missing[0].label}: ${missing[0].expected}`;
  const room = 300 - head.length - tail.length;
  if (first.length > room) first = `${first.slice(0, room - 1)}…`;
  return head + first + tail;
}
