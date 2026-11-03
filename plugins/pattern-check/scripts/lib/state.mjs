// state.mjs — where the plugin keeps what it knows about a session, and how it writes it.
//
// Base: ${XDG_STATE_HOME:-$HOME/.local/state}/pattern-check/ (XDG_STATE_HOME counts only when
// absolute). Under it:
//   sessions/<key>.json   the distinct files the session has touched, and the receipt path once recorded
//   receipts/<key>.md     a copy of the receipt (the original is in the repo, see receipt.mjs)
//   current/<repo hash>   the session key last seen in that repository, written by the PreToolUse
//                         hook on every call so the CLI, which runs from the Bash tool and gets no
//                         session_id, can find the session it belongs to
//   stop/<key>            the hash of the reply the Stop hook last refused (loop guard)
//
// THE KEY. Claude Code sends `session_id` to every hook (hooks reference, "Common input fields").
// When it is missing or unusable as a file name, the key degrades to the working directory's
// hash, and the caller is told so it can warn: a per-cwd key means two sessions in one directory
// share a counter and a receipt, which is weaker, not wrong.
//
// ATOMIC WRITES. Every file is written to a temporary name beside it and renamed into place, so a
// hook killed mid-write leaves the previous file, never a torn one. A torn or hand-edited session
// file is reported as a fault by readSession rather than thrown, so the hooks can fail open.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The state base directory. */
export function stateDir(env = process.env, home = homedir()) {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "pattern-check");
}

export function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** The nearest ancestor of `cwd` (inclusive) holding `.git`, else `cwd` itself. */
export function repoRoot(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/**
 * The session key for a hook payload, and whether it was degraded to a per-cwd key.
 * @returns {{ key: string, degraded: boolean }}
 */
export function sessionKey({ sessionId, cwd }) {
  if (typeof sessionId === "string" && SAFE_ID.test(sessionId) && sessionId.length <= 128) return { key: sessionId, degraded: false };
  return { key: `cwd-${sha256(resolve(cwd)).slice(0, 16)}`, degraded: true };
}

export function isSafeKey(key) {
  return typeof key === "string" && (SAFE_ID.test(key)) && key.length <= 128;
}

export const paths = {
  session: (base, key) => join(base, "sessions", `${key}.json`),
  receiptCopy: (base, key) => join(base, "receipts", `${key}.md`),
  current: (base, root) => join(base, "current", sha256(resolve(root)).slice(0, 16)),
  stop: (base, key) => join(base, "stop", key),
};

/** Writes `text` to `file` atomically: temp name beside it, then rename. Creates the directory. */
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* the temp file is the only thing lost */ }
    throw e;
  }
}

/** A fresh session record. */
export function emptySession(key, root) {
  return { key, repo: root, files: [], held: false, receipt: null, what: null, opened: null };
}

/**
 * Reads the session record. A missing file is a fresh session. A file that exists but does not
 * parse as the expected shape is a fault: the record returned is fresh and `fault` says why.
 * @returns {{ session: object, fault: string|null }}
 */
export function readSession(base, key, root) {
  const file = paths.session(base, key);
  if (!existsSync(file)) return { session: emptySession(key, root), fault: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { session: emptySession(key, root), fault: `state file ${file} is not valid JSON (${e.message})` };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files) || !parsed.files.every((f) => typeof f === "string")) {
    return { session: emptySession(key, root), fault: `state file ${file} has an unexpected shape` };
  }
  return {
    session: {
      key,
      repo: typeof parsed.repo === "string" ? parsed.repo : root,
      files: parsed.files,
      receipt: typeof parsed.receipt === "string" ? parsed.receipt : null,
      what: typeof parsed.what === "string" ? parsed.what : null,
      opened: typeof parsed.opened === "string" ? parsed.opened : null,
      held: parsed.held === true,
    },
    fault: null,
  };
}

export function writeSession(base, session) {
  writeAtomic(paths.session(base, session.key), `${JSON.stringify(session, null, 2)}\n`);
}

/** Records that `key` is the session last seen in `root`. */
export function writeCurrent(base, root, key) {
  writeAtomic(paths.current(base, root), `${key}\n`);
}

/** The session key last seen in `root`, or null. */
export function readCurrent(base, root) {
  try {
    const key = readFileSync(paths.current(base, root), "utf8").trim();
    return isSafeKey(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * Normalizes a path the way the counter compares them: absolute (relative to `cwd` if needed),
 * `..` resolved, backslashes to slashes, no trailing slash.
 */
export function normalizePath(p, cwd) {
  const forward = String(p).replace(/\\/g, "/");
  const abs = isAbsolute(forward) || /^[A-Za-z]:\//.test(forward) ? forward : resolve(cwd, forward).replace(/\\/g, "/");
  const collapsed = resolve(abs).replace(/\\/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}
