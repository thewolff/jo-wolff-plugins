// card-context.mjs — what pair_propose reads from two sibling plugins' files, so a card's why
// and sources draw on what the session already found out: pattern-check's receipt directory
// and ask-graham's findings. Read-only toward both; nothing here writes either plugin's files,
// and a file that is missing never refuses a card (gate.mjs patternSourceProblem,
// alternativesProblem decide; this file only finds the facts).
//
// THE RULES, copied rather than imported, since an installed plugin never depends on a sibling
// being installed:
//   pattern-check (0.4.0; the rule plugins/delegation/lib/receipt.mjs copies too): the receipt is
//     <git root>/.pattern-check/<key>.md, where the git root is the nearest ancestor of the
//     worktree (inclusive) holding `.git`, and the key is the session id when it matches
//     /^[A-Za-z0-9][A-Za-z0-9._-]*$/ and is at most 128 characters, else
//     `cwd-<sha256(worktree) first 16 hex>`. The directory is what the pattern-source check
//     needs (any receipt in it is a pattern source); the session's own path is named in the
//     refusal so the agent knows which file to write.
//   ask-graham (the findings file its Stop hook writes): the file is
//     ${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/findings/<session id>.json (XDG_STATE_HOME
//     counts only when it is an absolute path; HOME is the adapter's, else the process's home)
//     with `version: 1`, `sessionId`, `writtenAt` (ISO 8601) and `alternatives: [{ design,
//     chosen }]`, the pattern-fit design chosen and the better design, when there is one, not.
//     A session id that is not a plain file name has no findings file, as ask-graham writes none.
//
// HOW IT FAILS. A findings file reads as missing, with one errors.log line (host-io.mjs logFault,
// under this plugin's own state base) so the skipped check is not silent, when it is not a
// regular file (a symlink, a directory, a FIFO), is over FINDINGS_MAX_BYTES, cannot be read, is
// not a JSON object, or is not this session's findings: `version` not a known number, `sessionId`
// not the session's own, `writtenAt` not an ISO date, or `alternatives` not a list of
// `{ design: non-empty string, chosen: boolean }` (one bad entry fails the file; nothing is
// dropped silently). A missing file is silent.

import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PATTERN_CHECK_DIR } from "./sibling-state.mjs";
import { logFault, reasonOf } from "./host-io.mjs";

