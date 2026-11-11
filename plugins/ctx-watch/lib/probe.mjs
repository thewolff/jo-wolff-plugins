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
//   .daemon.jobs.semantic_index missing                   "… has no .daemon.jobs.semantic_index"
//   .daemon.jobs.semantic_index.semantic_enabled === true and .status !== "ready", unless it is
//   the throttled indexer resting (below)                 "the ctx semantic index is not ready (…)"
//   the resting shape with .daemon.jobs.semantic_index.last_run_at_ms missing, invalid, over 2 h
//   old, or over 60 s ahead of this clock                 "semantic index budget_exhausted: last run …"
//
// The semantic rows read the same `ctx daemon status` output as the rest (no second spawn: the
// cheapest call that exposes semantic status is the one already made; `ctx semantic status
// --format json` took 2.8-9 s on 2026-11-04 and `ctx search --format json` 2.9 s, against 0.15 s).
// ctx 2.3.0 has no rebuild verb (`ctx semantic --help`: enable, status, disable), so a not-ready
// index is not repaired here: the line names `ctx semantic enable --wait` ("Enable semantic
// search and start model indexing"). Semantic search not opted in (`semantic_enabled` false) is a
// pass: nothing to watch.
//
// `budget_exhausted` is a pass when the job also says `runtime_active: true`, has no
// `last_error`, its `last_run_status` is `budget_exhausted` or `ready`, and its own
// `last_run_at_ms` is at most 2 h old (`STALE_MS`, the Core window) and at most 60 s ahead of
// this clock. Three kinds of support, kept apart:
//
// Observed. Sampled every 8 s on 2026-11-04 13:22-13:43, the field cycled on its own, about
// 4 min `budget_exhausted` then about 1 min `ready`, with nobody running `ctx semantic enable`;
// in all 92 `budget_exhausted` samples `last_run_status` was also `budget_exhausted` (never
// `ready`: accepting `ready` is derived, not sampled), `runtime_active` was true, `last_error`
// absent, `indexed_chunks` absent in 84 (so neither of those two marks the healthy shape), and
// the job's own `last_run_at_ms` was 0.3-22 s old. Before 0.2.2 this rule failed that state and
// popped twice on 2026-11-04 (12:54 and 13:19).
//
// Inferred. ctx 2.3.0's embedded JSON contract defines `budget_exhausted` for search's
// `freshness.status` ("daemon-owned bounded maintenance left backlog while search served the
// latest committed generation", listed apart from `failed`). Its `daemon.jobs.semantic_index`
// section gives no such definition; reading the semantic job's `budget_exhausted` the same way
// is an analogy. The likely mechanism, also inferred: each new Core generation un-pins the
// semantic projection and the built-in throttle catches it up in budgeted runs; meanwhile hybrid
// search falls back to lexical (2026-11-04 03:00: `ctx search` said `semantic_status:
// unavailable`, the 03:00 fixture), and `ctx semantic enable --wait` would only wait for the
// next ready window.
//
// Not guaranteed. No upstream ctx text was found that makes the semantic job's
// `budget_exhausted` safe. `runtime_active` means the query service is owned, not that
// iterations are progressing, and Core refresh runs independently of the semantic job, so the
// Core freshness row says nothing about it: hence the job's own `last_run_at_ms` bound, without
// which a stalled indexer would pass on an old result for ever.
//
// `ctx` is the executable: the bare name by default (PATH lookup), or the absolute path the
// launchd timer was installed with (`--ctx`), so a PATH edited after install cannot change which
// program the timer runs.
//
// The spawn's bound is hard: spawnSync's timeout with SIGKILL (a ctx that ignores SIGTERM, the
// default kill signal, would otherwise hold the tick for ever), the child in its own process
// group (`detached`), and the group killed after a timeout so nothing the child started outlives
// the bound. runCtx never throws and never hangs past `timeoutMs` plus the kernel's kill latency.
// That is for the read-only calls (`daemon status`, `index mode`, `upgrade status`), where a kill
// tears nothing. The one state-changing call, the heal, is run with `{ graceMs }` instead: under
// lib/bounded-run.mjs, which sends the group SIGTERM at the bound and SIGKILL only `graceMs`
// later, so ctx gets the chance to leave its supervisor files whole (2026-11-10 23:29: a heal
// killed at 1.2 s is the likeliest writer of a supervisor environment file without LANG).
//
// heal({ run, env, exists }) runs `ctx index mode auto`, the command ctx's storage doc gives for
// repairing supervision ("when auto is not overridden, ctx installs or repairs supervision and
// starts the persistent background daemon"). It is the only ctx command the watcher runs that
// changes anything (`repair`, lib/repair.mjs, run by a person or an agent, adds the upgrade
// release), so it runs only when ctx already reports indexing mode `auto` and the config file
// ctx names exists: ctx-watch never sets up an installation and never flips a deliberate
// `manual` to `auto`. A non-CI `ctx daemon status` does NOT restart a dead daemon (tried on a
// throwaway data root, 2026-11-04: three calls, still `stale_lock`); `ctx index mode auto` did,
// in 0.4 s. Its bound is HEAL_TIMEOUT_MS (120 s) with a HEAL_GRACE_MS (15 s) SIGTERM grace:
// ctx 2.3.0's own daemon handoff waits up to 75 s for installation quiescence plus 5 s to stop
// and 5 s to restart a daemon (daemon_autostart.rs:83-87), and a heal bounded below that is a
// heal killed in the middle of ctx's own work. The heal never runs inside the SessionStart hook
// (its runner allows 4 s); it runs from the timer, `check` and `repair`.
//
// Before any heal, upgradeGate() reads `ctx upgrade status --format json` and the daemon
// upgrade handoff marker (<data root>/daemon/upgrade-handoff.json). While ctx 2.3.0's automatic
// upgrade hands the daemon over, `ctx daemon status` reads `running: false` (status.json
// `failed` on 2026-11-05, `stopped` on 2026-11-11) although the daemon is alive and copying
// files; healing on that signal is the suspected cause of the 2026-11-05 death. So:
//   - an active upgrade state (`staged`, `quiescing`, `applying`, `scheduled`, `recovering`:
//     ctx-upgrade-engine state.rs is_active_upgrade_status) under UPGRADE_STUCK_MS (30 min)
//     old, or a handoff marker ctx itself would call active (readHandoff), is `upgrading`: no
//     heal, no strike, a `wait` line;
//   - an active state over 30 min old whose handoff is not active (owner dead, marker over
//     15 min old, or none) is `stuck`: a finding of its own kind (`upgrade`), healable: false,
//     whose fix is the release sequence observed to work on 2026-11-11 (`ctx upgrade disable &&
//     ctx upgrade --dry-run && ctx index mode auto`; the `--dry-run` release is observed, not
//     documented). The watcher runs none of it; `repair` does, behind the same gates.
//
// check({ run, env, now, exists, deadlineMs, heal }) is probe, then (failing) the upgrade gate,
// then heal, then probe again; the result carries both probes and what the heal did. `heal:
// false` (the SessionStart hook) stops after the gate. With `deadlineMs` the spawns share one
// clock: each spawn's budget, the smaller of `timeoutMs` and what is left, is computed once; a
// step whose budget is not positive is skipped (never spawned with timeout 0, which spawnSync
// reads as "no limit") and the result says `budgetExhausted: true`; a failing result past the
// deadline says `check timed out after <deadlineMs> ms (<what the last step said>)`. Without it
// each spawn gets its own bound (the CLI and the timer, where nothing waits on the answer).
//
// A status call that timed out is not yet a dead daemon: on a loaded machine (2026-11-11
// 22:44-23:06Z, load average 78-183) `ctx daemon status` missed its 10 s twice while the daemon,
// pid 51357, ran throughout, and two "ctx is down" popups were false. So a timed-out status call
// asks daemonAlive(), which never runs ctx: the pid in <data root>/daemon/query-endpoint.json
// must be running (`process.kill(pid, 0)`, under a millisecond) and the query socket that file
// names must accept a connection (a node child connecting, bounded by ALIVE_TIMEOUT_MS; ~1 ms
// to connect, the child's start dominates). The socket is what makes a reused pid harmless: a
// process that took over the dead daemon's pid does not listen on its socket, and a socket file
// left behind refuses the connection. Both true: the result is `slow: true`, its reason says the
// daemon is running, and check() stops there (no upgrade read, no heal: nothing is down). `ps`
// is not used: it is setuid and refused (EPERM) inside a sandboxed shell, and a pid's command
// name proves less than its socket. A live daemon that is hung for good still accepts on its
// socket (the kernel queues the connection), so the state bounds a slow run (SLOW_MAX_MS).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_TIMEOUT_MS = 10_000;
/** The bound on daemonAlive's socket connect, child start included. */
export const ALIVE_TIMEOUT_MS = 2_000;
/** The heal's bound: above ctx's 75 s installation-quiescence wait plus its 5 s stop and 5 s restart, with room. */
export const HEAL_TIMEOUT_MS = 120_000;
/** How long the heal has between SIGTERM and SIGKILL once its bound is reached. */
export const HEAL_GRACE_MS = 15_000;
/** ctx 2.3.0's DAEMON_UPGRADE_HANDOFF_STALE_AFTER: a handoff marker older than this is not active. */
export const HANDOFF_STALE_MS = 15 * 60 * 1000;
/** An active upgrade state older than this, with no active handoff, is stuck. */
export const UPGRADE_STUCK_MS = 30 * 60 * 1000;
/** ctx-upgrade-engine state.rs is_active_upgrade_status. */
export const UPGRADE_ACTIVE = Object.freeze(["staged", "quiescing", "applying", "scheduled", "recovering"]);
/**
 * The other states ctx 2.3.0 writes to `.state.status`, none of which fences the daemon out:
 * "" (never upgraded: UpgradeState's default), "checking" (UpgradeState::begin),
 * "available"/"up_to_date" (a check), "applied", "dry_run", "disabled", "error" (the terminal
 * ones, state.rs terminal_installation_upgrade_attempt_id). Any status outside this list and
 * UPGRADE_ACTIVE is a state ctx-watch cannot judge, and the gate fails closed on it.
 */
