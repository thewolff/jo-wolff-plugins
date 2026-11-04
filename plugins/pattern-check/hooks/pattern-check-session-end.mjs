#!/usr/bin/env node
// pattern-check-session-end.mjs — Claude Code SessionEnd: remove the session's working files.
//
// A session leaves up to four files in the state directory (scripts/lib/state.mjs). Two are
// evidence and stay: receipts/<key>.md (the copy of the receipt) and current/<repo hash> (which
// the next session in that repository overwrites). Two are working state that means nothing once
// the session has ended, and this hook removes them: sessions/<key>.json (the files touched) and
// stop/<key> (the hash of the last refused reply). Before 0.3.1 they stayed forever.
//
// Claude Code sends SessionEnd hooks `session_id`, `cwd` and `reason` (hooks reference,
// "SessionEnd input"). The key is resolved exactly as the other hooks resolve it, so a degraded
// (per-cwd) key removes the per-cwd files.
//
// FAIL OPEN, NOT SILENT. Every path exits 0; SessionEnd cannot block anything. Removal is best
// effort: a file that is already gone is nothing; any other error is shown as one systemMessage
// line and appended to <state dir>/errors.log (scripts/lib/hookio.mjs). Rerun-safe: removing
// twice is a no-op. A session that never reaches SessionEnd (a crash, a kill) keeps its files.
//
// Contract: JSON on stdin (SessionEnd payload). JSON on stdout, or nothing.

import { realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveContext } from "../scripts/lib/context.mjs";
import { runHook } from "../scripts/lib/hookio.mjs";
import { paths } from "../scripts/lib/state.mjs";

/** The files this hook removes for a session key, in order. */
export function workingFiles(base, key) {
  return [paths.session(base, key), paths.stop(base, key)];
}

/** The hook's output for one payload: the JSON to print, or null for none. Throws are the caller's. */
export function handle(input, opts = {}) {
  const { base, key, warnings } = resolveContext(input, opts);
  for (const file of workingFiles(base, key)) {
    try {
      rmSync(file, { force: true });
    } catch (e) {
      warnings.push(`could not remove ${file} (${e.message})`);
    }
  }
  return warnings.length ? { systemMessage: `pattern-check: ${warnings.join("; ")}` } : null;
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) runHook({ file: "pattern-check-session-end.mjs", event: "SessionEnd", allowed: "the session's working files were left in place", handle: (input) => handle(input) });
