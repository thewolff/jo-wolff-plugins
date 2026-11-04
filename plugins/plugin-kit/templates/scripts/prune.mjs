#!/usr/bin/env node
// scripts/prune.mjs — the {{name}} plugin's retention verb, declared in .claude-plugin/plugin.json
// `state[].prune` and run by `ledger canary run` (nightly after the live runs, and daily on its
// own as `canary run --prunes-only`).
//
//   node scripts/prune.mjs [--days 30] [--dry-run]
//
// Removes every file under ${XDG_STATE_HOME:-~/.local/state}/{{name}} whose mtime is older than
// --days, then every directory left empty; then rotates every log (a `*.log` or `*.jsonl` file,
// errors.log included) that has grown past 256 KiB by renaming it to `<name>.1` (the previous
// `.1` is replaced, and its bytes count as freed), so a writer that only ever appends is bounded
// at 256 KiB plus one `.1`, and the `.1` ages out like any other file on a later run. Prints
// `rotated <path> to <path>.1` per rotation and `pruned: <n> file(s), <bytes> bytes freed` as the
// last line (the canary records the bytes). errors.log is kept whatever its age: it is the record.
//
// How it fails: no state directory → `pruned: 0 file(s), 0 bytes freed`, exit 0. A file that
// cannot be removed or rotated is counted as kept and named on stderr; exit stays 0 (a prune that
// cannot finish must not read as a failed canary night). A bad --days → usage on stderr, exit 1.

import { readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A log rotates once it passes this many bytes. */
export const MAX_LOG_BYTES = 256 * 1024;
/** The files that rotate rather than grow: appended logs. A `.1` never rotates again. */
export const ROTATED = /\.(log|jsonl)$/;

export function stateDir(env = process.env) {
  const xdg = env.XDG_STATE_HOME?.trim() ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local", "state");
  return join(xdg, "{{name}}");
}

/**
 * Remove files older than `days` under `dir`, then rotate the logs past `maxBytes`;
 * `{ removed, bytes, kept, rotated }` (`rotated` lists the logs renamed, or named on a dry run).
 */
export function prune(dir, { days = 30, now = Date.now(), dryRun = false, maxBytes = MAX_LOG_BYTES } = {}) {
  const cutoff = now - days * 24 * 3_600_000;
  const out = { removed: 0, bytes: 0, kept: 0, rotated: [] };
  const logs = [];
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
      if (e.name === "errors.log" || st.mtimeMs >= cutoff) {
        out.kept++;
        if (ROTATED.test(e.name) && st.size > maxBytes) logs.push({ path: p, name: e.name, dir: d });
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
  for (const log of logs) {
    const old = `${log.path}.1`;
    let replaced = 0;
    try {
      replaced = statSync(old).size;
    } catch {
      /* no earlier rotation */
    }
    try {
      if (!dryRun) renameSync(log.path, old);
      out.rotated.push(log.path);
      if (replaced) {
        out.removed++;
        out.bytes += replaced;
      }
    } catch (err) {
      process.stderr.write(`prune: could not rotate ${log.path}: ${err.message}\n`);
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
  for (const p of r.rotated) process.stdout.write(`${dryRun ? "would rotate" : "rotated"} ${p} to ${p}.1\n`);
  process.stdout.write(`pruned: ${r.removed} file(s), ${r.bytes} bytes freed${dryRun ? " (dry run)" : ""}; kept ${r.kept}\n`);
}
