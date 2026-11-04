// ask.mjs — the judge call: one prompt, one verdict, one bill per unique prompt.
//
// WHY A JUDGE IS MACHINERY
//   Five of the Stop hook's thirteen checks are not decidable by string matching — "is this
//   trailing section a batched dump or a legitimate summary" requires reading for meaning. The
//   governing reframe (2026-09-21): a model-graded check that runs AUTOMATICALLY inside a hook is
//   still machinery. It fires on a deterministic trigger, it returns pass or fail, and every
//   failure mode of the DISPATCH is deterministic: timeout, non-zero exit, unparseable output.
//   The judgment is the model's; the enforcement is this code's.
//
// WHAT IS SHARED AND WHAT IS OURS (since 1.7.0)
//   The command's resolution and the dispatch are plugin-kit's shared judge, vendored byte for
//   byte as ../lib/judge.mjs (the kit's test diffs it): resolveJudgeCommand, dispatch,
//   lastJsonObject, and the `node lib/judge.mjs setup` CLI that writes the shared file. This
//   file keeps what only i-have-audhd knows: the prompt (buildPrompt), the strict verdict shape
//   (asVerdict, parseVerdict), the harness budget, the cache, and the failure line with its
//   `cause=` (classify, modelOf, CAUSES, unavailable).
//
// THE COMMAND (resolveJudge; the kit's order, first found wins)
//   1. enforcement.judgeCommand in the profile, the plugin's own override (config.judgeCommand,
//      already read by lib/config.mjs); null or absent means "no override", not "no judge";
//   2. ${XDG_CONFIG_HOME:-~/.config}/judge/config.json, the shared file every judging plugin
//      reads, written by `node lib/judge.mjs setup`;
//   3. the profile again, as the kit's read-only legacy step (the same file as 1 for this plugin).
//   Nothing anywhere: the judge rules are inactive and the Stop hook logs each fired trigger to
//   skipped.log naming both places. A shared file that exists but is malformed stops the search
//   (the kit never swaps in an older command for a typo): same outcome, and the skipped line
//   says so. The result names its `source` (the profile key or the shared path) and every
//   failure line carries it, so an override silently winning over the shared file is visible.
//   Two forms, as the kit defines them: a literal {prompt} is replaced by the shell-escaped
//   prompt (every occurrence); without one the prompt is piped to stdin. Example:
//   "codex exec --skip-git-repo-check -".
//
//   The judge's environment carries I_HAVE_AUDHD_ENFORCE=off and I_HAVE_AUDHD_INJECT=off, so a
//   judge that is itself a Claude Code or OMP session does not run this plugin's hooks on its
//   own reply, whichever file the command came from. The setup tool's choices also prefix those
//   two switches onto the command; either is enough.
//
// OUTPUT PARSING
//   STDOUT ONLY is captured (the kit's dispatch; judge CLIs print banners on stderr). The LAST
//   JSON object on stdout (the kit's lastJsonObject: string-aware brace matching, a
//   {"type":"result","result":"…"} envelope unwrapped) must be the verdict, strictly
//   {"violation": <boolean>, "reason": <string>}; one more envelope level, any object whose
//   `result` is a string holding the verdict, is unwrapped here. Anything else is a failure.
//
// FAILURE IS OPEN AND LOUD, AND NEVER A PASS
//   Timeout, non-zero exit, a judge that cannot start, or unparseable output each return
//   {unavailable: true, error: …, detail: …, cause: …, source: …} and no verdict at all: no
//   `violation` field, so no caller can read a judge that could not speak as a pass. `error` is
//   one of the kit's ERRORS — timeout, nonzero, unparseable, spawn-failed — and `detail` the
//   kit's reason for it ("exit 127", "no exit within 30000 ms", an errno). Each appends one line
//   to judge-failures.log carrying everything needed to place and replay it:
//
//     rule=<rule> error=<kind> cause=<cause> session=<id> harness=<claude-code|omp>
//     model=<model|unknown> elapsedMs=<n> budgetMs=<n> section=<label@line|whole>
//     cache=<sha256 of the prompt> prompt=<path of the prompt, written on failure>
//     detail="<the kit's detail>" source="<where the command came from>"
//     [stderr="<last STDERR_LOGGED chars>"] [stdout="<last STDOUT_LOGGED chars, bad-json only>"]
//
//   `cause` is one of CAUSES, classified from the error kind and the judge's stderr (classify
//   below): the hook's own deadline is hook-deadline whatever stderr says, because the fact
//   to act on is that the judge was slower than the budget; a judge that exited after
//   aborting its own request is judge-self-abort. The person-facing alert states the cause
//   and its fix (i-have-audhd-stop.mjs, JUDGE UNAVAILABLE). session and section come from the
//   caller (options.meta); model is read off the judge command (modelOf) and is "unknown"
//   when no --model/-m flag or provider/model token is there.
//
// THE TIMEOUT follows the harness tag the stop core already runs under; there is no setting,
//   and the shared file's timeoutMs is not consulted: the hook's own deadline is fixed.
//   Untagged (Claude Code): 30s. I_HAVE_AUDHD_HARNESS=omp (set only by the OMP adapter on the
//   core it spawns): 20s, because OMP abandons a session_stop handler at 30s and the adapter
//   kills the core at 25s (omp/i-have-audhd-omp.ts, TIMEOUT); a 20s judge leaves the core
//   room to log the failure and emit its deterministic findings first. options.timeoutMs
//   overrides both, for tests.
//
// CLEANUP is the kit's: the judge's /bin/sh leads a fresh process group; when the dispatch
//   settles, one negative-pid SIGKILL reaps whatever of that group is still alive and the pipes
//   are released, so a descendant that left the group cannot hold this process open either.
//
// THE CACHE
//   sha256(promptText) → cache/<hash>.json, written only on a SUCCESSFUL verdict — a timeout
//   is never cached, because the judge might come back. Same prompt, same verdict, one judge
//   bill. The key is the whole prompt (rule, question, message): since 1.1.0 the question
//   varies per call (conclusion-first and bad-news-first append the unit's opening window and,
//   for a labeled section, a framing sentence), and an unlabeled message can equal one
//   section's text, so rule + contextText no longer determines what the judge sees. Cache
//   files keyed the old way simply stop matching: one re-bill per message, no migration.
//   On a FAILURE the prompt itself is written next to where the verdict would go,
//   cache/<hash>.prompt.txt, so the failure line's cache key is a replayable prompt:
//   `<judge command> < cache/<hash>.prompt.txt`. The cache is capped (lib/judge-cache.mjs): at
//   most 2,000 files, none older than 7 days, whichever bites first; about one write in 50 runs
//   the cap here (options.capCheck forces or skips it, for tests), and the plugin's prune verb
//   runs it every time. A verdict older than 7 days is for a prompt long out of context.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256hex, appendLog, stateDir } from "../lib/state.mjs";
import { CAP_EVERY, capCache } from "../lib/judge-cache.mjs";
import { dispatch, lastJsonObject, legacyProfilePath, readSharedConfig, resolveJudgeCommand } from "../lib/judge.mjs";

