// ledger-judge.mjs — ledger's layer over the shared judge dispatch (lib/judge.mjs, plugin-kit's
// copy byte for byte, never edited here): it checks "this finding is resolved" claims for
// `review` and grades rules for `report`. lib/judge.mjs runs the command (one string through
// /bin/sh as the leader of its own process group, the prompt on stdin or substituted for a
// literal `{prompt}`, stdout only, a hard timeout after which the whole group is killed, never a
// throw) and reads the one-word answer: the last non-empty line of stdout, stripped of markdown
// and punctuation, must start with one of the words.
//
// The command, first found wins (lib/judge.mjs resolveJudgeCommand, ledger's settings first):
//   1. env LEDGER_JUDGE_BIN (tests, one-off overrides)
//   2. `review.judgeCommand` in the ledger user file
//   3. `command` in the shared file, ${XDG_CONFIG_HOME:-~/.config}/judge/config.json (0.3.7),
//      written by `node lib/judge.mjs setup`; a malformed shared file ends the search here
//   4. `enforcement.judgeCommand` in the i-have-audhd profile ($I_HAVE_AUDHD_PROFILE, else
//      ~/.claude/i-have-audhd.json), legacy, when that file exists and parses
// The timeout is the shared file's `timeoutMs` when it sets one, else JUDGE_TIMEOUT_MS.
//
// Verdicts: `yes` (resolved), `no` (not resolved), `unverified` (no judge configured, it could
// not start, exited non-zero, timed out, or answered something else). `unverified` is fail-open:
// the caller treats the finding as resolved and shows the word so the human can see it.
// `yes` and `no` are cached in cc_judge_cache under `judge:<sha256(passage + question)>` with the
// passage and question they were given (0.3.3; before, cc_meta held the word only), so asking
// the same thing again never runs the judge and a cached answer can be read back with
// `ledger review judge <key>`; `unverified` is never cached.

import { createHash } from "node:crypto";
import { transaction } from "./db.mjs";
import { logError } from "./failopen.mjs";
import { dispatch, parseAnswer, readSharedConfig, resolveJudgeCommand } from "./judge.mjs";
import { nowIso } from "./time.mjs";

export const JUDGE_QUESTION = "Does this change resolve the finding? Answer yes or no.";
export const JUDGE_TIMEOUT_MS = 60_000;
export const PASSAGE_CAP_BYTES = 8 * 1024;
export const JUDGE_ENV_VAR = "LEDGER_JUDGE_BIN";

/** The pluginKey lib/judge.mjs resolves with: ledger's env override and `review.judgeCommand`. */
function pluginKey(config, env) {
  const ownTimeout = Number(readSharedConfig({ env }).config?.timeoutMs) > 0 ? undefined : JUDGE_TIMEOUT_MS;
  return { envVar: JUDGE_ENV_VAR, command: config?.review?.judgeCommand ?? null, source: "review.judgeCommand", timeoutMs: ownTimeout };
}

/**
 * { command, timeoutMs, source } for the judge, or all three null when none is configured.
 * `malformed` is `<path>: <error>` when the shared file exists and cannot be used, else null.
 */
export function judgeCommand(config, env = process.env) {
  const malformed = readSharedConfig({ env }).malformed;
  const found = resolveJudgeCommand({ pluginKey: pluginKey(config, env), env });
  return found ? { ...found, malformed } : { command: null, timeoutMs: null, source: null, malformed };
}

/** One judge run: { ok: true, stdout } or { ok: false, error, stderr } with ledger's wording of the failure. */
async function runOnce(command, prompt, timeoutMs, env) {
  const r = await dispatch(prompt, { command, timeoutMs, env });
  if (r.ok) return { ok: true, stdout: r.stdout, stderr: r.stderr.slice(-300) };
  const error =
    r.error === "nonzero" ? `judge exited ${r.code}` : r.error === "timeout" ? `judge timed out after ${Math.round(timeoutMs / 1000)}s` : `judge could not start: ${r.detail}`;
  return { ok: false, error, stderr: r.stderr.slice(-300) };
}

/**
 * One uncached judge call whose answer is one of `words` (the report's biting|silent|fine).
 * Returns { answer, error }: answer null with the reason when no judge is configured, it fails,
 * or it says none of the words. Nothing is written: a grade is recomputed each time.
 */
