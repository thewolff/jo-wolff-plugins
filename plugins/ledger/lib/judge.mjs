// judge.mjs — a judge model checks "this finding is resolved" claims. The dispatch contract is
// the i-have-audhd plugin's (judge/ask.mjs there): one command string run through /bin/sh as
// the leader of its own process group, the prompt on stdin (or substituted for a literal
// `{prompt}`, shell-escaped), stdout only, a hard timeout after which the whole group is
// killed, and never a throw. The answer here is one word, `yes` or `no`: the last non-empty
// line of stdout, stripped of markdown and punctuation, must start with one of them.
//
// The command, first found wins:
//   1. env LEDGER_JUDGE_BIN (tests, one-off overrides)
//   2. `review.judgeCommand` in the ledger user file
//   3. `enforcement.judgeCommand` in the i-have-audhd profile ($I_HAVE_AUDHD_PROFILE, else
//      ~/.claude/i-have-audhd.json), when that file exists and parses: one judge, configured once
//
// Verdicts: `yes` (resolved), `no` (not resolved), `unverified` (no judge configured, it could
// not start, exited non-zero, timed out, or answered something else). `unverified` is fail-open:
// the caller treats the finding as resolved and shows the word so the human can see it.
// `yes` and `no` are cached in cc_judge_cache under `judge:<sha256(passage + question)>` with the
// passage and question they were given (0.3.3; before, cc_meta held the word only), so asking
// the same thing again never runs the judge and a cached answer can be read back with
// `ledger review judge <key>`; `unverified` is never cached.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { transaction } from "./db.mjs";
import { logError } from "./failopen.mjs";
import { nowIso } from "./time.mjs";

export const JUDGE_QUESTION = "Does this change resolve the finding? Answer yes or no.";
export const JUDGE_TIMEOUT_MS = 60_000;
export const PASSAGE_CAP_BYTES = 8 * 1024;

/** The i-have-audhd profile path (the same rule that plugin uses). */
export function audhdProfilePath(env = process.env) {
  const explicit = env.I_HAVE_AUDHD_PROFILE;
  if (explicit && explicit.trim()) return explicit.trim();
  return join(env.HOME || homedir(), ".claude", "i-have-audhd.json");
}

/** { command, source } for the judge, or { command: null, source: null } when none is configured. */
export function judgeCommand(config, env = process.env) {
  if (env.LEDGER_JUDGE_BIN && env.LEDGER_JUDGE_BIN.trim()) return { command: env.LEDGER_JUDGE_BIN, source: "env LEDGER_JUDGE_BIN" };
  const own = config?.review?.judgeCommand;
  if (typeof own === "string" && own.trim()) return { command: own, source: "review.judgeCommand" };
  const path = audhdProfilePath(env);
  try {
    const cmd = JSON.parse(readFileSync(path, "utf8"))?.enforcement?.judgeCommand;
    if (typeof cmd === "string" && cmd.trim()) return { command: cmd, source: `enforcement.judgeCommand in ${path}` };
  } catch {
    /* absent or unparsable: no fallback */
  }
  return { command: null, source: null };
}

const shellEscape = (text) => "'" + String(text).replace(/'/g, `'\\''`) + "'";

/** The one-word answer among `words` (default yes/no), or null when the last non-empty line starts with none. */
export function parseAnswer(stdout, words = ["yes", "no"]) {
  const last = String(stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) return null;
  const word = /^[\s*_`"'>#-]*([a-z]+)/i.exec(last)?.[1]?.toLowerCase();
  return words.includes(word) ? word : null;
}

/**
 * One uncached judge call whose answer is one of `words` (the report's biting|silent|fine).
 * Returns { answer, error }: answer null with the reason when no judge is configured, it fails,
 * or it says none of the words. Nothing is written: a grade is recomputed each time.
 */
export async function askWord({ config, env = process.env, passage, question, words, timeoutMs = JUDGE_TIMEOUT_MS }) {
  const { command } = judgeCommand(config, env);
  if (!command) return { answer: null, error: "no judge configured" };
  const prompt = `${passage}\n\nQuestion: ${question}\nReply with a single word: ${words.join(", ")}.`;
  const r = await runJudge(command, prompt, timeoutMs, env);
  if (!r.ok) return { answer: null, error: r.error };
  const answer = parseAnswer(r.stdout, words);
  return answer ? { answer, error: null } : { answer: null, error: `unparsed: judge answered none of ${words.join("|")}` };
}

function runJudge(command, prompt, timeoutMs, env) {
  return new Promise((resolve) => {
    const placeholder = command.includes("{prompt}");
    const line = placeholder ? command.split("{prompt}").join(shellEscape(prompt)) : command;
    let child;
    try {
      child = spawn("/bin/sh", ["-c", line], { detached: true, stdio: ["pipe", "pipe", "pipe"], env });
    } catch (err) {
      resolve({ ok: false, error: `judge could not start: ${err.message}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ...result, stderr: stderr.slice(-300) });
    };
    const timer = setTimeout(() => settle({ ok: false, error: `judge timed out after ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < 1_000_000) stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on("error", (err) => settle({ ok: false, error: `judge could not start: ${err.message}` }));
    child.on("close", (code) => settle(code === 0 ? { ok: true, stdout } : { ok: false, error: `judge exited ${code}` }));
    child.stdin.on("error", () => {});
    child.stdin.end(placeholder ? undefined : prompt);
  });
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
export async function ask({ db, dbPath, config, env = process.env, passage, question = JUDGE_QUESTION, timeoutMs = JUDGE_TIMEOUT_MS, now = Date.now() }) {
  try {
    const key = `judge:${createHash("sha256").update(passage + question).digest("hex")}`;
    const hit = cached(db, key);
    if (hit === "yes" || hit === "no") return { verdict: hit, cached: true, error: null };
    const { command } = judgeCommand(config, env);
    if (!command) return { verdict: "unverified", cached: false, error: "no judge configured" };
    const prompt = `${passage}\n\nQuestion: ${question}\nReply with the single word yes or no.`;
    const r = await runJudge(command, prompt, timeoutMs, env);
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
