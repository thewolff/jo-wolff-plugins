// host-io.mjs — the I/O the gate core leaves to its adapters, shared by every host.
//
// WHAT IT PROVIDES
//   - The `io` object the core's verbs take: clock, realpath, boundary hashing and worktree
//     snapshots (makeIo).
//   - A file-backed, locked session store: state.json and journal.jsonl in one directory per
//     session (loadState, saveState, appendJournal, withSession).
//   - pair_run's process machinery: run a command under a Seatbelt profile in its own process
//     group (runSandboxed), and kill and reap whole process groups (reapGroups).
//
// RULES IT KEEPS
//   - Node built-ins only and no top-level await, so Node hooks, a Node MCP server and Bun
//     (OMP's extension loader) all import it.
//   - reapGroups is synchronous: the core calls io.reapRuns without awaiting and snapshots right
//     after, so the groups have to be dead when it returns.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { boundaryMatches, readState, serializeState } from "../core/gate.mjs";

// ─── paths ──────────────────────────────────────────────────────────────────────────────

/**
 * The base state directory: $PAIRED_CODING_STATE_DIR, else ~/.local/state/paired-coding.
 * Each session gets its own subdirectory (sessionDir).
 * @param {Record<string, string | undefined>} [env]
 */
export function stateBase(env = process.env) {
  const set = env.PAIRED_CODING_STATE_DIR;
  return set && set.startsWith("/") ? set : join(homedir(), ".local", "state", "paired-coding");
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The session's own state directory, or null when the id is not a safe path segment. */
export function sessionDir(base, sessionId) {
  return typeof sessionId === "string" && SAFE_ID.test(sessionId) && !sessionId.includes("..")
    ? join(base, sessionId)
    : null;
}

/** realpath for a path that may not exist yet: the deepest existing ancestor is resolved. */
export function realpathLoose(abs) {
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
      const parent = dirname(cur);
      if (parent === cur) throw err;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** The worktree for a working directory: the nearest ancestor holding `.git`, else the directory. */
export function findRoot(cwd) {
  const start = realpathSync(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

/** Temp directories pair_run may write while a change set is open, canonical. */
export function defaultTempPaths() {
  const out = new Set();
  for (const p of [tmpdir(), "/tmp", "/private/var/folders"]) {
    try { out.add(realpathSync(p)); } catch { /* absent on this machine */ }
  }
  return [...out];
}

/** Why pair_run cannot be fenced on this machine, or null. */
export function sandboxProblem() {
  if (process.platform !== "darwin") return "pair_run needs macOS Seatbelt (sandbox-exec); this platform has none";
  if (!existsSync("/usr/bin/sandbox-exec")) return "/usr/bin/sandbox-exec is missing";
  return null;
}

// ─── snapshots and hashing ──────────────────────────────────────────────────────────────

function fileHash(abs) {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

/**
 * Every non-directory path under `root` (untracked and ignored files included) with its type
 * and content hash. Directories themselves are not entries: creating a parent directory for a
 * boundary file is not a change. `exclusions` are worktree-relative directories left out.
 * @returns {Record<string, string>}
 */
export function snapshotTree(root, exclusions = []) {
  const out = {};
  const skip = new Set(exclusions.map((e) => e.replace(/\/+$/, "")));
  const walk = (absDir, relDir) => {
    for (const name of readdirSync(absDir)) {
      const rel = relDir ? `${relDir}/${name}` : name;
      if (skip.has(rel)) continue;
      const abs = join(absDir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
      else if (st.isFile()) out[rel] = `file:${st.mode & 0o111 ? "x" : "-"}:${fileHash(abs)}`;
      else out[rel] = `other:${st.mode}`;
    }
  };
  walk(root, "");
  return out;
}

/**
 * Fingerprints of the files a boundary covers right now. A literal entry that does not exist is
 * recorded as "absent", so creating it also changes the hash.
 */
export function hashBoundary(boundary, root, exclusions = []) {
  const snap = snapshotTree(root, exclusions);
  const out = {};
  for (const [rel, fp] of Object.entries(snap)) if (boundaryMatches(boundary, rel)) out[rel] = fp;
  for (const e of boundary) {
    const literal = !/[*?]/.test(e) && !e.endsWith("/");
    if (literal && !Object.hasOwn(out, e)) out[e] = "absent";
  }
  return out;
}

/**
 * The core's io for one session. `reapRuns` is supplied by the caller, who knows how run ids
 * map to process groups (see runPgids).
 * @param {{ root?: string | null, exclusions?: string[], reapRuns?: (ids: string[]) => void }} opts
 */
export function makeIo(opts = {}) {
  const exclusions = () => opts.exclusions ?? [];
  return {
    now: () => new Date().toISOString(),
    realpath: (abs) => realpathLoose(abs),
    hashBoundary: (boundary, root) => hashBoundary(boundary, root, exclusions()),
    snapshot: () => {
      if (!opts.root) throw new Error("no worktree root");
      return snapshotTree(opts.root, exclusions());
    },
    ...(opts.reapRuns ? { reapRuns: opts.reapRuns } : {}),
  };
}

// ─── session store ──────────────────────────────────────────────────────────────────────

const STATE = "state.json";
const JOURNAL = "journal.jsonl";
const RUNS = "runs.json";
const LOCK = "lock";
const MARKER = "activated";

/**
 * True once pairing was activated for this session directory: the marker written with the first
 * successful pair_start. From then on a missing or broken state file reads as closed, never as
 * inactive. The directory alone does not count: a refused pair_start journals into it.
 */
export function activated(dir) {
  return existsSync(join(dir, MARKER));
}

/** Write the activation marker; it also remembers the root and state dir for a degraded read. */
export function markActivated(dir, info) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, MARKER), JSON.stringify({ at: new Date().toISOString(), root: info?.root ?? null, stateDir: info?.stateDir ?? null }));
}

function readMarker(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), "utf8"));
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

/**
 * Load the state, failing closed through the core's readState. A degraded (closed) state keeps
 * the root and state dir recorded at activation, so it still fences pair_run correctly.
 */
export function loadState(dir, opts = {}) {
  let text = null;
  try {
    text = readFileSync(join(dir, STATE), "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") text = "\u0000unreadable";
  }
  const isOn = activated(dir);
  const marker = isOn ? readMarker(dir) : {};
  return readState(text, { activated: isOn, root: marker.root ?? undefined, stateDir: marker.stateDir ?? undefined, ...opts });
}

/** Atomic write: temp file in the same directory, then rename. */
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, STATE), serializeState(state));
}