export const UPGRADE_SETTLED = Object.freeze(["", "checking", "available", "up_to_date", "applied", "dry_run", "disabled", "error"]);
export const STALE_MS = 2 * 60 * 60 * 1000;
/** How far ahead of this clock a core_refresh stamp may sit before it is "in the future". */
export const SKEW_MS = 5 * 60 * 1000;
/** JavaScript's last representable Date, in ms: the upper bound of a plausible stamp. */
const MAX_DATE_MS = 8.64e15;
export const CTX = "ctx";
export const STATUS_ARGV = Object.freeze([CTX, "daemon", "status", "--format", "json"]);
export const MODE_ARGV = Object.freeze([CTX, "index", "mode", "--format", "json"]);
export const HEAL_ARGV = Object.freeze([CTX, "index", "mode", "auto", "--format", "json"]);
export const UPGRADE_ARGV = Object.freeze([CTX, "upgrade", "status", "--format", "json"]);
/** The line's fix while an upgrade is in progress: look, do not touch. */
export const UPGRADE_STATUS = "ctx upgrade status --format json";
/** The release sequence for a stuck upgrade (observed 2026-11-11; the `--dry-run` release is not documented by ctx). */
export function upgradeFix(autoEnabled) {
  return `${autoEnabled === false ? "" : "ctx upgrade disable && "}ctx upgrade --dry-run && ${"ctx index mode auto"}`;
}
const BOUNDED_RUN = fileURLToPath(new URL("./bounded-run.mjs", import.meta.url));
/** What lib/bounded-run.mjs prints on stderr after a timeout, and before a spawn error's code. */
const TIMEOUT_MARK = "ctx-watch-bounded-run: timed out";
const SPAWN_MARK = "ctx-watch-bounded-run: spawn ";
/** The one command a person runs for every failing probe (the heal, by hand, outside CI). */
export const FIX = "ctx index mode auto";
export const FIX_MISSING = "ctx docs show getting-started";
/** The command for a semantic index that is not ready: ctx 2.3.0 has no rebuild verb. */
export const SEMANTIC_FIX = "ctx semantic enable --wait";
/** The command for a status output with no semantic block at all (a ctx this plugin does not read). */
export const SEMANTIC_STATUS = "ctx semantic status";

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
 * gets SIGKILL, and so does everything left in its process group. A `timeoutMs` that is not
 * positive spawns nothing (spawnSync reads 0 as "no limit"): `error` says no time was left.
 *
 * With `{ graceMs }` the child runs under lib/bounded-run.mjs instead: SIGTERM to its group at
 * `timeoutMs`, SIGKILL `graceMs` later if any of it is still there. spawnSync keeps a SIGKILL
 * backstop a little past both, for a wrapper that itself stops answering.
 */
