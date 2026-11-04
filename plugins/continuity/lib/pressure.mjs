// lib/pressure.mjs — how full is this session's context, as a fraction of `contextTokens` from
// the config (default 200,000), measured from the transcript (lib/calibration.mjs).
//
// The measure, best first:
// - "usage": the token usage the newest main-thread reply since the last compaction marker
//   recorded (input + cache read + cache creation). Exact for that turn; Claude Code writes it.
// - "calibrated": the transcript's bytes since the marker times the median tokens-per-byte ratio
//   recorded when a host passed a real `token_count` at PreCompact (an adapter that passes it;
//   Claude Code does not).
// - "estimate": those bytes divided by BYTES_PER_TOKEN_ESTIMATE, when neither exists (a fresh
//   window with no reply yet, or a host whose transcript carries no usage). Measured on Claude
//   Code transcripts, bytes per context token ran about 8 to 9.5, with a wide spread; the warning
//   says `(estimate)` when this is the basis.

import { readCalibration, measureTranscript } from "./calibration.mjs";

/** Bytes of transcript per token of context when nothing better is known. An estimate. */
export const BYTES_PER_TOKEN_ESTIMATE = 8;

/**
 * `{ tokens, bytes, basis, sinceMarker }` for the transcript at `path`, where basis is
 * "usage", "calibrated" or "estimate"; null when the transcript cannot be measured or is empty.
 */
export function estimateContext(path, env = process.env) {
  const m = measureTranscript(path);
  if (!m || !m.bytes) return null;
  if (m.usageTokens) return { tokens: m.usageTokens, bytes: m.bytes, basis: "usage", sinceMarker: m.sinceMarker };
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
  const how =
    basis === "usage"
      ? `${pct}% full (from the token usage the last reply recorded)`
      : basis === "calibrated"
        ? `roughly ${pct}% full (calibrated from this machine's compactions)`
        : `roughly ${pct}% full (estimate), judged from the transcript's size because no reply since the last compaction recorded its token usage`;
  return (
    `continuity: this session's context is ${how}. Before it ends, run \`/continuity:handoff\` ` +
    "to write the judgment layer to `.ai/handoffs/` in the repository: what you were in the middle of, what you already ruled " +
    "out, what is still uncertain. The next session inherits that file and nothing else beyond the repository itself; " +
    "mechanical state (branch, diff, touched files, recent asks) is saved automatically at compaction and is not what gets lost. " +
    "If there is genuinely nothing in flight worth passing on, a short session or a finished task, say so in one line and stop. " +
    "This fires once per session either way."
  );
}
