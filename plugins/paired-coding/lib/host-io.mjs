// host-io.mjs — the I/O the gate core leaves to its adapters, shared by every host.
//
// WHAT IT PROVIDES
//   - The `io` object the core's verbs take: clock, realpath, boundary hashing and worktree
//     snapshots (makeIo).
//   - A file-backed, locked session store: state.json and journal.jsonl in one directory per
//     session (loadState, saveState, appendJournal, withSession).
//   - pair_run's process machinery: run a command in the sandbox (a Seatbelt profile on macOS;
//     on Linux the pair-landlock helper, lib/landlock.mjs, or bubblewrap, lib/bwrap.mjs) in
//     its own process group (runSandboxed), check it made no link where it could write
//     (newLinks), and kill and reap whole process groups (reapGroups).
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
import {
  boundaryMatches, boundaryRoots, bwrapArgsFor, landlockRulesFor, pairRunProfile, pairWriteBwrap, pairWriteLandlock, pairWriteProfile,
  readState, serializeState,
} from "../core/gate.mjs";
import { bwrapCommand, bwrapIo, bwrapProblem } from "./bwrap.mjs";
import { landlockAbi, landlockCommand, landlockIo, landlockProblem } from "./landlock.mjs";

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

/**
 * realpath for a path that may not exist yet: the deepest existing ancestor is resolved. The
 * native realpath returns each existing component in its on-disk spelling, so on a
 * case-insensitive volume `.GIT/config` comes back as `.git/config`; every path the gate
 * compares (root, state directory, write targets) is resolved this way, so they agree.
 */
