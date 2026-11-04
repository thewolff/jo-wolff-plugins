#!/usr/bin/env node
// hooks/worktree-spawn-guard.mjs — PreToolUse on `Agent|Task`: a spawn that asks for
// `isolation: "worktree"` is checked for the two states in which a worktree silently drops
// work. Ported from newdle's hooks/worktree-spawn-guard.mjs (0.2.175). Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage.
//
// Inert unless `tool_input.isolation` is "worktree". Then:
//   1. cwd is a workspace root: a directory whose `repos/` holds independently cloned git
//      repositories. A worktree of that root gets an EMPTY `repos/`, so every edit aimed at a
//      real path is rejected; committing does not help. Structural, permanent.
//   2. `git status --porcelain` in cwd prints anything (untracked files count: `git diff HEAD`
//      shows nothing for a new file). A worktree branches off a commit and carries none of
//      that work, so the isolated agent builds on a tree that disagrees with yours.
//
// HOW IT SPEAKS — config `checks["worktree-spawn-guard"]`:
//   "warn"  (default) additionalContext; the spawn proceeds with the hazard named.
//   "block" deny (newdle's behaviour; it chose deny over ask because `auto` permission mode
//           approves an `ask` with nobody seeing it).
//   "off"   nothing.
//
// A cwd that does not exist, is not in a git repository, or where git fails or exceeds 3 s →
// nothing: there is nothing to assert. The 3 s git budget keeps the whole hook under 4 s.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { loadConfig, withFault } from "../lib/config.mjs";

const HOOK = "worktree-spawn-guard";
const SPAWN = new Set(["agent", "task"]);
const GIT_TIMEOUT_MS = 3000;

const warn = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
const deny = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: text } });

function gitStatus(cwd, env) {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** A directory whose `repos/` holds at least one independently cloned git repository. */
export function isWorkspaceRoot(dir) {
  try {
    const reposDir = join(dir, "repos");
    if (!existsSync(reposDir)) return false;
    return readdirSync(reposDir, { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(join(reposDir, e.name, ".git")));
  } catch {
    return false;
  }
}

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  a warn, a deny, a systemMessage, or null
 */
export function handle(input, { env = process.env, status = gitStatus } = {}) {
  const { config, fault } = loadConfig(env);
  const mode = config.checks[HOOK];
  if (config.off || mode === "off") return null;
  const done = (out) => withFault(out, fault, HOOK);
  const speak = (body, instead) => (mode === "block" ? deny(`${body} Refused. ${instead}`) : warn(`${body} ${instead}`));

  if (!SPAWN.has(String(input?.tool_name ?? "").toLowerCase())) return done(null);
  const ti = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  if (String(ti.isolation ?? "").toLowerCase() !== "worktree") return done(null);

  const rawCwd = input?.cwd || ti.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const cwd = resolve(String(rawCwd));
  if (!existsSync(cwd)) return done(null);

  if (isWorkspaceRoot(cwd)) {
    return done(speak(
      `worktree-spawn-guard: this spawn asks for isolation: "worktree" while the working directory is a workspace root (${cwd}). Every directory under repos/ there is its own git repository, so a worktree of the root gets an EMPTY repos/ and rejects every edit aimed at a real path inside it; committing does not help.`,
      "Spawn without isolation, or with the cwd pointed at the specific nested repository the work belongs to. Do not create the worktree by hand or point the agent at another path to get around this.",
    ));
  }

  const out = status(cwd, env);
  if (out === null || out.trim() === "") return done(null);
  const dirty = out.trim().split("\n").slice(0, 10).join("\n");
  return done(speak(
    `worktree-spawn-guard: this spawn asks for isolation: "worktree" but the tree at ${cwd} is dirty. A worktree branches off a commit and carries NO uncommitted work, so the isolated agent would not see the changes below and would build on a tree that silently disagrees with yours (untracked files count: git diff HEAD shows nothing for a new file).\n\ngit status --porcelain (first 10):\n${dirty}\n\n`,
    "Commit the working tree first (a feature branch is fine) and spawn again with isolation, or drop the isolation request and let the agent edit this tree directly. Do not stash or create the worktree by hand to get around this.",
  ));
}

if (invokedDirectly(import.meta.url)) runHook(HOOK, import.meta.url, { plugin: "delegation" });