export const DEFAULT_TIMEOUT_MS = 30_000; // hooks/hooks.json's Stop timeout sits 5 s above this (pinned in the stop hook's tests)
const OMP_TIMEOUT_MS = 20_000; // see the header's THE TIMEOUT

// Read at call time: the tag is the core's process env, set by the OMP adapter on its child.
const harnessOf = (env) => (env.I_HAVE_AUDHD_HARNESS === "omp" ? "omp" : "claude-code");
const harnessTimeoutMs = (env) => (harnessOf(env) === "omp" ? OMP_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

// The places the command is looked for, for a skipped.log line or a notice: the profile key,
// the shared file, and the shared file's parse problem when it has one (`<path>: <error>`).
export function judgeSources(env = process.env) {
  const { path, malformed } = readSharedConfig({ env });
  return { profile: legacyProfilePath({ env }), shared: path, malformed };
}

// The judge for this plugin, { command, timeoutMs, source }, or null when none is configured
// (header, THE COMMAND). `config` is lib/config.mjs's enforcement object; options.timeoutMs
// overrides the harness budget, options.env is the process env (tests).
export function resolveJudge(config, { env = process.env, timeoutMs } = {}) {
  const command = config && typeof config.judgeCommand === "string" ? config.judgeCommand : null;
  return resolveJudgeCommand({
    pluginKey: {
      command,
      timeoutMs: Math.max(1, Number(timeoutMs) || harnessTimeoutMs(env)),
      source: `enforcement.judgeCommand in ${legacyProfilePath({ env })}`,
    },
    env,
  });
}

function buildPrompt(rule, question, contextText) {
  return [
    "You are judging one message against one communication rule. Reply with ONE JSON object and nothing else, exactly this shape:",
    '{"violation": true, "reason": "one short sentence"}',
    "",
    `Rule: ${rule}`,
    `Question: ${question}`,
    "",
    "Message under judgment, verbatim, between the markers:",
    "<<<MSG",
    contextText,
    "MSG",
  ].join("\n");
}

function asVerdict(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (typeof obj.violation !== "boolean") return null;
  if (typeof obj.reason !== "string") return null;
  return { violation: obj.violation, reason: obj.reason };
}

// The verdict in the kit's parsed object: the object itself, or the last JSON object inside its
// `result` string (an envelope the kit did not unwrap, one without type "result"). null otherwise.
function verdictOf(obj) {
  const direct = asVerdict(obj);
  if (direct) return direct;
  if (obj && typeof obj === "object" && typeof obj.result === "string") return verdictOf(lastJsonObject(obj.result));
  return null;
}

// The verdict on a judge's stdout: the LAST JSON object there, which must be verdict-shaped
// (header, OUTPUT PARSING). null when none qualifies.
export function parseVerdict(stdout) {
  return verdictOf(lastJsonObject(stdout));
}

// How much of the judge's stderr reaches judge-failures.log (the tail, where the reason is),
// and how much of a bad-json judge's stdout (the tail: a half-printed verdict or an error page's
// last words).
const STDERR_LOGGED = 300;
const STDOUT_LOGGED = 300;

// Every cause a failure line can carry, and the fix the person-facing alert states for each.
export const CAUSES = ["credential-revoked", "no-credential", "rate-limited", "judge-self-abort", "hook-deadline", "bad-json", "other"];

// The cause of a failed dispatch, from its error kind (the kit's ERRORS) and the judge's stderr.
// Order matters: the hook's own deadline is hook-deadline whatever stderr says (the judge was
// slower than the budget), unparseable stdout is bad-json, then the stderr patterns, then other.
// `quota` counts only as a word of the error sentence, never as a path segment or file name
// (`/tmp/quota/config.json`); an abort only in the client's own "Request was aborted" shape,
// never a bare "aborted" ("parse aborted at byte 3").
export function classify(error, stderr) {
  if (error === "timeout") return "hook-deadline";
  if (error === "unparseable") return "bad-json";
  const s = String(stderr ?? "");
  if (/\b401\b|revoked|invalid[_ ]?(?:api[_ ]?key|token)|token (?:is |has )?(?:expired|invalid)|authentication_error|unauthori[sz]ed/i.test(s)) return "credential-revoked";
  if (/no credential|not logged in|login required|not authenticated|no api key|missing (?:api )?key|\bgh auth login\b|\bcodex login\b|\bclaude login\b|please (?:log in|login|run .*login)/i.test(s)) return "no-credential";
  if (/\b429\b|rate.?limit|too many requests|overloaded|(?<![/\\.])\b(?:insufficient_)?quota\b(?![/\\.]\w)|\b529\b/i.test(s)) return "rate-limited";
  if (/request was aborted|AbortError|ECONNRESET|socket hang up/i.test(s)) return "judge-self-abort";
  return "other";
}

// The model named in a judge command: `--model x`, `--model=x`, `-m x`, or a trailing
// provider/model token (`… model-judge.ts anthropic/claude-haiku-5-5`); "unknown" otherwise.
export function modelOf(command) {
  const c = String(command ?? "");
  const flag = /(?:^|\s)(?:--model|-m)(?:=|\s+)([^\s'"]+)/.exec(c);
  if (flag) return flag[1];
  const slash = [...c.matchAll(/(?:^|\s)([a-z0-9-]+\/[a-z0-9][a-z0-9.-]*)(?=\s|$)/gi)].map((m) => m[1]).filter((t) => !t.startsWith("/") && !/\.(mjs|ts|js|sh)$/.test(t) && !t.includes("//"));
  return slash.length ? slash[slash.length - 1] : "unknown";
}

const oneLineTail = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(-n);

// The judge-failures.log line, and the result every failure returns: no verdict. `ctx` is
// { session, harness, model, elapsedMs, budgetMs, section, cacheKey, promptPath, detail,
// source }; `run` the kit's dispatch result (stderr, stdout).
function unavailable(log, rule, error, run, ctx) {
  const cause = classify(error, run.stderr);
  const stderrTail = oneLineTail(run.stderr, STDERR_LOGGED);
  const stdoutTail = cause === "bad-json" ? oneLineTail(run.stdout, STDOUT_LOGGED) : "";
  log(
    "judge-failures.log",
    `rule=${rule} error=${error} cause=${cause} session=${ctx.session} harness=${ctx.harness} model=${ctx.model} ` +
      `elapsedMs=${ctx.elapsedMs} budgetMs=${ctx.budgetMs} section=${ctx.section} cache=${ctx.cacheKey} prompt=${ctx.promptPath} ` +
      `detail=${JSON.stringify(ctx.detail)} source=${JSON.stringify(ctx.source)}` +
      (stderrTail ? ` stderr=${JSON.stringify(stderrTail)}` : "") +
      (stdoutTail ? ` stdout=${JSON.stringify(stdoutTail)}` : ""),
  );
  return {
    unavailable: true,
    error,
    detail: ctx.detail,
    cause,
    model: ctx.model,
    budgetMs: ctx.budgetMs,
    source: ctx.source,
    ...(stderrTail ? { stderr: stderrTail } : {}),
    ...(stdoutTail ? { stdout: stdoutTail } : {}),
  };
}

// askJudge(rule, question, contextText, config, options?)
//   config: lib/config.mjs's enforcement object (judgeCommand is the override; resolveJudge).
//   options: { timeoutMs, stateDir, env } — for tests; production takes the harness timeout,
//   the shared state dir and process.env. { meta: { session, section } } — who is asking, for
//   the failure line: the Stop hook passes its session id and the judged section
//   ("<label>@<line>", or "whole" for an unsectioned message).
//   Never throws.
export async function askJudge(rule, question, contextText, config, options = {}) {
  const dir = options.stateDir ?? null;
  const log = (file, text) => appendLog(file, text, dir ?? undefined);
  const env = options.env ?? process.env;
  const judge = resolveJudge(config, { env, timeoutMs: options.timeoutMs });
  if (!judge) return { unavailable: true, error: "no-judge-command" };
  const { command, timeoutMs, source } = judge;

  const promptText = buildPrompt(rule, question, contextText);

  // Cache lookup — same prompt, same verdict, no second bill.
  const key = sha256hex(promptText);
  const cacheDir = dir ? join(dir, "cache") : join(stateDir(), "cache");
  const cachePath = join(cacheDir, `${key}.json`);
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    const v = asVerdict(cached);
    if (v) return { ...v, cached: true };
  } catch {
    /* cache miss */
  }

  const started = Date.now();
  const run = await dispatch(promptText, {
    command,
    timeoutMs,
    env: { ...env, I_HAVE_AUDHD_ENFORCE: "off", I_HAVE_AUDHD_INJECT: "off" },
  });
  const verdict = run.ok ? verdictOf(lastJsonObject(run.stdout)) : null;

  if (!verdict) {
    // The replayable prompt, next to where the verdict would have gone.
    const promptPath = join(cacheDir, `${key}.prompt.txt`);
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(promptPath, promptText);
      maybeCap(cacheDir, options);
    } catch {
      /* the line still names the path; a state dir that cannot be written is logged by the caller's other writes */
    }
    const meta = options.meta ?? {};
    const error = run.ok ? "unparseable" : run.error;
    const detail = run.ok ? 'exit 0 but no {"violation", "reason"} object last on stdout' : run.detail;
    return unavailable(log, rule, error, run, {
      session: meta.session ?? "no-session",
      harness: harnessOf(env),
      model: modelOf(command),
      elapsedMs: Date.now() - started,
      budgetMs: timeoutMs,
      section: meta.section ?? "whole",
      cacheKey: key,
      promptPath,
      detail,
      source,
    });
  }

  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(verdict));
    maybeCap(cacheDir, options);
  } catch (err) {
    log("judge-failures.log", `rule=${rule} error=cache-write-failed (${err.message})`);
  }
  return { ...verdict, cached: false };
}

/** One write in CAP_EVERY trims the cache; `options.capCheck` true runs it now, false never. */
function maybeCap(cacheDir, options) {
  const check = options.capCheck ?? Math.random() < 1 / CAP_EVERY;
  if (check) capCache(cacheDir);
}