export function appendJournal(dir, entries) {
  if (!entries || entries.length === 0) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, JOURNAL), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run `fn` holding the session's lock (a directory created with mkdir, which is atomic). A lock
 * older than `staleMs` is taken over: its holder died. Synchronous so hooks stay simple.
 * @template T
 * @param {string} dir
 * @param {() => T} fn
 * @returns {T}
 */
export function withLock(dir, fn, { waitMs = 10000, staleMs = 15000 } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, LOCK);
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) { rmSync(lock, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() > end) throw new Error(`timed out waiting for the session lock ${lock}`);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * One locked read-modify-write of a session's state. `fn(state)` returns a core Result (or any
 * object with `state` and `journal`); the state is saved when it changed and the journal appended.
 */
export function withSession(dir, opts, fn) {
  return withLock(dir, () => {
    const before = loadState(dir, opts);
    const r = fn(before);
    if (r && r.state && r.state !== before) saveState(dir, r.state);
    if (r && r.journal) appendJournal(dir, r.journal);
    return r;
  });
}

/** The start time ps reports for a process, or null when it is gone. */
function startTime(pid) {
  const ps = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const out = ps.status === 0 ? ps.stdout.trim() : "";
  return out || null;
}

/**
 * Remember which process group a run id owns, with its leader's start time, so a later process
 * (a hook, a restarted server) can reap it without killing an unrelated group that reused the id.
 */
export function recordRun(dir, runId, pgid) {
  const started = startTime(pgid);
  withLock(dir, () => {
    const runs = readRuns(dir);
    runs[runId] = { pgid, started };
    writeAtomic(join(dir, RUNS), JSON.stringify(runs));
  });
}

