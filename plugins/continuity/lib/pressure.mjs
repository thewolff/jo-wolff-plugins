// lib/pressure.mjs — when to ask for a handoff: how large this session's context is, measured
// from the transcript (lib/calibration.mjs), against an absolute ask point in tokens, counted per
// compaction window.
//
// The measure, best first:
// - "usage": the token usage the newest main-thread reply since the last compaction marker
//   recorded (input + cache read + cache creation). Exact for that turn; Claude Code writes it.
// - "calibrated": the transcript's bytes since the marker times the median tokens-per-byte ratio
//   recorded when a host passed a real `token_count` at PreCompact (an adapter that passes it;
//   Claude Code does not).
// - "estimate": those bytes divided by BYTES_PER_TOKEN_ESTIMATE, when neither exists (a fresh
//   window with no reply yet, or a host whose transcript carries no usage). Measured on Claude
//   Code transcripts, bytes per context token ran about 8 to 9.5, with a wide spread; the ask
//   says `(estimate)` when this is the basis.
//
// When, per surface (the UserPromptSubmit ask and the Stop block each keep their own anchor):
// - The first ask in a compaction window comes at the ask point (askPoint(): `askTokens`, else
//   the 0.3 `threshold` × `contextTokens`, else the default: `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`
//   minus the margin, or 175,000; the default is pulled down to `askMarginTokens` before the
//   auto-compact point when the person set an auto-compact window, lib/autocompact.mjs), and
//   never below the window's first recorded usage plus `askMarginTokens` (40,000): a Desktop
//   session that opens at 130,000 tokens is not asked on its first turn, and neither is the
//   first turn after a compaction.
// - After an ask, the next one in the same window comes once the context has grown a further
//   `reaskStepTokens` (150,000) past the size it was asked at, or sooner, at `askMarginTokens`
//   before the auto-compact point, when that comes first and was not already passed by an ask
//   (so a 300,000-token window asks near 175,000 and again near 227,000, never twice at one
//   point). The anchor is written per window (`epoch`), so a compaction re-arms the ask, and a
//   0.3 flag (an ISO string, no epoch) counts as an earlier window.
// - A handoff this session wrote after the window's compaction marker and after the last ask
//   silences the ask that is due, and becomes the anchor the next step is counted from (at the
//   size of the turn it silenced).

import { autoCompactCliff } from "./autocompact.mjs";
import { readCalibration, measureTranscript } from "./calibration.mjs";
import { lastHandoffBy, resolveHandoffRoot } from "./handoffs.mjs";
import { setFlag, sessionKey } from "./session-flags.mjs";

/** Bytes of transcript per token of context when nothing better is known. An estimate. */
export const BYTES_PER_TOKEN_ESTIMATE = 8;
/** The ask point when nothing configures one: under Claude Code's 200,000-token idle-compaction threshold. */
export const ASK_TOKENS = 175000;
/** The 0.3 defaults a config file that sets only one of `threshold` / `contextTokens` falls back to. */
export const LEGACY_THRESHOLD = 0.65;
export const LEGACY_CONTEXT_TOKENS = 200000;
/** Claude Code raises an idle-compaction threshold below this to this. */
export const IDLE_COMPACT_FLOOR = 100000;

/**
 * `{ tokens, bytes, basis, sinceMarker, baselineTokens, epoch, markerAt, model }` for the
 * transcript at `path`, where basis is "usage", "calibrated" or "estimate"; null when the
 * transcript cannot be measured or is empty.
 */
export function estimateContext(path, env = process.env) {
  const m = measureTranscript(path);
  if (!m || !m.bytes) return null;
  const window = { bytes: m.bytes, sinceMarker: m.sinceMarker, baselineTokens: m.baselineTokens, epoch: m.epoch, markerAt: m.markerAt, model: m.model };
  if (m.usageTokens) return { tokens: m.usageTokens, basis: "usage", ...window };
  const cal = readCalibration(env);
  return cal ? { tokens: m.bytes * cal.ratio, basis: "calibrated", ...window } : { tokens: m.bytes / BYTES_PER_TOKEN_ESTIMATE, basis: "estimate", ...window };
}

/** `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` as Claude Code reads it (a positive whole number, at least 100,000); null when unset or not a number. */
export function idleCompactMinTokens(env = process.env) {
  const raw = String(env?.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS ?? "").trim();
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) return null;
  return Math.max(IDLE_COMPACT_FLOOR, Number(raw));
}

/**
 * The ask points of a window before the baseline floor, `{ tokens, source, cap }`. `tokens`, the
 * first ask, in precedence order: the config's `askTokens`; the 0.3 `threshold` ×
 * `contextTokens` when the file sets either; else the default, `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`
 * minus `askMarginTokens` or ASK_TOKENS, lowered to `cap` when that is earlier. `cap` is
 * `askMarginTokens` before `cliff` (lib/autocompact.mjs autoCompactCliff(), the context size
 * Claude Code will auto-compact at), null without one; dueAsk() also brings a re-ask forward to
 * it. An explicit `askTokens` or `threshold` is never lowered.
 */
