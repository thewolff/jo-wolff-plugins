// landlock.mjs — the Landlock half of the Linux sandbox: finding, checking and running the
// pair-landlock helper (landlock/README.md) with the ruleset core/gate.mjs builds
// (landlockRulesFor, pairWriteLandlock).
//
// WHAT IT PROVIDES
//   - probeLandlock: which helper binary this machine runs, whether its bytes match
//     landlock/SHA256SUMS, and the kernel's Landlock ABI from `pair-landlock --abi`.
//   - landlockProblem: the same, probed once per process; only success is remembered.
//   - landlockCommand: the helper and the ruleset line it reads on stdin.
//   - landlockIo: the filesystem facts the core's builders take.
//   - parseMountinfo: the mount points in a /proc/<pid>/mountinfo text.
//
// RULES IT KEEPS
//   - Node built-ins only and no top-level await (host-io.mjs imports it everywhere).
//   - A checksum mismatch, an architecture with no binary, or a helper that will not run is a
//     refusal, never a quiet fall back to bubblewrap: those mean the plugin is not what was
//     shipped. Only a kernel without Landlock ABI 3 falls back.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The helper's directory in this plugin. */
export const LANDLOCK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "landlock");

/** process.arch -> the architecture in the helper binary's name. */
export const HELPER_ARCHES = Object.freeze({ x64: "x86_64", arm64: "aarch64" });

/** The lowest ABI the fence takes: ABI 3 is the first that can deny truncate(2). */
export const MIN_LANDLOCK_ABI = 3;
/** pair-landlock's exit code for a kernel without Landlock ABI 3. */
const EXIT_UNSUPPORTED = 120;

/**
 * @typedef {{ helper: string, abi: number } | { problem: string, fallback: boolean }} LandlockProbe
 *   `fallback` is true only when the kernel lacks Landlock ABI 3, the one case bubblewrap may
 *   stand in for; every other problem refuses pairing.
 */

/**
 * Probe Landlock through the helper, without caching: pick the binary for `arch`, check its
 * SHA256 against SHA256SUMS before running it, then ask it for the kernel's ABI.
 * @param {{ dir?: string, arch?: string }} [opts]
 * @returns {LandlockProbe}
 */
export function probeLandlock({ dir = LANDLOCK_DIR, arch = process.arch } = {}) {
  const refuse = (problem) => ({ problem, fallback: false });
  const name = HELPER_ARCHES[arch];
  if (!name) return refuse(`the pair-landlock helper is built for x86_64 and aarch64 Linux; this machine is ${arch}`);
  const rel = `bin/pair-landlock-${name}-linux`;
  const helper = join(dir, rel);
  let sums;
  try {
    sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
  } catch (err) {
    return refuse(`cannot read the helper's checksums at ${join(dir, "SHA256SUMS")} (${err?.code ?? err}); reinstall the plugin`);
  }
  const want = sums.split("\n").map((line) => line.trim().split(/\s+/)).find((f) => f[1] === rel)?.[0];
  if (!want) return refuse(`${join(dir, "SHA256SUMS")} lists no ${rel}; reinstall the plugin`);
  let got;
  try {
    got = createHash("sha256").update(readFileSync(helper)).digest("hex");
  } catch (err) {
    return refuse(`cannot read the helper at ${helper} (${err?.code ?? err}); reinstall the plugin`);
  }
  if (got !== want) return refuse(`the helper at ${helper} does not match its checksum (sha256 ${got}, SHA256SUMS lists ${want}); reinstall the plugin, or rebuild it with landlock/build.sh`);
  const res = spawnSync(helper, ["--abi"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  const said = String(res.stderr ?? "").trim();
  if (res.error) return refuse(`cannot run the helper at ${helper} (${res.error.code ?? res.error.message})`);
  const abi = Number.parseInt(String(res.stdout ?? "").trim(), 10);
  if (res.status === EXIT_UNSUPPORTED) return { problem: said.replace(/^pair-landlock: /, "") || "Landlock is unavailable on this kernel", fallback: true };
  if (res.status !== 0 || !Number.isInteger(abi)) return refuse(`the helper at ${helper} failed its ABI probe (${said || `exit ${res.status}${res.signal ? `, signal ${res.signal}` : ""}`})`);
  if (abi < MIN_LANDLOCK_ABI) return { problem: `Landlock ABI ${abi} is below ${MIN_LANDLOCK_ABI}, so truncation cannot be denied`, fallback: true };
  return { helper, abi };
}

let probed = null;

/**
 * Why Landlock cannot fence pair_run here, or null. Probes once per process (probeLandlock),
 * and like bubblewrap's probe remembers only success, so the checksum is checked before the
 * helper's first use in a process and never trusted from an earlier one.
 * @returns {{ problem: string, fallback: boolean } | null}
 */
export function landlockProblem() {
  if (probed) return null;
  const p = probeLandlock();
  if ("helper" in p) {
    probed = p;
    return null;
  }
  return p;
}

/** The kernel's Landlock ABI from the probe, or null before a successful one. */
export function landlockAbi() {
  return probed ? probed.abi : null;
}

/**
 * The helper to run and the ruleset line to write first on its stdin, for `command`.
 * @param {import("../core/gate.mjs").LandlockRules} rules
 * @param {string} command  what the helper runs with /bin/sh -c
 * @returns {{ file: string, input: string }}
 */
export function landlockCommand(rules, command) {
  if (!probed) throw new Error("Landlock was not probed; call landlockProblem first");
  return { file: probed.helper, input: `${JSON.stringify({ files: rules.files, dirs: rules.dirs, rw_trees: rules.rw_trees, command })}\n` };
}

const typeOf = (st) => (st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other");

/**
 * The mount points in a mountinfo text (proc(5): the fifth field of each line, with space,
 * tab, newline and backslash written as three-digit octal escapes).
 * @param {string} text
 * @returns {string[]}
 */
export function parseMountinfo(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const point = line.split(" ")[4];
    if (point) out.push(point.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8))));
  }
  return out;
}