const PATTERN_CHECK_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ASK_GRAHAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const THIS_FILE = "lib/card-context.mjs";
/** The findings versions this reader knows. */
export const FINDINGS_VERSIONS = Object.freeze([1]);
/** The most a findings file may be, in bytes: a verdict record is a few hundred. */
export const FINDINGS_MAX_BYTES = 64 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The nearest ancestor of `dir` (inclusive) holding `.git` (a directory, or a worktree's file), else null. */
export function gitRoot(dir) {
  let at = resolve(dir);
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

/** pattern-check's receipt key for a session in `cwd`. */
export function patternCheckKey(sessionId, cwd) {
  if (typeof sessionId === "string" && PATTERN_CHECK_KEY.test(sessionId) && sessionId.length <= 128) return sessionId;
  return `cwd-${createHash("sha256").update(resolve(cwd), "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * ask-graham's findings file for a session, or null when the id is not a plain file name. The
 * state base is `env.XDG_STATE_HOME` when absolute, else `<home>/.local/state`.
 * @param {unknown} sessionId
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 */
export function findingsPath(sessionId, env, home) {
  if (typeof sessionId !== "string" || !ASK_GRAHAM_ID.test(sessionId)) return null;
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "ask-graham", "findings", `${sessionId}.json`);
}

/** The first FINDINGS_MAX_BYTES + 1 bytes of the regular file at `path` as UTF-8, or the typed failure. Throws only what open/read throw. */
function readBounded(path) {
  const st = lstatSync(path);
  if (!st.isFile()) return { problem: st.isSymbolicLink() ? "is a symbolic link, not a regular file" : "is not a regular file" };
  if (st.size > FINDINGS_MAX_BYTES) return { problem: `is ${st.size} bytes, over the ${FINDINGS_MAX_BYTES}-byte limit` };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(FINDINGS_MAX_BYTES + 1);
    let n = 0;
    for (let got = 1; got > 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    if (n > FINDINGS_MAX_BYTES) return { problem: `is over the ${FINDINGS_MAX_BYTES}-byte limit` };
    return { raw: buf.toString("utf8", 0, n) };
  } finally {
    closeSync(fd);
  }
}

/** Why `json` is not this session's findings record, or null. */
function findingsProblem(json, sessionId) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return "are not a JSON object";
  if (!FINDINGS_VERSIONS.includes(json.version)) return `have version ${JSON.stringify(json.version) ?? String(json.version)}, not one this plugin reads (${FINDINGS_VERSIONS.join(", ")})`;
  if (json.sessionId !== sessionId) return `name session ${JSON.stringify(json.sessionId) ?? String(json.sessionId)}, not this session (${JSON.stringify(sessionId)})`;
  if (typeof json.writtenAt !== "string" || !ISO_DATE.test(json.writtenAt) || !Number.isFinite(Date.parse(json.writtenAt))) return `have no ISO 8601 writtenAt (${JSON.stringify(json.writtenAt) ?? String(json.writtenAt)})`;
  if (!Array.isArray(json.alternatives)) return `have no alternatives list (${JSON.stringify(json.alternatives) ?? String(json.alternatives)})`;
  for (const [i, a] of json.alternatives.entries()) {
    if (!a || typeof a !== "object" || typeof a.design !== "string" || a.design.trim() === "" || typeof a.chosen !== "boolean") {
      return `have alternatives[${i}] ${JSON.stringify(a) ?? String(a)}, not { design: non-empty string, chosen: boolean }`;
    }
  }
  return null;
}

/**
 * The findings at `path` as the gate reads them, `{ path, sessionId, writtenAt, alternatives }`,
 * or null when the file is missing. Not a regular file, over FINDINGS_MAX_BYTES, unreadable,
 * not JSON, or not this session's record (findingsProblem): null, and one `fault(reason)` call.
 * @param {string | null} path
 * @param {{ sessionId: string | null, fault?: (reason: string) => void }} opts
 */
export function readFindings(path, { sessionId, fault = () => {} }) {
  if (!path) return null;
  const skipped = "the card's alternatives were not checked against them";
  let read;
  try {
    read = readBounded(path);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    fault(`ask-graham findings ${path} could not be read (${reasonOf(err)}); ${skipped}`);
    return null;
  }
  if (read.problem) {
    fault(`ask-graham findings ${path} ${read.problem}; ${skipped}`);
    return null;
  }
  let json;
  try {
    json = JSON.parse(read.raw);
  } catch (err) {
    fault(`ask-graham findings ${path} are not JSON (${reasonOf(err)}); ${skipped}`);
    return null;
  }
  const problem = findingsProblem(json, sessionId);
  if (problem) {
    fault(`ask-graham findings ${path} ${problem}; ${skipped}`);
    return null;
  }
  return { path, sessionId: json.sessionId, writtenAt: json.writtenAt, alternatives: json.alternatives.map((a) => ({ design: a.design, chosen: a.chosen })) };
}

/**
 * The gate's io.cardContext for one session: the pattern-check receipt directory and this
 * session's receipt path (null outside a git repository), the repository root the worktree is
 * in (the worktree itself outside one), and the session's ask-graham findings. `env` is the
 * adapter's environment, the one its pairing state lives under; there is no fall back to this
 * process's, so a missing one is a thrown TypeError (the gate refuses the card and says so).
 * The home is `env.HOME` when absolute, else the process's. Never throws on a sibling's file:
 * each fault is one errors.log line under this plugin's state base.
 * @param {{ root: string, sessionId: string | null, env: Record<string, string | undefined>, fault?: (reason: string) => void }} opts
 */
export function cardContext({ root, sessionId, env, fault }) {
  if (!env || typeof env !== "object") throw new TypeError("cardContext needs the adapter's env");
  const home = typeof env.HOME === "string" && isAbsolute(env.HOME) ? env.HOME : homedir();
  const log = fault ?? ((reason) => { logFault(env, "pair_propose", { session_id: sessionId ?? undefined }, reason, THIS_FILE); });
  const repo = gitRoot(root);
  const receiptDir = repo ? join(repo, PATTERN_CHECK_DIR) : null;
  const receiptPath = repo ? join(receiptDir, `${patternCheckKey(sessionId, root)}.md`) : null;
  return {
    receiptDir,
    receiptPath,
    repoRoot: repo ?? resolve(root),
    findings: readFindings(findingsPath(sessionId, env, home), { sessionId, fault: log }),
  };
}
