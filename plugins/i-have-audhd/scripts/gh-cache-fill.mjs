#!/usr/bin/env node
// scripts/gh-cache-fill.mjs — fills lib/gh-cache.mjs's file for the keys the Stop hook could
// not answer, off the hook's hot path.
//
//   node scripts/gh-cache-fill.mjs <cache path> <owner/repo#n> [<owner/repo#n> …]
//
// The Stop hook spawns this detached (its own process group, stdio ignored, never awaited) and
// exits; nothing in the turn waits for it. Whether a host keeps a detached child alive past the
// hook's own exit is not proven for Claude Code, so a cache that never fills has to be harmless,
// and it is: the hook reads unknown for every key and says nothing about it.
//
// WHAT IT DOES
//   Takes one lock (<cache>.lock, pid inside; a lock younger than LOCK_TTL_MS means another
//   fill is running and this one exits), looks up at most FILL_MAX_KEYS keys with
//   `gh api --cache 10m repos/<owner>/<repo>/issues/<n>` (GitHub's issues endpoint answers for
//   PRs too and marks them with `pull_request`), each under GH_TIMEOUT_MS and all inside
//   FILL_BUDGET_MS, then merges what it learned into the file through a temp file and a rename.
//   A 404 is recorded as `missing` (short TTL in the reader); any other failure — gh not on
//   PATH, not logged in, rate-limited, network — records nothing for the key and sets
//   `helper.error`, which it also logs to errors.log once per distinct error and then at most
//   once an hour, so a helper that can never look anything up is visible without being noisy.
//
// How it fails: no arguments → usage on stderr, exit 2. A held lock → exit 0, nothing done.
// A cache file that cannot be written → one errors.log line, exit 0. `gh` missing → no entry is
// written, `helper.error` says `gh-not-found`, one errors.log line. Exit is 0 on every path
// but usage; nothing here can affect the turn that spawned it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, basename } from "node:path";
import { readGhCache, ghCacheLockPath, parseGhKey, LOCK_TTL_MS, FILL_MAX_KEYS, FILL_BUDGET_MS, HIT_TTL_MS } from "../lib/gh-cache.mjs";
import { logFault } from "../lib/state.mjs";

export const GH_TIMEOUT_MS = 10_000;
const JQ = "{number: .number, title: .title, pull_request: (.pull_request != null)}";
const RELOG_MS = 3_600_000;
const SELF = "scripts/gh-cache-fill.mjs";

// One `gh api` result → { kind, title } | { missing: true } | { error }. Exported for the
// fixture tests (scripts/fixtures/gh-api-*.txt are real captures).
export function parseGhResult({ status, stdout, stderr, error }) {
  if (error) return { error: error.code === "ENOENT" ? "gh-not-found" : `gh-spawn-${error.code || error.message}` };
  const err = String(stderr ?? "").trim();
  if (status === 0) {
    try {
      const o = JSON.parse(String(stdout ?? "").trim());
      if (o && typeof o === "object" && typeof o.pull_request === "boolean") {
        return { kind: o.pull_request ? "pr" : "issue", title: typeof o.title === "string" ? o.title : "" };
      }
    } catch {
      /* fall through */
    }
    return { error: "gh-unparseable" };
  }
  if (/HTTP 404\b/.test(err)) return { missing: true };
  if (/gh auth login|GH_TOKEN/.test(err)) return { error: "gh-not-logged-in" };
  if (/HTTP 401\b/.test(err)) return { error: "gh-unauthorized" };
  if (/HTTP 403\b|HTTP 429\b|rate limit/i.test(err)) return { error: "gh-rate-limited" };
  return { error: `gh-exit-${status}${err ? ` ${err.slice(0, 120)}` : ""}` };
}

// Run `gh api` for one key. `runGh` is injectable for tests.
export function lookupKey(key, runGh = defaultRunGh) {
  const parts = parseGhKey(key);
  if (!parts) return { error: "bad-key" };
  return parseGhResult(runGh(parts));
}

