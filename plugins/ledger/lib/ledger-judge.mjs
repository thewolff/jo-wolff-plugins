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
// The timeout is the shared file's `timeoutMs` when it is longer than JUDGE_TIMEOUT_MS, else
// JUDGE_TIMEOUT_MS: ledger's diff judge never runs shorter than 60 s (0.3.7), because `judge
// setup` writes 30 s by default and a judge cut off early fails open as `unverified`.
// A command that prints a `claude -p --output-format json` envelope ({"type":"result",
// "result":"…"}) is read through it: the answer is taken from `result`.
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
import { dispatch, parseAnswer, readSharedConfig, resolveJudgeCommand, topLevelJsonSpans } from "./judge.mjs";
import { nowIso } from "./time.mjs";

export const JUDGE_QUESTION = "Does this change resolve the finding? Answer yes or no.";
/** The question when the pattern-check receipt changed since the finding was raised (0.4.10). */
export const RECEIPT_CHANGED_QUESTION =
  "Does this change resolve the finding? A finding that holds the code to a requirement the receipt edit removed or changed no longer applies and counts as resolved; judge against the current receipt text. Answer yes or no.";
export const RECEIPT_DIFF_CAP_BYTES = 4 * 1024;
export const RECEIPT_CURRENT_CAP_BYTES = 6 * 1024;
export const QUOTE_CAP_BYTES = 200;
export const QUOTES_SHOWN = 5;
export const JUDGE_TIMEOUT_MS = 60_000;
export const PASSAGE_CAP_BYTES = 16 * 1024;
export const JUDGE_ENV_VAR = "LEDGER_JUDGE_BIN";

/** The pluginKey lib/judge.mjs resolves with: ledger's env override and `review.judgeCommand`. */
function pluginKey(config) {
  return { envVar: JUDGE_ENV_VAR, command: config?.review?.judgeCommand ?? null, source: "review.judgeCommand" };
}

/**
 * { command, timeoutMs, source } for the judge, or all three null when none is configured.
 * timeoutMs is the shared file's `timeoutMs` floored at JUDGE_TIMEOUT_MS. `malformed` is
 * `<path>: <error>` when no command was found and the shared file exists but cannot be used,
 * else null.
 */
export function judgeCommand(config, env = process.env) {
  const found = resolveJudgeCommand({ pluginKey: pluginKey(config), env });
  if (found) return { ...found, timeoutMs: Math.max(found.timeoutMs, JUDGE_TIMEOUT_MS), malformed: null };
  return { command: null, timeoutMs: null, source: null, malformed: readSharedConfig({ env }).malformed };
}

/** `stdout`, or the `result` string of a `{"type":"result","result":"…"}` envelope when that is its last top-level JSON object. */
function unwrapEnvelope(stdout) {
  const last = topLevelJsonSpans(stdout).at(-1);
  if (!last) return stdout;
  try {
    const envelope = JSON.parse(last);
    return envelope?.type === "result" && typeof envelope.result === "string" ? envelope.result : stdout;
  } catch {
    return stdout;
  }
}

/** One judge run: { ok: true, stdout } or { ok: false, error, stderr } with ledger's wording of the failure. */
async function runOnce(command, prompt, timeoutMs, env, run = dispatch) {
  const r = await run(prompt, { command, timeoutMs, env });
  if (r.ok) return { ok: true, stdout: unwrapEnvelope(r.stdout), stderr: r.stderr.slice(-300) };
  const error =
    r.error === "nonzero" ? `judge exited ${r.code}` : r.error === "timeout" ? `judge timed out after ${Math.round(timeoutMs / 1000)}s` : `judge could not start: ${r.detail}`;
  return { ok: false, error, stderr: r.stderr.slice(-300) };
}

/**
 * One uncached judge call whose answer is one of `words` (the report's biting|silent|fine).
 * Returns { answer, error }: answer null with the reason when no judge is configured, it fails,
 * or it says none of the words. Nothing is written: a grade is recomputed each time.
 * `run` stands in for lib/judge.mjs dispatch (tests).
 */