/**
 * What a budgeted walk may spend before it gives up (landlockIo.walk): entries listed,
 * directory depth below the top, and wall time. The carve-out scan before every pair_run
 * uses these (core/gate.mjs carveOutHazard), so a sibling-state tree that outgrew them
 * refuses the run, naming the budget, instead of holding the host.
 */
export const WALK_BUDGET = Object.freeze({ entries: 100000, depth: 64, ms: 5000 });

/** The filesystem facts core/gate.mjs's Landlock builders take. */
export const landlockIo = Object.freeze({
  lstat(abs) {
    try {
      const st = lstatSync(abs);
      return { type: typeOf(st), nlink: st.nlink };
    } catch {
      return null;
    }
  },
  // A directory that cannot be listed, or an entry that cannot be looked at, is reported
  // rather than skipped, so the builder treats it as holding something outside the boundary.
  // Nothing is skipped: a `.git` entry is descended into like any directory, since a grant on
  // the directory above it reaches everything in it. The walk is iterative (a tree deeper
  // than the call stack cannot throw) and reads each directory one entry at a time, so a wide
  // directory is never listed whole before the entry budget is checked. Given a budget, it
  // stops at the first limit it meets with one "unwalked" entry naming it, at the path it had
  // reached; the clock and the signal are looked at before each directory and after every
  // entry read and every lstat, so neither a flat directory nor the last one walked runs past
  // them. A single filesystem call that blocks is not interrupted: the bound holds between calls.
  /**
   * @param {string} dir
   * @param {{ budget?: { entries: number, depth: number, ms: number }, signal?: AbortSignal }} [opts]
   */
  walk(dir, opts = {}) {
    const out = [];
    const budget = opts.budget ?? null;
    const started = Date.now();
    /** @type {Array<{ dir: string, depth: number }>} */
    const stack = [{ dir, depth: 0 }];
    const stop = (path, reason) => { out.push({ path, type: "unwalked", nlink: 0, reason }); return out; };
    const spent = (path) => {
      if (opts.signal?.aborted) return stop(path, "the run was aborted");
      if (budget && Date.now() - started > budget.ms) return stop(path, `looking at it took longer than ${budget.ms} ms`);
      return null;
    };
    while (stack.length) {
      const { dir: d, depth } = stack.pop();
      let done = spent(d);
      if (done) return done;
      if (budget && depth >= budget.depth) return stop(d, `it is deeper than ${budget.depth} directories`);
      let listing;
      try { listing = opendirSync(d); } catch { out.push({ path: `${d}/`, type: "unreadable", nlink: 0 }); continue; }
      // Pushed in reverse so the entries come out in listing order, as the recursive walk gave them.
      const below = [];
      try {
        for (;;) {
          let ent;
          try { ent = listing.readSync(); } catch { out.push({ path: `${d}/`, type: "unreadable", nlink: 0 }); break; }
          if ((done = spent(d))) return done;
          if (ent === null) break;
          const abs = join(d, ent.name);
          if (budget && out.length >= budget.entries) return stop(abs, `it holds more than ${budget.entries} entries`);
          let st;
          try { st = lstatSync(abs); } catch { out.push({ path: abs, type: "unreadable", nlink: 0 }); continue; }
          if ((done = spent(abs))) return done;
          const type = typeOf(st);
          out.push({ path: abs, type, nlink: st.nlink });
          if (type === "dir") below.push({ dir: abs, depth: depth + 1 });
        }
      } finally {
        listing.closeSync();
      }
      for (let i = below.length - 1; i >= 0; i--) stack.push(below[i]);
    }
    return out;
  },
  mounts() {
    try {
      return parseMountinfo(readFileSync("/proc/self/mountinfo", "utf8"));
    } catch {
      return null;
    }
  },
});