function readRuns(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, RUNS), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Process group ids for run ids, from the registry. A group whose id now belongs to a different
 * live leader (the leader's start time differs from the recorded one) is skipped: the id was
 * reused. A group whose leader exited but whose members live on is kept; the system does not
 * hand a process group's id to a new process while the group still has members.
 */
export function runPgids(dir, runIds) {
  const runs = readRuns(dir);
  const out = [];
  for (const id of runIds) {
    const r = runs[id];
    if (!r || !Number.isInteger(r.pgid) || r.pgid <= 1) continue;
    const now = startTime(r.pgid);
    if (now !== null && r.started !== null && now !== r.started) continue;
    out.push(r.pgid);
  }
  return out;
}

// ─── process groups ─────────────────────────────────────────────────────────────────────

/** Live (non-zombie) members of the given process groups, from ps. */
function liveMembers(pgids) {
  const want = new Set(pgids);
  const ps = spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr || ps.status}`);
  const live = [];
  for (const line of ps.stdout.split("\n")) {
    const [pid, pgid, stat] = line.trim().split(/\s+/);
    if (!pid || !want.has(Number(pgid))) continue;
    if (stat && stat.startsWith("Z")) continue;
    live.push({ pid: Number(pid), pgid: Number(pgid) });
  }
  return live;
}

/**
 * Kill every process in each group and wait until none is left alive (zombies count as dead:
 * a zombie whose parent is this blocked event loop cannot be reaped while we wait). Synchronous.
 * Throws when a group is still alive after `timeoutMs`.
 * @param {number[]} pgids
 * @returns {number[]} the groups that still had live members when called
 */
export function reapGroups(pgids, { timeoutMs = 3000 } = {}) {
  const groups = [...new Set(pgids.filter((p) => Number.isInteger(p) && p > 1))];
  if (groups.length === 0) return [];
  const alive = [...new Set(liveMembers(groups).map((m) => m.pgid))];
  const end = Date.now() + timeoutMs;
  for (;;) {
    for (const g of groups) {
      try { process.kill(-g, "SIGKILL"); } catch (err) { if (err?.code !== "ESRCH" && err?.code !== "EPERM") throw err; }
    }
    const left = liveMembers(groups);
    if (left.length === 0) return alive;
    if (Date.now() > end) throw new Error(`process group(s) still alive: ${[...new Set(left.map((m) => m.pgid))].join(", ")}`);
    sleepSync(50);
  }
}

/**
 * Write `content` to the absolute `path` from inside the Seatbelt `profile`, creating missing
 * parent directories there too. The kernel checks the resolved target of every create and write,
 * so a path that a swapped symlink turns toward somewhere the profile denies fails instead of
 * landing. Synchronous: pair_write and pair_edit run under the session lock.
 * @param {{ profile: string, path: string, content: string }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
export function writeSandboxed(opts) {
  const script = '/bin/mkdir -p -- "${1%/*}" && /bin/cat > "$1"';
  const res = spawnSync("/usr/bin/sandbox-exec", ["-p", opts.profile, "/bin/sh", "-c", script, "pair-write", opts.path], {
    input: Buffer.from(opts.content, "utf8"),
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 30_000,
  });
  if (res.error) return { ok: false, error: String(res.error.message ?? res.error) };
  if (res.status !== 0) {
    const err = String(res.stderr ?? "").trim();
    return { ok: false, error: err || `exit ${res.status}${res.signal ? ` (signal ${res.signal})` : ""}` };
  }
  return { ok: true };
}

/**
 * Run `command` with /bin/sh under the Seatbelt `profile`, in its own process group, in the
 * foreground. On timeout or abort the whole group is killed and reaped before this resolves.
 * On a normal exit the group is left as it is (pair_done reaps it before its snapshot).
 * @param {{ profile: string, command: string, cwd: string, timeoutMs?: number, signal?: AbortSignal,
 *   onSpawn?: (pgid: number) => void, env?: Record<string, string>, maxOutput?: number }} opts
 * @returns {Promise<{ exitCode: number | null, signal: string | null, stdout: string, stderr: string,
 *   timedOut: boolean, aborted: boolean, pgid: number | null, error?: string }>}
 */
export function runSandboxed(opts) {
  const max = opts.maxOutput ?? 64 * 1024;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("/usr/bin/sandbox-exec", ["-p", opts.profile, "/bin/sh", "-c", opts.command], {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.env ?? process.env,
      });
    } catch (err) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, pgid: null, error: String(err) });
      return;
    }
    const pgid = child.pid ?? null;
    let stdout = "";
    let stderr = "";
    const keep = (acc, chunk) => (acc + chunk).slice(-max);
    child.stdout.setEncoding("utf8").on("data", (c) => { stdout = keep(stdout, c); });
    child.stderr.setEncoding("utf8").on("data", (c) => { stderr = keep(stderr, c); });
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let reapError;
    const killGroup = () => {
      if (!pgid) return;
      try { reapGroups([pgid]); } catch (err) { reapError = String(err?.message ?? err); }
    };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killGroup(); }, opts.timeoutMs) : null;
    const onAbort = () => { aborted = true; killGroup(); };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    let exitInfo = { code: null, sig: null };
    let failure;
    let grace;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      opts.signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      const error = failure ?? reapError;
      resolve({ exitCode: exitInfo.code, signal: exitInfo.sig, stdout, stderr, timedOut, aborted, pgid, ...(error ? { error } : {}) });
    };
    child.on("error", (err) => {
      failure = String(err);
      finish();
    });
    child.on("exit", (code, sig) => {
      exitInfo = { code, sig };
      // A killed group is reaped again here: the leader's exit can race the first reap.
      if (timedOut || aborted || failure) killGroup();
      // Normally 'close' follows once the pipes drain. A process that left the group may hold
      // them open forever, so stop waiting shortly after the leader exits.
      grace = setTimeout(finish, 500);
    });
    child.on("close", finish);
    if (pgid && opts.onSpawn) {
      try {
        opts.onSpawn(pgid);
      } catch (err) {
        // Fail closed: a run whose group is not recorded could never be reaped by pair_done.
        failure = `could not record the run's process group (${err instanceof Error ? err.message : String(err)}); killed`;
        killGroup();
      }
    }
  });
}