export async function askWord({ config, env = process.env, passage, question, words, timeoutMs, run = dispatch }) {
  const judge = judgeCommand(config, env);
  if (!judge.command) return { answer: null, error: judge.malformed ? `no judge configured (malformed ${judge.malformed})` : "no judge configured" };
  const prompt = `${passage}\n\nQuestion: ${question}\nReply with a single word: ${words.join(", ")}.`;
  const r = await runOnce(judge.command, prompt, timeoutMs ?? judge.timeoutMs, env, run);
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

const bytes = (s) => Buffer.byteLength(s);
/** The first `n` bytes of `s`, never splitting a character. */
const clip = (s, n) => Buffer.from(s).subarray(0, Math.max(0, n)).toString("utf8").replace(/\uFFFD+$/, "");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A regex matching any of `words` as a whole word, or null when there are none. */
export function focusPattern(words) {
  const w = [...new Set((words ?? []).filter(Boolean))];
  return w.length ? new RegExp(`(?<![\\w$])(?:${w.map(escapeRe).join("|")})(?![\\w$])`) : null;
}

const UNIT_CAP_BYTES = 4 * 1024;
const FINDING_CAP_BYTES = 2 * 1024;
const MARKER_RESERVE_BYTES = 512;
const REGION_LINE_BYTES = 240;
const EXCERPT_CONTEXT_LINES = 12;

/**
 * A unit longer than UNIT_CAP_BYTES that mentions `focus` becomes the lines around each mention
 * (the first line kept as its heading), so a cut keeps what the finding is about instead of the
 * unit's first bytes. Lines for which `pinned(line)` is true are always kept (a cited region's
 * cited lines). Returns `text` unchanged otherwise.
 */
function excerpt(text, focus, pinned = null) {
  if (!focus || bytes(text) <= UNIT_CAP_BYTES || !focus.test(text)) return text;
  const lines = text.split("\n");
  const keep = new Set([0]);
  lines.forEach((l, i) => {
    if (pinned?.(l)) keep.add(i);
    if (focus.test(l)) for (let k = Math.max(0, i - EXCERPT_CONTEXT_LINES); k <= Math.min(lines.length - 1, i + EXCERPT_CONTEXT_LINES); k++) keep.add(k);
  });
  const out = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > prev + 1) out.push(`\u2026 (${i - prev - 1} lines not shown)`);
    out.push(lines[i]);
    prev = i;
  }
  if (prev < lines.length - 1) out.push(`\u2026 (${lines.length - 1 - prev} lines not shown)`);
  return out.join("\n");
}

/**
 * A unified diff split into units, each { head, text }: a hunk, whose `head` is its file's header
 * lines (shown once before that file's first shown hunk), or a file entry with no hunk at all (a
 * mode change, a rename, a binary file), whose header lines are its `text`.
 */
function hunks(diff) {
  const out = [];
  let head = "";
  let fileHunks = 0;
  let cur = null;
  const endFile = () => {
    if (cur) out.push(cur);
    else if (head && !fileHunks) out.push({ head: "", text: head });
    cur = null;
    head = "";
    fileHunks = 0;
  };
  for (const line of String(diff).split("\n")) {
    if (line.startsWith("diff --git ")) {
      endFile();
      head = line;
    } else if (line.startsWith("@@")) {
      if (cur) out.push(cur);
      cur = { head, text: line };
      fileHunks++;
    } else if (cur) cur.text += `\n${line}`;
    else head += head ? `\n${line}` : line;
  }
  endFile();
  return out.map((h) => ({ ...h, text: h.text.replace(/\n$/, "") })).filter((h) => h.text);
}

/** The first and last parts of `s` within `n` bytes, the middle replaced by a line saying how much is not shown. */
function clipBothEnds(s, n) {
  if (bytes(s) <= n) return s;
  const gap = (k) => `\n… (${k} bytes not shown) …\n`;
  const room = n - bytes(gap(bytes(s)));
  if (room <= 0) return clip(s, n);
  const headBytes = Math.ceil(room / 2);
  const tail = Buffer.from(s).subarray(bytes(s) - (room - headBytes)).toString("utf8").replace(/^\uFFFD+/, "");
  const front = clip(s, headBytes);
  return front + gap(bytes(s) - bytes(front) - bytes(tail)) + tail;
}

/** The quotations in `text`: spans in “…”, "…" or ‘…’ of at least 8 characters, in order. */
export function quotations(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/\u201c([^\u201d\n]{8,}?)\u201d|"([^"\n]{8,}?)"|\u2018([^\u2019\n]{8,}?)\u2019/g)) out.push((m[1] ?? m[2] ?? m[3]).trim());
  return [...new Set(out)].filter((q) => q.length >= 8);
}

