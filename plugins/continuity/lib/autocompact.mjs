// lib/autocompact.mjs — where Claude Code will auto-compact this session: the auto-compact window
// the person set, resolved the way Claude Code resolves it, less the buffer it compacts ahead of,
// and pulled earlier by CLAUDE_AUTOCOMPACT_PCT_OVERRIDE. lib/pressure.mjs asks for a handoff
// `askMarginTokens` before that point when it comes before the default ask point.
//
// The window, first match wins (code.claude.com/docs/en/model-config.md, "Set the auto-compact
// window"; settings-reference.md, `autoCompactWindow` and `modelSettings`; settings.md,
// "Settings precedence"):
// 1. `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: a token count, or with a `k` / `M` suffix; below 100,000
//    is read as 100,000 and above 1,000,000 as 1,000,000; anything else is ignored, as Claude Code
//    ignores it. (`--autocompact` sits between this and the settings files; a hook cannot see it.)
// 2. The settings files, project local (`<project>/.claude/settings.local.json`) over shared
//    project (`<project>/.claude/settings.json`) over user (`$CLAUDE_CONFIG_DIR/settings.json`,
//    else `~/.claude/settings.json`). The highest file that sets the window for the model wins;
//    inside one file `modelSettings.<model>.autoCompactWindow` beats the top-level
//    `autoCompactWindow`. A value of `"auto"` there is Claude Code's tuned default: no window.
//    `<project>` is `CLAUDE_PROJECT_DIR`, else the hook's cwd. Managed settings and `--settings`
//    are not read.
// 3. None: Claude Code's default for the model (about 967,000 on a native 1M window), which is
//    past the idle-compaction point, so it changes nothing here and is not modelled.
//
// The model is the transcript's newest main-thread `message.model`; a `modelSettings` key matches
// it exactly or with its `[1m]` and `-YYYYMMDD` suffixes taken off. Claude Code compacts about
// AUTO_COMPACT_BUFFER tokens before the window (measured, not documented; see the constant);
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1-100, a percentage of the window) only moves that earlier.
//
// How it fails: open. A settings file that is missing, unreadable, not JSON, or carries a value
// of the wrong shape is skipped as if it set nothing; with no window found the ask point is what
// it was without this module.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How far before the window Claude Code auto-compacts. Measured, not documented, so it may move
 * between releases: on Claude Code 2.1.321 with a 300,000 window for claude-fable-5-2, session
 * eacf7986 compacted automatically on 2026-11-10 at 7:03 PM PST with `compactMetadata.preTokens`
 * 267,109, which is 32,891 before the window.
 */
export const AUTO_COMPACT_BUFFER = 33000;
export const WINDOW_MIN = 100000;
export const WINDOW_MAX = 1000000;

/** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as Claude Code reads it: tokens (k/M suffixes allowed), clamped to 100,000..1,000,000; null when unset or not a token count. */
export function envWindow(raw) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "" ? 1 : /k/i.test(m[2]) ? 1000 : 1000000);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, Math.round(n)));
}

/** A settings-file window: a whole number from 100,000 to 1,000,000, or "auto" (null: the default); undefined when the value is absent or of the wrong shape. */
function settingsWindow(v) {
  if (v === "auto") return null;
  if (Number.isInteger(v) && v >= WINDOW_MIN && v <= WINDOW_MAX) return v;
  return undefined;
}

const modelKey = (model) => String(model).replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");

function readJson(path) {
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return json && typeof json === "object" && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

/** The settings files Claude Code reads, highest precedence first. */
export function settingsFiles(projectDir, env = process.env) {
  const files = [];
  if (projectDir) files.push(join(projectDir, ".claude", "settings.local.json"), join(projectDir, ".claude", "settings.json"));
  const userDir = env?.CLAUDE_CONFIG_DIR || (env?.HOME ? join(env.HOME, ".claude") : null);
  if (userDir) files.push(join(userDir, "settings.json"));
  return files;
}

/**
 * The auto-compact window for `model`, `{ tokens, source }` (source: "env" or the settings file
 * path), or null when none is set (Claude Code's tuned default).
 */
export function autoCompactWindow({ model = null, projectDir = null, env = process.env } = {}) {
  const fromEnv = envWindow(env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (fromEnv != null) return { tokens: fromEnv, source: "CLAUDE_CODE_AUTO_COMPACT_WINDOW" };
  for (const file of settingsFiles(projectDir, env)) {
    const json = readJson(file);
    if (!json) continue;
    let found;
    const per = json.modelSettings;
    if (model && per && typeof per === "object" && !Array.isArray(per)) {
      const want = [String(model), modelKey(model)];
      for (const [key, entry] of Object.entries(per)) {
        if (!want.includes(key) && modelKey(key) !== want[1]) continue;
        found = settingsWindow(entry?.autoCompactWindow);
        if (found !== undefined) break;
      }
    }
    if (found === undefined) found = settingsWindow(json.autoCompactWindow);
    if (found === undefined) continue;
    return found === null ? null : { tokens: found, source: file };
  }
  return null;
}

/** CLAUDE_AUTOCOMPACT_PCT_OVERRIDE as a fraction (1-100 → 0.01-1); null when unset or out of range. */
export function pctOverride(env = process.env) {
  const raw = String(env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 100 ? n / 100 : null;
}

/**
 * The context size at which Claude Code will auto-compact, `{ tokens, window, source }`: the
 * window less AUTO_COMPACT_BUFFER, or the percentage override of the window when that is
 * earlier; null when no window is set.
 */
export function autoCompactCliff(opts = {}) {
  const w = autoCompactWindow(opts);
  if (!w) return null;
  const pct = pctOverride(opts.env ?? process.env);
  const tokens = Math.min(w.tokens - AUTO_COMPACT_BUFFER, pct == null ? Infinity : Math.floor(w.tokens * pct));
  return { tokens, window: w.tokens, source: w.source };
}
