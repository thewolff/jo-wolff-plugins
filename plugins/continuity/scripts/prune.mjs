#!/usr/bin/env node
// scripts/prune.mjs — the continuity plugin's retention verb, declared in .claude-plugin/plugin.json
// `state[].prune` and run nightly by `ledger canary run` after the live runs.
//
//   node scripts/prune.mjs [--days 30] [--dry-run]
//
// Removes every file under ${XDG_STATE_HOME:-~/.local/state}/continuity whose mtime is older than
// --days (the snapshots `<session>.json` and the once-marks `sessions/<session>.json`), then every
// directory left empty. Prints `pruned: <n> file(s), <bytes> bytes freed` as the last line (the
// canary records the bytes). errors.log, heartbeat.ndjson and calibration.ndjson are kept whatever
// their age: they are the record (the liveness line and the pressure check read the last two, and
// each is already trimmed to its newest 200 lines on write once it passes 400).
//
// How it fails: no state directory → `pruned: 0 file(s), 0 bytes freed`, exit 0. A file that
// cannot be removed is counted as kept and named on stderr; exit stays 0 (a prune that cannot
// finish must not read as a failed canary night). A bad --days → usage on stderr, exit 1.

import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { invokedDirectly } from "../lib/hook-runner.mjs";
import { KEPT_FILES, stateDir } from "../lib/paths.mjs";

export { stateDir };

/** Remove files older than `days` under `dir`; `{ removed, bytes, kept }`. */
export function prune(dir, { days = 30, now = Date.now(), dryRun = false } = {}) {
  const cutoff = now - days * 24 * 3_600_000;
  const out = { removed: 0, bytes: 0, kept: 0 };
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        try {
          if (!dryRun && readdirSync(p).length === 0) rmdirSync(p);
        } catch {
          /* left as is */
        }
        continue;
      }
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (KEPT_FILES.includes(e.name) || st.mtimeMs >= cutoff) {
        out.kept++;
        continue;
      }
      try {
        if (!dryRun) rmSync(p, { force: true });
        out.removed++;
        out.bytes += st.size;
      } catch (err) {
        out.kept++;
        process.stderr.write(`prune: could not remove ${p}: ${err.message}\n`);
      }
    }
  };
  walk(dir);
  return out;
}

// realpath on both sides (lib/hook-runner.mjs invokedDirectly): a URL pathname is percent-encoded
// and argv is the path as typed, so a plain comparison skipped the run through a symlink or a
// directory with a space in its name, silently.
if (invokedDirectly(import.meta.url)) {
  const argv = process.argv.slice(2);
  let days = 30;
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
  const r = prune(stateDir(), { days, dryRun });
  process.stdout.write(`pruned: ${r.removed} file(s), ${r.bytes} bytes freed${dryRun ? " (dry run)" : ""}; kept ${r.kept}\n`);
}