/**
 * The units of the receipt-change section, each already within its cap and marked `exact` so the
 * allocator never excerpts it: the receipt diff (RECEIPT_DIFF_CAP_BYTES), or a line saying the
 * earlier text is not on record; one evidence line per quotation of the finding found on a removed
 * line (the quotation only, QUOTE_CAP_BYTES each, QUOTES_SHOWN at most); the current receipt
 * (RECEIPT_CURRENT_CAP_BYTES). `change` is { diff: string|null, old?: string|null, oldUnreadable?: boolean, quotes: string[], current: string|null };
 * with no diff but `old`, the earlier text is shown whole (within the diff's cap) instead.
 */
export function receiptChangeUnits(change) {
  const units = [
    {
      exact: true,
      rank: 0,
      text: change.diff
        ? `Receipt diff, from the text when the finding was raised to the current text:\n${clipBothEnds(String(change.diff), RECEIPT_DIFF_CAP_BYTES)}`
        : change.old != null
          ? `The receipt diff could not be built; the receipt's text when the finding was raised:\n${clipBothEnds(String(change.old), RECEIPT_DIFF_CAP_BYTES)}`
          : change.oldUnreadable
            ? "The receipt's text when the finding was raised could not be read from the ledger database; only the current text is shown."
            : "The receipt's text when the finding was raised is not on record; only the current text is shown.",
    },
  ];
  const quotes = change.quotes ?? [];
  if (quotes.length) {
    const lines = quotes.slice(0, QUOTES_SHOWN).map((q) => `The finding quotes \u201c${bytes(q) > QUOTE_CAP_BYTES ? `${clip(q, QUOTE_CAP_BYTES)}\u2026` : q}\u201d, which is on a line the receipt edit removed or replaced.`);
    if (quotes.length > QUOTES_SHOWN) lines.push(`(${quotes.length - QUOTES_SHOWN} more quotations not shown)`);
    units.push({ exact: true, rank: 0, text: lines.join("\n") });
  }
  units.push({ exact: true, rank: 0, text: `Current receipt:\n${change.current ? clipBothEnds(String(change.current), RECEIPT_CURRENT_CAP_BYTES) : "(none: the repository has no pattern-check receipt now)"}` });
  return units;
}

/**
 * The passage for one finding, in priority order: its text; `absent`, evidence that identifiers
 * it names no longer occur at HEAD ([{ name, files, since }] or names); `current`, the files it names as they are at HEAD
 * ([{ path, from, to, text, rank, core? }] regions, { path, missing: true } or { path, unreadable: true }); the diff of the
 * files it names (`diff`); `tests`, test files changed in the window that refer to it
 * ([{ path, diff }]); the pattern-check receipt (`receipt`, for a finding about it); and the other
 * changed files (`others`, [{ path, diff }]). `nothingChanged` says no file changed at all since
 * it was raised.
 * `receiptChange` ({ diff, quotes, current }, 0.4.10) is set when the pattern-check receipt changed
 * since the finding was raised: its section (receiptChangeUnits) comes right after the finding,
 * and the `receipt` section is then left out.
 *
 * Under PASSAGE_CAP_BYTES it is the plain concatenation, nothing excerpted. Over it, each section
 * is filled in that order with whole units (regions, hunks, file entries), chosen by rank (a
 * region's own `rank`, else 0 for a unit mentioning a `focus` word and 1 for the rest) and shown
 * in their original order; no room is reserved for later sections. A unit over UNIT_CAP_BYTES that
 * mentions a `focus` word is shown as the lines around those mentions; every rank-0 unit is placed
 * first as its bare cited lines, then all are expanded to their `core` lines, then whole, where room remains,
 * before any lower-ranked unit, so cited lines are the last evidence removed; when none of a section's units fits, its
 * top-ranked unit is shown with its middle cut, at most UNIT_CAP_BYTES. HEAD region lines longer
 * than REGION_LINE_BYTES are clipped, also only when over the cap. Whenever anything was
 * left out or excerpted, the passage ends with a marker naming how many bytes each section left
 * out and the sha256 of the whole uncut input, so the judge knows the evidence is partial and two
 * inputs that differ anywhere are cached apart.
 */
