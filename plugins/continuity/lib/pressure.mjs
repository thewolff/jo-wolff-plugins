// lib/pressure.mjs — how full is this session's context, as a fraction of `contextTokens` from
// the config (default 200,000), estimated from the transcript's size (lib/calibration.mjs).
//
// The estimate is the transcript's bytes since its last compaction marker divided by
// BYTES_PER_TOKEN_ESTIMATE. It is an estimate, not a count: Claude Code gives a hook no token
// count before compaction, so the size of the transcript file is the only measure every hook
// event can reach. A transcript line is JSON with metadata around the text, so bytes / 4 tends to
// overstate the context, which makes the check speak early rather than late. When a host has
// ever reported a real `token_count` at PreCompact (an adapter that passes it; Claude Code does
// not), the calibrated ratio replaces the constant and the answer says which basis it used.

import { readCalibration, measureTranscript } from "./calibration.mjs";

/** Bytes of transcript per token of context when nothing better is known. An estimate. */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

/**
 * `{ tokens, bytes, basis, sinceMarker }` for the transcript at `path`, where basis is
 * "calibrated" or "estimate"; null when the transcript cannot be measured or is empty.
 */
export function estimateContext(path, env = process.env) {
  const m = measureTranscript(path);
  if (!m || !m.bytes) return null;
  const cal = readCalibration(env);
  return cal
    ? { tokens: m.bytes * cal.ratio, bytes: m.bytes, basis: "calibrated", sinceMarker: m.sinceMarker }
    : { tokens: m.bytes / BYTES_PER_TOKEN_ESTIMATE, bytes: m.bytes, basis: "estimate", sinceMarker: m.sinceMarker };
}

/**
 * `{ pct, estimated, target, basis }` when the estimate is at or past `threshold` × `contextTokens`;
 * null when the transcript cannot be measured or the estimate is under.
 */
export function pressure(input, { threshold, contextTokens, env = process.env } = {}) {
  const est = estimateContext(input?.transcript_path, env);
  if (!est || est.tokens < contextTokens * threshold) return null;
  return { pct: Math.round((est.tokens / contextTokens) * 100), estimated: Math.round(est.tokens), target: contextTokens, basis: est.basis };
}

/** The text that asks for a handoff; the same on both surfaces, with the way out in backticks. */
export function handoffRequest(pct, basis = "estimate") {
  const how = basis === "calibrated" ? "calibrated from this machine's compactions" : "estimated from the transcript's size, not counted";
  return (
    `continuity: this session's context is roughly ${pct}% full (${how}). Before it ends, run \`/continuity:handoff\` ` +
    "to write the judgment layer to `.ai/handoffs/` in the repository: what you were in the middle of, what you already ruled " +
    "out, what is still uncertain. The next session inherits that file and nothing else beyond the repository itself; " +
    "mechanical state (branch, diff, touched files, recent asks) is saved automatically at compaction and is not what gets lost. " +
    "If there is genuinely nothing in flight worth passing on, a short session or a finished task, say so in one line and stop. " +
    "This fires once per session either way."
  );
}
