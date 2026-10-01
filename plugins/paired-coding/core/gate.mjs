// gate.mjs — the paired-coding gate core. Pure functions over a plain JSON state.
//
// WHAT IT DECIDES
//   Whether a tool call, a write, a command run or a pairing verb may happen, given the
//   pairing state. Every host adapter (Claude Code hooks, the OMP extension, any other host)
//   calls these functions; none of them re-implements a verdict.
//
// WHAT IT DOES NOT DO
//   No I/O. Hashing files, taking worktree snapshots, resolving symlinks, killing process
//   groups and reading the clock all arrive as injected functions on an `io` object, so the
//   tests drive every verdict with fake events. No host imports and no dependencies, so Node,
//   Bun, OMP's TypeScript extensions and other TypeScript builds can all import this one file.
//
// STATE
//   phase "inactive"  pairing not started: the gate does nothing.
//   phase "closed"    pairing active, no change set open.
//   phase "open"      a change set is open; `changeSet` names its card, boundary and quote.
//   Once a session has been activated, a missing, unreadable or malformed state reads as
//   "closed", never "inactive" (readState). That is the fail-closed rule.
//
// AGREEMENT
//   The agent judges that agreement was reached and calls pair_begin with a quote of the
//   user's words. The gate binds the quote to the user's own latest turn: that turn came from
//   the host's human-input signal (recordInput, adapter machinery only), it arrived after the
//   card was shown, and it contains the quote verbatim. The boundary files must still hash to
//   their values when the card was proposed. pair_stop is bound the same way, so the agent
//   cannot end pairing on its own and then write freely.
//
// RESULTS
//   Verbs return { ok, reason?, state, journal, ...extra }. A refusal returns the input state
//   unchanged and one journal entry naming the verb and the reason. Nothing here throws on bad
//   input; an injected function that throws becomes a refusal.

/** @typedef {"inactive" | "closed" | "open"} Phase */
/** @typedef {Record<string, string>} Snapshot worktree-relative path -> fingerprint (type, hash) */
/** @typedef {{ type: string, at?: unknown, [key: string]: unknown }} JournalEntry */
/**
 * @typedef {object} Card
 * @property {string} id
 * @property {string[]} boundary  worktree-relative paths, globs (* ? **), or "dir/" subtrees
 * @property {Record<string, string>} hashes  boundary file fingerprints at proposal time
 * @property {number} inputSeq  sequence number of the latest trusted input when proposed
 * @property {unknown} [at]
 * @property {string} [whyNow]
 * @property {string} [decision]
 * @property {string} [currentCode]
 * @property {string} [effect]
 * @property {string[]} [checks]
 * @property {string[]} [openPoints]
 * @property {Array<{path: string, change: string}>} [changedSinceReadBack]
 */
/**
 * @typedef {object} ChangeSet
 * @property {string} cardId
 * @property {string[]} boundary
 * @property {string} quote
 * @property {number} inputSeq
 * @property {string[]} runs  every pair_run started under this change set
 * @property {unknown} [openedAt]
 */
/**
 * @typedef {object} State
 * @property {1} v
 * @property {Phase} phase
 * @property {string | null} [sessionId]
 * @property {string | null} [root]      worktree, canonical absolute path
 * @property {string | null} [stateDir]  state and journal directory, canonical absolute path
 * @property {string[]} [tempPaths]      absolute paths pair_run may write while open
 * @property {string[]} [protect]        absolute paths every pair_run profile denies
 * @property {string[]} [exclusions]     worktree-relative directories left out of snapshots
 * @property {number} [inputSeq]
 * @property {{ seq: number, text: string, at?: unknown } | null} [lastInput]
 * @property {number} [startSeq]
 * @property {number} [cardSeq]
 * @property {Card | null} [card]
 * @property {ChangeSet | null} [changeSet]
 * @property {Array<{ runId: string, cardId: string | null }>} [running]
 * @property {Snapshot | null} [baseline]
 * @property {Array<{path: string, change: string}>} [unreviewed]
 * @property {{ reason: string, at?: unknown } | null} [halt]
 * @property {string | null} [degraded]
 */
/**
 * @typedef {object} Io
 * @property {() => unknown} [now]
 * @property {(boundary: string[], root: string) => Record<string, string>} [hashBoundary]
 * @property {() => Snapshot} [snapshot]
 * @property {(absPath: string) => string} [realpath]
 * @property {(runIds: string[]) => void} [reapRuns]
 */
/** @typedef {{ ok: boolean, reason?: string, state: State, journal: JournalEntry[], [key: string]: unknown }} Result */

/** The pairing verbs the adapter registers as model-callable tools. */
export const PAIR_TOOLS = Object.freeze([
  "pair_start",
  "pair_stop",
  "pair_note",
  "pair_propose",
  "pair_begin",
  "pair_done",
  "pair_write",
  "pair_edit",
  "pair_run",
]);