export function passageFor(findingText, diff, { current = [], tests = [], absent = [], focus = [], receipt = null, receiptChange = null, others = [], nothingChanged = false } = {}) {
  const re = focusPattern(focus);
  const ranked = (text) => (re && re.test(text) ? 0 : 1);
  const change = nothingChanged
    ? receiptChange
      ? "(no code changes since the finding was raised; the receipt changed, see above)"
      : "(no changes since the finding was raised)"
    : String(diff ?? "") || "(no change to the files the finding names)";
  const changeUnits = nothingChanged || !String(diff ?? "") ? [{ head: "", text: change, rank: 0 }] : hunks(change).map((h) => ({ ...h, rank: ranked(h.text) }));
  const fileUnits = (list) => list.flatMap((o) => hunks(o.diff || "(no textual change)").map((h) => ({ head: `File: ${o.path}${h.head ? `\n${h.head}` : ""}`, text: h.text, rank: ranked(h.text) })));
  const sections = [
    { name: "finding", header: "Finding:\n", units: [{ text: String(findingText ?? ""), rank: 0 }], cap: FINDING_CAP_BYTES },
    receiptChange && { name: "receipt change", header: "\n\nThe pattern-check receipt changed since the finding was raised. The current receipt below is authoritative: a requirement the edit removed or changed no longer holds.\n", units: receiptChangeUnits(receiptChange) },
    absent.length && {
      name: "absent",
      header: "\n\nEvidence from the tree:\n",
      units: absent.map((a) => ({ text: typeof a === "string" ? `\`${a}\` named in the finding no longer occurs anywhere at HEAD` : `\`${a.name}\` named in the finding no longer occurs anywhere at HEAD (was in ${a.files.join(", ")} at ${a.since})`, rank: 0 })),
    },
    current.length && {
      name: "files at HEAD",
      header: "\n\nThe files the finding names, as they are at HEAD (around the cited lines, the identifiers it names, and the lines changed since):\n",
      units: current.map((c) =>
        c.missing
          ? { text: `File: ${c.path}: not present at HEAD`, rank: 0 }
          : c.unreadable
            ? { text: `File: ${c.path}: present at HEAD, but its contents could not be retrieved`, rank: 0 }
            : {
                clipLines: true,
                pinned: c.core ? [c.core.from, c.core.to] : null,
                text: `File: ${c.path} (lines ${c.from}-${c.to} at HEAD)\n${c.text}`,
                rank: c.rank ?? 1,
                fallbacks: [c.core, c.core?.bare].filter(Boolean).map((r) => ({ clipLines: true, text: `File: ${c.path} (lines ${r.from}-${r.to} at HEAD)\n${r.text}`, rank: c.rank ?? 1 })),
              },
      ),
    },
    { name: "named diff", header: "\n\nChange (unified diff):\n", units: changeUnits },
    tests.length && { name: "tests", header: "\n\nTest files changed since the finding was raised that refer to it (unified diff):\n", units: fileUnits(tests) },
    receipt && !receiptChange && { name: "receipt", header: "\n\nPattern-check receipt (current text):\n", units: [{ text: String(receipt), rank: 0 }] },
    others.length && { name: "other files", header: "\n\nOther files changed since the finding was raised (unified diff):\n", units: fileUnits(others) },
  ].filter(Boolean);
  for (const s of sections) s.units.forEach((u, i) => (u.order = i));
  const render = (s, chosen) => {
    let text = "";
    let shownHead = null;
    for (const u of [...chosen].sort((a, b) => a.order - b.order)) {
      const head = u.head && u.head !== shownHead ? `${u.head}\n` : "";
      if (u.head) shownHead = u.head;
      text += (text ? "\n" : "") + head + u.text;
    }
    return s.header + text;
  };
  const whole = sections.map((s) => render(s, s.units)).join("");
  const size = bytes(whole);
  if (size <= PASSAGE_CAP_BYTES) return whole;

  // Only once over the cap: HEAD region lines are clipped, and the bytes they lose count as cut.
  const shorten = (u) => {
    if (u.exact) return u.text;
    const pin = u.pinned && ((l) => {
      const m = /^\s*(\d+)\| /.exec(l);
      return Boolean(m) && Number(m[1]) >= u.pinned[0] && Number(m[1]) <= u.pinned[1];
    });
    const t = excerpt(u.text, re, pin);
    return u.clipLines ? t.split("\n").map((l) => (bytes(l) > REGION_LINE_BYTES ? `${clip(l, REGION_LINE_BYTES)}…` : l)).join("\n") : t;
  };
  let room = PASSAGE_CAP_BYTES - MARKER_RESERVE_BYTES;
  const left = [];
  let out = "";
  for (const s of sections) {
    const full = bytes(render(s, s.units));
    const budget = Math.min(room, s.cap ?? Infinity);
    if (bytes(s.header) >= budget) {
      left.push(`${s.name} ${full} bytes`);
      continue;
    }
    const byRank = [...s.units].sort((a, b) => a.rank - b.rank || a.order - b.order);
    const chosen = [];
    const fits = (list) => bytes(render(s, list)) <= budget;
    // Largest first: the unit whole, then its core, then its bare cited lines.
    const formsOf = (u) => [{ ...u, text: shorten(u) }, ...(u.fallbacks ?? []).map((f) => ({ ...f, text: shorten(f), order: u.order }))];
    // Every rank-0 unit is placed first in its smallest form (a cited region's bare cited lines; a
    // unit with no fallback, whole), so one region's core cannot take the room a later region's
    // cited lines need; then all are grown to cores, then whole, and only then lower ranks admitted.
    const forms = new Map(byRank.map((u) => [u, formsOf(u)]));
    const held = new Map();
    for (const u of byRank) {
      if (u.rank !== 0) continue;
      const fit = forms.get(u).at(-1);
      if (fits([...chosen, fit])) {
        held.set(u, fit);
        chosen.push(fit);
      }
    }
    for (const level of [1, 0]) {
      for (const [u, h] of held) {
        const f = forms.get(u)[Math.min(level, forms.get(u).length - 1)];
        if (f === h || bytes(f.text) <= bytes(h.text)) continue;
        const i = chosen.indexOf(h);
        if (fits([...chosen.slice(0, i), f, ...chosen.slice(i + 1)])) {
          chosen[i] = f;
          held.set(u, f);
        }
      }
    }
    for (const u of byRank) {
      if (held.has(u)) continue;
      const fit = forms.get(u).find((f) => fits([...chosen, f]));
      if (fit) chosen.push(fit);
    }
    let text = render(s, chosen);
    if (!chosen.length) {
      // At most one unit's worth, so one oversized unit cannot take the room later sections need.
      const top = byRank[0];
      const limit = Math.min(budget, bytes(s.header) + UNIT_CAP_BYTES) - bytes(render(s, [{ ...top, text: "" }]));
      // A unit whose heading alone does not fit is left out rather than overrunning the cap.
      text = limit > 0 ? render(s, [{ ...top, text: clipBothEnds(shorten(top), limit) }]) : "";
    }
    out += text;
    room -= bytes(text);
    if (bytes(text) !== full) left.push(`${s.name} ${Math.max(0, full - bytes(text))} bytes`);
  }
  const digest = createHash("sha256").update(whole).digest("hex");
  const marker = (l) => `\n[cut: the passage was ${size} bytes, over the ${PASSAGE_CAP_BYTES}-byte limit; left out: ${l.join(", ") || "nothing whole"}; sha256 of the whole: ${digest}]`;
  if (bytes(out) + bytes(marker(left)) > PASSAGE_CAP_BYTES) {
    const short = [...left.slice(0, 3), ...(left.length > 3 ? [`${left.length - 3} more sections`] : [])];
    return clip(out, PASSAGE_CAP_BYTES - bytes(marker(short))) + marker(short);
  }
  return `${out}\n[cut: the passage was ${size} bytes, over the ${PASSAGE_CAP_BYTES}-byte limit; left out: ${left.join(", ") || "nothing whole"}; sha256 of the whole: ${digest}]`;
}

/**
 * Ask the judge about one passage. Never throws. `run` stands in for lib/judge.mjs dispatch (tests).
 * @returns {Promise<{ verdict: "yes"|"no"|"unverified", cached: boolean, error: string|null }>}
 */
export async function ask({ db, dbPath, config, env = process.env, passage, question = JUDGE_QUESTION, timeoutMs, now = Date.now(), run = dispatch }) {
  try {
    const key = `judge:${createHash("sha256").update(passage + question).digest("hex")}`;
    const hit = cached(db, key);
    if (hit === "yes" || hit === "no") return { verdict: hit, cached: true, error: null };
    const judge = judgeCommand(config, env);
    if (!judge.command) return { verdict: "unverified", cached: false, error: judge.malformed ? `no judge configured (malformed ${judge.malformed})` : "no judge configured" };
    const prompt = `${passage}\n\nQuestion: ${question}\nReply with the single word yes or no.`;
    const r = await runOnce(judge.command, prompt, timeoutMs ?? judge.timeoutMs, env, run);
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
