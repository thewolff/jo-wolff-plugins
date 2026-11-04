// gh-cache.mjs — what the links-resolve check knows about GitHub issues and PRs, from disk only.
//
// WHY A CACHE AND NEVER A LIVE CALL
//   The Stop hook runs on every turn with a budget in the tens of milliseconds. An uncached
//   `gh api` lookup measured 0.31–0.50 s on this machine (3 of 4 runs over 300 ms), so the
//   hook never asks GitHub. It reads this file, treats a missing or expired entry as UNKNOWN
//   (never as dead), and hands the unknown keys to scripts/gh-cache-fill.mjs, a detached
//   helper that fills the file for a later stop. A cache that never fills costs nothing but
//   the GitHub existence and kind sub-checks, which then stay silent.
//
// THE FILE
//   <state dir>/gh-cache.json (lib/state.mjs stateDir, the plugin's one state directory):
//   {
//     "entries": { "<owner>/<repo>#<n>": { "kind": "issue"|"pr"|"missing", "title": "…", "at": ISO } },
//     "helper":  { "at": ISO, "error": "<why the last fill could not look anything up>" | null }
//   }
//   A hit (issue or pr) is trusted for HIT_TTL_MS; a miss (GitHub said 404) for MISS_TTL_MS
//   only, so a PR referenced before it is opened does not read as missing for long. gh's own
//   `--cache` keeps 404s too, so the helper asks with `--cache 10m` to match: a 404 gh served
//   from its cache is at most ten minutes old, and the plugin's entry lasts ten more, so the
//   worst case is about twenty minutes. Past its TTL an entry is unknown again and is looked
//   up again.
//
// FAILURE: an unreadable or malformed file reads as empty (every key unknown) and leaves one
//   errors.log line; the hook never throws over it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir, logFault } from "./state.mjs";

export const HIT_TTL_MS = 7 * 24 * 3_600_000;
export const MISS_TTL_MS = 10 * 60_000;
// A fill the helper is still running: a second helper inside this window does nothing.
export const LOCK_TTL_MS = 120_000;
// How many keys one helper run looks up, and how long one run may take in all.
export const FILL_MAX_KEYS = 20;
export const FILL_BUDGET_MS = 45_000;

export const KINDS = new Set(["issue", "pr", "missing"]);

export function ghCachePath(dir = stateDir()) {
  return join(dir, "gh-cache.json");
}

export const ghCacheLockPath = (path) => `${path}.lock`;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The cache's contents, validated entry by entry; an unreadable or malformed file is empty.
// `missing` (no file yet) is the normal first state and logs nothing.
export function readGhCache(path = ghCachePath()) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { entries: {}, helper: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logFault("lib/gh-cache.mjs", `gh-cache at ${path} does not parse (${err.message}); every GitHub link is unknown`);
    return { entries: {}, helper: null };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.entries ?? {})) {
    logFault("lib/gh-cache.mjs", `gh-cache at ${path} is not {"entries": {…}}; every GitHub link is unknown`);
    return { entries: {}, helper: null };
  }
  const entries = {};
  for (const [key, e] of Object.entries(parsed.entries ?? {})) {
    if (isPlainObject(e) && KINDS.has(e.kind) && typeof e.at === "string" && Number.isFinite(Date.parse(e.at))) {
      entries[key] = { kind: e.kind, title: typeof e.title === "string" ? e.title : "", at: e.at };
    }
  }
  return { entries, helper: isPlainObject(parsed.helper) ? parsed.helper : null };
}

// What the cache says about `key` right now: { kind, title } while the entry is inside its
// TTL, null when it is absent or expired (unknown, to be looked up again).
export function lookupGh(cache, key, now = Date.now()) {
  const e = cache?.entries?.[key];
  if (!e) return null;
  const age = now - Date.parse(e.at);
  const ttl = e.kind === "missing" ? MISS_TTL_MS : HIT_TTL_MS;
  if (!(age >= 0 && age < ttl)) return null;
  return { kind: e.kind, title: e.title ?? "" };
}

// "owner/repo#n" for a GitHub issue or PR URL's parts.
export const ghKey = (owner, repo, number) => `${owner}/${repo}#${number}`;

// The parts of a key, or null.
export function parseGhKey(key) {
  const m = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(String(key ?? ""));
  return m ? { owner: m[1], repo: m[2], number: m[3] } : null;
}