/** Read-only host tools, OMP and Claude Code spellings. Allowed while pairing. */
export const READ_ONLY_TOOLS = Object.freeze([
  "read", "grep", "glob", "find", "web_search",
  "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch",
]);

/** Host tools that write files or run code. Refused while pairing, in closed and open. */
export const HOST_MUTATING_TOOLS = Object.freeze([
  "write", "edit", "ast_edit", "bash", "eval", "python", "notebook",
  "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash",
]);

/** Sub-agent dispatch tools. Refused while pairing in v1: a child session starts inactive. */
export const DISPATCH_TOOLS = Object.freeze(["task", "Task", "Agent"]);

const PAIR_SET = new Set(PAIR_TOOLS);
const READ_SET = new Set(READ_ONLY_TOOLS);
const MUTATING_SET = new Set(HOST_MUTATING_TOOLS);
const DISPATCH_SET = new Set(DISPATCH_TOOLS);
const PHASES = new Set(["inactive", "closed", "open"]);
const CONTROL = /[\u0000-\u001f\u007f]/;

// ─── state ──────────────────────────────────────────────────────────────────────────────

/** @returns {State} */
export function inactiveState() {
  return { v: 1, phase: "inactive" };
}

/**
 * Parse a persisted state. Fail closed: a present file that does not parse or validate, or a
 * missing file in a session the adapter knows it activated, reads as "closed" with no card,
 * no trusted input and no change set, marked `degraded`. Only a missing file in a session that
 * was never activated reads as "inactive".
 * @param {string | null | undefined} text
 * @param {{ activated?: boolean, sessionId?: string, root?: string, stateDir?: string }} [opts]
 * @returns {State}
 */
export function readState(text, opts = {}) {
  if (text === null || text === undefined) {
    return opts.activated ? degradedState("state file missing", opts) : inactiveState();
  }
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return degradedState("state file unreadable", opts);
  }
  if (!isValidState(parsed)) return degradedState("state file malformed", opts);
  return parsed;
}

/** @param {State} state */
export function serializeState(state) {
  return JSON.stringify(state);
}

