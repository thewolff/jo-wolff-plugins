// model-notice.mjs — the pure half of the model notice: is this cwd a coordinating folder, does a
// model id match the owner's expected one, and the exact text of each notice. No I/O except
// realpath, which the caller can replace.
//
// Model match: expectedModel is a minimum. A trailing bracket suffix such as `[1m]` is stripped,
// then the id is parsed as claude-<family>-<major>[-<minor>][-YYYYMMDD]. It passes when its family
// ranks above the expected family (config `modelFamilyRank`, default haiku < sonnet < opus < fable), or the family is the same and
// its version is at least the expected one (major, then minor; a missing minor is 0), so
// `claude-opus-5` falls below `claude-opus-5-5`. expectedModel is normalised the same way, so a
// configured `claude-opus-5-5[1m]` is the minimum 5.5. An id that does not start with `claude-`
// (an alias such as `opus`) cannot be judged. Two different families are compared only when both are in the ranking: an
// incoming family that is not listed (a brand-new family) or an expected family that is not listed
// is "unknown", never "mismatch". The same family needs no ranking, so its versions compare either way.
// An expectedModel that cannot be parsed falls back to the older exact-or-dated comparison.
//
// Effort: compared only when the caller passes one. The hook input at PostModelSwitch carries
// no effort today (measured on the desktop app and the CLI, 2026-11-11), so the notice is
// model-only and says `(effort not visible to hooks here)`.

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** The id with a trailing `[...]` suffix removed and whitespace trimmed; "" for a non-string. */
export function normalizeModel(id) {
  return typeof id === "string" ? id.trim().replace(/\[[^\]]*\]$/, "") : "";
}

/** Family order, lowest first; the config key `modelFamilyRank` replaces it, so a new family needs no code change. */
export const DEFAULT_FAMILY_RANK = Object.freeze(["haiku", "sonnet", "opus", "fable"]);

/** `{ family, major, minor }` for a claude-<family>-<major>[-<minor>][-YYYYMMDD] id (bracket suffix already removed), else null. */
function parseModel(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  return m ? { family: m[1], major: Number(m[2]), minor: m[3] === undefined ? 0 : Number(m[3]) } : null;
}

/** "match" (at least expectedModel), "mismatch" (below it) or "unknown" (not a ranked claude- id, so it cannot be judged). */
export function judgeModel(id, expectedModel, familyRank = DEFAULT_FAMILY_RANK) {
  const m = normalizeModel(id);
  if (!m.startsWith("claude-")) return "unknown";
  const want = normalizeModel(expectedModel).replace(/-\d{8}$/, "");
  const rank = (f) => familyRank.indexOf(f);
  const have = parseModel(m);
  const min = parseModel(want);
  if (!min) return m === want || (m.startsWith(want) && /^-\d{8}(?:$|-)/.test(m.slice(want.length))) ? "match" : "mismatch";
  if (!have) return "unknown";
  const atLeast = have.major > min.major || (have.major === min.major && have.minor >= min.minor);
  if (have.family === min.family) return atLeast ? "match" : "mismatch";
  const [a, b] = [rank(have.family), rank(min.family)];
  if (a < 0 || b < 0) return "unknown";
  return a > b ? "match" : "mismatch";
}

const real = (p, realpath) => {
  try {
    return realpath(p);
  } catch {
    return null;
  }
};

/** True when `cwd` is one of `folders` or inside one, both compared after realpath. A cwd that does not exist is in none. */
export function inFolders(cwd, folders, { realpath = realpathSync } = {}) {
  if (typeof cwd !== "string" || !cwd || !Array.isArray(folders) || !folders.length) return false;
  const here = real(cwd, realpath);
  if (!here) return false;
  return folders.some((f) => {
    const base = (real(f, realpath) ?? resolve(f)).replace(/[\\/]+$/, "") || sep;
    return here === base || here.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

/** The notice for a session on the wrong model (or effort, when known). */
export function wrongModelText(model, effort, { expectedModel, expectedEffort }) {
  const at = typeof effort === "string" && effort ? `at ${effort} effort` : "(effort not visible to hooks here)";
  return `Coordinator notice: this session is running ${model} ${at}. The owner's setting for coordinator sessions is at least ${expectedModel} at ${expectedEffort} effort. Switching is suggested (/model, /effort), and the first reply to the owner should say so.`;
}

/** The notice for a switch back onto the expected model. */
export function backOnModelText(model) {
  return `Coordinator notice: this session is now on ${model}. The earlier model notice no longer applies.`;
}

/**
 * Decide what a PostModelSwitch says.
 * @param {{ toModel?: string, fromModel?: string, source?: string, effort?: string, cwd?: string }} sw
 * @param {{ folders: string[], expectedModel: string, expectedEffort: string }} config
 * @returns {{ say: string|null, skipped: string|null }} `say` is the notice text or null;
 *   `skipped` names why the switch could not be judged (one skipped.log line), else null.
 */
export function decide(sw, config, { realpath = realpathSync } = {}) {
  const none = { say: null, skipped: null };
  if (!inFolders(sw.cwd, config.folders, { realpath })) return none;
  if (sw.source === "resume") return none;
  const to = judgeModel(sw.toModel, config.expectedModel, config.modelFamilyRank);
  if (to === "unknown") return { say: null, skipped: `to_model ${JSON.stringify(sw.toModel ?? null)} is not ${typeof sw.toModel === "string" && normalizeModel(sw.toModel).startsWith("claude-") ? "comparable with expectedModel: its family or expectedModel's is not in modelFamilyRank" : "a claude- model id"}; cannot judge` };
  const effortKnown = typeof sw.effort === "string" && sw.effort !== "";
  const effortOk = !effortKnown || sw.effort === config.expectedEffort;
  if (to === "mismatch" || !effortOk) return { say: wrongModelText(sw.toModel, effortKnown ? sw.effort : null, config), skipped: null };
  if (judgeModel(sw.fromModel, config.expectedModel, config.modelFamilyRank) === "mismatch") return { say: backOnModelText(sw.toModel), skipped: null };
  return none;
}
