// judge-cache.mjs — the bound on the judge cache (<state>/cache: one <sha>.json per verdict, one
// <sha>.prompt.txt per failure; judge/ask.mjs writes them).
//
// Why a cap and not the 30-day prune alone: a cache of one file per unique prompt grows with
// every message judged (8,249 files, 32 MB, none older than 30 days when measured on 2026-11-04),
// and a cached verdict is worth nothing once its prompt is out of the harness's context. So:
// at most MAX_FILES files, none older than MAX_AGE_DAYS, whichever bites first. capCache removes
// every file past the age, then the oldest (by mtime) until the count is at the cap. The judge
// enforces it on write, sampled (about one write in CAP_EVERY, judge/ask.mjs), and the plugin's
// prune verb (scripts/prune.mjs) enforces it on every run.
//
// `{ removed, bytes, kept }`; never throws; a file that cannot be removed is kept and named on
// stderr; no directory → all zeros.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_FILES = 2000;
export const MAX_AGE_DAYS = 7;
/** The judge checks the cap on about one write in this many. */
export const CAP_EVERY = 50;

/** Trim `dir` to `maxFiles` files none older than `maxAgeDays`; `{ removed, bytes, kept }`. */
export function capCache(dir, { maxFiles = MAX_FILES, maxAgeDays = MAX_AGE_DAYS, now = Date.now(), dryRun = false } = {}) {
  const out = { removed: 0, bytes: 0, kept: 0 };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  const files = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile()) files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* gone between readdir and stat */
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const cutoff = now - maxAgeDays * 86_400_000;
  const over = Math.max(0, files.length - maxFiles);
  files.forEach((f, i) => {
    if (f.mtimeMs >= cutoff && i >= over) {
      out.kept++;
      return;
    }
    try {
      if (!dryRun) rmSync(f.path, { force: true });
      out.removed++;
      out.bytes += f.size;
    } catch (err) {
      out.kept++;
      process.stderr.write(`judge cache: could not remove ${f.path}: ${err.message}\n`);
    }
  });
  return out;
}
