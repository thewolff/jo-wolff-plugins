// claudex.mjs — a claudex-loop Codex inspection that already reviewed this commit (0.4.10).
//
// claudex-loop's runner (skills/claudex-loop/scripts/runner.py) writes one result.json per run.
// An inspection records no HEAD sha: it snapshots the working tree against `base` — every changed
// or untracked path with its kind and the sha256 of its bytes, plus the sha256 of
// `git diff --binary <base> --` — usually before anything is committed. So a result is matched to
// HEAD by content: ledger recomputes the same snapshot from the HEAD commit and requires it to be
// identical, on the full base sha the review uses, never by time or mtime.
//
// A result counts (matchesHead) only when it is a completed codex `inspect` with exit code 0, an
// APPROVED verdict and no high or medium finding, for the same repository, on the review's base,
// whose plan is the current pattern-check receipt (when the repository has one), and whose
// snapshot equals HEAD's. The diff digest may instead equal HEAD's diff with the added files
// left out: new files a builder never staged are not in the runner's `git diff`, and their
// contents are still checked through the per-file hashes.
//
// Nothing here throws to the caller: a candidate that cannot be read, parsed or compared is
// skipped, a real error is logged in one errors.log line, and the codex lab runs as before.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { logError } from "../failopen.mjs";

