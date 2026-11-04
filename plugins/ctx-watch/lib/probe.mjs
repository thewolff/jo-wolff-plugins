// lib/probe.mjs — one look at the ctx daemon, and the one repair ctx documents.
//
// probe({ run, env, now, ctx }) spawns `ctx daemon status --format json` with CI removed from the
// environment (OMP puts CI=true in agent shells, and ctx then refuses to start a daemon) under a
// 10 s bound, and judges the JSON, never the exit code: `ctx daemon status` exits 0 while the
// daemon is dead. Failing, each with its own reason naming the field:
//
//   ctx cannot run (not on PATH, timed out, no output)   "ctx could not run: …"
//   the output is not JSON                               "`ctx daemon status` printed no JSON …"
//   .daemon.running !== true or .daemon.status !== "running"
//                                                        "the ctx daemon is not running (…)"
//   .daemon.supervisor.status !== "installed"            "the ctx supervisor is not installed (…)"
//   .daemon.jobs.core_refresh.last_run_at_ms missing, not a whole number of epoch ms in range,
//   or more than 5 min ahead of this clock                "… has no / invalid … / core_refresh in the future …"
//   .daemon.jobs.core_refresh.last_run_at_ms > 2 h old   "core_refresh last ran … ago (…)"
//
// `ctx` is the executable: the bare name by default (PATH lookup), or the absolute path the
// launchd timer was installed with (`--ctx`), so a PATH edited after install cannot change which
// program the timer runs.
//
// The spawn's bound is hard: spawnSync's timeout with SIGKILL (a ctx that ignores SIGTERM, the
// default kill signal, would otherwise hold the tick for ever), the child in its own process
// group (`detached`), and the group killed after a timeout so nothing the child started outlives
// the bound. runCtx never throws and never hangs past `timeoutMs` plus the kernel's kill latency.
//
// heal({ run, env, exists }) runs `ctx index mode auto`, the command ctx's storage doc gives for
// repairing supervision ("when auto is not overridden, ctx installs or repairs supervision and
// starts the persistent background daemon"). It is the only ctx command this plugin runs that
// changes anything, so it runs only when ctx already reports indexing mode `auto` and the
// config file ctx names exists: ctx-watch never sets up an installation and never flips a
// deliberate `manual` to `auto`. A non-CI `ctx daemon status` does NOT restart a dead daemon
// (tried on a throwaway data root, 2026-11-04: three calls, still `stale_lock`); `ctx index mode
// auto` did, in 0.4 s.
//
// check({ run, env, now, exists, deadlineMs }) is probe, then heal on a failing probe, then probe
// again; the result carries both probes and what the heal did. With `deadlineMs` the four spawns
// (status, mode, mode auto, status) share one clock: each gets the smaller of `timeoutMs` and
// what is left, a step with nothing left is skipped, and a failing result past the deadline says
// `check timed out after <deadlineMs> ms (<what the last step said>)`. Without it each spawn gets
// `timeoutMs` on its own (the CLI, where nothing waits on the answer).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export const PROBE_TIMEOUT_MS = 10_000;
export const STALE_MS = 2 * 60 * 60 * 1000;
/** How far ahead of this clock a core_refresh stamp may sit before it is "in the future". */
export const SKEW_MS = 5 * 60 * 1000;
/** JavaScript's last representable Date, in ms: the upper bound of a plausible stamp. */
const MAX_DATE_MS = 8.64e15;
export const CTX = "ctx";
export const STATUS_ARGV = Object.freeze([CTX, "daemon", "status", "--format", "json"]);
export const MODE_ARGV = Object.freeze([CTX, "index", "mode", "--format", "json"]);
export const HEAL_ARGV = Object.freeze([CTX, "index", "mode", "auto", "--format", "json"]);
/** The one command a person runs for every failing probe (the heal, by hand, outside CI). */
export const FIX = "ctx index mode auto";
export const FIX_MISSING = "ctx docs show getting-started";

/** `env` without CI: what every ctx spawn gets. */
export function ctxEnv(env = process.env) {
  const { CI: _ci, ...rest } = env;
  return rest;
}

/** `argv` with its executable replaced by `ctx` (the bare name or an absolute path). */
const withCtx = (argv, ctx) => [ctx, ...argv.slice(1)];

/**
 * Run `argv` with `env` under `timeoutMs`. Never throws. `{ code, stdout, stderr, error }`:
 * `error` is set when the program could not start, timed out, or was killed. A timed-out child
 * gets SIGKILL, and so does everything left in its process group.
 */