export function runCtx(argv, env, timeoutMs = PROBE_TIMEOUT_MS, { graceMs } = {}) {
  if (!(timeoutMs > 0)) return { code: null, stdout: "", stderr: "", error: `not run: no time left (timeout ${timeoutMs} ms)` };
  const graceful = graceMs > 0;
  const [bin, args, bound] = graceful
    ? [process.execPath, [BOUNDED_RUN, String(timeoutMs), String(graceMs), ...argv], timeoutMs + graceMs + 5_000]
    : [argv[0], argv.slice(1), timeoutMs];
  const r = spawnSync(bin, args, { env, encoding: "utf8", timeout: bound, killSignal: "SIGKILL", detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = r.stderr ?? "";
  let error;
  const notFound = () => (isAbsolute(argv[0]) ? `${argv[0]} does not exist (pinned at install; run install again)` : `${argv[0]} is not on PATH`);
  const timedOut = () => `${argv.join(" ")} did not answer in ${timeoutMs / 1000} s`;
  let timed = false;
  if (graceful && r.status === 124 && stderr.includes(TIMEOUT_MARK)) {
    error = timedOut();
    timed = true;
    stderr = stderr.replace(`\n${TIMEOUT_MARK}\n`, "");
  } else if (graceful && r.status === 127 && stderr.includes(SPAWN_MARK)) {
    const code = stderr.slice(stderr.indexOf(SPAWN_MARK) + SPAWN_MARK.length).trim();
    error = code === "ENOENT" ? notFound() : `${argv[0]} could not start: ${code}`;
    stderr = "";
  } else if (r.error?.code === "ENOENT") error = notFound();
  else if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL") {
    error = timedOut();
    timed = true;
    if (r.pid) {
      try {
        process.kill(-r.pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
    }
  } else if (r.error) error = r.error.message;
  return timed ? { code: r.status, stdout: r.stdout ?? "", stderr, error, timedOut: true } : { code: r.status, stdout: r.stdout ?? "", stderr, error };
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

/** How far ahead of this clock a semantic_index stamp may sit while it still counts as resting. */
export const SEMANTIC_SKEW_MS = 60 * 1000;

/**
 * The throttled semantic indexer between budgeted runs: `status` and `last_run_status` from the
 * catch-up cycle, the query service owned, no error, and a last run inside the Core staleness
 * window (`STALE_MS`, at most `SEMANTIC_SKEW_MS` ahead of `now`). See the header for the evidence.
 * `{ resting, reason }`: `reason` is set when the shape is the resting one but its
 * `last_run_at_ms` is missing, invalid, in the future, or stale, naming the age.
 */
export function semanticResting(semantic, now) {
  const lastError = field(semantic, "last_error");
  const shape =
    field(semantic, "status") === "budget_exhausted" &&
    field(semantic, "runtime_active") === true &&
    (lastError === undefined || lastError === null) &&
    ["budget_exhausted", "ready"].includes(field(semantic, "last_run_status"));
  if (!shape) return { resting: false, reason: null };
  const at = field(semantic, "last_run_at_ms");
  const head = "semantic index budget_exhausted: last run";
  const where = "semantic_index.last_run_at_ms";
  const stale = (reason) => ({ resting: false, reason: `${head} ${reason}` });
  if (at === undefined || at === null) return stale(`age unknown (no ${where})`);
  if (!validMs(at)) return stale(`age unknown (${where} = ${JSON.stringify(at).slice(0, 24)})`);
  const ago = now - at;
  if (ago < -SEMANTIC_SKEW_MS) return stale(`${age(-ago)} in the future (${where}, over ${age(SEMANTIC_SKEW_MS)} skew)`);
  if (ago > STALE_MS) return stale(`${age(ago)} ago (${where}, over ${age(STALE_MS)})`);
  return { resting: true, reason: null };
}

/**
 * Judge one `ctx daemon status --format json` run at `now` (ms). Returns `{ ok, reason, fix,
 * fields }`; `fields` holds what was read (`running`, `status`, `supervisor`, `lastRunAtMs`,
 * `pid`) so a report can show it.
 */
export function judge(r, now) {
  // `healable`: whether `ctx index mode auto` is the repair for this failure (false for the
  // semantic rows: the daemon is up, and the mode command would change nothing).
  const fail = (reason, fields = {}, fix = FIX, healable = true) => ({ ok: false, reason, fix, fields, healable });
  if (r.error) return fail(`ctx could not run: ${r.error}`, {}, /is not on PATH$|does not exist \(/.test(r.error) ? FIX_MISSING : FIX);
  const j = parseJson(r.stdout);
  if (!j) return fail(`\`${STATUS_ARGV.join(" ")}\` printed no JSON (exit ${r.code ?? "none"}): ${firstLine(r)}`);
  const d = field(j, "daemon");
  if (!d) return fail(`\`${STATUS_ARGV.join(" ")}\` has no .daemon`);
  const semantic = field(field(d, "jobs"), "semantic_index");
  const fields = {
    running: field(d, "running") ?? null,
    status: field(d, "status") ?? null,
    pid: field(d, "pid") ?? null,
    supervisor: field(field(d, "supervisor"), "status") ?? null,
    lastRunAtMs: field(field(field(d, "jobs"), "core_refresh"), "last_run_at_ms") ?? null,
    semanticEnabled: field(semantic, "semantic_enabled") ?? null,
    semanticStatus: field(semantic, "status") ?? null,
  };
  if (fields.running !== true || fields.status !== "running") return fail(`the ctx daemon is not running (.daemon.running = ${JSON.stringify(fields.running)}, .daemon.status = ${JSON.stringify(fields.status)})`, fields);
  if (fields.supervisor !== "installed") return fail(`the ctx supervisor is not installed (.daemon.supervisor.status = ${JSON.stringify(fields.supervisor)}): launchd will not restart the daemon`, fields);
  if (fields.lastRunAtMs === null) return fail(`\`${STATUS_ARGV.join(" ")}\` has no .daemon.jobs.core_refresh.last_run_at_ms`, fields);
  if (!validMs(fields.lastRunAtMs)) return fail(`\`${STATUS_ARGV.join(" ")}\` has an invalid .daemon.jobs.core_refresh.last_run_at_ms (${JSON.stringify(fields.lastRunAtMs)}: not whole epoch milliseconds)`, fields);
  const ago = now - fields.lastRunAtMs;
  if (ago < -SKEW_MS) return fail(`core_refresh in the future (.daemon.jobs.core_refresh.last_run_at_ms = ${iso(fields.lastRunAtMs)}, ${age(-ago)} ahead of this clock; over ${age(SKEW_MS)} of skew)`, fields);
  if (ago > STALE_MS) return fail(`the ctx daemon runs but core_refresh last ran ${age(ago)} ago (.daemon.jobs.core_refresh.last_run_at_ms = ${iso(fields.lastRunAtMs)}; over ${age(STALE_MS)})`, fields);
  if (semantic === undefined || semantic === null) return fail(`\`${STATUS_ARGV.join(" ")}\` has no .daemon.jobs.semantic_index`, fields, SEMANTIC_STATUS, false);
  const rest = semanticResting(semantic, now);
  const resting = rest.resting;
  const semanticNote = fields.semanticEnabled !== true ? "semantic search not enabled" : `semantic index ${fields.semanticStatus}${resting ? " (throttled catch-up, not a failure)" : ""}`;
  if (fields.semanticEnabled === true && fields.semanticStatus !== "ready" && !resting) {
    if (rest.reason) return fail(rest.reason, fields, SEMANTIC_FIX, false);
    const reason = field(semantic, "reason");
    const lastRun = field(semantic, "last_run_status");
    const lastRunNote = fields.semanticStatus === "budget_exhausted" ? `, last run ${JSON.stringify(lastRun ?? null)}` : "";
    return fail(`the ctx semantic index is not ready (.daemon.jobs.semantic_index.status = ${JSON.stringify(fields.semanticStatus)}${lastRunNote}${typeof reason === "string" ? `, reason = ${JSON.stringify(reason)}` : ""})`, fields, SEMANTIC_FIX, false);
  }
  return { ok: true, reason: null, fix: null, fields, healable: false, summary: `daemon running (pid ${fields.pid ?? "?"}), supervisor installed, core_refresh ${age(ago)} ago, ${semanticNote}` };
}

/**
 * One probe: spawn, judge, stamp. A status call that timed out while daemonAlive() says the
 * daemon is running is `slow: true` (still `ok: false`), its reason saying so; `aliveBudget()`
 * (ms) bounds that check, and one that is not positive skips it (not slow).
 */
export function probe({ run = runCtx, env = process.env, now = Date.now, timeoutMs = PROBE_TIMEOUT_MS, ctx = CTX, daemonAlive: alive = daemonAlive, aliveBudget = () => ALIVE_TIMEOUT_MS } = {}) {
  const at = now();
  const r = run(withCtx(STATUS_ARGV, ctx), ctxEnv(env), timeoutMs);
  const judged = { at, ...judge(r, at) };
  if (judged.ok || r.timedOut !== true) return judged;
  const budget = Math.min(ALIVE_TIMEOUT_MS, aliveBudget());
  if (!(budget > 0)) return judged;
  const live = alive({ env, timeoutMs: budget });
  if (live?.alive !== true) return judged;
  return { ...judged, slow: true, reason: `${judged.reason}; the ctx daemon is running (${live.detail}): slow, not down` };
}

/** ctx's data root: CTX_DATA_ROOT, else ~/.ctx (ctx 2.3.0's default). */
const dataRoot = (env) => env.CTX_DATA_ROOT || join(env.HOME || homedir(), ".ctx");

/** <data root>/daemon/upgrade-handoff.json: CTX_DATA_ROOT, else ~/.ctx (ctx 2.3.0's default data root). */
export function handoffPath(env = process.env) {
  return join(dataRoot(env), "daemon", "upgrade-handoff.json");
}

/** Connect to the unix socket `path` from a node child within `timeoutMs`: `{ ok, detail }`. Never throws. */
export function connectSocket(path, timeoutMs = ALIVE_TIMEOUT_MS) {
  const script = 'const s=require("node:net").connect(process.argv[1]);s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",(e)=>{process.stderr.write(String(e.code||e.message));process.exit(1)})';
  const r = spawnSync(process.execPath, ["-e", script, path], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", env: {}, stdio: ["ignore", "ignore", "pipe"] });
  if (r.status === 0) return { ok: true, detail: "connected" };
  if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL") return { ok: false, detail: `no connection within ${timeoutMs} ms` };
  return { ok: false, detail: (r.stderr || r.error?.message || `exit ${r.status}`).trim() };
}

/**
 * Whether the ctx daemon's process is demonstrably alive, without running ctx: `{ alive, pid,
 * detail }`. Reads <data root>/daemon/query-endpoint.json (`pid`, `path`); alive only when that
 * pid is running and its query socket accepts a connection. A dead pid is answered without
 * connecting. Never throws.
 */
export function daemonAlive({ env = process.env, timeoutMs = ALIVE_TIMEOUT_MS, connect = connectSocket } = {}) {
  const file = join(dataRoot(env), "daemon", "query-endpoint.json");
  let ep;
  try {
    ep = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { alive: false, pid: null, detail: `${file} unreadable (${err.code ?? err.message})` };
  }
  const pid = field(ep, "pid");
  const sock = field(ep, "path");
  if (!Number.isInteger(pid) || pid <= 0 || typeof sock !== "string" || !sock) return { alive: false, pid: null, detail: `${file} has no pid and socket path` };
  if (!pidAlive(pid)) return { alive: false, pid, detail: `pid ${pid} is not running` };
  const c = connect(sock, timeoutMs);
  if (!c.ok) return { alive: false, pid, detail: `pid ${pid} runs, but its query socket ${sock} did not accept a connection (${c.detail})` };
  return { alive: true, pid, detail: `the ctx daemon's query socket accepted a connection (pid ${pid})` };
}

/** Whether `pid` names a running process (EPERM: running, someone else's). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * The handoff marker as ctx 2.3.0 judges it (ctx-daemon-runtime handoff/state.rs
 * handoff_marker_state_at): `absent`; `corrupt` (unreadable, no handoff_id, an unknown phase, no
 * pid); `terminal` (phase completed/aborted, mtime over HANDOFF_STALE_MS old, or the owner dead);
 * else `active`. The owner is `helper_pid` in phases scheduled/finalizing, `owner_pid` in
 * preparing/ready. `{ state, phase, pid, alive, ageMs }`.
 */
export function readHandoff(file, { now = Date.now(), alive = pidAlive } = {}) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { state: err.code === "ENOENT" ? "absent" : "corrupt", phase: null, pid: null, alive: false, ageMs: null };
  }
  const j = parseJson(text);
  const phase = typeof field(j, "phase") === "string" ? j.phase : null;
  const out = { state: "corrupt", phase, pid: null, alive: false, ageMs: null };
  if (typeof field(j, "handoff_id") !== "string" || !j.handoff_id || phase === null) return out;
  if (phase === "completed" || phase === "aborted") return { ...out, state: "terminal" };
  const pidKey = phase === "scheduled" || phase === "finalizing" ? "helper_pid" : phase === "preparing" || phase === "ready" ? "owner_pid" : null;
  if (!pidKey) return out;
  const pid = field(j, pidKey);
  if (!Number.isInteger(pid) || pid <= 0) return out;
  let ageMs = null;
  try {
    ageMs = now - statSync(file).mtimeMs;
  } catch {
    /* gone between the read and the stat: not fresh */
  }
  const isAlive = alive(pid);
  const state = ageMs === null || ageMs > HANDOFF_STALE_MS || !isAlive ? "terminal" : "active";
  return { state, phase, pid, alive: isAlive, ageMs };
}

/** `ctx upgrade status --format json`, read: `{ status, attemptId, sinceMs, autoEnabled, error }` (status null when ctx could not say). */
export function readUpgrade({ run = runCtx, env = process.env, ctx = CTX, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const none = { status: null, attemptId: null, sinceMs: null, autoEnabled: null };
  const r = run(withCtx(UPGRADE_ARGV, ctx), ctxEnv(env), timeoutMs);
  if (r.error) return { ...none, error: r.error };
  const j = parseJson(r.stdout);
  const st = field(j, "state");
  const status = typeof field(st, "status") === "string" ? st.status : null;
  if (status === null) return { ...none, error: `\`${UPGRADE_ARGV.join(" ")}\` (exit ${r.code ?? "none"}) has no .state.status: ${firstLine(r)}` };
  const since = Date.parse(field(st, "last_attempt_at") ?? "");
  const enabled = field(field(j, "auto_upgrade"), "enabled");
  const attemptId = field(st, "attempt_id");
  return { status, attemptId: typeof attemptId === "string" ? attemptId : null, sinceMs: Number.isFinite(since) ? since : null, autoEnabled: typeof enabled === "boolean" ? enabled : null, error: null };
}

/**
 * Whether ctx is mid-upgrade, stuck in one, neither, or cannot be told. `{ verdict: "none" |
 * "upgrading" | "stuck" | "unknown", reason, fix, upgrade, handoff }`. Upgrading: a handoff ctx
 * calls active, or an active upgrade state younger than UPGRADE_STUCK_MS (or of unknown age).
 * Stuck: an active state at least that old with no active handoff. Unknown: no active handoff,
 * and `ctx upgrade status` failed, printed no state, or named one outside UPGRADE_ACTIVE and
 * UPGRADE_SETTLED; nothing then says no upgrade is running, so nothing may change state.
 */
export function upgradeGate({ run = runCtx, env = process.env, ctx = CTX, now = Date.now, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const at = now();
  const upgrade = readUpgrade({ run, env, ctx, timeoutMs });
  const handoff = readHandoff(handoffPath(env), { now: at });
  const active = UPGRADE_ACTIVE.includes(upgrade.status);
  const old = upgrade.sinceMs !== null ? at - upgrade.sinceMs : null;
  const since = upgrade.sinceMs !== null ? `, since ${iso(upgrade.sinceMs)} (${age(old)} ago)` : "";
  const owner = handoff.pid !== null ? `handoff owner pid ${handoff.pid} ${handoff.alive ? "alive" : "dead"}` : handoff.state === "absent" ? "no handoff marker" : `handoff marker ${handoff.state}`;
  const stateNote = upgrade.status !== null ? `ctx upgrade state ${JSON.stringify(upgrade.status)}${since}` : "ctx upgrade state unknown";
  if (handoff.state === "active" || (active && (old === null || old < UPGRADE_STUCK_MS))) {
    return { verdict: "upgrading", reason: `upgrade in progress: ${stateNote}; ${owner}; not healing`, fix: UPGRADE_STATUS, upgrade, handoff };
  }
  if (active) {
    const why = handoff.pid !== null && handoff.alive ? `handoff marker over ${age(HANDOFF_STALE_MS)} old` : owner;
    return { verdict: "stuck", reason: `ctx upgrade stuck in ${JSON.stringify(upgrade.status)} for ${age(old)} (${why}): no ctx daemon can start`, fix: upgradeFix(upgrade.autoEnabled), upgrade, handoff };
  }
  if (upgrade.error !== null || !UPGRADE_SETTLED.includes(upgrade.status)) {
    const why = upgrade.error ?? `ctx upgrade state ${JSON.stringify(upgrade.status)} is not one ctx-watch knows`;
    return { verdict: "unknown", reason: `upgrade state unknown (${why}); ${owner}; not healing`, fix: UPGRADE_STATUS, upgrade, handoff };
  }
  return { verdict: "none", reason: null, fix: null, upgrade, handoff };
}

/**
 * The documented repair, guarded. `{ attempted, ok, detail }`: not attempted when ctx is not on
 * PATH, when indexing mode is not `auto`, when the config file ctx names does not exist, or when
 * `remaining()` (ms left on a shared deadline) is spent. The mode read is bounded by `timeoutMs`;
 * the heal by `healTimeoutMs` with a `graceMs` SIGTERM grace.
 */
export function heal({ run = runCtx, env = process.env, exists = existsSync, timeoutMs = PROBE_TIMEOUT_MS, healTimeoutMs = HEAL_TIMEOUT_MS, graceMs = HEAL_GRACE_MS, ctx = CTX, remaining = () => Infinity } = {}) {
  const e = ctxEnv(env);
  const passed = { attempted: false, ok: false, detail: "not attempted: the check's deadline passed", budgetExhausted: true };
  // Each spawn's budget is computed once and the same value both guards and bounds it.
  const modeBudget = Math.min(timeoutMs, remaining());
  if (modeBudget <= 0) return passed;
  const mode = run(withCtx(MODE_ARGV, ctx), e, modeBudget);
  if (mode.error) return { attempted: false, ok: false, detail: `not attempted: ctx could not run: ${mode.error}` };
  const mj = parseJson(mode.stdout);
  const current = field(field(mj, "indexing"), "mode");
  const configPath = field(mj, "config_path");
  if (current !== "auto") return { attempted: false, ok: false, detail: `not attempted: ctx indexing mode is ${JSON.stringify(current ?? null)}, not auto; ctx-watch does not change it` };
  if (typeof configPath !== "string" || !exists(configPath)) return { attempted: false, ok: false, detail: `not attempted: ${configPath ?? "ctx's config file"} does not exist (ctx is not set up here)` };
  const healBudget = Math.min(healTimeoutMs, remaining());
  if (healBudget <= 0) return passed;
  const r = run(withCtx(HEAL_ARGV, ctx), e, healBudget, { graceMs });
  if (r.error) return { attempted: true, ok: false, detail: `\`${HEAL_ARGV.join(" ")}\`: ${r.error}` };
  const j = parseJson(r.stdout);
  if (!j) return { attempted: true, ok: false, detail: `\`${HEAL_ARGV.join(" ")}\` (exit ${r.code ?? "none"}): ${firstLine(r)}` };
  const running = field(field(j, "daemon"), "running");
  const sup = field(field(field(j, "daemon"), "supervisor"), "status") ?? null;
  return { attempted: true, ok: running === true, detail: `\`${HEAL_ARGV.join(" ")}\`: daemon running = ${JSON.stringify(running ?? null)}, supervisor ${JSON.stringify(sup)}` };
}

/**
 * Probe; on failure read the upgrade gate, then heal and probe again. `{ ok, reason, fix,
 * fields, at, first, healed, timedOut, budgetExhausted, upgrading?, kind? }`: the top level is
 * the last probe; `first` is the failing one when a heal was tried. A failure the heal cannot
 * touch (`healable: false`: the semantic rows, where the daemon is up) is returned as is, with
 * `healed: { attempted: false, … }` naming why. During a live upgrade the result is the failing
 * probe with `upgrading: true` and the gate's reason; a stuck upgrade is `kind: "upgrade"`,
 * `healable: false`, with the release sequence as its fix. `heal: false` stops after the gate.
 * `deadlineMs` (optional) is the one clock the whole check runs on, measured from the first
 * `now()`. Each spawn's budget (the smaller of its bound and what is left) is computed once; a
 * budget that is not positive skips that spawn, never runs it with timeout 0, and the result
 * says `budgetExhausted: true` (and, failing, `timedOut: true`).
 */
export function check(deps = {}) {
  const { now = Date.now, timeoutMs = PROBE_TIMEOUT_MS, deadlineMs = null, heal: mayHeal = true } = deps;
  const start = now();
  const remaining = () => (deadlineMs === null ? Infinity : start + deadlineMs - now());
  const budget = () => Math.min(timeoutMs, remaining());
  const late = (result) => ({ ...result, timedOut: true, reason: `check timed out after ${deadlineMs} ms (${result.reason})` });
  const done = (result, budgetExhausted = false) => {
    if (result.ok) return { timedOut: false, ...result, budgetExhausted };
    if (budgetExhausted || (deadlineMs !== null && remaining() <= 0)) return { ...late(result), budgetExhausted };
    return { timedOut: false, ...result, budgetExhausted };
  };
  const firstBudget = budget();
  if (firstBudget <= 0) return done({ at: start, ok: false, reason: "no time left to probe ctx", fix: FIX, fields: {}, first: null, healed: null }, true);
  const first = probe({ ...deps, timeoutMs: firstBudget, aliveBudget: remaining });
  if (first.ok) return { ...first, first: null, healed: null, timedOut: false, budgetExhausted: false };
  if (first.slow === true) return done({ ...first, first: null, healed: { attempted: false, ok: false, detail: "not attempted: the ctx daemon is running, only slow to answer" } });
  if (first.healable === false) return done({ ...first, first: null, healed: { attempted: false, ok: false, detail: `not attempted: the daemon is running; \`${FIX}\` does not touch the semantic index` } });
  const gateBudget = budget();
  if (gateBudget <= 0) return done({ ...first, first: null, healed: { attempted: false, ok: false, detail: "not attempted: no time left to read the upgrade state" } }, true);
  const gate = upgradeGate({ ...deps, timeoutMs: gateBudget });
  if (gate.verdict === "upgrading") return done({ ...first, reason: gate.reason, fix: gate.fix, upgrading: true, upgrade: gate.upgrade, handoff: gate.handoff, first: null, healed: { attempted: false, ok: false, detail: "not attempted: an upgrade is in progress" } });
  if (gate.verdict === "stuck") return done({ ...first, reason: gate.reason, fix: gate.fix, kind: "upgrade", healable: false, upgrade: gate.upgrade, handoff: gate.handoff, first: null, healed: { attempted: false, ok: false, detail: "not attempted: a stuck upgrade fences the daemon out; the release is `repair`'s, not the watcher's" } });
  if (!mayHeal) return done({ ...first, first: null, healed: { attempted: false, ok: false, detail: "not attempted: the session-start check does not heal" } });
  if (gate.verdict === "unknown") {
    const skipped = { attempted: false, ok: false, detail: `not attempted: ${gate.reason}` };
    // ctx itself could not run: that is the finding, and its fix is the one to show.
    if (first.fix === FIX_MISSING) return done({ ...first, upgrade: gate.upgrade, handoff: gate.handoff, first: null, healed: skipped });
    return done({ ...first, reason: `${first.reason}; not healed: upgrade state unknown`, fix: gate.fix, upgrade: gate.upgrade, handoff: gate.handoff, first: null, healed: skipped });
  }
  const healed = heal({ ...deps, remaining });
  if (!healed.attempted) return done({ ...first, first: null, healed }, healed.budgetExhausted === true);
  const secondBudget = budget();
  if (secondBudget <= 0) return done({ ...first, first: null, healed: { ...healed, detail: `${healed.detail}; no time left to probe again` } }, true);
  const second = probe({ ...deps, timeoutMs: secondBudget, aliveBudget: remaining });
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