export async function askWord({ config, env = process.env, passage, question, words, timeoutMs }) {
  const judge = judgeCommand(config, env);
  if (!judge.command) return { answer: null, error: judge.malformed ? `no judge configured (malformed ${judge.malformed})` : "no judge configured" };
  const prompt = `${passage}\n\nQuestion: ${question}\nReply with a single word: ${words.join(", ")}.`;
  const r = await runOnce(judge.command, prompt, timeoutMs ?? judge.timeoutMs, env);
  if (!r.ok) return { answer: null, error: r.error };
  const answer = parseAnswer(r.stdout, words);
  return answer ? { answer, error: null } : { answer: null, error: `unparsed: judge answered none of ${words.join("|")}` };
}

/** The cached answer for `key`, or null. */
function cached(db, key) {
  try {
    return db.prepare("SELECT answer FROM cc_judge_cache WHERE key = ?").get(key)?.answer ?? null;
  } catch {
    return null;
  }
}

function remember(db, dbPath, { key, question, passage, answer, now }, env) {
  try {
    transaction(
      db,
      () => {
        db.prepare(
          "INSERT INTO cc_judge_cache (key, question, passage, answer, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET answer = excluded.answer, passage = excluded.passage, question = excluded.question, at = excluded.at",
        ).run(key, question, passage, answer, nowIso(now));
      },
      dbPath,
    );
  } catch (err) {
    logError("review", `judge answer not cached: ${err.message}`, env);
  }
}

/** The cached row for `key` (`judge:` prefix optional): { key, question, passage, answer, at } or null. */
export function cachedJudgement(db, key) {
  const k = String(key ?? "").startsWith("judge:") ? key : `judge:${key}`;
  return db.prepare("SELECT key, question, passage, answer, at FROM cc_judge_cache WHERE key = ?").get(k) ?? null;
}

/** The cached judge rows at or after `since` (ms), newest first. */
export function judgementsSince(db, since) {
  return db.prepare("SELECT key, question, passage, answer, at FROM cc_judge_cache WHERE at >= ? ORDER BY at DESC").all(nowIso(since));
}

/**
 * The passage for one finding: its text, then the diff. When the two together pass
 * PASSAGE_CAP_BYTES, the passage is cut to fit and ends with a marker saying how much was left
 * out and the sha256 of the whole input, so the judge knows the evidence is partial and two
 * inputs that differ only past the cut are cached apart.
 */
export function passageFor(findingText, diff) {
  const full = `Finding:\n${String(findingText ?? "")}\n\nChange (unified diff):\n${String(diff ?? "") || "(no change to the files the finding names)"}`;
  const size = Buffer.byteLength(full);
  if (size <= PASSAGE_CAP_BYTES) return full;
  const digest = createHash("sha256").update(full).digest("hex");
  const marker = `\n[cut: the finding and change are ${size} bytes; only the first part fits the ${PASSAGE_CAP_BYTES}-byte limit, the rest is not shown; sha256 of the whole: ${digest}]`;
  const room = Math.max(0, PASSAGE_CAP_BYTES - Buffer.byteLength(marker));
  return Buffer.from(full).subarray(0, room).toString("utf8").replace(/\uFFFD+$/, "") + marker;
}

/**
 * Ask the judge about one passage. Never throws.
 * @returns {Promise<{ verdict: "yes"|"no"|"unverified", cached: boolean, error: string|null }>}
 */
export async function ask({ db, dbPath, config, env = process.env, passage, question = JUDGE_QUESTION, timeoutMs, now = Date.now() }) {
  try {
    const key = `judge:${createHash("sha256").update(passage + question).digest("hex")}`;
    const hit = cached(db, key);
    if (hit === "yes" || hit === "no") return { verdict: hit, cached: true, error: null };
    const judge = judgeCommand(config, env);
    if (!judge.command) return { verdict: "unverified", cached: false, error: judge.malformed ? `no judge configured (malformed ${judge.malformed})` : "no judge configured" };
    const prompt = `${passage}\n\nQuestion: ${question}\nReply with the single word yes or no.`;
    const r = await runOnce(judge.command, prompt, timeoutMs ?? judge.timeoutMs, env);
    const answer = r.ok ? parseAnswer(r.stdout) : null;
    if (!answer) {
      const error = r.ok ? "judge answered neither yes nor no" : r.error;
      logError("review", `judge unavailable: ${error}${r.stderr ? ` · ${r.stderr.replace(/\s+/g, " ").trim()}` : ""}`, env);
      return { verdict: "unverified", cached: false, error };
    }
    remember(db, dbPath, { key, question, passage, answer, now }, env);
    return { verdict: answer, cached: false, error: null };
  } catch (err) {
    logError("review", `judge failed: ${err.message}`, env);
    return { verdict: "unverified", cached: false, error: err.message };
  }
}