export function realpathLoose(abs) {
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
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
  const start = realpathSync.native(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

/** Temp directories pair_run may write while a change set is open, canonical. */
export function defaultTempPaths() {
  const out = new Set();
  for (const p of [tmpdir(), "/tmp", "/private/var/folders"]) {
    try { out.add(realpathSync.native(p)); } catch { /* absent on this machine */ }
  }
  return [...out];
}

/**
 * The sandbox this machine fences pairing with, chosen once per process from cached probes, so
 * every verb of a session gets the same one: Seatbelt on macOS; on Linux Landlock through the
 * pair-landlock helper when the kernel has ABI 3 or later, else bubblewrap, else none. A run
 * Landlock cannot express goes to bubblewrap on its own (runSandboxed, writeSandboxed). A
 * helper that fails its checksum, or no helper for this architecture, refuses outright.
 * @returns {{ name: "seatbelt" | "landlock" | "bwrap", why?: string } | { problem: string }}
 *   `why`: for bubblewrap, why Landlock is not used
 */
export function sandboxBackend() {
  if (process.platform === "darwin") return existsSync(SANDBOX_EXEC) ? { name: "seatbelt" } : { problem: `${SANDBOX_EXEC} is missing` };
  if (process.platform !== "linux") return { problem: `pair_run needs macOS Seatbelt or Linux Landlock or bubblewrap to fence its writes, and ${process.platform} has none` };
  return pickLinuxBackend(landlockProblem(), bwrapProblem);
}

/**
 * The Linux half of sandboxBackend, over the Landlock probe's answer and bubblewrap's probe:
 * Landlock when it works; bubblewrap only when the kernel lacks Landlock ABI 3; otherwise the
 * reason pairing is refused.
 * @param {{ problem: string, fallback: boolean } | null} landlock  landlockProblem()
 * @param {() => string | null} bwrap  bwrapProblem
 */
export function pickLinuxBackend(landlock, bwrap) {
  if (landlock === null) return { name: "landlock" };
  if (!landlock.fallback) return { problem: landlock.problem };
  const bw = bwrap();
  if (bw === null) return { name: "bwrap", why: landlock.problem };
  return { problem: `Landlock is not usable (${landlock.problem}), and ${bw}` };
}

/**
 * One sentence naming the active sandbox, for pair_start to tell the agent and its partner.
 * @param {ReturnType<typeof sandboxBackend>} backend
 */
export function describeSandbox(backend) {
  if ("problem" in backend) return `No sandbox: ${backend.problem}.`;
  if (backend.name === "seatbelt") return "Sandbox: macOS Seatbelt (sandbox-exec).";
  if (backend.name === "bwrap") return `Sandbox: bubblewrap, which fences writes per directory (Landlock is not usable here: ${backend.why}).`;
  const bw = bwrapProblem();
  return `Sandbox: Landlock (kernel ABI ${landlockAbi()}, helper checksum verified), which fences writes per file; a run whose boundary Landlock cannot express goes to bubblewrap${bw === null ? "" : `, which is unavailable here (${bw}), so such a run is refused`}.`;
}

/**
 * Why pair_run cannot be fenced on this machine, or null (sandboxBackend).
 */
export function sandboxProblem() {
  const b = sandboxBackend();
  return "problem" in b ? b.problem : null;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

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

/**
 * Write the activation marker; it also remembers the root and state dir for a degraded read.
 * A fresh marker is not ended: pairing is on until the gate itself saves an inactive state.
 */
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
  return readState(text, { activated: isOn, ended: marker.ended === true, root: marker.root ?? undefined, stateDir: marker.stateDir ?? undefined, ...opts });
}

/** Atomic write: temp file in the same directory, then rename. */
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

/**
 * Save the state. Saving an inactive state in an activated session first marks the marker ended:
 * only the gate ending pairing writes that, so an inactive state.json written by anything else
 * in a session whose marker is not ended reads as closed (readState).
 */
export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (state.phase === "inactive" && activated(dir)) {
    writeAtomic(join(dir, MARKER), JSON.stringify({ ...readMarker(dir), ended: true, endedAt: new Date().toISOString() }));
  }
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
 * @typedef {{ file: string, args: string[], fds: number[], close: () => void, input?: string,
 *   backend: "seatbelt" | "landlock" | "bwrap", fellBack?: string, writable: string[] }} SandboxedCommand
 *   `input`: what goes to the helper's stdin before anything else (Landlock's rules line);
 *   `fellBack`: why a Landlock machine ran this under bubblewrap instead; `writable`: where in
 *   the worktree the command can write, for the link check
 */

/**
 * The Linux backend for one run or write: `override` when given (tests), else this process's
 * (sandboxBackend). Throws when there is none; bubblewrap is probed before it is returned,
 * since bwrapCommand needs the probe's answer.
 * @param {"landlock" | "bwrap" | undefined} override
 */
function linuxBackend(override) {
  const b = override ? { name: override } : sandboxBackend();
  if ("problem" in b) throw new Error(b.problem);
  if (b.name === "bwrap") {
    const bw = bwrapProblem();
    if (bw !== null) throw new Error(bw);
  }
  return b.name;
}

/**
 * Landlock could not express this job (`reason`): bubblewrap runs it, or nothing does.
 * @param {string} reason
 */
function fallBack(reason) {
  const bw = bwrapProblem();
  if (bw !== null) throw new Error(`Landlock cannot fence this (${reason}), and bubblewrap is unavailable to fence it instead: ${bw}`);
  return reason;
}

const noop = () => {};

/**
 * What the sandbox runs for pair_run's `command` on this platform: sandbox-exec with the
 * Seatbelt profile on macOS; on Linux the pair-landlock helper with landlockRulesFor's rules,
 * or bubblewrap with the plan's pinned binds and the seccomp filter when Landlock is not this
 * machine's backend or cannot express the run. `close` releases the descriptors handed to
 * bwrap once it has started.
 * @param {import("../core/gate.mjs").State} state
 * @param {string} command
 * @param {string} cwd
 * @param {"landlock" | "bwrap"} [override]
 * @returns {SandboxedCommand}
 */
function runCommand(state, command, cwd, override) {
  const argv = ["/bin/sh", "-c", command];
  if (process.platform !== "linux") {
    return { file: SANDBOX_EXEC, args: ["-p", pairRunProfile(state), ...argv], fds: [], close: noop, backend: "seatbelt", writable: boundaryRoots(state) };
  }
  let fellBack;
  if (linuxBackend(override) === "landlock") {
    const rules = landlockRulesFor(state, [], landlockIo);
    if (!("notExpressible" in rules)) {
      const { file, input } = landlockCommand(rules, command);
      const inTree = (p) => p === state.root || p.startsWith(`${state.root}/`);
      const writable = [...rules.files, ...rules.dirs.map((d) => d.path)].filter(inTree);
      return { file, args: [], fds: [], close: noop, input, backend: "landlock", writable };
    }
    fellBack = fallBack(rules.notExpressible);
  }
  const plan = bwrapArgsFor(state, [], bwrapIo);
  return { ...bwrapCommand(plan, { argv, cwd }), backend: "bwrap", ...(fellBack ? { fellBack } : {}), writable: plan.writable };
}

/**
 * What the sandbox runs for pair_write's `script` (writeSandboxed): sandbox-exec with the
 * open-phase profile on macOS; on Linux an in-place write through the pair-landlock helper
 * (pairWriteLandlock), or bubblewrap's staged write (pairWriteBwrap) when Landlock is not this
 * machine's backend or cannot keep the write to the file it names.
 * @param {{ state: import("../core/gate.mjs").State, path: string, tempPath: string, backend?: "landlock" | "bwrap" }} opts
 * @param {string} script
 * @returns {SandboxedCommand}
 */
function writeCommand(opts, script) {
  const argv = ["/bin/sh", "-c", script, "pair-write", opts.path, opts.tempPath];
  if (process.platform !== "linux") {
    return { file: SANDBOX_EXEC, args: ["-p", pairWriteProfile(opts.state, opts.tempPath), ...argv], fds: [], close: noop, backend: "seatbelt", writable: [] };
  }
  let fellBack;
  if (linuxBackend(opts.backend) === "landlock") {
    const plan = pairWriteLandlock(opts.state, opts.path, landlockIo);
    if (!("notExpressible" in plan)) {
      const { file, input } = landlockCommand(plan, plan.command);
      return { file, args: [], fds: [], close: noop, input, backend: "landlock", writable: [] };
    }
    fellBack = fallBack(plan.notExpressible);
  }
  return { ...bwrapCommand(pairWriteBwrap(opts.state, opts.tempPath, bwrapIo), { argv }), backend: "bwrap", ...(fellBack ? { fellBack } : {}), writable: [] };
}

/**
 * Write `content` to the absolute `path` in the sandbox, creating missing parent directories
 * there too.
 *
 * On macOS, under the open-phase Seatbelt profile (pairWriteProfile), and on Linux under
 * bubblewrap, under a bwrap that can write only the target's directory (pairWriteBwrap): the
 * content goes to `tempPath` (a new file in the same directory, created exclusively) and is
 * renamed over `path`, so the write never goes through the target's existing inode: a hard
 * link or a symlink at `path` is replaced, and the file it pointed at is left as it was. An
 * existing target's permission bits are kept. Seatbelt checks the resolved path of every
 * create and rename; on Linux the bound directory is opened without following symlinks and
 * checked to be the path it names, so in both a parent directory a swapped symlink turns
 * elsewhere fails instead of landing.
 *
 * On Linux under Landlock (pairWriteLandlock) the content goes through the helper's stdin
 * straight into the target, in place: Landlock grants the one existing file, or for a new one
 * its directory with the shell's noclobber on, so the create fails on anything already there.
 * A target that is a symlink or has a second hard link, which an in-place write would follow,
 * goes to bubblewrap's staged write instead (`fellBack` says why). Landlock opens every path
 * component as the kernel resolves it, so a swapped symlink fails there too.
 *
 * Synchronous: pair_write and pair_edit run under the session lock.
 * @param {{ state: import("../core/gate.mjs").State, path: string, tempPath: string, content: string, backend?: "landlock" | "bwrap" }} opts
 *   `backend`: overrides this process's Linux backend (tests)
 * @returns {{ ok: boolean, error?: string, backend?: string, fellBack?: string }}
 */
export function writeSandboxed(opts) {
  const mode = process.platform === "linux" ? "-c %a" : "-f %Lp";
  const script = [
    "set -eC",
    'p="$1"; t="$2"',
    '/bin/mkdir -p -- "${p%/*}"',
    "trap '/bin/rm -f -- \"$t\"' EXIT",
    'if [ -d "$p" ]; then echo "the target is a directory" >&2; exit 1; fi',
    '/bin/cat > "$t"',
    `if [ -f "$p" ]; then /bin/chmod "$(/usr/bin/stat -L ${mode} -- "$p")" "$t"; fi`,
    '/bin/mv -f -- "$t" "$p"',
  ].join("\n");
  let cmd;
  try {
    cmd = writeCommand(opts, script);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const content = Buffer.from(opts.content, "utf8");
  const ran = { backend: cmd.backend, ...(cmd.fellBack ? { fellBack: cmd.fellBack } : {}) };
  let res;
  try {
    res = spawnSync(cmd.file, cmd.args, {
      input: cmd.input === undefined ? content : Buffer.concat([Buffer.from(cmd.input, "utf8"), content]),
      stdio: ["pipe", "ignore", "pipe", ...cmd.fds],
      timeout: 30_000,
    });
  } finally {
    cmd.close();
  }
  if (res.error) return { ok: false, error: String(res.error.message ?? res.error), ...ran };
  if (res.status !== 0) {
    const err = String(res.stderr ?? "").trim();
    return { ok: false, error: err || `exit ${res.status}${res.signal ? ` (signal ${res.signal})` : ""}`, ...ran };
  }
  return { ok: true, ...ran };
}

/**
 * Run `command` with /bin/sh in the sandbox the state calls for (pairRunProfile on macOS;
 * landlockRulesFor on Linux, or bwrapArgsFor when Landlock is not this machine's backend or
 * cannot express the run), in its own process group, in the foreground. On timeout or abort the
 * whole group is killed and reaped before this resolves. On a normal exit the group is left as
 * it is (pair_done reaps it before its snapshot); under bubblewrap its own PID namespace ends
 * every process the command started when the command exits. With `linkCheck`, `links` in the
 * result lists what the run made where it could write in the worktree that a later write could
 * follow out of the agreement (newLinks, since `linkCheck.sinceMs`), checked after every
 * process of a killed run is gone. `backend` names the sandbox the run had, and `fellBack` why
 * a Landlock machine ran it under bubblewrap.
 * @param {{ state: import("../core/gate.mjs").State, command: string, cwd: string, timeoutMs?: number, signal?: AbortSignal,
 *   onSpawn?: (pgid: number) => void, env?: Record<string, string>, maxOutput?: number,
 *   linkCheck?: { sinceMs: number, exclusions: string[] }, backend?: "landlock" | "bwrap" }} opts
 *   `backend`: overrides this process's Linux backend (tests)
 * @returns {Promise<{ exitCode: number | null, signal: string | null, stdout: string, stderr: string,
 *   timedOut: boolean, aborted: boolean, pgid: number | null, links: string[], error?: string,
 *   backend?: string, fellBack?: string }>}
 */
export function runSandboxed(opts) {
  const max = opts.maxOutput ?? 64 * 1024;
  return new Promise((resolve) => {
    let child;
    let writable = [];
    let gitBefore = null;
    let ran = {};
    try {
      const cmd = runCommand(opts.state, opts.command, opts.cwd, opts.backend);
      writable = cmd.writable;
      ran = { backend: cmd.backend, ...(cmd.fellBack ? { fellBack: cmd.fellBack } : {}) };
      try {
        if (opts.linkCheck) gitBefore = gitBaseline(opts.state.root, writable, opts.linkCheck.exclusions);
        child = spawn(cmd.file, cmd.args, {
          cwd: opts.cwd,
          detached: true,
          stdio: [cmd.input === undefined ? "ignore" : "pipe", "pipe", "pipe", ...cmd.fds],
          env: opts.env ?? process.env,
        });
        if (cmd.input !== undefined) {
          // The helper reads its ruleset line and then runs the command with this stdin; ending
          // it there gives the command an empty stdin, as "ignore" does for the others. A helper
          // that exits before reading (a spawn failure) must not crash the host on EPIPE.
          child.stdin.on("error", noop);
          child.stdin.end(cmd.input);
        }
      } finally {
        cmd.close();
      }
    } catch (err) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, pgid: null, links: [], error: err instanceof Error ? err.message : String(err), ...ran });
      return;
    }
    const linksMade = () => (gitBefore ? newLinks(opts.state.root, writable, opts.linkCheck.sinceMs, gitBefore, opts.linkCheck.exclusions) : []);
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
      resolve({ exitCode: exitInfo.code, signal: exitInfo.sig, stdout, stderr, timedOut, aborted, pgid, links: linksMade(), ...ran, ...(error ? { error } : {}) });
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

// ─── the post-run link check ────────────────────────────────────────────────────────────

/**
 * The `.git` entries (any letter case) under `roots`, worktree-relative, each with its inode, so
 * a later newLinks can tell one that is new or replaced from one that only changed. `.git` is
 * not walked into, nor are `exclusions`, nor symlinked directories.
 * @param {string} root
 * @param {string[]} roots  absolute paths in the worktree
 * @param {string[]} [exclusions]
 * @returns {Record<string, number>}
 */
export function gitBaseline(root, roots, exclusions = []) {
  const out = {};
  walkRoots(root, roots, exclusions, (rel, st, isGit) => { if (isGit) out[rel] = st.ino; });
  return out;
}

/**
 * What a run made under `roots` that a later write could follow out of the agreement:
 * worktree-relative paths that are a symlink or a file with more than one hard link whose
 * change time is at or after `sinceMs` (making a link sets it, and so does writing a file that
 * already had a second link), and every `.git` entry that is not in `gitBefore` with the same
 * inode (a `.git` directory's own times change whenever git works in it, so it goes by inode).
 * Sorted.
 * @param {string} root
 * @param {string[]} roots  absolute paths in the worktree
 * @param {number} sinceMs
 * @param {Record<string, number>} gitBefore  from gitBaseline before the run
 * @param {string[]} [exclusions]
 * @returns {string[]}
 */
export function newLinks(root, roots, sinceMs, gitBefore, exclusions = []) {
  const found = new Set();
  walkRoots(root, roots, exclusions, (rel, st, isGit) => {
    if (isGit) {
      if (gitBefore[rel] !== st.ino) found.add(rel);
    } else if (st.ctimeMs >= sinceMs && (st.isSymbolicLink() || (!st.isDirectory() && st.nlink > 1))) {
      found.add(rel);
    }
  });
  return [...found].sort();
}

function walkRoots(root, roots, exclusions, visitFn) {
  const skip = new Set(exclusions.map((e) => e.replace(/\/+$/, "")));
  const seen = new Set();
  const visit = (abs) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    let st;
    try { st = lstatSync(abs); } catch { return; }
    const rel = abs === root ? "." : abs.slice(root.length + 1);
    const isGit = basename(abs).toLowerCase() === ".git";
    visitFn(rel, st, isGit);
    if (isGit || !st.isDirectory() || skip.has(rel)) return;
    let names;
    try { names = readdirSync(abs); } catch { return; }
    for (const n of names) visit(join(abs, n));
  };
  for (const r of roots) if (r === root || r.startsWith(`${root}/`)) visit(r);
}
