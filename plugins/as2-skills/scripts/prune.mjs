#!/usr/bin/env node
// scripts/prune.mjs — the as2-skills plugin's retention verb, declared in .claude-plugin/plugin.json
// `state[].prune` and run by `ledger canary run` (nightly after the live runs, and daily on its
// own as `canary run --prunes-only`).
//
//   node scripts/prune.mjs [--days 1] [--dry-run]
//
// The seo-audit skill makes one temporary directory per Lighthouse run (`$TMPDIR/seo-audit-lh-*`,
// scripts/lib/lighthouse.ts) and one Chrome profile per render (`$TMPDIR/seo-audit-chrome-*`,
// scripts/lib/render.ts), and each removes its own in `finally`. What that cannot cover is a
// process killed outright (the 120 s wall clock firing on a hung Chrome, a SIGKILL, a crash):
// the directory stays. This verb removes every `seo-audit-*` directory under the temp directory
// (`os.tmpdir()`: $TMPDIR, else /tmp) whose mtime is older than --days (default 1, longer than
// any run), with everything in it, and prints `pruned: <n> file(s), <bytes> bytes freed` as the
// last line (the canary records the bytes). `<n>` counts the files inside the directories.
//
// How it fails: no temp directory → `pruned: 0 file(s), 0 bytes freed`, exit 0. A directory that
// cannot be removed is counted as kept and named on stderr; exit stays 0 (a prune that cannot
// finish must not read as a failed canary night). A bad --days → usage on stderr, exit 1.

import { readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The directories this verb owns: the seo-audit skill's temp dirs. */
export const PREFIX = "seo-audit-";

/** Files and bytes under `dir`, recursively (what removing it frees). */
function measure(dir) {
  let files = 0;
  let bytes = 0;
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files, bytes };
  }
  for (const e of names) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = measure(p);
      files += sub.files;
      bytes += sub.bytes;
      continue;
    }
    try {
      bytes += statSync(p).size;
      files++;
    } catch {
      /* gone between readdir and stat */
    }
  }
  return { files, bytes };
}

/**
 * Remove every `seo-audit-*` directory under `base` older than `days`; `{ removed, bytes, kept }`
 * (`removed` counts the files inside; `kept` the directories left, younger or stuck).
 */
export function prune(base, { days = 1, now = Date.now(), dryRun = false } = {}) {
  const cutoff = now - days * 24 * 3_600_000;
  const out = { removed: 0, bytes: 0, kept: 0 };
  let names;
  try {
    names = readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of names) {
    if (!e.name.startsWith(PREFIX)) continue;
    const p = join(base, e.name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (st.mtimeMs >= cutoff) {
      out.kept++;
      continue;
    }
    const size = measure(p);
    try {
      if (!dryRun) rmSync(p, { recursive: true, force: true });
      out.removed += size.files;
      out.bytes += size.bytes;
    } catch (err) {
      out.kept++;
      process.stderr.write(`prune: could not remove ${p}: ${err.message}\n`);
    }
  }
  return out;
}

const direct = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (direct) {
  const argv = process.argv.slice(2);
  let days = 1;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--dry-run") dryRun = true;
    else {
      process.stderr.write("usage: prune.mjs [--days N] [--dry-run]\n");
      process.exit(1);
    }
  }
  if (!Number.isInteger(days) || days < 0) {
    process.stderr.write("usage: prune.mjs [--days N] [--dry-run]\n");
    process.exit(1);
  }
  const r = prune(tmpdir(), { days, dryRun });
  process.stdout.write(`pruned: ${r.removed} file(s), ${r.bytes} bytes freed${dryRun ? " (dry run)" : ""}; kept ${r.kept}\n`);
}