export const MAX_DEPTH = 3;
export const MAX_FILES = 200;
export const MAX_BYTES = 1024 * 1024;
export const DEFAULT_DIRS = Object.freeze(["~/agent-scratch/{repo}"]);
const GIT_TIMEOUT_MS = 60_000;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** git with stdout as a Buffer (blob bytes are compared raw); throws on failure or timeout. */
export function gitBytes(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const r = spawnSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.code === "ETIMEDOUT" ? `timed out after ${Math.round(timeoutMs / 1000)}s` : r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(r.stderr ?? "").trim() || `exit ${r.status}`}`);
  return r.stdout;
}

const nulList = (buf) => buf.toString("utf8").split("\0").filter(Boolean);

/**
 * The runner's snapshot of `base`..`head`, recomputed from the commit: { base, files, diffs }.
 * `files` is a Map path → `${kind}:${sha256}`; `diffs` holds the sha256 of the whole diff and of
 * the diff without the added files. null when a path is a submodule or anything but a file,
 * symlink or deletion (the runner refuses those too).
 */
export function snapshotAt(top, base, head) {
  const names = nulList(gitBytes(top, ["diff", "--no-ext-diff", "--name-only", "-z", base, head]));
  const files = new Map();
  for (const name of names) {
    const entry = gitBytes(top, ["ls-tree", "-z", head, "--", `:(literal)${name}`]).toString("utf8").split("\0").find(Boolean);
    if (!entry) {
      files.set(name, `deleted:${sha256("")}`);
      continue;
    }
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry);
    if (!m || m[2] !== "blob") return null;
    const kind = m[1] === "120000" ? "symlink" : m[1] === "100644" || m[1] === "100755" ? "file" : null;
    if (!kind) return null;
    files.set(name, `${kind}:${sha256(gitBytes(top, ["cat-file", "blob", m[3]]))}`);
  }
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--binary", base, head];
  const full = sha256(gitBytes(top, diffArgs));
  const status = gitBytes(top, ["diff", "--no-ext-diff", "--name-status", "--no-renames", "-z", base, head]).toString("utf8").split("\0");
  const added = [];
  for (let i = 0; i + 1 < status.length; i += 2) if (status[i] === "A") added.push(status[i + 1]);
  const withoutAdded = added.length ? sha256(gitBytes(top, [...diffArgs, "--", ".", ...added.map((p) => `:(exclude,literal)${p}`)])) : full;
  return { base, files, diffs: [full, withoutAdded] };
}

/** Folders to scan: `review.claudexDirs` (default DEFAULT_DIRS), `~` expanded, `{repo}` → the repository's folder name. */
export function claudexDirs(config, top, home = homedir()) {
  const list = Array.isArray(config?.review?.claudexDirs) ? config.review.claudexDirs : DEFAULT_DIRS;
  return list
    .filter((d) => typeof d === "string" && d.trim())
    .map((d) => d.trim().replaceAll("{repo}", basename(top)))
    .map((d) => (d === "~" ? home : d.startsWith("~/") ? join(home, d.slice(2)) : d));
}

/**
 * Every result.json among `paths` (a file is taken as is; a folder is searched MAX_DEPTH levels
 * down), at most MAX_FILES. `explicit` paths that are missing are logged; a missing default folder is not.
 */
export function candidates(paths, { env = process.env, explicit = new Set(), cwd = process.cwd() } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== "ENOENT" || explicit.has(dir)) logError("review", `claudex results folder ${dir} not readable: ${err.message}`, env);
      return;
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES) return;
      if (e.isFile() && e.name === "result.json") found.push(join(dir, e.name));
      else if (e.isDirectory() && depth < MAX_DEPTH) walk(join(dir, e.name), depth + 1);
    }
  };
  for (const raw of paths) {
    const p = isAbsolute(raw) ? raw : resolve(cwd, raw);
    let st;
    try {
      st = statSync(p);
    } catch (err) {
      if (err.code !== "ENOENT" || explicit.has(raw)) logError("review", `claudex result ${p} not readable: ${err.message}`, env);
      continue;
    }
    if (st.isFile()) {
      if (found.length < MAX_FILES) found.push(p);
    } else if (st.isDirectory()) walk(p, 0);
  }
  return [...new Set(found)];
}

/** The parsed record at `path`, or null (over MAX_BYTES, unreadable or not JSON: logged). */
export function readRecord(path, env = process.env) {
  try {
    const st = statSync(path);
    if (st.size > MAX_BYTES) {
      logError("review", `claudex result ${path} is ${st.size} bytes, over ${MAX_BYTES}; skipped`, env);
      return null;
    }
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (err) {
    logError("review", `claudex result ${path} not usable: ${err.message}; skipped`, env);
    return null;
  }
}

const same = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * Why `record` does not count as an inspection of `head` (a short phrase), or null when it does.
 * `receipt` is { path } of the current pattern-check receipt, or { path: undefined } for none.
 * `snapshotOf()` returns HEAD's recomputed snapshot (memoized by the caller).
 */
export function mismatch(record, { top, base, receipt, snapshotOf }) {
  if (record.mode !== "inspect") return "not an inspection";
  if (record.status !== "completed" || record.exit_code !== 0) return "not completed";
  if (record.provider !== "codex") return "not a codex inspection";
  const r = record.response;
  if (r?.verdict !== "APPROVED") return `verdict ${r?.verdict ?? "missing"}`;
  if (!Array.isArray(r.findings)) return "no findings list";
  // Every field approvalResult reads is checked here, so a candidate that passes cannot fail later.
  const str = (v) => v === undefined || v === null || typeof v === "string";
  // The producer's own enum (runner.py validate_review): anything else is a malformed record.
  if (r.findings.some((f) => !f || typeof f !== "object" || !["high", "medium", "low"].includes(f.severity) || !str(f.path) || !str(f.evidence) || !(str(f.id) || typeof f.id === "number"))) return "malformed findings";
  if (r.findings.some((f) => f.severity === "high" || f.severity === "medium")) return "has material findings";
  if (!str(record.requested_model) || !str(record.artifacts) || (record.observed_models != null && !Array.isArray(record.observed_models))) return "malformed metadata";
  if (typeof record.repo !== "string" || !same(record.repo, top)) return "another repository";
  const snap = record.snapshot;
  // snapshot.base is the runner's resolved commit id; record.base is whatever ref was typed.
  if (!base || snap?.base !== base) return "another base";
  if (receipt?.unreadable) return "the current receipt could not be read";
  if (receipt?.path) {
    let digest;
    try {
      digest = sha256(readFileSync(receipt.path));
    } catch {
      return "receipt unreadable";
    }
    if (record.plan_sha256 !== digest) return "inspected another plan than the current receipt";
  }
  if (!Array.isArray(snap.files) || typeof snap.diff_sha256 !== "string") return "no snapshot";
  const mine = snapshotOf();
  if (!mine) return "HEAD's change has a path the runner cannot snapshot";
  // Set equality: unique paths in the result, the same paths as HEAD's, each with the same kind and hash.
  const theirs = new Map();
  for (const f of snap.files) {
    if (!f || typeof f.path !== "string" || typeof f.kind !== "string" || typeof f.sha256 !== "string" || theirs.has(f.path)) return "malformed snapshot files";
    theirs.set(f.path, `${f.kind}:${f.sha256}`);
  }
  if (theirs.size !== mine.files.size) return "different files";
  for (const [path, value] of mine.files) {
    if (theirs.get(path) !== value) return "different files";
  }
  if (!mine.diffs.includes(snap.diff_sha256)) return "different diff";
  return null;
}

/**
 * The newest (by started_at) claudex APPROVED inspection of `base`..`head`, as
 * { record, path, result } (`result` the lab result it stands for, built inside the guard), or
 * null. Never throws.
 */
export function findApproval({ top, base, head, receipt, config, env = process.env, paths = [], cwd = process.cwd(), home = homedir() }) {
  try {
    const list = candidates([...paths, ...claudexDirs(config, top, home)], { env, explicit: new Set(paths), cwd });
    let snap;
    let snapError = null;
    const snapshotOf = () => {
      if (snap === undefined && !snapError) {
        try {
          snap = snapshotAt(top, base, head);
        } catch (err) {
          snapError = err;
          logError("review", `claudex: could not snapshot ${base.slice(0, 8)}..${head.slice(0, 8)}: ${err.message}`, env);
        }
      }
      return snap ?? null;
    };
    let best = null;
    for (const path of list) {
      const record = readRecord(path, env);
      if (!record) continue;
      let why;
      try {
        why = mismatch(record, { top, base, receipt, snapshotOf });
      } catch (err) {
        logError("review", `claudex result ${path} could not be compared: ${err.message}; skipped`, env);
        continue;
      }
      if (why) continue;
      let result;
      try {
        result = approvalResult({ record, path });
      } catch (err) {
        logError("review", `claudex result ${path} could not be used: ${err.message}; skipped`, env);
        continue;
      }
      if (!best || Number(record.started_at) > Number(best.record.started_at)) best = { record, path, result };
    }
    return best;
  } catch (err) {
    logError("review", `claudex: ${err.message}; codex runs`, env);
    return null;
  }
}

/** The lab result an approval stands for: pass, or pass-with-nits for its low findings. */
export function approvalResult({ record, path }) {
  const lows = (record.response?.findings ?? []).filter((f) => f?.severity === "low");
  const items = lows.map((f) => ({ severity: "nit", text: [f.path, f.evidence].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim() || String(f.id ?? "low finding") }));
  const model = (Array.isArray(record.observed_models) && record.observed_models.find((m) => typeof m === "string" && m)) || record.requested_model || "claudex";
  const where = record.artifacts || path;
  return {
    verdict: items.length ? "pass-with-nits" : "pass",
    items,
    findings: items.length ? items.map((it, k) => `${k + 1}. [nit] ${it.text}`).join("\n") : null,
    model,
    reason: `claudex inspect APPROVED, ${where}, snapshot ${String(record.snapshot?.sha256 ?? "").slice(0, 8)}`,
  };
}