function defaultRunGh({ owner, repo, number }) {
  // gh's own cache keeps 404s too; 10m matches lib/gh-cache.mjs's MISS_TTL_MS, so a PR named
  // before it is opened reads as missing for at most about twenty minutes, not gh's hour.
  const r = spawnSync("gh", ["api", "--cache", "10m", `repos/${owner}/${repo}/issues/${number}`, "--jq", JQ], {
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
}

// True when a fill is already running (a lock younger than LOCK_TTL_MS).
export function lockHeld(cachePath, now = Date.now()) {
  const lock = ghCacheLockPath(cachePath);
  try {
    return now - statSync(lock).mtimeMs < LOCK_TTL_MS;
  } catch {
    return false;
  }
}

// Merge `learned` ({key: entry}) and `helper` into the file; entries past HIT_TTL_MS are dropped.
function writeMerged(cachePath, learned, helper, now) {
  const current = readGhCache(cachePath);
  const entries = {};
  for (const [k, e] of Object.entries(current.entries)) {
    if (now - Date.parse(e.at) < HIT_TTL_MS) entries[k] = e;
  }
  Object.assign(entries, learned);
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entries, helper }));
  renameSync(tmp, cachePath);
}

// The fill. Returns { looked, learned, error } for tests; never throws past its own logging.
export function fill(cachePath, keys, { runGh = defaultRunGh, now = Date.now, budgetMs = FILL_BUDGET_MS, maxKeys = FILL_MAX_KEYS } = {}) {
  const out = { looked: 0, learned: {}, error: null };
  if (lockHeld(cachePath, now())) return out;
  const lock = ghCacheLockPath(cachePath);
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(lock, String(process.pid));
  } catch (err) {
    logFault(SELF, `could not take ${basename(lock)} (${err.message}); nothing looked up`);
    return out;
  }
  const started = now();
  try {
    const unique = [...new Set(keys)].slice(0, maxKeys);
    for (const key of unique) {
      if (now() - started > budgetMs) break;
      const r = lookupKey(key, runGh);
      out.looked += 1;
      if (r.kind) out.learned[key] = { kind: r.kind, title: r.title, at: new Date(now()).toISOString() };
      else if (r.missing) out.learned[key] = { kind: "missing", title: "", at: new Date(now()).toISOString() };
      else {
        out.error = r.error;
        if (/^gh-(not-found|not-logged-in|unauthorized|rate-limited)$/.test(r.error)) break; // the rest would fail the same way
      }
    }
    // Visible without being noisy: a new error is logged at once, the same one at most hourly;
    // `helper.loggedAt` remembers when, in the one write below.
    const previous = readGhCache(cachePath).helper;
    const at = new Date(now()).toISOString();
    const helper = { at, error: out.error, loggedAt: null };
    if (out.error) {
      const loggedAt = previous?.error === out.error ? Date.parse(previous.loggedAt) : NaN;
      if (Number.isFinite(loggedAt) && now() - loggedAt < RELOG_MS) helper.loggedAt = previous.loggedAt;
      else {
        logFault(SELF, `GitHub lookups are not filling the cache (${out.error}); the links-resolve check reads every GitHub link as unknown until they do`);
        helper.loggedAt = at;
      }
    }
    try {
      writeMerged(cachePath, out.learned, helper, now());
    } catch (err) {
      logFault(SELF, `could not write ${cachePath} (${err.message}); ${Object.keys(out.learned).length} lookup(s) lost`);
    }
  } finally {
    try {
      if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock, { force: true });
    } catch {
      /* a stale lock expires by age */
    }
  }
  return out;
}

const invokedDirectly = await (async () => {
  try {
    const [{ realpathSync }, { fileURLToPath }] = await Promise.all([import("node:fs"), import("node:url")]);
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const [cachePath, ...keys] = process.argv.slice(2);
  if (!cachePath || !keys.length) {
    process.stderr.write("usage: node scripts/gh-cache-fill.mjs <cache path> <owner/repo#n> [...]\n");
    process.exit(2);
  }
  try {
    fill(cachePath, keys);
  } catch (err) {
    logFault(SELF, `threw: ${err?.stack || String(err)}`);
  }
  process.exit(0);
}
