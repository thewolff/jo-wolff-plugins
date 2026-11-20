// claudex-repo.mjs — the deterministic repository behind the claudex fixtures. Not a test file
// (node --test runs it and finds no tests). capture-claudex-fixture.mjs builds it and saves what
// the real claudex-loop runner's snapshot() reports for its uncommitted change; review-claudex.test.mjs
// builds it again byte for byte, commits that change, and checks the saved snapshot against HEAD.
//
// Fixed author, committer and dates make every commit sha the same on every machine.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXED = Object.freeze({
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-11-19T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-11-19T12:00:00Z",
  GIT_CONFIG_NOSYSTEM: "1",
});

export function gitIn(dir, env, ...args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...env, ...FIXED } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Build the fixture repository in `dir` (an empty folder): `main` with one commit, then branch
 * `feat` with an uncommitted change. `variant` "staged" stages every new file (git add);
 * "untracked" leaves the new files untracked, as a builder that never runs git add does.
 * Returns the base commit's sha.
 */
export function buildRepo(dir, env, variant = "staged") {
  gitIn(dir, env, "init", "-q", "-b", "main");
  gitIn(dir, env, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "gone.txt"), "to be deleted\n");
  gitIn(dir, env, "add", "-A");
  gitIn(dir, env, "commit", "-qm", "base");
  const base = gitIn(dir, env, "rev-parse", "HEAD");
  gitIn(dir, env, "checkout", "-q", "-b", "feat");
  writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "new.mjs"), "export const added = 1;\n");
  gitIn(dir, env, "rm", "-q", "gone.txt");
  if (variant === "staged") gitIn(dir, env, "add", "-A");
  return base;
}

/** Commit everything in the working tree, as the author does after the inspection. Returns HEAD. */
export function commitAll(dir, env, message = "the inspected change") {
  gitIn(dir, env, "add", "-A");
  gitIn(dir, env, "commit", "-qm", message);
  return gitIn(dir, env, "rev-parse", "HEAD");
}
