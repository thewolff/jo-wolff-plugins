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
//     counts only when it is an absolute path) with `alternatives: [{ design, chosen }]`, the
//     pattern-fit design chosen and the better design, when there is one, not. A session id
//     that is not a plain file name has no findings file, as ask-graham writes none.
//
// HOW IT FAILS. A findings file that cannot be read, is not JSON, or is not an object reads as
// missing, with one errors.log line (host-io.mjs logFault, under this plugin's own state base)
// so the skipped check is not silent. Entries of `alternatives` that are not
// `{ design: non-empty string, chosen: boolean }` are left out.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PATTERN_CHECK_DIR } from "./sibling-state.mjs";
import { logFault, reasonOf } from "./host-io.mjs";

const PATTERN_CHECK_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ASK_GRAHAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const THIS_FILE = "lib/card-context.mjs";

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

/** ask-graham's findings file for a session, or null when the id is not a plain file name. */
export function findingsPath(sessionId, env = process.env, home = homedir()) {
  if (typeof sessionId !== "string" || !ASK_GRAHAM_ID.test(sessionId)) return null;
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "ask-graham", "findings", `${sessionId}.json`);
}

/**
 * The findings at `path` as the gate reads them, `{ path, alternatives }`, or null when the
 * file is missing. Unreadable or not a JSON object: null, and one `fault(reason)` call.
 */
export function readFindings(path, { fault = () => {} } = {}) {
  if (!path) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    fault(`ask-graham findings ${path} could not be read (${reasonOf(err)}); the card's alternatives were not checked against them`);
    return null;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    fault(`ask-graham findings ${path} are not JSON (${reasonOf(err)}); the card's alternatives were not checked against them`);
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    fault(`ask-graham findings ${path} are not a JSON object; the card's alternatives were not checked against them`);
    return null;
  }
  const alternatives = (Array.isArray(json.alternatives) ? json.alternatives : [])
    .filter((a) => a && typeof a === "object" && typeof a.design === "string" && a.design.trim() !== "" && typeof a.chosen === "boolean")
    .map((a) => ({ design: a.design, chosen: a.chosen }));
  return { path, alternatives };
}

/**
 * The gate's io.cardContext for one session: the pattern-check receipt directory and this
 * session's receipt path (null outside a git repository), the repository root the worktree is
 * in (the worktree itself outside one), and the session's ask-graham findings. Never throws on
 * a sibling's file: each fault is one errors.log line under this plugin's state base.
 * @param {{ root: string, sessionId: string | null, env?: Record<string, string | undefined>, home?: string, fault?: (reason: string) => void }} opts
 */
export function cardContext({ root, sessionId, env = process.env, home = homedir(), fault }) {
  const log = fault ?? ((reason) => { logFault(env, "pair_propose", { session_id: sessionId ?? undefined }, reason, THIS_FILE); });
  const repo = gitRoot(root);
  const receiptDir = repo ? join(repo, PATTERN_CHECK_DIR) : null;
  const receiptPath = repo ? join(receiptDir, `${patternCheckKey(sessionId, root)}.md`) : null;
  return {
    receiptDir,
    receiptPath,
    repoRoot: repo ?? resolve(root),
    findings: readFindings(findingsPath(sessionId, env, home), { fault: log }),
  };
}