export function runCtx(argv, env, timeoutMs = PROBE_TIMEOUT_MS) {
  const r = spawnSync(argv[0], argv.slice(1), { env, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let error;
  if (r.error?.code === "ENOENT") error = isAbsolute(argv[0]) ? `${argv[0]} does not exist (pinned at install; run install again)` : `${argv[0]} is not on PATH`;
  else if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL") {
    error = `${argv.join(" ")} did not answer in ${timeoutMs / 1000} s`;
    if (r.pid) {
      try {
        process.kill(-r.pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
    }
  } else if (r.error) error = r.error.message;
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error };
}

const field = (o, k) => (o && typeof o === "object" && !Array.isArray(o) ? o[k] : undefined);
/** Whole epoch milliseconds a Date can hold. */
export const validMs = (ms) => Number.isInteger(ms) && ms >= 0 && ms <= MAX_DATE_MS;
const iso = (ms) => new Date(ms).toISOString();

/** "3m", "2h 5m", "41s". */
export function age(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Parse a run's stdout as JSON; `undefined` when it is not. */
export function parseJson(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : undefined;
  } catch {
    return undefined;
  }
}

const firstLine = (r) => (r.stderr || r.stdout || "").trim().split("\n")[0]?.slice(0, 120) || "(no output)";

/**
 * Judge one `ctx daemon status --format json` run at `now` (ms). Returns `{ ok, reason, fix,
 * fields }`; `fields` holds what was read (`running`, `status`, `supervisor`, `lastRunAtMs`,
 * `pid`) so a report can show it.
 */
export function judge(r, now) {
  const fail = (reason, fields = {}, fix = FIX) => ({ ok: false, reason, fix, fields });
  if (r.error) return fail(`ctx could not run: ${r.error}`, {}, /is not on PATH$|does not exist \(/.test(r.error) ? FIX_MISSING : FIX);
  const j = parseJson(r.stdout);
  if (!j) return fail(`\`${STATUS_ARGV.join(" ")}\` printed no JSON (exit ${r.code ?? "none"}): ${firstLine(r)}`);
  const d = field(j, "daemon");
  if (!d) return fail(`\`${STATUS_ARGV.join(" ")}\` has no .daemon`);
  const fields = {
    running: field(d, "running") ?? null,
    status: field(d, "status") ?? null,
    pid: field(d, "pid") ?? null,
    supervisor: field(field(d, "supervisor"), "status") ?? null,
    lastRunAtMs: field(field(field(d, "jobs"), "core_refresh"), "last_run_at_ms") ?? null,
  };
  if (fields.running !== true || fields.status !== "running") return fail(`the ctx daemon is not running (.daemon.running = ${JSON.stringify(fields.running)}, .daemon.status = ${JSON.stringify(fields.status)})`, fields);
  if (fields.supervisor !== "installed") return fail(`the ctx supervisor is not installed (.daemon.supervisor.status = ${JSON.stringify(fields.supervisor)}): launchd will not restart the daemon`, fields);
  if (fields.lastRunAtMs === null) return fail(`\`${STATUS_ARGV.join(" ")}\` has no .daemon.jobs.core_refresh.last_run_at_ms`, fields);
  if (!validMs(fields.lastRunAtMs)) return fail(`\`${STATUS_ARGV.join(" ")}\` has an invalid .daemon.jobs.core_refresh.last_run_at_ms (${JSON.stringify(fields.lastRunAtMs)}: not whole epoch milliseconds)`, fields);
  const ago = now - fields.lastRunAtMs;
  if (ago < -SKEW_MS) return fail(`core_refresh in the future (.daemon.jobs.core_refresh.last_run_at_ms = ${iso(fields.lastRunAtMs)}, ${age(-ago)} ahead of this clock; over ${age(SKEW_MS)} of skew)`, fields);
  if (ago > STALE_MS) return fail(`the ctx daemon runs but core_refresh last ran ${age(ago)} ago (.daemon.jobs.core_refresh.last_run_at_ms = ${iso(fields.lastRunAtMs)}; over ${age(STALE_MS)})`, fields);
  return { ok: true, reason: null, fix: null, fields, summary: `daemon running (pid ${fields.pid ?? "?"}), supervisor installed, core_refresh ${age(ago)} ago` };
}

/** One probe: spawn, judge, stamp. */
export function probe({ run = runCtx, env = process.env, now = Date.now, timeoutMs = PROBE_TIMEOUT_MS, ctx = CTX } = {}) {
  const at = now();
  const r = run(withCtx(STATUS_ARGV, ctx), ctxEnv(env), timeoutMs);
  return { at, ...judge(r, at) };
}

/**
 * The documented repair, guarded. `{ attempted, ok, detail }`: not attempted when ctx is not on
 * PATH, when indexing mode is not `auto`, when the config file ctx names does not exist, or when
 * `remaining()` (ms left on a shared deadline) is spent.
 */
export function heal({ run = runCtx, env = process.env, exists = existsSync, timeoutMs = PROBE_TIMEOUT_MS, ctx = CTX, remaining = () => Infinity } = {}) {
  const e = ctxEnv(env);
  const bound = () => Math.min(timeoutMs, remaining());
  if (bound() <= 0) return { attempted: false, ok: false, detail: "not attempted: the check's deadline passed" };
  const mode = run(withCtx(MODE_ARGV, ctx), e, bound());
  if (mode.error) return { attempted: false, ok: false, detail: `not attempted: ctx could not run: ${mode.error}` };
  const mj = parseJson(mode.stdout);
  const current = field(field(mj, "indexing"), "mode");
  const configPath = field(mj, "config_path");
  if (current !== "auto") return { attempted: false, ok: false, detail: `not attempted: ctx indexing mode is ${JSON.stringify(current ?? null)}, not auto; ctx-watch does not change it` };
  if (typeof configPath !== "string" || !exists(configPath)) return { attempted: false, ok: false, detail: `not attempted: ${configPath ?? "ctx's config file"} does not exist (ctx is not set up here)` };
  if (bound() <= 0) return { attempted: false, ok: false, detail: "not attempted: the check's deadline passed" };
  const r = run(withCtx(HEAL_ARGV, ctx), e, bound());
  if (r.error) return { attempted: true, ok: false, detail: `\`${HEAL_ARGV.join(" ")}\`: ${r.error}` };
  const j = parseJson(r.stdout);
  if (!j) return { attempted: true, ok: false, detail: `\`${HEAL_ARGV.join(" ")}\` (exit ${r.code ?? "none"}): ${firstLine(r)}` };
  const running = field(field(j, "daemon"), "running");
  const sup = field(field(field(j, "daemon"), "supervisor"), "status") ?? null;
  return { attempted: true, ok: running === true, detail: `\`${HEAL_ARGV.join(" ")}\`: daemon running = ${JSON.stringify(running ?? null)}, supervisor ${JSON.stringify(sup)}` };
}

/**
 * Probe; on failure heal and probe again. `{ ok, reason, fix, fields, at, first, healed,
 * timedOut }`: the top level is the last probe; `first` is the failing one when a heal was tried.
 * `deadlineMs` (optional) is the one clock the whole check runs on, measured from the first
 * probe's `now()`.
 */
export function check(deps = {}) {
  const { now = Date.now, timeoutMs = PROBE_TIMEOUT_MS, deadlineMs = null } = deps;
  const start = now();
  const remaining = () => (deadlineMs === null ? Infinity : start + deadlineMs - now());
  const bound = () => Math.max(0, Math.min(timeoutMs, remaining()));
  const done = (result) => {
    if (result.ok || deadlineMs === null || remaining() > 0) return { timedOut: false, ...result };
    return { ...result, timedOut: true, reason: `check timed out after ${deadlineMs} ms (${result.reason})` };
  };
  const first = probe({ ...deps, timeoutMs: bound() });
  if (first.ok) return { ...first, first: null, healed: null, timedOut: false };
  const healed = heal({ ...deps, remaining });
  if (!healed.attempted) return done({ ...first, first: null, healed });
  if (remaining() <= 0) return done({ ...first, first: null, healed: { ...healed, detail: `${healed.detail}; no time left to probe again` } });
  const second = probe({ ...deps, timeoutMs: bound() });
  return done({ ...second, first, healed });
}

export const LINE_MAX = 160;

/** The SessionStart / `check` line for a failing result: `ctx-watch: <reason>; fix: <command>`, at most 160 characters. */
export function needsYouLine(result) {
  if (result.ok) return null;
  const tail = `; fix: \`${result.fix}\``;
  const head = "ctx-watch: ";
  let reason = result.reason;
  const room = LINE_MAX - head.length - tail.length;
  if (reason.length > room) reason = reason.slice(0, room - 1) + "…";
  return head + reason + tail;
}