export function askPoint(config, env = process.env, cliff = null) {
  const cap = cliff ? Math.max(1, cliff.tokens - config.askMarginTokens) : null;
  if (config.askTokens != null) return { tokens: config.askTokens, source: "askTokens", cap };
  if (config.threshold != null || config.contextTokens != null) {
    return { tokens: Math.round((config.threshold ?? LEGACY_THRESHOLD) * (config.contextTokens ?? LEGACY_CONTEXT_TOKENS)), source: "threshold", cap };
  }
  const idle = idleCompactMinTokens(env);
  const base = idle != null ? { tokens: Math.max(1, idle - config.askMarginTokens), source: "idle" } : { tokens: ASK_TOKENS, source: "default" };
  return cap != null && cap < base.tokens ? { tokens: cap, source: "autoCompactWindow", cap } : { ...base, cap };
}

/**
 * The next ask after one at `tokens`: a re-ask step on, or `cap` when that comes first and is at
 * least `gap` further on (an ask already within `gap` of the cap was the near-compaction ask; it
 * is not repeated a turn later).
 */
export function nextAsk(tokens, step, cap, gap = 0) {
  return cap != null && cap - tokens >= gap ? Math.min(tokens + step, cap) : tokens + step;
}

/** The anchor stored under a flag when it belongs to `epoch`; null for another window, a 0.3 ISO string, or junk. */
function anchorIn(value, epoch) {
  if (!value || typeof value !== "object" || value.epoch !== epoch) return null;
  if (typeof value.tokens !== "number" || !Number.isFinite(value.tokens)) return null;
  const at = Date.parse(value.at);
  return { tokens: value.tokens, at: Number.isFinite(at) ? at : 0 };
}

/**
 * Whether the surface whose anchor is `flags[flag]` ("promptWarned" or "stopBlocked") asks now.
 * Null when the transcript cannot be measured, the context is under the point due, or a handoff
 * this session wrote silences it (that silence is recorded as the new anchor, best effort).
 * Otherwise `{ tokens, basis, next, mark }`: `next` is where the following ask would come;
 * `mark()` writes the ask as the anchor and returns false when it could not, so the caller
 * decides whether to ask anyway.
 */
export async function dueAsk(input, flag, { config, flags = {}, env = process.env, now = Date.now() } = {}) {
  const est = estimateContext(input?.transcript_path, env);
  if (!est) return null;
  const cliff = autoCompactCliff({ model: est.model, projectDir: env?.CLAUDE_PROJECT_DIR || input?.cwd || null, env });
  const point = askPoint(config, env, cliff);
  const prev = anchorIn(flags[flag], est.epoch);
  const floor = est.baselineTokens != null ? est.baselineTokens + config.askMarginTokens : 0;
  const due = prev ? nextAsk(prev.tokens, config.reaskStepTokens, point.cap, config.askMarginTokens) : Math.max(point.tokens, floor);
  if (est.tokens < due) return null;
  const key = sessionKey(input);
  const tokens = Math.round(est.tokens);
  const anchor = (by) => setFlag(key, flag, { epoch: est.epoch, tokens, at: new Date(now).toISOString(), by }, env);
  // A handoff written after this window's compaction and after the last ask already holds what
  // the ask would ask for. Without a session id there is no handoff to attribute.
  if (input?.session_id) {
    const { root } = await resolveHandoffRoot(String(input.cwd || "") || process.cwd(), env);
    const wrote = lastHandoffBy(root, input.session_id, now);
    if (wrote != null && wrote > (est.markerAt ?? -Infinity) && wrote > (prev?.at ?? -Infinity)) {
      anchor("handoff");
      return null;
    }
  }
  return { tokens, basis: est.basis, next: nextAsk(tokens, config.reaskStepTokens, point.cap, config.askMarginTokens), mark: () => anchor("ask") };
}

const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+$)/g, ",");

/** The text that asks for a handoff; the same on both surfaces, with the way out in backticks. `next` is where the following ask comes. */
export function handoffRequest(tokens, basis = "estimate", next = tokens + 150000) {
  const how =
    basis === "usage"
      ? `${thousands(tokens)} tokens (from the token usage the last reply recorded)`
      : basis === "calibrated"
        ? `roughly ${thousands(tokens)} tokens (calibrated from this machine's compactions)`
        : `roughly ${thousands(tokens)} tokens (estimate), judged from the transcript's size because no reply since the last compaction recorded its token usage`;
  return (
    `continuity: this session's context is ${how}. Before it is compacted, run \`/continuity:handoff\` ` +
    "to write the judgment layer to `.ai/handoffs/` in the repository: what you were in the middle of, what you already ruled " +
    "out, what is still uncertain. The next session inherits that file and nothing else beyond the repository itself; " +
    "mechanical state (branch, diff, touched files, recent asks) is saved automatically at compaction and is not what gets lost. " +
    "If there is genuinely nothing in flight worth passing on, a short session or a finished task, say so in one line and stop. " +
    `This asks again only once the context reaches ${thousands(next)} tokens, or after the next compaction.`
  );
}