function degradedState(reason, opts) {
  const root = typeof opts.root === "string" && opts.root.startsWith("/") ? opts.root : null;
  const stateDir = typeof opts.stateDir === "string" && opts.stateDir.startsWith("/") ? opts.stateDir : null;
  return {
    v: 1,
    phase: "closed",
    sessionId: typeof opts.sessionId === "string" ? opts.sessionId : null,
    root,
    stateDir,
    tempPaths: [],
    protect: [],
    exclusions: [],
    inputSeq: 0,
    lastInput: null,
    startSeq: 0,
    cardSeq: 0,
    card: null,
    changeSet: null,
    running: [],
    baseline: null,
    unreviewed: [],
    halt: null,
    degraded: reason,
  };
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStrArr = (x) => Array.isArray(x) && x.every((s) => typeof s === "string");
const isAbs = (x) => typeof x === "string" && x.startsWith("/") && !CONTROL.test(x);
const isSeq = (x) => Number.isInteger(x) && x >= 0;

function isValidState(s) {
  if (!isObj(s) || s.v !== 1 || !PHASES.has(s.phase)) return false;
  if (s.phase === "inactive") return true;
  if (!isAbs(s.root) || !isAbs(s.stateDir)) return false;
  if (!isStrArr(s.tempPaths) || !s.tempPaths.every(isAbs)) return false;
  if (!isStrArr(s.protect) || !s.protect.every(isAbs)) return false;
  if (!isStrArr(s.exclusions)) return false;
  if (!isSeq(s.inputSeq) || !isSeq(s.startSeq) || !isSeq(s.cardSeq)) return false;
  if (s.lastInput !== null && !(isObj(s.lastInput) && isSeq(s.lastInput.seq) && typeof s.lastInput.text === "string")) return false;
  if (s.card !== null && !isValidCard(s.card)) return false;
  if (!Array.isArray(s.running) || !s.running.every((r) => isObj(r) && typeof r.runId === "string")) return false;
  if (s.baseline !== null && !isSnapshot(s.baseline)) return false;
  if (!Array.isArray(s.unreviewed)) return false;
  if (s.halt !== null && !(isObj(s.halt) && typeof s.halt.reason === "string")) return false;
  if (s.phase === "open") {
    const c = s.changeSet;
    if (!isObj(c) || typeof c.cardId !== "string" || typeof c.quote !== "string" || !isSeq(c.inputSeq)) return false;
    if (!isStrArr(c.boundary) || c.boundary.length === 0 || boundaryProblem(c.boundary) !== null) return false;
    if (!isStrArr(c.runs)) return false;
  } else if (s.changeSet !== null) {
    return false;
  }
  return true;
}

function isValidCard(c) {
  return (
    isObj(c) &&
    typeof c.id === "string" &&
    isStrArr(c.boundary) &&
    c.boundary.length > 0 &&
    boundaryProblem(c.boundary) === null &&
    isObj(c.hashes) &&
    isSeq(c.inputSeq)
  );
}

function isSnapshot(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}

// ─── results ────────────────────────────────────────────────────────────────────────────

function stamp(io) {
  return io && typeof io.now === "function" ? io.now() : undefined;
}

function entry(type, io, fields = {}) {
  const at = stamp(io);
  return at === undefined ? { type, ...fields } : { type, at, ...fields };
}

/** @returns {Result} */
function refuse(state, verb, reason, io) {
  return { ok: false, reason, state, journal: [entry("refusal", io, { verb, reason })] };
}

const clone = (state) => JSON.parse(JSON.stringify(state));

function callIo(io, name, ...args) {
  if (!io || typeof io[name] !== "function") return { error: `the adapter supplied no ${name}` };
  try {
    return { value: io[name](...args) };
  } catch (err) {
    return { error: `${name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── paths and boundaries ───────────────────────────────────────────────────────────────

/**
 * Lexically resolve `p` against `root`: absolute paths stay, relative ones join the root,
 * "." and ".." segments collapse. No filesystem access; symlinks are the adapter's realpath.
 * @param {string} root
 * @param {unknown} p
 * @returns {string | null} absolute path, or null for an unusable input
 */
export function resolvePath(root, p) {
  if (typeof p !== "string" || p.length === 0 || CONTROL.test(p)) return null;
  const joined = p.startsWith("/") ? p : `${root}/${p}`;
  const out = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

function within(dir, abs) {
  return abs === dir || abs.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/** The worktree-relative form of `abs`, or null when `abs` is the root itself or outside it. */
function relativeTo(root, abs) {
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
}

const REGEX_META = /[.^$*+?()[\]{}|\\]/g;

/**
 * Regex source (no anchors) for one boundary entry, in syntax shared by JavaScript and
 * Seatbelt's regex filter: `*` is any run inside one path segment, `?` one character inside a
 * segment, `**` any number of whole segments. Brackets and braces are literal characters.
 * @param {string} entry
 */
export function globToRegexSource(entry) {
  const segs = entry.split("/");
  let out = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") {
      out += last ? ".+" : "([^/]+/)*";
      return;
    }
    out += seg.replace(REGEX_META, (ch) => (ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : `\\${ch}`));
    if (!last) out += "/";
  });
  return out;
}

/** A trailing "/" means the whole subtree; an entry with * or ? is a glob; else one file. */
function normalizeEntry(entry) {
  return entry.endsWith("/") ? `${entry}**` : entry;
}

function isGlob(entry) {
  return /[*?]/.test(entry);
}

/**
 * Why a boundary is unusable, or null. Entries are worktree-relative, have no "." or ".."
 * segments, no empty segments, no control characters and no double quotes.
 * @param {unknown} boundary
 * @returns {string | null}
 */
export function boundaryProblem(boundary) {
  if (!Array.isArray(boundary) || boundary.length === 0) return "the card names no boundary";
  for (const raw of boundary) {
    if (typeof raw !== "string" || raw.length === 0) return "a boundary entry is empty";
    if (CONTROL.test(raw) || raw.includes('"')) return `boundary entry ${JSON.stringify(raw)} holds a control character or a double quote`;
    if (raw.startsWith("/")) return `boundary entry ${JSON.stringify(raw)} is absolute; boundary entries are worktree-relative`;
    const segs = normalizeEntry(raw).split("/");
    if (segs.some((s) => s === "" || s === "." || s === "..")) return `boundary entry ${JSON.stringify(raw)} has an empty, "." or ".." segment`;
  }
  return null;
}

/**
 * Whether a worktree-relative path lies inside the boundary.
 * @param {string[]} boundary
 * @param {string} rel
 */
export function boundaryMatches(boundary, rel) {
  if (typeof rel !== "string" || rel === "") return false;
  return boundary.some((raw) => {
    const e = normalizeEntry(raw);
    return isGlob(e) ? new RegExp(`^${globToRegexSource(e)}$`).test(rel) : rel === e;
  });
}

// ─── snapshots ──────────────────────────────────────────────────────────────────────────

/**
 * Paths whose fingerprint differs between two snapshots, sorted. Paths under `exclusions`
 * (worktree-relative directories) are ignored.
 * @param {Snapshot} before
 * @param {Snapshot} after
 * @param {string[]} [exclusions]
 * @returns {Array<{ path: string, change: "added" | "removed" | "modified" }>}
 */
export function diffSnapshots(before, after, exclusions = []) {
  const excluded = (p) => exclusions.some((d) => p === d || p.startsWith(d.endsWith("/") ? d : `${d}/`));
  const out = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (excluded(path)) continue;
    const a = Object.hasOwn(before, path) ? before[path] : undefined;
    const b = Object.hasOwn(after, path) ? after[path] : undefined;
    if (a === b) continue;
    out.push({ path, change: a === undefined ? "added" : b === undefined ? "removed" : "modified" });
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

function takeSnapshot(io) {
  const r = callIo(io, "snapshot");
  if (r.error) return r;
  if (!isSnapshot(r.value)) return { error: "snapshot returned a malformed snapshot" };
  return r;
}

function sameHashes(a, b) {
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

// ─── trusted input ──────────────────────────────────────────────────────────────────────

/**
 * Record one human turn. ADAPTER MACHINERY ONLY: call it from the host's human-input signal
 * (OMP `input` event; Claude Code `UserPromptSubmit`), never from a model-callable tool. Only
 * `source: "interactive"` enters the trusted store; any other source is journaled as
 * untrusted and changes nothing.
 * @param {State} state
 * @param {{ text: unknown, source: unknown }} event
 * @param {Io} [io]
 * @returns {Result}
 */
export function recordInput(state, event, io) {
  if (state.phase === "inactive") return { ok: true, state, journal: [] };
  const text = typeof event?.text === "string" ? event.text : "";
  if (event?.source !== "interactive") {
    return { ok: true, trusted: false, state, journal: [entry("untrusted-input", io, { source: String(event?.source), text })] };
  }
  const next = clone(state);
  next.inputSeq += 1;
  next.lastInput = { seq: next.inputSeq, text, at: stamp(io) };
  return { ok: true, trusted: true, state: next, journal: [entry("input", io, { seq: next.inputSeq, text })] };
}

/**
 * Why a quote does not bind to the user's latest turn after `anchorSeq`, or null. Shared by
 * pair_begin and pair_stop.
 */
function quoteProblem(state, anchorSeq, quote) {
  if (typeof quote !== "string" || quote.trim() === "") return "the quote of your partner's words is empty";
  const last = state.lastInput;
  if (!last || last.seq <= anchorSeq) return "your partner has not typed a turn since the card was shown";
  if (!last.text.includes(quote)) return "the quote does not occur verbatim in your partner's latest turn";
  return null;
}

// ─── verbs ──────────────────────────────────────────────────────────────────────────────

/**
 * pair_start: activate pairing (inactive -> closed) and take the first snapshot. Agent-callable
 * with no binding, because it only adds restrictions. The adapter supplies the paths.
 * @param {State} state
 * @param {{ sessionId?: string, root: string, stateDir: string, tempPaths?: string[], protect?: string[], exclusions?: string[] }} args
 * @param {Io} io
 * @returns {Result}
 */
export function pairStart(state, args, io) {
  if (state.phase !== "inactive") return refuse(state, "pair_start", "pairing is already active", io);
  const canon = (p) => {
    if (!isAbs(p)) return null;
    if (typeof io?.realpath !== "function") return p;
    const r = callIo(io, "realpath", p);
    return r.error || !isAbs(r.value) ? null : r.value;
  };
  const root = canon(args?.root);
  const stateDir = canon(args?.stateDir);
  if (!root) return refuse(state, "pair_start", "the worktree root is not a usable absolute path", io);
  if (!stateDir) return refuse(state, "pair_start", "the state directory is not a usable absolute path", io);
  if (root === "/" || within(stateDir, root)) return refuse(state, "pair_start", "the worktree lies inside the state directory", io);
  const tempPaths = args.tempPaths ?? [];
  const protect = args.protect ?? [];
  const exclusions = args.exclusions ?? [];
  if (!isStrArr(tempPaths) || !tempPaths.every(isAbs)) return refuse(state, "pair_start", "a temp path is not absolute", io);
  if (!isStrArr(protect) || !protect.every(isAbs)) return refuse(state, "pair_start", "a protected path is not absolute", io);
  if (!isStrArr(exclusions) || exclusions.some((e) => boundaryProblem([e]) !== null)) {
    return refuse(state, "pair_start", "a snapshot exclusion is not a clean worktree-relative path", io);
  }
  const snap = takeSnapshot(io);
  if (snap.error) return refuse(state, "pair_start", `could not snapshot the worktree: ${snap.error}`, io);
  /** @type {State} */
  const next = {
    v: 1,
    phase: "closed",
    sessionId: typeof args.sessionId === "string" ? args.sessionId : null,
    root,
    stateDir,
    tempPaths,
    protect,
    exclusions,
    inputSeq: 0,
    lastInput: null,
    startSeq: 0,
    cardSeq: 0,
    card: null,
    changeSet: null,
    running: [],
    baseline: snap.value,
    unreviewed: [],
    halt: null,
    degraded: null,
  };
  return { ok: true, state: next, journal: [entry("start", io, { sessionId: next.sessionId, root, stateDir, exclusions })] };
}

/**
 * pair_stop: end pairing (closed -> inactive). Bound like pair_begin: `quote` must occur
 * verbatim in the user's latest trusted turn, and that turn must have arrived after the
 * latest card (or after pair_start when no card exists). Refused while a change set is open
 * or a pair_run is running. Returns the changes since the last read-back for the summary.
 * @param {State} state
 * @param {{ quote: unknown }} args
 * @param {Io} io
 * @returns {Result}
 */
export function pairStop(state, args, io) {
  if (state.phase === "inactive") return refuse(state, "pair_stop", "pairing is not active", io);
  if (state.phase === "open") return refuse(state, "pair_stop", "a change set is open; finish it with pair_done first", io);
  if (state.running.length > 0) return refuse(state, "pair_stop", "a pair_run is still running", io);
  const anchor = state.card ? state.card.inputSeq : state.startSeq;
  const problem = quoteProblem(state, anchor, args?.quote);
  if (problem) return refuse(state, "pair_stop", problem, io);
  return finish(state, io, "pair_stop", { quote: args.quote });
}

/**
 * Session end, ADAPTER MACHINERY ONLY (host shutdown), never a model-callable tool. Reaps
 * every run, takes the final snapshot and judges it, then goes inactive.
 * @param {State} state
 * @param {Io} io
 * @returns {Result}
 */
export function sessionEnd(state, io) {
  if (state.phase === "inactive") return { ok: true, state, journal: [] };
  const runIds = [...new Set([...(state.changeSet?.runs ?? []), ...state.running.map((r) => r.runId)])];
  const journal = [];
  if (runIds.length > 0) {
    const reaped = callIo(io, "reapRuns", runIds);
    if (reaped.error) journal.push(entry("reap-failed", io, { runIds, reason: reaped.error }));
  }
  const r = finish({ ...state, running: [] }, io, "session-end", {});
  return { ...r, journal: [...journal, ...r.journal] };
}

function finish(state, io, verb, fields) {
  const snap = takeSnapshot(io);
  const journal = [];
  let changedSinceReadBack = [];
  let unapproved = [];
  if (snap.error) {
    journal.push(entry("snapshot-failed", io, { verb, reason: snap.error }));
  } else if (state.baseline) {
    const diff = diffSnapshots(state.baseline, snap.value, state.exclusions);
    if (state.phase === "open") {
      unapproved = diff.filter((d) => !boundaryMatches(state.changeSet.boundary, d.path));
      changedSinceReadBack = diff.filter((d) => boundaryMatches(state.changeSet.boundary, d.path));
      if (unapproved.length) journal.push(entry("unapproved-write", io, { cardId: state.changeSet.cardId, paths: unapproved }));
    } else {
      changedSinceReadBack = diff;
    }
    if (changedSinceReadBack.length) journal.push(entry("between-change-sets", io, { changes: changedSinceReadBack }));
  }
  journal.push(entry("stop", io, { verb, ...fields }));
  return { ok: true, state: inactiveState(), journal, changedSinceReadBack: [...state.unreviewed, ...changedSinceReadBack], unapproved };
}

/**
 * pair_note: append a note (roadmap, observations) to the journal. The agent's only way to
 * keep notes while pairing; the state directory is not writable by any agent tool.
 * @param {State} state
 * @param {{ text: unknown }} args
 * @param {Io} [io]
 * @returns {Result}
 */
export function pairNote(state, args, io) {
  if (state.phase === "inactive") return refuse(state, "pair_note", "pairing is not active", io);
  if (typeof args?.text !== "string" || args.text.trim() === "") return refuse(state, "pair_note", "the note is empty", io);
  return { ok: true, state, journal: [entry("note", io, { text: args.text })] };
}

/**
 * pair_propose: record the next card. Its boundary is hashed now (io.hashBoundary), and the
 * card remembers the latest trusted-input sequence number, so only a turn typed after this
 * card can agree to it. Changes found between change sets ride on the card for the user.
 * @param {State} state
 * @param {{ boundary: string[], whyNow?: string, decision?: string, currentCode?: string, effect?: string, checks?: string[], openPoints?: string[] }} card
 * @param {Io} io
 * @returns {Result & { card?: Card }}
 */
export function pairPropose(state, card, io) {
  if (state.phase === "inactive") return refuse(state, "pair_propose", "pairing is not active", io);
  if (state.halt) return refuse(state, "pair_propose", `the session is stopped: ${state.halt.reason}`, io);
  if (state.phase === "open") return refuse(state, "pair_propose", "a change set is open; finish it with pair_done before the next card", io);
  if (!state.root) return refuse(state, "pair_propose", "the state lost its worktree root; stop and start pairing again", io);
  if (!isObj(card)) return refuse(state, "pair_propose", "the card is not an object", io);
  const problem = boundaryProblem(card.boundary);
  if (problem) return refuse(state, "pair_propose", problem, io);
  if (card.openPoints !== undefined && !isStrArr(card.openPoints)) return refuse(state, "pair_propose", "openPoints is not a list of strings", io);
  if (card.checks !== undefined && !isStrArr(card.checks)) return refuse(state, "pair_propose", "checks is not a list of strings", io);
  const hashed = callIo(io, "hashBoundary", [...card.boundary], state.root);
  if (hashed.error) return refuse(state, "pair_propose", `could not hash the boundary: ${hashed.error}`, io);
  if (!isSnapshot(hashed.value)) return refuse(state, "pair_propose", "hashBoundary returned malformed hashes", io);
  const next = clone(state);
  next.cardSeq += 1;
  /** @type {Card} */
  const recorded = {
    id: `card-${next.cardSeq}`,
    whyNow: card.whyNow,
    decision: card.decision,
    currentCode: card.currentCode,
    effect: card.effect,
    boundary: [...card.boundary],
    checks: card.checks ? [...card.checks] : [],
    openPoints: card.openPoints ? [...card.openPoints] : [],
    hashes: hashed.value,
    inputSeq: next.inputSeq,
    at: stamp(io),
    changedSinceReadBack: next.unreviewed,
  };
  next.card = JSON.parse(JSON.stringify(recorded));
  next.unreviewed = [];
  return { ok: true, state: next, card: next.card, journal: [entry("card", io, { card: next.card })] };
}

/**
 * pair_begin: open the change set for the latest card. Succeeds only if (a) cardId is the
 * latest card, (b) a trusted turn arrived after the card, (c) `quote` occurs verbatim in the
 * latest trusted turn, (d) the boundary files hash to their proposal-time values. Also refused
 * while the card lists open points, while a change set is open, and while the session is
 * stopped. On success it snapshots the worktree; changes since the last snapshot are
 * journaled and shown on the next card.
 * @param {State} state
 * @param {{ cardId: unknown, quote: unknown }} args
 * @param {Io} io
 * @returns {Result}
 */
export function pairBegin(state, args, io) {
  if (state.phase === "inactive") return refuse(state, "pair_begin", "pairing is not active", io);
  if (state.halt) return refuse(state, "pair_begin", `the session is stopped: ${state.halt.reason}`, io);
  if (state.phase === "open") return refuse(state, "pair_begin", "a change set is already open", io);
  const card = state.card;
  if (!card) return refuse(state, "pair_begin", "no card has been proposed", io);
  if (args?.cardId !== card.id) return refuse(state, "pair_begin", "that card is not the latest card; re-propose it", io);
  if (card.openPoints && card.openPoints.length > 0) return refuse(state, "pair_begin", "the card still lists open points; settle them and re-propose", io);
  const problem = quoteProblem(state, card.inputSeq, args.quote);
  if (problem) return refuse(state, "pair_begin", problem, io);
  const hashed = callIo(io, "hashBoundary", [...card.boundary], state.root);
  if (hashed.error) return refuse(state, "pair_begin", `could not hash the boundary: ${hashed.error}`, io);
  if (!sameHashes(hashed.value, card.hashes)) return refuse(state, "pair_begin", "a boundary file changed since the card was shown; the card is stale, re-propose it", io);
  const snap = takeSnapshot(io);
  if (snap.error) return refuse(state, "pair_begin", `could not snapshot the worktree: ${snap.error}`, io);
  const next = clone(state);
  const between = next.baseline ? diffSnapshots(next.baseline, snap.value, next.exclusions) : [];
  next.unreviewed = [...next.unreviewed, ...between];
  next.baseline = snap.value;
  next.phase = "open";
  next.changeSet = {
    cardId: card.id,
    boundary: [...card.boundary],
    quote: args.quote,
    inputSeq: next.lastInput.seq,
    runs: [],
    openedAt: stamp(io),
  };
  const journal = [];
  if (between.length) journal.push(entry("between-change-sets", io, { changes: between }));
  journal.push(entry("agreement", io, { cardId: card.id, quote: args.quote, inputSeq: next.lastInput.seq, cardAt: card.at }));
  return { ok: true, state: next, journal };
}

/**
 * pair_done: close the open change set. Refused while a pair_run under it is running. On
 * success it first reaps every process group of the change set's runs (io.reapRuns), then
 * snapshots, so the read-back is taken after writes have stopped. Every changed path must lie
 * inside the boundary; any that does not is an unapproved write and stops the session.
 * Returns `changed` (inside the boundary, for the read-back diff) and `unapproved`.
 * @param {State} state
 * @param {{ cardId: unknown }} args
 * @param {Io} io
 * @returns {Result & { changed?: Array<{path: string, change: string}>, unapproved?: Array<{path: string, change: string}> }}
 */
export function pairDone(state, args, io) {
  if (state.phase !== "open") return refuse(state, "pair_done", "no change set is open", io);
  const cs = state.changeSet;
  if (args?.cardId !== cs.cardId) return refuse(state, "pair_done", "that card is not the open change set", io);
  if (state.running.some((r) => r.cardId === cs.cardId)) return refuse(state, "pair_done", "a pair_run under this change set is still running", io);
  if (cs.runs.length > 0) {
    const reaped = callIo(io, "reapRuns", [...cs.runs]);
    if (reaped.error) return refuse(state, "pair_done", `could not reap the change set's process groups: ${reaped.error}`, io);
  }
  const snap = takeSnapshot(io);
  if (snap.error) return refuse(state, "pair_done", `could not snapshot the worktree: ${snap.error}`, io);
  const diff = state.baseline ? diffSnapshots(state.baseline, snap.value, state.exclusions) : [];
  const changed = diff.filter((d) => boundaryMatches(cs.boundary, d.path));
  const unapproved = diff.filter((d) => !boundaryMatches(cs.boundary, d.path));
  const next = clone(state);
  next.phase = "closed";
  next.changeSet = null;
  next.baseline = snap.value;
  const journal = [entry("done", io, { cardId: cs.cardId, changed })];
  if (unapproved.length) {
    next.halt = { reason: `unapproved write outside change set ${cs.cardId}: ${unapproved.map((d) => d.path).join(", ")}`, at: stamp(io) };
    journal.push(entry("unapproved-write", io, { cardId: cs.cardId, paths: unapproved }));
  }
  return { ok: true, state: next, journal, changed, unapproved, halted: unapproved.length > 0 };
}

// ─── tool verdicts ──────────────────────────────────────────────────────────────────────

/**
 * The pre-call verdict for any host tool call. Inactive: allow everything. While pairing, an
 * allowlist: read-only tools and the pair_* verbs are allowed (pair_write and pair_edit only
 * while open); the host's mutating tools, its code runners and sub-agent dispatch are refused;
 * anything unknown is refused. `opts.allow` adds host lifecycle tools by name, and can never
 * re-allow a mutating, dispatch or pair_* name.
 * @param {State} state
 * @param {{ toolName: unknown }} call
 * @param {{ allow?: string[] }} [opts]
 * @param {Io} [io]
 * @returns {{ allow: boolean, reason?: string, journal: JournalEntry[] }}
 */
export function toolVerdict(state, call, opts = {}, io) {
  if (state.phase === "inactive") return { allow: true, journal: [] };
  const name = typeof call?.toolName === "string" ? call.toolName : "";
  const deny = (reason) => ({ allow: false, reason, journal: [entry("refusal", io, { verb: "tool_call", tool: name, reason })] });
  const pass = () => ({ allow: true, journal: [entry("verdict", io, { tool: name, allow: true })] });
  if (PAIR_SET.has(name)) {
    if ((name === "pair_write" || name === "pair_edit") && state.phase !== "open") return deny("no change set is open; agree a card first");
    return pass();
  }
  if (READ_SET.has(name)) return pass();
  if (MUTATING_SET.has(name)) return deny(`${name} is the host's own mutating tool; while pairing, write with pair_write or pair_edit and run commands with pair_run`);
  if (DISPATCH_SET.has(name)) return deny("sub-agent dispatch is refused while pairing; do the recon in this session");
  if (Array.isArray(opts.allow) && opts.allow.includes(name)) return pass();
  return deny(`${name || "(unnamed tool)"} is not on the pairing allowlist`);
}

/**
 * pair_write / pair_edit, checked INSIDE the tool's execute function against the final
 * arguments it received. Allowed only while open, only inside the worktree and the boundary,
 * never in the state directory. With io.realpath the resolved target is checked the same way,
 * so a symlink cannot carry a write out of the boundary.
 * @param {State} state
 * @param {{ path: unknown, toolName?: string }} args
 * @param {Io} [io]
 * @returns {{ ok: boolean, reason?: string, absPath?: string, journal: JournalEntry[] }}
 */
export function checkWrite(state, args, io) {
  const verb = args?.toolName === "pair_edit" ? "pair_edit" : "pair_write";
  const deny = (reason) => ({ ok: false, reason, journal: [entry("refusal", io, { verb, path: String(args?.path), reason })] });
  if (state.phase === "inactive") return deny("pairing is not active");
  if (state.halt) return deny(`the session is stopped: ${state.halt.reason}`);
  if (state.phase !== "open") return deny("no change set is open; agree a card first");
  const abs = resolvePath(state.root, args?.path);
  const problem = targetProblem(state, abs);
  if (problem) return deny(problem);
  if (io && typeof io.realpath === "function") {
    const real = callIo(io, "realpath", abs);
    if (real.error) return deny(`could not resolve the target: ${real.error}`);
    const realProblem = targetProblem(state, resolvePath(state.root, real.value));
    if (realProblem) return deny(`the target resolves to ${String(real.value)}: ${realProblem}`);
  }
  return { ok: true, absPath: abs, journal: [entry("write", io, { verb, path: relativeTo(state.root, abs), cardId: state.changeSet.cardId })] };
}

function targetProblem(state, abs) {
  if (!abs) return "the path is not usable";
  if (within(state.stateDir, abs)) return "the path is inside the pairing state directory";
  if (!boundaryMatches(state.changeSet.boundary, relativeTo(state.root, abs))) return "outside the agreed boundary; reopen";
  return null;
}

// ─── pair_run ───────────────────────────────────────────────────────────────────────────

/**
 * Admit one pair_run and return the Seatbelt profile it must run under, built from the state
 * at this moment. The command itself plays no part: whatever command arrives at execution,
 * after any other extension rewrote it, runs under this profile. Runs started while open are
 * tied to the change set so pair_done can refuse while they run and reap them afterwards.
 * @param {State} state
 * @param {{ runId: unknown }} args
 * @param {Io} [io]
 * @returns {Result & { profile?: string }}
 */
export function runStart(state, args, io) {
  if (state.phase === "inactive") return refuse(state, "pair_run", "pairing is not active", io);
  if (state.halt) return refuse(state, "pair_run", `the session is stopped: ${state.halt.reason}`, io);
  if (!state.root || !state.stateDir) return refuse(state, "pair_run", "the state lost its worktree root; stop and start pairing again", io);
  const runId = args?.runId;
  if (typeof runId !== "string" || runId === "") return refuse(state, "pair_run", "the run has no id", io);
  if (state.running.some((r) => r.runId === runId)) return refuse(state, "pair_run", "a run with this id is already running", io);
  let profile;
  try {
    profile = pairRunProfile(state);
  } catch (err) {
    return refuse(state, "pair_run", `could not build the sandbox profile: ${err instanceof Error ? err.message : String(err)}`, io);
  }
  const next = clone(state);
  const cardId = next.phase === "open" ? next.changeSet.cardId : null;
  next.running.push({ runId, cardId });
  if (cardId) next.changeSet.runs.push(runId);
  return { ok: true, state: next, profile, journal: [entry("run-start", io, { runId, cardId, phase: next.phase })] };
}

/**
 * Record that a pair_run returned (exited, timed out or was aborted and reaped).
 * @param {State} state
 * @param {{ runId: unknown, exitCode?: unknown }} args
 * @param {Io} [io]
 * @returns {Result}
 */
export function runEnd(state, args, io) {
  if (state.phase === "inactive" || !Array.isArray(state.running)) return { ok: true, state, journal: [] };
  const next = clone(state);
  next.running = next.running.filter((r) => r.runId !== args?.runId);
  return { ok: true, state: next, journal: [entry("run-end", io, { runId: args?.runId, exitCode: args?.exitCode })] };
}

/** A Seatbelt string literal; control characters are refused rather than guessed at. */
function sbplString(path) {
  if (CONTROL.test(path)) throw new Error(`a sandboxed path holds a control character (${JSON.stringify(path)})`);
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sbplRegex(source) {
  if (CONTROL.test(source) || source.includes('"')) throw new Error("a boundary pattern cannot be expressed as a sandbox regex");
  return `#"${source}"`;
}

/**
 * The Seatbelt profile for pair_run in the current phase. Later Seatbelt rules win, so the
 * order below is the precedence, last one strongest.
 *   closed: everything allowed except writes to the worktree, the state directory and the
 *           protected paths.
 *   open:   all writes denied; then the temp paths and the few /dev files a shell needs
 *           allowed; then the whole worktree denied again (a worktree that sits under a temp
 *           path stays fenced); then the boundary allowed; then the state directory and the
 *           protected paths denied, even where a boundary or temp path covers them.
 * @param {State} state
 * @returns {string}
 */
export function pairRunProfile(state) {
  const denyRoot = `(deny file-write* (subpath ${sbplString(state.root)}))`;
  const denyTail = [state.stateDir, ...(state.protect ?? [])].map((p) => `(deny file-write* (subpath ${sbplString(p)}))`).join("");
  if (state.phase !== "open") return `(version 1)(allow default)${denyRoot}${denyTail}`;
  const outside = [
    ...["/dev/null", "/dev/zero", "/dev/tty", "/dev/dtracehelper"].map((p) => `(literal ${sbplString(p)})`),
    `(subpath ${sbplString("/dev/fd")})`,
    ...(state.tempPaths ?? []).map((p) => `(subpath ${sbplString(p)})`),
  ];
  const boundary = state.changeSet.boundary.map((raw) => {
    const e = normalizeEntry(raw);
    if (!isGlob(e)) return `(literal ${sbplString(`${state.root}/${e}`)})`;
    const root = state.root.replace(REGEX_META, (ch) => `\\${ch}`);
    return `(regex ${sbplRegex(`^${root}/${globToRegexSource(e)}$`)})`;
  });
  return `(version 1)(allow default)(deny file-write*)(allow file-write* ${outside.join(" ")})${denyRoot}(allow file-write* ${boundary.join(" ")})${denyTail}`;
}
